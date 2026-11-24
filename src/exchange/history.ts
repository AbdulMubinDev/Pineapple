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
  /** Retention class: 'chart' keeps bars + 500 (default), 'htf' keeps 1050. */
  role?: 'chart' | 'htf';
}

/**
 * Warm one series up to `bars` closed candles ending at the last bar closed by `now`.
 * Fetches only what the repo lacks at the tail; a repo too old to join the window is discarded.
 * A pair younger than `bars` simply yields fewer (`available < bars`): the listing date is the natural start
 * because the exchange returns nothing before it.
 */
export async function loadHistory(o: LoadHistoryOptions): Promise<{ loaded: number; available: number }> {
  const { client, repo, symbol, tf, bars, now } = o;
  const step = tfToMs(tf);
  const lastClosed = barOpenFor(now, tf) - step;
  const wantedStart = lastClosed - (bars - 1) * step;

  const latest = repo.latest(symbol, tf);
  let from = wantedStart;
  if (latest !== null) {
    if (latest.openTime + step >= wantedStart) from = Math.max(wantedStart, latest.openTime + step);
    else repo.pruneBefore(symbol, tf, wantedStart); // too old to join the window without a gap
  }

  let loaded = 0;
  if (from <= lastClosed) {
    const fetched = (await client.klines(symbol, tf, from, lastClosed)).filter(
      (c) => c.openTime >= from && c.openTime <= lastClosed && c.openTime + step <= now,
    );
    repo.upsert(symbol, tf, fetched);
    loaded = fetched.length;
  }

  const keep = o.role === 'htf' ? HTF_KEEP_BARS : bars + CHART_EXTRA_BARS;
  repo.pruneBefore(symbol, tf, lastClosed - (keep - 1) * step);
  return { loaded, available: Math.min(bars, repo.count(symbol, tf)) };
}
