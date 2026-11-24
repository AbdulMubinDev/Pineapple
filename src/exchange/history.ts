import { barOpenFor, tfToMs } from '../core/timeframe.js';
import type { Timeframe } from '../core/types.js';
import type { CandleRepo } from '../store/candles.js';
import type { ExchangeClient } from './client.js';

/** Bars kept beyond the wanted window on the chart timeframe. */
export const CHART_EXTRA_BARS = 500;
/** Bars kept per higher timeframe (1000 wanted + 50 spare). */
export const HTF_KEEP_BARS = 1000 + 50;

export interface LoadHistoryOptions {
  client: ExchangeClient;
  repo: CandleRepo;
  symbol: string;
  tf: Timeframe;
  bars: number;
  /** UTC epoch ms; only candles closed by this time are kept. */
  now: number;
  /** Retention class: 'chart' keeps bars + 500 (default), 'htf' keeps max(bars, 1050). */
  role?: 'chart' | 'htf';
  /** PairInfo.onboardDate (UTC epoch ms). Bars cannot exist before it, so the head is not chased past it. */
  onboardDate?: number;
}

/**
 * Warm one series up to `bars` closed candles ending at the last bar closed by `now`.
 * 1. A repo too old to join the window is discarded.
 * 2. The missing tail is fetched; then the missing head, down to max(window start, listing date).
 * 3. If the window still has interior holes it is refetched once (bounded, so a genuine exchange gap cannot loop).
 * `available` is the real number of bars in the window; a pair younger than `bars` reports fewer.
 */
export async function loadHistory(o: LoadHistoryOptions): Promise<{ loaded: number; available: number }> {
  const { client, repo, symbol, tf, bars, now } = o;
  const step = tfToMs(tf);
  const lastClosed = barOpenFor(now, tf) - step;
  const wantedStart = lastClosed - (bars - 1) * step;
  const windowStart = o.onboardDate === undefined ? wantedStart : Math.max(wantedStart, barOpenFor(o.onboardDate, tf));

  const fetchRange = async (from: number, to: number): Promise<void> => {
    if (from > to) return;
    const fetched = (await client.klines(symbol, tf, from, to)).filter(
      (c) => c.openTime >= from && c.openTime <= to && c.openTime + step <= now,
    );
    repo.upsert(symbol, tf, fetched);
  };

  const latest = repo.latest(symbol, tf);
  let tailFrom = wantedStart;
  if (latest !== null) {
    if (latest.openTime + step >= wantedStart) tailFrom = Math.max(wantedStart, latest.openTime + step);
    else repo.pruneBefore(symbol, tf, wantedStart); // too old to join the window without a gap
  }
  const before = repo.count(symbol, tf);

  await fetchRange(Math.max(tailFrom, windowStart), lastClosed);

  const inWindow = () => repo.range(symbol, tf, wantedStart, lastClosed);
  let stored = inWindow();
  const earliest = stored[0]?.openTime;
  if (earliest !== undefined && stored.length < bars && earliest > windowStart) {
    await fetchRange(windowStart, earliest - step);
    stored = inWindow();
  }

  // Interior holes: refetch the window once. Slots are counted from the earliest stored bar, so a young pair is not a hole.
  const first = stored[0]?.openTime;
  if (first !== undefined && stored.length !== (lastClosed - first) / step + 1) {
    await fetchRange(first, lastClosed);
    stored = inWindow();
  }

  const loaded = repo.count(symbol, tf) - before;
  const keep = o.role === 'htf' ? Math.max(bars, HTF_KEEP_BARS) : bars + CHART_EXTRA_BARS;
  repo.pruneBefore(symbol, tf, lastClosed - (keep - 1) * step);
  return { loaded, available: Math.min(bars, stored.length) };
}
