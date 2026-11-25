// Warm-up for the live scanner: per-pair history loading with retry and backoff, bounded concurrency, and the
// higher-timeframe series a resident instance starts from.
import { barOpenFor, tfToMs } from '../core/timeframe.js';
import type { Candle, Timeframe } from '../core/types.js';
import { aggregateCandles, bucketOpen, periodOf } from '../engine/memory-provider.js';
import { HttpStatusError } from '../exchange/budget.js';
import type { ExchangeClient } from '../exchange/client.js';
import { loadHistory } from '../exchange/history.js';
import { NetworkError } from '../net/http.js';
import type { CandleRepo } from '../store/candles.js';

/** Chart bars loaded per pair (Global Constraints). */
export const WARMUP_BARS = 3_000;
/** Bars loaded natively per higher timeframe the script requests. */
export const HTF_BARS = 1_000;
/** Pairs loading at once: REST is the bottleneck (the budget paces it), so a few in flight keep it busy. */
export const WARMUP_CONCURRENCY = 6;
/** Retry delays after a transient failure: 2 s, 4 s, ... capped at 60 s. */
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 60_000;
/** Attempts per pair before it is given up for now (retried at the next universe refresh). */
export const RETRY_ATTEMPTS = 8;

/** A failure that says nothing about the pair: the network, 5xx, 429 or 418 (the budget backs off for those). */
export function isTransient(e: unknown): boolean {
  return e instanceof NetworkError || (e instanceof HttpStatusError && (e.status >= 500 || e.status === 429 || e.status === 418));
}

/** Runs `fn`, retrying transient failures with backoff (RETRY_BASE_MS doubling to RETRY_MAX_MS), at most `attempts` times. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  o: { attempts?: number; onRetry?: (attempt: number, delayMs: number, e: unknown) => void; cancelled?: () => boolean } = {},
): Promise<T> {
  const attempts = o.attempts ?? RETRY_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || attempt >= attempts || o.cancelled?.()) throw e;
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      o.onRetry?.(attempt, delay, e);
      await sleep(delay);
    }
  }
}

/** Calls `fn` for every item, at most `limit` at a time; one item's failure does not stop the others. */
export async function forEachPooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch {
        // fn reports its own failures
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/** The newest contiguous run of `candles` (oldest first). */
export function contiguousTail(candles: Candle[], tf: Timeframe): Candle[] {
  const step = tfToMs(tf);
  let i = candles.length - 1;
  while (i > 0 && candles[i]!.openTime - candles[i - 1]!.openTime === step) i--;
  return candles.slice(Math.max(0, i));
}

/** Our exchange timeframe for a request.security timeframe, when Binance serves it natively ('D' -> '1d', '240' -> '4h'). */
export function nativeTimeframe(pineTf: string): Timeframe | null {
  const p = periodOf(pineTf);
  if (!p || p.kind !== 'ms') return null;
  for (const tf of ['15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'] as const) if (tfToMs(tf) === p.ms) return tf;
  return null;
}

/**
 * The candles a resident instance gets for one request.security timeframe: native exchange bars for the buckets
 * before the last history bar's bucket, then what the closed chart bars build (aggregateCandles) from there on. The
 * last, developing bucket is always built from closed chart bars, never an exchange kline (FeedStore checks it).
 */
export function buildHtf(history: Candle[], pineTf: string, native: Candle[]): Candle[] {
  const p = periodOf(pineTf);
  const last = history[history.length - 1];
  if (!p || !last) return aggregateCandles(history, pineTf);
  const lastOpen = bucketOpen(last.openTime, p);
  const before = native.filter((c) => c.openTime < lastOpen && bucketOpen(c.openTime, p) === c.openTime);
  const cut = before.length > 0 ? before[before.length - 1]!.openTime + 1 : -Infinity;
  return [...before, ...aggregateCandles(history, pineTf).filter((c) => c.openTime >= cut)];
}

export interface PairHistory {
  /** Closed chart bars, oldest first, contiguous, ending with the last bar closed at load time. */
  history: Candle[];
  /** Per request.security timeframe: buildHtf's series. */
  htf: Record<string, Candle[]>;
}

export interface LoadPairOptions {
  client: ExchangeClient;
  candles: CandleRepo;
  symbol: string;
  tf: Timeframe;
  onboardDate: number;
  securityTimeframes: string[];
  now: number;
  bars?: number;
  htfBars?: number;
}

/** Loads (through the budget) and reads back one pair's warm-up history. Throws what loadHistory throws. */
export async function loadPairHistory(o: LoadPairOptions): Promise<PairHistory> {
  const bars = o.bars ?? WARMUP_BARS;
  const base = { client: o.client, repo: o.candles, symbol: o.symbol, now: o.now, onboardDate: o.onboardDate };
  await loadHistory({ ...base, tf: o.tf, bars });
  const step = tfToMs(o.tf);
  const lastClosed = barOpenFor(o.now, o.tf) - step;
  const history = contiguousTail(o.candles.range(o.symbol, o.tf, lastClosed - (bars - 1) * step, lastClosed), o.tf);
  const htf: Record<string, Candle[]> = {};
  for (const pineTf of o.securityTimeframes) {
    const native = nativeTimeframe(pineTf);
    let natives: Candle[] = [];
    if (native && native !== o.tf) {
      await loadHistory({ ...base, tf: native, bars: o.htfBars ?? HTF_BARS, role: 'htf' });
      natives = o.candles.range(o.symbol, native, 0, o.now);
    }
    htf[pineTf] = buildHtf(history, pineTf, natives);
  }
  return { history, htf };
}
