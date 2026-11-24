// The StrategyLayer's own state, and its plain-JSON form for saving with the broker's (one transaction).
// A live run restored from it must carry on exactly as an uninterrupted one: Maps keep their insertion
// order as entry arrays, Sets become arrays, and `seq` comes back as it was, so order ids never repeat.
import type { OrderIntent } from '../core/types.js';
import type { LayerAnomaly, TradeAttribution } from './strategy-layer.js';

export const LAYER_STATE_VERSION = 1;

export type Dir = 1 | -1;

/** A physical lot: what a close or exit for its entry id may still take. */
export interface Lot {
  entryId: string;
  qty: number;
  dir: Dir;
  price: number;
  /** Exit ids that have filled against this trade: an exit id fills once per trade (TradingView). */
  exitsFilled: Set<string>;
  /** Filled past the pyramiding cap (see StrategyLayer.book): not a script trade, closed at the next open. */
  overfill?: boolean;
  /** Overfill lots: when the lot filled (its round trip's entry time). */
  time?: number;
}

/** An open trade as the script sees it (strategy.opentrades): exits pair with these by close_entries_rule. */
export interface TradeRecord {
  entryId: string;
  qty: number;
  dir: Dir;
  price: number;
  barIndex: number;
  time: number;
}

export interface OrderMeta {
  kind: 'entry' | 'order' | 'exit' | 'close' | 'close_all' | 'overfill';
  entryId?: string;
  /** exit legs: the exit registration they belong to. */
  exitKey?: string;
}

/** Re-sends of one exit leg the broker did not take. */
export interface LegRetry {
  total: number;
  /** The bar (openTime) `inBar` counts for. */
  bar: number;
  inBar: number;
}

export interface ExitReg {
  key: string;
  exitId: string;
  /** '' = every open entry. */
  fromEntry: string;
  qty?: number;
  qtyPercent?: number;
  limit?: number;
  stop?: number;
  profitTicks?: number;
  lossTicks?: number;
  ocaName?: string;
  /** Leg order id -> the intent last handed out for it (JSON), to send only changes. */
  sent: Map<string, string>;
  /** It has had a trade to protect (so it dies when that trade is gone). */
  wasLive: boolean;
  /** Legs the broker did not take, waiting to be sent again. */
  awaiting: Set<string>;
  retries: Map<string, LegRetry>;
  /** Legs given up on after too many re-sends: never sent again for this exit. */
  abandoned: Set<string>;
}

/** Everything a StrategyLayer holds between calls. */
export interface LayerInternals {
  lots: Lot[];
  records: TradeRecord[];
  meta: Map<string, OrderMeta>;
  exits: Map<string, ExitReg>;
  parked: Map<string, OrderIntent>;
  scriptAvg: number;
  tainted: boolean;
  seq: number;
  anomalies: LayerAnomaly[];
  attributions: TradeAttribution[];
}

export type LotState = Omit<Lot, 'exitsFilled'> & { exitsFilled: string[] };

export type ExitRegState = Omit<ExitReg, 'sent' | 'awaiting' | 'retries' | 'abandoned'> & {
  sent: [string, string][];
  awaiting: string[];
  retries: [string, LegRetry][];
  abandoned: string[];
};

/** Plain JSON: JSON.parse(JSON.stringify(s)) restores it identically. */
export interface LayerState {
  version: typeof LAYER_STATE_VERSION;
  symbol: string;
  lots: LotState[];
  records: TradeRecord[];
  meta: [string, OrderMeta][];
  /** In registration order (the order exits are brought up to date in). */
  exits: ExitRegState[];
  parked: [string, OrderIntent][];
  scriptAvg: number;
  tainted: boolean;
  seq: number;
  anomalies: LayerAnomaly[];
  attributions: TradeAttribution[];
}

/** A deep copy through JSON that refuses NaN / Infinity (JSON would silently turn them into null). */
function plainCopy<T>(x: T, what: string): T {
  return JSON.parse(
    JSON.stringify(x, (k, v: unknown) => {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${what}: ${k || 'value'} is ${v}, which JSON cannot hold`);
      return v;
    }),
  ) as T;
}

export function encodeLayer(symbol: string, l: LayerInternals): LayerState {
  const state: LayerState = {
    version: LAYER_STATE_VERSION,
    symbol,
    lots: l.lots.map((lot) => ({ ...lot, exitsFilled: [...lot.exitsFilled] })),
    records: l.records,
    meta: [...l.meta],
    exits: [...l.exits.values()].map((r) => ({
      ...r,
      sent: [...r.sent],
      awaiting: [...r.awaiting],
      retries: [...r.retries],
      abandoned: [...r.abandoned],
    })),
    parked: [...l.parked],
    scriptAvg: l.scriptAvg,
    tainted: l.tainted,
    seq: l.seq,
    anomalies: l.anomalies,
    attributions: l.attributions,
  };
  return plainCopy(state, `StrategyLayer(${symbol}) snapshot`);
}

export function decodeLayer(symbol: string, s: LayerState): LayerInternals {
  if (s.version !== LAYER_STATE_VERSION) throw new Error(`StrategyLayer state version ${String(s.version)} is not supported (expected ${LAYER_STATE_VERSION})`);
  if (s.symbol !== symbol) throw new Error(`StrategyLayer state is for ${s.symbol}, not ${symbol}`);
  const c = plainCopy(s, `StrategyLayer(${symbol}) state`);
  return {
    lots: c.lots.map((lot) => ({ ...lot, exitsFilled: new Set(lot.exitsFilled) })),
    records: c.records,
    meta: new Map(c.meta),
    exits: new Map(
      c.exits.map((r) => [
        r.key,
        { ...r, sent: new Map(r.sent), awaiting: new Set(r.awaiting), retries: new Map(r.retries), abandoned: new Set(r.abandoned) },
      ]),
    ),
    parked: new Map(c.parked),
    scriptAvg: c.scriptAvg,
    tainted: c.tainted,
    seq: c.seq,
    anomalies: c.anomalies,
    attributions: c.attributions,
  };
}
