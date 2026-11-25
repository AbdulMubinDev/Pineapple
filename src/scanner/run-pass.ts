// Per-pass planning for a ScannerRun: which bars a pair steps (catch-up from the stored bars), and the funding queued
// into each pair's barHooks funding array before those bars are stepped.
import type { PaperBroker } from '../broker/broker.js';
import { tfToMs } from '../core/timeframe.js';
import type { Candle, Timeframe } from '../core/types.js';
import type { DueFunding, FundingTracker } from '../exchange/funding.js';
import type { CandleRepo } from '../store/candles.js';
import { MAX_CATCHUP_BARS, type Pair } from './types.js';

/** A pair and the bars it steps this pass, oldest first. */
export interface PairPlan {
  p: Pair;
  seq: Candle[];
}

/**
 * The bars `p` steps to reach `bar`: the stored ones after its last stepped bar, then `bar`. 'behind' when the repo
 * has a hole there, or the gap is longer than MAX_CATCHUP_BARS.
 */
export function catchUpBars(p: Pair, bar: Candle, candles: CandleRepo, tf: Timeframe): Candle[] | 'behind' {
  const step = tfToMs(tf);
  const from = p.last.openTime + step;
  if (bar.openTime === from) return [bar];
  if ((bar.openTime - from) / step > MAX_CATCHUP_BARS) return 'behind';
  const seq = [...candles.range(p.info.symbol, tf, from, bar.openTime - step), bar];
  for (let i = 0; i < seq.length; i++) if (seq[i]!.openTime !== from + i * step) return 'behind';
  return seq;
}

export interface FundingContext {
  broker: PaperBroker;
  funding: FundingTracker;
  now: number;
  appliedThrough: (symbol: string) => number;
  log: (kind: string, symbol: string | undefined, detail: unknown) => void;
}

/**
 * Ruling B: the funding due for pairs with a position or orders (an order may fill at the next bar's open, before
 * the funding time) is pushed into their barHooks funding array before the bar that contains it is stepped. An event
 * older than the first bar to step (published late) is applied at once. Returns, per symbol, the applied-through
 * time of what was applied here (the late ones); the queued ones count once stepped (fundingSteppedThrough).
 */
export async function queueFunding(ctx: FundingContext, plans: PairPlan[]): Promise<Record<string, number>> {
  const applied: Record<string, number> = {};
  const bySymbol = new Map<string, PairPlan>();
  for (const x of plans) {
    const s = x.p.info.symbol;
    if (ctx.broker.position(s) !== null || ctx.broker.openOrders(s).length > 0) bySymbol.set(s, x);
  }
  if (bySymbol.size === 0) return applied;
  let due: DueFunding[] = [];
  try {
    due = await ctx.funding.due([...bySymbol.keys()], ctx.now, ctx.appliedThrough);
  } catch (e) {
    ctx.log('warning', undefined, { reason: 'funding_due_failed', message: e instanceof Error ? e.message : String(e) });
  }
  for (const { symbol, event } of due) {
    const { p, seq } = bySymbol.get(symbol)!;
    const last = p.funding[p.funding.length - 1];
    if ((last && event.time <= last.time) || event.time <= p.fundingThrough) continue; // queued or applied already
    if (event.time < seq[0]!.openTime) {
      ctx.broker.applyFunding(symbol, event);
      applied[symbol] = p.fundingThrough = event.time;
      ctx.log('warning', symbol, { reason: 'funding_late', time: event.time });
    } else p.funding.push(event);
  }
  return applied;
}

/** The funding time through which `p`'s queued events have been stepped (its fundingThrough at least). */
export function fundingSteppedThrough(p: Pair, tf: Timeframe): number {
  const end = p.last.openTime + tfToMs(tf);
  let t = p.fundingThrough;
  for (const ev of p.funding) if (ev.time < end && ev.time > t) t = ev.time;
  return t;
}
