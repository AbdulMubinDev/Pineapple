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
  /** The pass's close: events up to closeTime - 1 belong to the bars it steps. */
  closeTime: number;
  appliedThrough: (symbol: string) => number;
  log: (kind: string, symbol: string | undefined, detail: unknown) => void;
}

/**
 * The applied-through a funding lookup for `symbol` starts after: the stored one, floored at just before the
 * exposure began (the position's open, else the first bar an order could fill on), so older events are not asked for.
 */
export function exposureFloor(broker: PaperBroker, symbol: string, stored: number, firstBar: number): number {
  const pos = broker.position(symbol);
  return Math.max(stored, (pos ? pos.openTime : firstBar) - 1);
}

/** Symbols of `plans` with a position or orders: their funding matters this pass. */
export function exposedPlans(broker: PaperBroker, plans: PairPlan[]): Map<string, PairPlan> {
  const out = new Map<string, PairPlan>();
  for (const x of plans) {
    const s = x.p.info.symbol;
    if (broker.position(s) !== null || broker.openOrders(s).length > 0) out.set(s, x);
  }
  return out;
}

/**
 * Ruling B: the funding due for pairs with a position or orders (an order may fill at the next bar's open, before
 * the funding time) is pushed into their barHooks funding array before the bar that contains it is stepped. Read
 * from the repo only (the run prefetches between passes, through the budget): no REST inside a pass. An event older
 * than the first bar to step (it settled after its bar was stepped) is applied at once. Returns, per symbol, the
 * applied-through time of what was applied here; queued events count once stepped (fundingSteppedThrough).
 */
export async function queueFunding(ctx: FundingContext, plans: PairPlan[]): Promise<Record<string, number>> {
  const applied: Record<string, number> = {};
  const bySymbol = exposedPlans(ctx.broker, plans);
  if (bySymbol.size === 0) return applied;
  let due: DueFunding[] = [];
  const floor = (s: string) => exposureFloor(ctx.broker, s, ctx.appliedThrough(s), bySymbol.get(s)!.seq[0]!.openTime);
  try {
    due = await ctx.funding.due([...bySymbol.keys()], ctx.closeTime - 1, floor, { fetch: false });
  } catch (e) {
    ctx.log('warning', undefined, { reason: 'funding_due_failed', message: e instanceof Error ? e.message : String(e) });
  }
  for (const { symbol, event } of due) {
    const { p, seq } = bySymbol.get(symbol)!;
    const last = p.funding[p.funding.length - 1];
    if ((last && event.time <= last.time) || event.time <= p.fundingThrough) continue; // queued or applied already
    if (event.time < seq[0]!.openTime) {
      const change = ctx.broker.applyFunding(symbol, event);
      applied[symbol] = p.fundingThrough = event.time;
      if (change !== 0) ctx.log('warning', symbol, { reason: 'funding_late', time: event.time, amount: change });
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
