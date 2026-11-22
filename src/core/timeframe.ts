import type { Timeframe } from './types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const TF_MS: Record<Timeframe, number> = {
  '15m': 15 * MIN,
  '30m': 30 * MIN,
  '1h': HOUR,
  '2h': 2 * HOUR,
  '4h': 4 * HOUR,
  '6h': 6 * HOUR,
  '8h': 8 * HOUR,
  '12h': 12 * HOUR,
  '1d': 24 * HOUR,
};

export function isTimeframe(s: string): s is Timeframe {
  return Object.hasOwn(TF_MS, s);
}

export function tfToMs(tf: Timeframe): number {
  return TF_MS[tf];
}

/** Open time (UTC epoch ms) of the bar containing `time`. Binance bars align to the UTC epoch. */
export function barOpenFor(time: number, tf: Timeframe): number {
  const ms = TF_MS[tf];
  return Math.floor(time / ms) * ms;
}
