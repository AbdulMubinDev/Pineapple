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
  /** Slippage in ticks of the pair's tick size (TradingView's Properties). When set, it replaces slippagePct. */
  slippageTicks?: number;
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
  /** Gross realised P&L, before fees and funding. Fees and funding are in their own fields. */
  pnl: number;
  fees: number;
  funding: number;
  exitReason: 'signal' | 'stop' | 'target' | 'liquidation' | 'delisting';
  /** The order that closed it (`liquidation:<symbol>:<time>` for a liquidation). Absent in older states. */
  exitOrderId?: string;
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
  /** The taker rate in force at submit: its margin reservation keeps it after a fee edit. Absent in older states. */
  reserveRate?: number;
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
  rejections: Rejection[];
  /** Per symbol: the running pnl - fees + funding of its closed trades. Absent in older states (rebuilt from `closed`). */
  realisedNet?: Record<string, number>;
  /** The fees and sizing in force (owner edits after approval). Absent in older states (the options' are used). */
  fees?: FeeConfig;
  sizing?: SizingRule;
}

/** An accepted order that was dropped at fill time because it no longer fit the free margin. */
export interface Rejection {
  orderId: string;
  symbol: string;
  time: number;
  reason: 'no_free_balance';
}
