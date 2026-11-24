import type { Candle, FundingEvent, Timeframe } from '../core/types.js';
import { fetchFundingHistory, fetchKlines, type PageDeps } from '../data/binance-rest.js';
import { httpGet } from '../net/http.js';
import {
  budgetedGet,
  EXCHANGE_INFO_WEIGHT,
  FUNDING_INFO_WEIGHT,
  REST_LIMIT_PER_MIN,
  RestBudget,
  TICKER_24H_WEIGHT,
  type RestResponse,
} from './budget.js';
import type { ExchangeClient, PairInfo, Ticker24h } from './client.js';
import { buildUniverse } from './universe.js';

const BASE = 'https://fapi.binance.com';
export const DEFAULT_FUNDING_HOURS = 8;

/** Funding interval for a symbol; symbols absent from /fapi/v1/fundingInfo use 8 hours. */
export function fundingHoursFor(map: Map<string, number>, symbol: string): number {
  return map.get(symbol) ?? DEFAULT_FUNDING_HOURS;
}

const finite = (v: unknown): v is string | number =>
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) || (typeof v === 'number' && Number.isFinite(v));

/** Parse /fapi/v1/ticker/24hr. Entries without a symbol or finite quoteVolume/lastPrice are skipped and counted. */
export function parseTickers(raw: unknown): { tickers: Ticker24h[]; skipped: number } {
  if (!Array.isArray(raw)) throw new Error('ticker/24hr: expected an array response');
  const tickers: Ticker24h[] = [];
  let skipped = 0;
  for (const t of raw as Record<string, unknown>[]) {
    if (t && typeof t.symbol === 'string' && finite(t.quoteVolume) && finite(t.lastPrice)) {
      tickers.push({ symbol: t.symbol, quoteVolume: Number(t.quoteVolume), lastPrice: Number(t.lastPrice) });
    } else {
      skipped++;
    }
  }
  return { tickers, skipped };
}

/** Parse /fapi/v1/fundingInfo. Entries without a symbol and a positive finite fundingIntervalHours are skipped and counted. */
export function parseFundingInfo(raw: unknown): { intervals: Map<string, number>; skipped: number } {
  if (!Array.isArray(raw)) throw new Error('fundingInfo: expected an array response');
  const intervals = new Map<string, number>();
  let skipped = 0;
  for (const r of raw as Record<string, unknown>[]) {
    const h = r?.fundingIntervalHours;
    if (r && typeof r.symbol === 'string' && typeof h === 'number' && Number.isFinite(h) && h > 0) {
      intervals.set(r.symbol, h);
    } else {
      skipped++;
    }
  }
  return { intervals, skipped };
}

export interface BinanceClientOptions {
  budget?: RestBudget;
  /** Injectable for tests; defaults to the allowlisted httpGet. */
  get?: (url: string, opts: { timeoutMs?: number }) => Promise<RestResponse>;
  now?: () => number;
}

/** Binance USDT-M futures client, public endpoints only. Every REST call is charged to the RestBudget. Streams arrive in Task 3. */
export class BinanceClient implements ExchangeClient {
  /** Malformed entries dropped from the last response of each endpoint. */
  skipped = { tickers: 0, fundingInfo: 0 };
  readonly budget: RestBudget;
  private readonly get: NonNullable<BinanceClientOptions['get']>;
  private readonly deps: PageDeps;

  constructor(o: BinanceClientOptions = {}) {
    const now = o.now ?? Date.now;
    this.budget =
      o.budget ??
      new RestBudget({ limitPerMin: REST_LIMIT_PER_MIN, now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    this.get = o.get ?? httpGet;
    this.deps = { getJson: (url, weight) => this.getJson(url, weight), now };
  }

  private getJson(url: string, weight: number, timeoutMs?: number): Promise<unknown> {
    return budgetedGet(this.budget, weight, () => this.get(url, timeoutMs === undefined ? {} : { timeoutMs }));
  }

  async pairs(): Promise<PairInfo[]> {
    const info = await this.getJson(`${BASE}/fapi/v1/exchangeInfo`, EXCHANGE_INFO_WEIGHT, 30_000);
    return buildUniverse(info).pairs;
  }

  async tickers24h(): Promise<Ticker24h[]> {
    const { tickers, skipped } = parseTickers(await this.getJson(`${BASE}/fapi/v1/ticker/24hr`, TICKER_24H_WEIGHT, 30_000));
    this.skipped.tickers = skipped;
    return tickers;
  }

  klines(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]> {
    return fetchKlines(symbol, tf, fromMs, toMs, this.deps);
  }

  fundingHistory(symbol: string, fromMs: number, toMs: number): Promise<FundingEvent[]> {
    return fetchFundingHistory(symbol, fromMs, toMs, this.deps);
  }

  async fundingIntervalHours(): Promise<Map<string, number>> {
    const { intervals, skipped } = parseFundingInfo(await this.getJson(`${BASE}/fapi/v1/fundingInfo`, FUNDING_INFO_WEIGHT));
    this.skipped.fundingInfo = skipped;
    return intervals;
  }

  stream(): { close(): void } {
    throw new Error('not implemented');
  }
}
