// One all-market price stream shared by every run and timeframe (review M-6): `!ticker@arr` (last price, 24h quote
// volume) and `!markPrice@arr@1s` (mark price, funding). The timeframe LiveFeeds run with `prices: false`.
import type { ExchangeClient, MarkUpdate } from '../exchange/client.js';
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS, ROTATE_MS, SILENCE_MS } from '../exchange/live-feed.js';

export const PRICE_STREAMS = ['!ticker@arr', '!markPrice@arr@1s'] as const;
const TICK_MS = 5_000;
const OPEN_TIMEOUT_MS = 10_000;

export interface PriceFeedOptions {
  client: ExchangeClient;
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface PriceFeedStatus {
  connected: boolean;
  lastMessageAt: number;
  reconnects: number;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const num = (v: unknown): number => (typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN);

export class PriceFeed {
  private sub: { close(): void } | null = null;
  private epoch = 0;
  private open = false;
  private running = false;
  private openedAt = 0;
  private startedAt = 0;
  private lastMessageAt = 0;
  private attempts = 0;
  private retryPending = false;
  private reconnects = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly priceCbs: ((symbol: string, last: number, time: number) => void)[] = [];
  private readonly markCbs: ((m: MarkUpdate) => void)[] = [];
  private readonly volumeCbs: ((symbol: string, quoteVolume: number) => void)[] = [];
  private readonly errorCbs: ((e: unknown) => void)[] = [];

  constructor(private readonly o: PriceFeedOptions) {}

  onPrice(cb: (symbol: string, last: number, time: number) => void): void {
    this.priceCbs.push(cb);
  }

  onMark(cb: (m: MarkUpdate) => void): void {
    this.markCbs.push(cb);
  }

  /** 24h quote volume per symbol, as the ticker stream updates it. */
  onVolume(cb: (symbol: string, quoteVolume: number) => void): void {
    this.volumeCbs.push(cb);
  }

  /** Listener exceptions and stream open failures. The feed keeps going. */
  onError(cb: (e: unknown) => void): void {
    this.errorCbs.push(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.epoch++;
    this.sub?.close();
    this.sub = null;
    this.open = false;
    const clear = this.o.clearTimer ?? clearTimeout;
    for (const t of this.timers) clear(t);
    this.timers.clear();
  }

  status(): PriceFeedStatus {
    return { connected: this.open, lastMessageAt: this.lastMessageAt, reconnects: this.reconnects };
  }

  private timer(fn: () => void, ms: number): void {
    const h = this.o.setTimer(() => {
      this.timers.delete(h);
      if (this.running) fn();
    }, ms);
    this.timers.add(h);
  }

  private tick(): void {
    this.timer(() => {
      const now = this.o.now();
      if (this.open && now - Math.max(this.lastMessageAt, this.openedAt) >= SILENCE_MS) this.reconnect();
      else if (!this.open && !this.retryPending && now - this.startedAt >= OPEN_TIMEOUT_MS) this.reconnect();
      else if (this.open && now - this.openedAt >= ROTATE_MS) this.connect();
      this.tick();
    }, TICK_MS);
  }

  private connect(): void {
    this.sub?.close();
    const epoch = ++this.epoch;
    this.open = false;
    this.retryPending = false;
    this.startedAt = this.o.now();
    try {
      const sub = this.o.client.stream(
        [...PRICE_STREAMS],
        (m) => {
          if (epoch === this.epoch) this.onMessage(m);
        },
        (s) => {
          if (epoch !== this.epoch) return;
          if (s === 'open') {
            this.open = true;
            this.openedAt = this.o.now();
          } else this.reconnect();
        },
      );
      if (epoch === this.epoch) this.sub = sub;
      else sub.close();
    } catch (e) {
      this.report(e);
      this.reconnect();
    }
  }

  /** Reopen after a backoff (1 s doubling to 60 s; reset by any message). */
  private reconnect(): void {
    if (this.retryPending || !this.running) return;
    this.retryPending = true;
    this.epoch++;
    this.sub?.close();
    this.sub = null;
    this.open = false;
    this.reconnects++;
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** this.attempts++, RECONNECT_MAX_MS);
    this.timer(() => this.connect(), delay);
  }

  private onMessage(m: unknown): void {
    this.lastMessageAt = this.o.now();
    this.attempts = 0;
    if (!isRec(m) || !Array.isArray(m.data)) return;
    if (m.stream === '!ticker@arr') {
      for (const t of m.data) {
        if (!isRec(t) || typeof t.s !== 'string') continue;
        const symbol = t.s;
        const last = num(t.c);
        const time = num(t.E);
        const q = num(t.q);
        if (Number.isFinite(q)) for (const cb of this.volumeCbs) this.guard(() => cb(symbol, q));
        if (Number.isFinite(last) && Number.isFinite(time)) for (const cb of this.priceCbs) this.guard(() => cb(symbol, last, time));
      }
    } else if (m.stream === '!markPrice@arr@1s') {
      for (const r of m.data) {
        if (!isRec(r) || typeof r.s !== 'string') continue;
        const u: MarkUpdate = { symbol: r.s, markPrice: num(r.p), fundingRate: num(r.r), nextFundingTime: num(r.T), time: num(r.E) };
        if (![u.markPrice, u.fundingRate, u.nextFundingTime, u.time].every(Number.isFinite)) continue;
        for (const cb of this.markCbs) this.guard(() => cb(u));
      }
    }
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.report(e);
    }
  }

  private report(e: unknown): void {
    for (const cb of this.errorCbs) {
      try {
        cb(e);
      } catch {
        // an error listener must not break the feed
      }
    }
  }
}
