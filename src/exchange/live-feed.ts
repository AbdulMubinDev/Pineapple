import { barOpenFor, tfToMs } from '../core/timeframe.js';
import type { Candle, Timeframe } from '../core/types.js';
import type { CandleRepo } from '../store/candles.js';
import type { ExchangeClient, MarkUpdate } from './client.js';

/** Binance allows 1024; 200 keeps each subscription URL short and a single dropped socket cheap. */
export const STREAMS_PER_CONNECTION = 200;
/** A close fires at the latest this long after its first closed kline arrived; still-missing symbols come from REST. */
export const CLOSE_WAIT_MS = 3_000;
/** No closed kline for a close by close + this: the feed is stale, the close is fetched over REST and sockets reconnect. */
export const STALE_GRACE_MS = 30_000;
/** A connection with no message at all for this long is dead (the !ticker@arr / kline streams send every second or so). */
export const SILENCE_MS = 60_000;
/** Binance drops a connection at 24 h; rotate before that. */
export const ROTATE_MS = 23 * 3_600_000;
/** A connection that has not opened by then is abandoned and retried. */
export const OPEN_TIMEOUT_MS = 10_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** After a failed backfill, wait this long before trying again. */
export const RETRY_MS = 5_000;
/** A REST catch-up only targets closes at least this old, so the exchange has published the bar. */
export const REST_SETTLE_MS = 3_000;
const TICK_MS = 5_000;
const REST_CONCURRENCY = 8;

export type CloseListener = (closeTime: number, bars: Map<string, Candle>) => void | Promise<unknown>;

export interface LiveFeedOptions {
  client: ExchangeClient;
  repo: CandleRepo;
  tf: Timeframe;
  symbols: string[];
  now: () => number;
  setTimer: typeof setTimeout;
  /**
   * The last close already handled (a bar boundary, UTC epoch ms). Closes after it are emitted, backfilled over REST
   * when the stream missed them. Default: the last boundary at or before `now()` at construction.
   */
  lastCloseTime?: number;
}

export interface LiveFeedStatus {
  connected: boolean;
  stale: boolean;
  lastMessageAt: number;
  catchingUp: boolean;
}

interface Conn {
  sub: { close(): void } | null;
  open: boolean;
  lastMsg: number;
}

