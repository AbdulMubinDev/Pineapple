// In-memory ExchangeClient for tests. Serves recorded candles and funding through the same paging code and RestBudget
// as BinanceClient, supports scripted responses and records every call. Streams are scripted: tests push Binance-shaped
// `{ stream, data }` envelopes to the open connections that subscribe to them.
import { tfToMs } from '../core/timeframe.js';
import type { Candle, FundingEvent, Timeframe } from '../core/types.js';
import { fetchFundingHistory, fetchKlines, type PageDeps } from '../data/binance-rest.js';
import type { ExchangeClient, MarkUpdate, PairInfo, Ticker24h } from './client.js';
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

/** One fake stream connection, as opened by `stream()`. */
export interface FakeConnection {
  streams: string[];
  open: boolean;
  /** Closed by the caller or dropped by `dropStreams()`. */
  closed: boolean;
  onMsg: (m: unknown) => void;
  onState: (s: 'open' | 'closed') => void;
}

const tfBySymbolKey = (symbol: string, tf: Timeframe): string => `${symbol}|${tf}`;

export class FakeExchange implements ExchangeClient {
  readonly budget: RestBudget;
  readonly calls: FakeCall[] = [];
  /** Every stream connection ever opened, oldest first. */
  readonly connections: FakeConnection[] = [];
  /** When true (default), new connections report 'open' on the next microtask; when false they stay pending. */
  autoOpenStreams = true;
  private readonly candles = new Map<string, Candle[]>();
  private readonly funding = new Map<string, FundingEvent[]>();
  private readonly scripted: ScriptedResponse[] = [];
  private readonly klineScripts = new Map<string, (number | 'empty')[]>();
  private readonly klineFailures = new Map<string, number>();
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

  /** Queue per-symbol kline replies: a status code, or 'empty' for a 200 with no bars. Consumed before `script`. */
  scriptKlines(symbol: string, ...replies: (number | 'empty')[]): void {
    this.klineScripts.set(symbol, [...(this.klineScripts.get(symbol) ?? []), ...replies]);
  }

  /** Every kline request for `symbol` returns `status` until called again with null. */
  failKlines(symbol: string, status: number | null): void {
    if (status === null) this.klineFailures.delete(symbol);
    else this.klineFailures.set(symbol, status);
  }

  private getJson(url: string, weight: number): Promise<unknown> {
    return budgetedGet(this.budget, weight, () => {
      const u = new URL(url);
      const sym = u.pathname === '/fapi/v1/klines' ? (u.searchParams.get('symbol') ?? '') : '';
      const perSymbol = this.klineFailures.get(sym) ?? this.klineScripts.get(sym)?.shift();
      const s = perSymbol === undefined ? this.scripted.shift() : undefined;
      const headers = new Headers();
      let status = 200;
      let body: unknown = null;
      if (perSymbol === 'empty') {
        body = [];
      } else if (perSymbol !== undefined) {
        status = perSymbol;
        body = { msg: 'scripted' };
      } else if (s) {
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

  stream(streams: string[], onMsg: (m: unknown) => void, onState: (s: 'open' | 'closed') => void): { close(): void } {
    const conn: FakeConnection = { streams: [...streams], open: false, closed: false, onMsg, onState };
    this.connections.push(conn);
    if (this.autoOpenStreams) {
      queueMicrotask(() => {
        if (conn.closed) return;
        conn.open = true;
        onState('open');
      });
    }
    // Like BinanceClient: a close the caller asked for is silent.
    return { close: () => void (conn.closed = true) };
  }

  /** Deliver `{ stream, data }` to every open connection subscribed to `stream`. */
  pushRaw(stream: string, data: unknown): void {
    for (const c of this.connections) if (c.open && !c.closed && c.streams.includes(stream)) c.onMsg({ stream, data });
  }

  /** A kline event (`closed` = the k.x flag), stamped with the injected clock. */
  pushKline(symbol: string, tf: Timeframe, c: Candle, closed = true): void {
    const k = {
      t: c.openTime,
      T: c.openTime + tfToMs(tf) - 1,
      s: symbol,
      i: tf,
      o: String(c.open),
      h: String(c.high),
      l: String(c.low),
      c: String(c.close),
      v: String(c.volume),
      x: closed,
    };
    this.pushRaw(`${symbol.toLowerCase()}@kline_${tf}`, { e: 'kline', E: this.o.now(), s: symbol, k });
  }

  pushTickers(rows: { symbol: string; last: number }[]): void {
    const E = this.o.now();
    this.pushRaw('!ticker@arr', rows.map((r) => ({ e: '24hrTicker', E, s: r.symbol, c: String(r.last) })));
  }

  pushMarks(rows: MarkUpdate[]): void {
    this.pushRaw(
      '!markPrice@arr@1s',
      rows.map((m) => ({ e: 'markPriceUpdate', E: m.time, s: m.symbol, p: String(m.markPrice), r: String(m.fundingRate), T: m.nextFundingTime })),
    );
  }

  /** Open connections created while `autoOpenStreams` was false. */
  openPending(): void {
    for (const c of this.connections) {
      if (c.closed || c.open) continue;
      c.open = true;
      c.onState('open');
    }
  }

  /** The server drops one live connection (index among the not-yet-closed ones). */
  dropConnection(liveIndex: number): void {
    const c = this.connections.filter((x) => !x.closed)[liveIndex];
    if (!c) throw new Error(`no live connection ${liveIndex}`);
    c.closed = true;
    c.open = false;
    c.onState('closed');
  }

  /** The server drops every open or pending connection: each reports 'closed'. */
  dropStreams(): void {
    for (const c of this.connections) {
      if (c.closed) continue;
      c.closed = true;
      c.open = false;
      c.onState('closed');
    }
  }
}
