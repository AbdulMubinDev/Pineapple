/** All times are UTC epoch milliseconds. Candles are keyed by openTime. */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FundingEvent {
  time: number;
  rate: number;
  markPrice: number;
}

export type Timeframe = '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '8h' | '12h' | '1d';

/* ---------- Paper broker types ---------- */

export interface MaintBracket {
  notionalCap: number;
  maintMarginRate: number;
  maintAmount: number;
}

export interface PairRules {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minNotional: number;
  maxLeverage: number;
  leverageEstimated: boolean;
  brackets: MaintBracket[];
}

export interface FeeConfig {
  makerRate: number;
  takerRate: number;
  slippagePct: number;
}

export type BrokerMode = 'tradingview' | 'binance';

/** `notionalUsd` is position size, not margin. */
export type SizingRule = { kind: 'script' } | { kind: 'fixed'; notionalUsd: number };

export interface OrderIntent {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  reduceOnly: boolean;
  ocaGroup?: string;
  ocaType?: 'cancel' | 'reduce';
  tag: 'entry' | 'exit';
  entryId?: string;
  leverage: number;
}

export type SubmitResult =
  | { accepted: true }
  | { accepted: false; reason: 'no_free_balance' | 'below_min_notional' | 'zero_qty_after_rounding' };

export interface Fill {
  orderId: string;
  symbol: string;
  time: number;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
  fee: number;
  liquidity: 'maker' | 'taker';
}

export interface Position {
  symbol: string;
  /** Signed: positive long, negative short. */
  qty: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  openTime: number;
}

export interface ClosedTrade {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  fees: number;
  funding: number;
  exitReason: 'signal' | 'stop' | 'target' | 'liquidation' | 'delisting';
}

export interface AccountView {
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  feesPaid: number;
  fundingNet: number;
}

/** An order resting in the broker: the intent plus bookkeeping. */
export interface StoredOrder extends OrderIntent {
  seq: number;
  submittedAt: number;
  /** stop_limit only: the stop has triggered and it now rests as a limit. */
  triggered?: boolean;
}

/** Fees and funding accrued on the currently open position, split into closed trades pro rata. */
export interface PositionMeta {
  fees: number;
  funding: number;
}

/** Plain JSON. JSON.parse(JSON.stringify(s)) restores it identically. */
export interface BrokerState {
  balance: number;
  feesPaid: number;
  fundingNet: number;
  nextSeq: number;
  positions: Record<string, Position>;
  meta: Record<string, PositionMeta>;
  lastPrice: Record<string, number>;
  orders: StoredOrder[];
  closed: ClosedTrade[];
}
