import type { Candle, FundingEvent, PairRules, Timeframe } from '../core/types.js';

export interface PairInfo {
  symbol: string;
  rules: PairRules & { bracketsEstimated: boolean };
  /** UTC epoch ms from exchangeInfo.onboardDate. */
  onboardDate: number;
}

export interface Ticker24h {
  symbol: string;
  quoteVolume: number;
  lastPrice: number;
}

export interface MarkUpdate {
  symbol: string;
  markPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  time: number;
}

export interface ExchangeClient {
  pairs(): Promise<PairInfo[]>;
  tickers24h(): Promise<Ticker24h[]>;
  /** Closed candles with openTime in [fromMs, toMs], oldest first. */
  klines(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]>;
  fundingHistory(symbol: string, fromMs: number, toMs: number): Promise<FundingEvent[]>;
  /** Funding interval in hours per symbol (from /fapi/v1/fundingInfo); symbols missing there use 8. */
  fundingIntervalHours(): Promise<Map<string, number>>;
  stream(
    streams: string[],
    onMsg: (m: unknown) => void,
    onState: (s: 'open' | 'closed') => void,
  ): { close(): void };
}