interface PendingClose {
  bars: Map<string, Candle>;
  queued: boolean;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const num = (v: unknown): number => (typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN);

async function forEachLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  let failure: { e: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (i < items.length && failure === null) {
      const t = items[i++]!;
      try {
        await fn(t);
      } catch (e) {
        failure ??= { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw (failure as { e: unknown }).e;
}

/**
 * Live data for one chart timeframe: closed klines for its own symbols, plus last and mark prices for them.
 * One close event per bar boundary, in order, each exactly once (`lastEmitted` is the high-water mark).
 *
 * - Closed klines are buffered per close. The close fires when every symbol has arrived, or CLOSE_WAIT_MS after the
 *   first one; still-missing symbols are fetched over REST.
 * - Before a close fires, each symbol's bars are written to the repo in one transaction, together with any gap behind
 *   them (fetched over REST first), so a stream bar is never stored past a hole.
 * - Stale: no closed kline for a close by close + STALE_GRACE_MS, or a connection silent for SILENCE_MS. Missed closes
 *   are fetched over REST and fired in order; sockets reconnect with backoff. Stale clears once messages flow on the
 *   current connections and every due close has fired.
 * - Connections rotate every ROTATE_MS. A dropped connection reconnects with exponential backoff.
 */
export class LiveFeed {
  private symbols: Set<string>;
  private readonly step: number;
  private lastEmitted: number;
  private queuedTarget: number;
  private readonly pending = new Map<number, PendingClose>();
  private conns: Conn[] = [];
  private gen = 0;
  private running = false;
  private connected = false;
  private connectStartedAt = 0;
  private openedAt = 0;
  private msgSinceOpen = false;
  private lastMessageAt = 0;
  private stale = false;
  private inCatchUp = false;
  private failedAt: number | null = null;
  private attempts = 0;
  private reconnectPending = false;
  private lastStaleReconnectAt = -Infinity;
  private work: Promise<void> = Promise.resolve();
  private readonly closeListeners: CloseListener[] = [];
  private readonly priceListeners: ((symbol: string, last: number, time: number) => void)[] = [];
  private readonly markListeners: ((m: MarkUpdate) => void)[] = [];
  private readonly errorListeners: ((e: unknown) => void)[] = [];

  constructor(private readonly o: LiveFeedOptions) {
    this.step = tfToMs(o.tf);
    this.symbols = new Set(o.symbols);
    const last = o.lastCloseTime ?? barOpenFor(o.now(), o.tf);
    if (last % this.step !== 0) throw new Error(`lastCloseTime ${last} is not a ${o.tf} boundary`);
    this.lastEmitted = last;
    this.queuedTarget = last;
  }

  onClose(cb: CloseListener): () => void {
    return this.listen(this.closeListeners, cb);
  }

  onPrice(cb: (symbol: string, last: number, time: number) => void): () => void {
    return this.listen(this.priceListeners, cb);
  }

  onMark(cb: (m: MarkUpdate) => void): () => void {
    return this.listen(this.markListeners, cb);
  }

  /** Backfill failures and listener exceptions. The feed keeps going (and retries backfills). */
  onError(cb: (e: unknown) => void): () => void {
    return this.listen(this.errorListeners, cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect(); // also starts the watchdog tick for this generation
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.closeConns();
    this.gen++;
    this.connected = false;
    this.pending.clear();
  }

  /** Replace this feed's symbols and reconnect with the new stream list. Other timeframes' feeds are untouched. */
  setSymbols(symbols: string[]): void {
    const wasEmpty = this.symbols.size === 0;
    this.symbols = new Set(symbols);
    for (const p of this.pending.values()) for (const s of [...p.bars.keys()]) if (!this.symbols.has(s)) p.bars.delete(s);
    // An empty feed emits nothing, so it has no backlog to catch up when symbols arrive.
    if (wasEmpty) this.lastEmitted = this.queuedTarget = Math.max(this.lastEmitted, barOpenFor(this.o.now(), this.o.tf));
    if (this.running) this.connect();
  }

  status(): LiveFeedStatus {
    return {
      connected: this.connected,
      stale: this.stale,
      lastMessageAt: this.lastMessageAt,
      catchingUp: this.inCatchUp || this.failedAt !== null || this.overdue(),
    };
  }

  /** Resolves when queued close work has finished. */
  settled(): Promise<void> {
    return this.work;
  }

  // --- connections -------------------------------------------------------------------------------------------

  private streamList(): string[] {
    if (this.symbols.size === 0) return [];
    const klines = [...this.symbols].map((s) => `${s.toLowerCase()}@kline_${this.o.tf}`);
    return ['!ticker@arr', '!markPrice@arr@1s', ...klines];
  }

  private closeConns(): void {
    for (const c of this.conns) c.sub?.close();
    this.conns = [];
  }

  private connect(): void {
    this.closeConns();
    const gen = ++this.gen;
    this.armTick(gen);
    const now = this.o.now();
    this.connected = false;
    this.msgSinceOpen = false;
    this.reconnectPending = false;
    this.connectStartedAt = now;
    const streams = this.streamList();
    const chunks: string[][] = [];
    for (let i = 0; i < streams.length; i += STREAMS_PER_CONNECTION) chunks.push(streams.slice(i, i + STREAMS_PER_CONNECTION));
    this.conns = chunks.map(() => ({ sub: null, open: false, lastMsg: now }));
    for (const [i, chunk] of chunks.entries()) {
      try {
        const sub = this.o.client.stream(
          chunk,
          (m) => this.onMessage(gen, i, m),
          (s) => this.onState(gen, i, s),
        );
        if (gen !== this.gen) sub.close();
        else this.conns[i]!.sub = sub;
      } catch (e) {
        this.report(e);
        this.scheduleReconnect();
        return;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectPending || !this.running) return;
    this.reconnectPending = true;
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
    this.attempts++;
    const gen = this.gen;
    this.o.setTimer(() => {
      if (this.running && gen === this.gen) this.connect();
    }, delay);
  }

  private onState(gen: number, i: number, s: 'open' | 'closed'): void {
    const conn = this.conns[i];
    if (gen !== this.gen || !this.running || !conn) return;
    if (s === 'open') {
      conn.open = true;
      conn.lastMsg = this.o.now();
      if (this.conns.every((c) => c.open)) {
        this.connected = true;
        this.openedAt = this.o.now();
        this.requestCatchUp();
      }
    } else {
      conn.open = false;
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  // --- messages ----------------------------------------------------------------------------------------------

  private onMessage(gen: number, i: number, m: unknown): void {
    const conn = this.conns[i];
    if (gen !== this.gen || !this.running || !conn) return;
    const now = this.o.now();
    conn.lastMsg = now;
    this.lastMessageAt = now;
    this.msgSinceOpen = true;
    this.attempts = 0;
    if (isRec(m) && typeof m.stream === 'string') {
      if (m.stream === '!ticker@arr') this.onTickers(m.data);
      else if (m.stream === '!markPrice@arr@1s') this.onMarks(m.data);
      else if (m.stream.endsWith(`@kline_${this.o.tf}`)) this.onKlineEvent(m.data);
    }
    this.maybeClearStale();
  }

  private onTickers(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const t of data) {
      if (!isRec(t) || typeof t.s !== 'string' || !this.symbols.has(t.s)) continue;
      const last = num(t.c);
      const time = num(t.E);
      if (!Number.isFinite(last) || !Number.isFinite(time)) continue;
      for (const cb of this.priceListeners) this.guard(() => cb(t.s as string, last, time));
    }
  }

  private onMarks(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const r of data) {
      if (!isRec(r) || typeof r.s !== 'string' || !this.symbols.has(r.s)) continue;
      const m: MarkUpdate = { symbol: r.s, markPrice: num(r.p), fundingRate: num(r.r), nextFundingTime: num(r.T), time: num(r.E) };
      if (![m.markPrice, m.fundingRate, m.nextFundingTime, m.time].every(Number.isFinite)) continue;
      for (const cb of this.markListeners) this.guard(() => cb(m));
    }
  }

  private onKlineEvent(data: unknown): void {
    if (!isRec(data) || !isRec(data.k)) return;
    const k = data.k;
    if (k.x !== true || typeof k.s !== 'string' || !this.symbols.has(k.s)) return;
    const c: Candle = { openTime: num(k.t), open: num(k.o), high: num(k.h), low: num(k.l), close: num(k.c), volume: num(k.v) };
    if (!Object.values(c).every(Number.isFinite) || c.openTime % this.step !== 0) return;
    const closeTime = c.openTime + this.step;
    if (closeTime <= this.lastEmitted) return; // a repeat of a close already fired
    let p = this.pending.get(closeTime);
    if (!p) {
      p = { bars: new Map(), queued: false };
      this.pending.set(closeTime, p);
      this.o.setTimer(() => {
        if (this.running) this.enqueue(closeTime);
      }, CLOSE_WAIT_MS);
    }
    p.bars.set(k.s, c);
    if (!p.queued && p.bars.size >= this.symbols.size) {
      p.queued = true;
      this.enqueue(closeTime);
    }
  }

  // --- watchdog ----------------------------------------------------------------------------------------------

  private armTick(gen: number): void {
    // One tick loop per generation; older loops stop themselves.
    this.o.setTimer(() => {
      if (!this.running || gen !== this.gen) return;
      this.check();
      this.armTick(gen);
    }, TICK_MS);
  }

  private overdue(): boolean {
    return this.symbols.size > 0 && this.o.now() >= this.lastEmitted + this.step + STALE_GRACE_MS;
  }

  private check(): void {
    const now = this.o.now();
    if (this.failedAt !== null && now - this.failedAt >= RETRY_MS) {
      this.failedAt = null;
      this.requestCatchUp();
    }
    if (this.overdue()) {
      if (!this.pending.has(this.lastEmitted + this.step)) this.stale = true; // no closed kline arrived at all
      this.requestCatchUp();
      if (this.connected && now - this.lastStaleReconnectAt >= SILENCE_MS) {
        this.lastStaleReconnectAt = now;
        this.scheduleReconnect();
      }
    }
    if (this.connected && this.conns.some((c) => now - c.lastMsg >= SILENCE_MS)) {
      this.stale = true;
      this.scheduleReconnect();
    }
    if (!this.connected && this.conns.length > 0 && now - this.connectStartedAt >= OPEN_TIMEOUT_MS) this.scheduleReconnect();
    if (this.connected && now - this.openedAt >= ROTATE_MS) this.connect();
    this.maybeClearStale();
  }

  private maybeClearStale(): void {
    if (this.stale && this.connected && this.msgSinceOpen && !this.inCatchUp && this.failedAt === null && !this.overdue()) {
      this.stale = false;
    }
  }

  // --- closes ------------------------------------------------------------------------------------------------

  /** Fire every close that is due and the stream did not deliver. */
  private requestCatchUp(): void {
    if (this.symbols.size === 0 || this.failedAt !== null) return;
    this.enqueue(barOpenFor(this.o.now() - REST_SETTLE_MS, this.o.tf), true);
  }

  private enqueue(target: number, catchUp = false): void {
    if (target <= Math.max(this.lastEmitted, this.queuedTarget)) return;
    this.queuedTarget = target;
    this.work = this.work
      .then(() => this.emitThrough(target, catchUp))
      .catch((e: unknown) => {
        this.inCatchUp = false;
        this.failedAt = this.o.now();
        this.queuedTarget = this.lastEmitted;
        this.report(e);
      });
  }

  /** Write and fire every close in (lastEmitted, target], oldest first. Throws (writing nothing) if a backfill fails. */
  private async emitThrough(target: number, catchUp: boolean): Promise<void> {
    if (!this.running || target <= this.lastEmitted) return;
    const { tf, repo, client } = this.o;
    const step = this.step;
    const closes: number[] = [];
    for (let c = this.lastEmitted + step; c <= target; c += step) closes.push(c);
    const lo = closes[0]! - step;
    const hi = target - step;
    if (catchUp || closes.length > 1) this.inCatchUp = true;

    const symbols = [...this.symbols];
    const rows = new Map<string, Candle[]>();
    const firstWanted = new Map<string, number>();
    await forEachLimit(symbols, REST_CONCURRENCY, async (s) => {
      const latest = repo.latest(s, tf);
      // From the bar after the newest stored one, so the gap behind a stream bar is filled before (with) it.
      const from = latest === null ? lo : latest.openTime + step;
      firstWanted.set(s, from);
      if (from > hi) return;
      const merged = new Map<number, Candle>();
      let covered = true;
      for (let t = from; t <= hi; t += step) {
        const b = this.pending.get(t + step)?.bars.get(s);
        if (b) merged.set(t, b);
        else covered = false;
      }
      if (!covered) {
        this.inCatchUp = true;
        for (const c of await client.klines(s, tf, from, hi)) {
          if (c.openTime >= from && c.openTime <= hi && !merged.has(c.openTime)) merged.set(c.openTime, c);
        }
      }
      rows.set(
        s,
        [...merged.values()].sort((a, b) => a.openTime - b.openTime),
      );
    });
    if (!this.running) return;
    repo.upsertMany(tf, rows);

    for (const closeTime of closes) {
      if (!this.running) return;
      const open = closeTime - step;
      const bars = new Map<string, Candle>();
      for (const s of symbols) {
        let b = rows.get(s)?.find((c) => c.openTime === open);
        if (!b && open < firstWanted.get(s)!) b = repo.range(s, tf, open, open)[0];
        if (b) bars.set(s, b);
      }
      this.lastEmitted = closeTime;
      for (const k of [...this.pending.keys()]) if (k <= closeTime) this.pending.delete(k);
      for (const cb of [...this.closeListeners]) {
        try {
          await cb(closeTime, bars);
        } catch (e) {
          this.report(e);
        }
      }
    }
    if (this.queuedTarget < this.lastEmitted) this.queuedTarget = this.lastEmitted;
    this.inCatchUp = false;
    this.maybeClearStale();
  }

  // --- helpers -----------------------------------------------------------------------------------------------

  private listen<T>(list: T[], cb: T): () => void {
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.report(e);
    }
  }

  private report(e: unknown): void {
    for (const cb of this.errorListeners) {
      try {
        cb(e);
      } catch {
        // an error listener must not break the feed
      }
    }
  }
}
