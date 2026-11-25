// Funding around live fills between closes. A funding time inside the forming bar passes before that bar is stepped;
// a live fill that closes or reduces the position in between must not lose it.
//  - Resolved (the event is in the repo): applied to the open position before the fill (fundingBeforeLiveFill).
//  - Not resolved yet: the closed part is remembered (pendingAfterLiveFill) and charged once the rate is known
//    (settlePending), as a broker funding adjustment on the symbol. The part still open gets it when its bar is stepped.
import type { PaperBroker } from '../broker/broker.js';
import type { FundingEvent, Position } from '../core/types.js';
import type { FundingTracker } from '../exchange/funding.js';
import type { Pair } from './types.js';

/** The fetch window around a funding time, as FundingTracker uses it. */
const BEFORE_MS = 1_000;
const AFTER_MS = 60_000;

export interface PendingFunding {
  symbol: string;
  time: number;
  /** Signed quantity that held the funding time and was closed live before the event settled. */
  qty: number;
}

const resolved = (funding: FundingTracker, symbol: string, t: number): FundingEvent | undefined => funding.range(symbol, t - BEFORE_MS, t + AFTER_MS)[0];

/**
 * Applies, oldest first, the resolved funding events of `p`'s open position with fundingThrough < time <= `time`
 * (stopping at the first unresolved one). Returns the new applied-through time, or null when nothing was applied.
 */
export function fundingBeforeLiveFill(broker: PaperBroker, funding: FundingTracker, p: Pair, time: number): number | null {
  const symbol = p.info.symbol;
  const pos = broker.position(symbol);
  if (pos === null) return null;
  let through: number | null = null;
  // Times before the position opened do not concern it (and may never be resolved).
  for (const t of funding.passedTimes(symbol, Math.max(p.fundingThrough, pos.openTime - 1), time)) {
    const ev = resolved(funding, symbol, t);
    if (!ev) break;
    broker.applyFunding(symbol, ev);
    through = p.fundingThrough = t;
  }
  return through;
}

/** After a live fill: the passed funding times not applied yet (unresolved, or after an unresolved one) that the closed part of `before` held. */
export function pendingAfterLiveFill(funding: FundingTracker, symbol: string, before: Position | null, after: Position | null, fundingThrough: number, time: number): PendingFunding[] {
  if (!before) return [];
  const sameSide = after !== null && Math.sign(after.qty) === Math.sign(before.qty);
  const closed = Math.abs(before.qty) - (sameSide ? Math.abs(after.qty) : 0);
  if (!(closed > 1e-12)) return [];
  // Everything after fundingThrough was not applied before the fill (fundingBeforeLiveFill stops at the first unresolved).
  return funding
    .passedTimes(symbol, Math.max(fundingThrough, before.openTime), time)
    .map((t) => ({ symbol, time: t, qty: Math.sign(before.qty) * closed }));
}

/**
 * Charges the pending items whose event is now in the repo (a long pays a positive rate). Returns what is still
 * pending, and the settled ones with their amounts.
 */
export function settlePending(
  broker: PaperBroker,
  funding: FundingTracker,
  pending: PendingFunding[],
): { remaining: PendingFunding[]; settled: (PendingFunding & { amount: number; rate: number })[] } {
  const remaining: PendingFunding[] = [];
  const settled: (PendingFunding & { amount: number; rate: number })[] = [];
  for (const x of pending) {
    const ev = resolved(funding, x.symbol, x.time);
    const mark = ev ? (ev.markPrice > 0 ? ev.markPrice : broker.lastPriceOf(x.symbol)) : undefined;
    if (!ev || mark === undefined) {
      remaining.push(x);
      continue;
    }
    const amount = -x.qty * mark * ev.rate;
    broker.adjustFunding(x.symbol, amount);
    settled.push({ ...x, amount, rate: ev.rate });
  }
  return { remaining, settled };
}
