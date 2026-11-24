// In-memory ExchangeClient for tests (REST half). Serves recorded candles and funding through the same
// paging code and RestBudget as BinanceClient, supports scripted responses and records every call.
import { tfToMs } from '../core/timeframe.js';
import type { Candle, FundingEvent, Timeframe } from '../core/types.js';
import { fetchFundingHistory, fetchKlines, type PageDeps } from '../data/binance-rest.js';
import type { ExchangeClient, PairInfo, Ticker24h } from './client.js';
import { budgetedGet, REST_LIMIT_PER_MIN, RestBudget } from './budget.js';

/** One scripted reply, consumed by the next REST request (any endpoint) before real data is served. */
export interface ScriptedResponse {
  status: number;
  /** Seconds, sent as the Retry-After header. */
  retryAfter?: number;
  /** Sent as X-MBX-USED-WEIGHT-1M. */
  usedWeight?: number;
}

export interface FakeCall {
  /** From the injected clock, when the request left the budget. */
  time: number;
  weight: number;
  url: string;
  status: number;
}

export interface FakeExchangeOptions {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  limitPerMin?: number;
  pairs?: PairInfo[];
  tickers?: Ticker24h[];
  fundingIntervals?: Map<string, number>;
}

const tfBySymbolKey = (symbol: string, tf: Timeframe): string => `${symbol}|${tf}`;

export class FakeExchange implements ExchangeClient {
  readonly budget: RestBudget;
  readonly calls: FakeCall[] = [];
  private readonly candles = new Map<string, Candle[]>();
  private readonly funding = new Map<string, FundingEvent[]>();
  private readonly scripted: ScriptedResponse[] = [];
  private readonly deps: PageDeps;

  constructor(private readonly o: FakeExchangeOptions) {
    this.budget = new RestBudget({ limitPerMin: o.limitPerMin ?? REST_LIMIT_PER_MIN, now: o.now, sleep: o.sleep });
    this.deps = { getJson: (url, weight) => this.getJson(url, weight), now: o.now };
  }

  /** Total weight charged so far; each retried attempt is charged again (deliberately conservative). */
  get weightCharged(): number {
    return this.calls.reduce((s, c) => s + c.weight, 0);
  }

  setCandles(symbol: string, tf: Timeframe, candles: Candle[]): void {
    this.candles.set(tfBySymbolKey(symbol, tf), [...candles].sort((a, b) => a.openTime - b.openTime));
  }

  setFunding(symbol: string, events: FundingEvent[]): void {
    this.funding.set(symbol, [...events].sort((a, b) => a.time - b.time));
  }

  /** Queue replies for the next requests, e.g. `script({ status: 429, retryAfter: 5 })`. */
  script(...responses: ScriptedResponse[]): void {
    this.scripted.push(...responses);
  }

  private getJson(url: string, weight: number): Promise<unknown> {
    return budgetedGet(this.budget, weight, () => {
      const s = this.scripted.shift();
      const headers = new Headers();
      let status = 200;
      let body: unknown = null;
      if (s) {
        status = s.status;
        if (s.retryAfter !== undefined) headers.set('retry-after', String(s.retryAfter));
        if (s.usedWeight !== undefined) headers.set('x-mbx-used-weight-1m', String(s.usedWeight));
        body = { msg: 'scripted' };
      } else {
        body = this.serve(new URL(url));
      }
      this.calls.push({ time: this.o.now(), weight, url, status });
      return Promise.resolve({ status, headers, body });
    });
  }

  private serve(u: URL): unknown {
    const q = u.searchParams;
    const symbol = q.get('symbol') ?? '';
    const from = Number(q.get('startTime'));
    const to = Number(q.get('endTime'));
    const limit = Number(q.get('limit'));
    if (u.pathname === '/fapi/v1/klines') {
      const tf = q.get('interval') as Timeframe;
      const step = tfToMs(tf);
      return (this.candles.get(tfBySymbolKey(symbol, tf)) ?? [])
        .filter((c) => c.openTime >= from && c.openTime <= to)
        .slice(0, limit)
        .map((c) => [c.openTime, String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), c.openTime + step - 1]);
    }
    if (u.pathname === '/fapi/v1/fundingRate') {
      return (this.funding.get(symbol) ?? [])
        .filter((f) => f.time >= from && f.time <= to)
        .slice(0, limit)
        .map((f) => ({ symbol, fundingTime: f.time, fundingRate: String(f.rate), markPrice: String(f.markPrice) }));
    }
    throw new Error(`FakeExchange: unexpected path ${u.pathname}`);
  }

  pairs(): Promise<PairInfo[]> {
    return Promise.resolve(this.o.pairs ?? []);
  }

  tickers24h(): Promise<Ticker24h[]> {
    return Promise.resolve(this.o.tickers ?? []);
  }

  klines(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]> {
    return fetchKlines(symbol, tf, fromMs, toMs, this.deps);
  }

  fundingHistory(symbol: string, fromMs: number, toMs: number): Promise<FundingEvent[]> {
    return fetchFundingHistory(symbol, fromMs, toMs, this.deps);
  }

  fundingIntervalHours(): Promise<Map<string, number>> {
    return Promise.resolve(this.o.fundingIntervals ?? new Map());
  }

  stream(): { close(): void } {
    throw new Error('not implemented');
  }
}
