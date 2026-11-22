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
