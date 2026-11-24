import { barOpenFor, tfToMs } from '../core/timeframe.js';
import type { Candle, Timeframe } from '../core/types.js';
import type { CandleRepo } from '../store/candles.js';
import { HttpStatusError } from './budget.js';
import type { ExchangeClient, MarkUpdate } from './client.js';

/** Binance allows 1024; 200 keeps each subscription URL short and a single dropped socket cheap. */
export const STREAMS_PER_CONNECTION = 200;
/** A close fires at the latest this long after its first closed kline arrived; still-missing symbols come from REST. */
export const CLOSE_WAIT_MS = 3_000;
/** No closed kline for a close by close + this: the feed is stale, the close is fetched over REST and sockets reconnect. */
export const STALE_GRACE_MS = 30_000;
/** A connection with no message, or the whole feed with no kline event, for this long is dead (both stream ~every second). */
export const SILENCE_MS = 60_000;
/** Binance drops a connection at 24 h; rotate (make-before-break) before that. */
export const ROTATE_MS = 23 * 3_600_000;
/** A connection that has not opened by then is abandoned and retried. */
export const OPEN_TIMEOUT_MS = 10_000;
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** After a failed (transient) backfill, wait this long before trying again. */
export const RETRY_MS = 5_000;
/** A REST catch-up only targets closes at least this old, so the exchange has published the bar. */
export const REST_SETTLE_MS = 3_000;
/**
 * REST returned no bar for a symbol: retry after these delays. 3 s wait + 6 s of retries keeps the close inside the
 * 10 s pass deadline.
 */
export const MISSING_RETRY_MS: readonly number[] = [1_000, 2_000, 3_000];
/**
 * Retry rounds stop by this long after the first kline of the batch's oldest close (or after the batch started), so a
 * close is never held past the 10 s pass deadline however many symbols are missing.
 */
export const RETRY_DEADLINE_MS = 9_500;
/** The same non-HTTP failure for one symbol on this many batches in a row marks it missing instead of failing the batch. */
export const ERROR_STREAK_LIMIT = 3;
/**
 * A gap behind the batch of at most this many bars is fetched and written with it (one small request). A repo further
 * behind is loadHistory's to repair: the feed still emits the bars but does not store them past the hole.
 */
export const GAP_FILL_BARS = 99;
const TICK_MS = 5_000;
const REST_CONCURRENCY = 8;

export interface CloseInfo {
  /** Symbols with no bar for this close (REST had none, or rejected the request). */
  missing: string[];
  /** Symbols whose stored history is too far behind to extend: their bars are emitted but not stored; run loadHistory. */
  behind: string[];
}

export type CloseListener = (closeTime: number, bars: Map<string, Candle>, info: CloseInfo) => void | Promise<unknown>;

export interface LiveFeedOptions {
  client: ExchangeClient;
  repo: CandleRepo;
  tf: Timeframe;
  symbols: string[];
  now: () => number;
  setTimer: typeof setTimeout;
  /** Used by stop() to cancel pending timers. Default: the global clearTimeout. */
  clearTimer?: typeof clearTimeout;
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
  /** Symbols with no bar in the last emitted close (REST had none, or rejected the request). */
  missing: string[];
  /** Symbols whose stored history was too far behind to extend at the last close (see CloseInfo.behind). */
  behind: string[];
}

/** A close fired without some symbols' bars. */
export class MissingBarsError extends Error {
  constructor(
    public readonly closeTime: number,
    public readonly symbols: string[],
  ) {
    super(`close ${new Date(closeTime).toISOString()}: no bar for ${symbols.join(', ')}`);
    this.name = 'MissingBarsError';
  }
}

/** A symbol's stored history ends too far back to join the live bars; loadHistory must repair it. */
export class RepoBehindError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly latestOpenTime: number,
  ) {
    super(`${symbol}: stored history ends at ${new Date(latestOpenTime).toISOString()}, too far behind to extend`);
    this.name = 'RepoBehindError';
  }
}

interface Conn {
  chunk: string[];
  sub: { close(): void } | null;
  open: boolean;
  /** Bumped on every (re)open, so callbacks from an older socket are ignored. */
  epoch: number;
  startedAt: number;
  lastMsg: number;
  attempts: number;
  retryPending: boolean;
}

interface Gen {
  id: number;
  conns: Conn[];
  /** When every connection of this generation was first open at once (0 until then). */
  allOpenAt: number;
}

interface PendingClose {
  bars: Map<string, Candle>;
  queued: boolean;
  /** When the first closed kline of this close arrived. */
  firstAt: number;
}

interface SymbolPlan {
  symbol: string;
  from: number;
  storable: boolean;
  bars: Map<number, Candle>;
  /** REST rejected this symbol for this batch: no retries. */
  permanent: boolean;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const num = (v: unknown): number => (typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN);
/** A 4xx other than 429/418: this request is wrong for this symbol, retrying will not help. */
const isPermanent = (e: unknown): boolean => e instanceof HttpStatusError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 418;

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
 *   first one; still-missing symbols are fetched over REST, retried (MISSING_RETRY_MS) when REST has no bar yet, and
 *   reported in `missing` if they never appear. A 4xx for one symbol marks it missing; transient errors (5xx, network,
 *   429/418) fail the batch, which writes nothing and is retried.
 * - Before a close fires, each symbol's bars are written with any small gap behind them (GAP_FILL_BARS), all symbols
 *   in one transaction. Nothing is ever stored past a hole.
 * - Stale: no closed kline for a close by close + STALE_GRACE_MS, a connection silent for SILENCE_MS, or no kline event
 *   at all for SILENCE_MS. Missed closes are fetched over REST and fired in order; sockets reconnect. Stale clears only
 *   on a kline event from the current connections, once every due close has fired.
 * - A dropped connection reopens on its own, with its own backoff. Rotation (ROTATE_MS) and setSymbols are
 *   make-before-break. After any open, a catch-up is scheduled for the next boundary + REST_SETTLE_MS.
 */
export class LiveFeed {
  private symbols: Set<string>;
  private readonly step: number;
  private lastEmitted: number;
  private queuedTarget: number;
  private readonly pending = new Map<number, PendingClose>();
  private cur: Gen | null = null;
  private old: Gen | null = null;
  private genSeq = 0;
  /** Bumped by start() and stop(); timers from another life do nothing. */
  private life = 0;
  private running = false;
  private lastMessageAt = 0;
  private lastKlineAt = 0;
  private lastCurKlineAt = 0;
  private stale = false;
  private staleSince = 0;
  private inCatchUp = false;
  private failedAt: number | null = null;
  private lastMissing: string[] = [];
  private lastBehind: string[] = [];
  private readonly errorStreak = new Map<string, number>();
  private readonly reportedBehind = new Set<string>();
  private lastStaleReconnectAt = -Infinity;
  private work: Promise<void> = Promise.resolve();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sleepers = new Set<() => void>();
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

  /** Backfill failures, MissingBarsError, RepoBehindError and listener exceptions. The feed keeps going. */
  onError(cb: (e: unknown) => void): () => void {
    return this.listen(this.errorListeners, cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const life = ++this.life;
    this.lastKlineAt = this.o.now();
    this.connect(false);
    this.armTick(life);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.life++;
    this.closeGen(this.old);
    this.closeGen(this.cur);
    this.old = this.cur = null;
    this.pending.clear();
    this.queuedTarget = this.lastEmitted;
    this.inCatchUp = false;
    const clear = this.o.clearTimer ?? clearTimeout;
    for (const t of this.timers) clear(t);
    this.timers.clear();
    for (const wake of [...this.sleepers]) wake();
  }

  /** Replace this feed's symbols; new connections open before the old ones close. Other timeframes' feeds are untouched. */
  setSymbols(symbols: string[]): void {
    const wasEmpty = this.symbols.size === 0;
    this.symbols = new Set(symbols);
    for (const p of this.pending.values()) for (const s of [...p.bars.keys()]) if (!this.symbols.has(s)) p.bars.delete(s);
    // An empty feed emits nothing, so it has no backlog to catch up when symbols arrive.
    if (wasEmpty) this.lastEmitted = this.queuedTarget = Math.max(this.lastEmitted, barOpenFor(this.o.now(), this.o.tf));
    if (this.running) this.connect(true);
  }

  status(): LiveFeedStatus {
    return {
      connected: this.isConnected(),
      stale: this.stale,
      lastMessageAt: this.lastMessageAt,
      catchingUp: this.inCatchUp || this.failedAt !== null || this.overdue(),
      missing: [...this.lastMissing],
      behind: [...this.lastBehind],
    };
  }

  /** Resolves when queued close work has finished. */
  settled(): Promise<void> {
    return this.work;
  }

  // --- timers ------------------------------------------------------------------------------------------------

  /** setTimer bound to this life: the callback does nothing once the feed has stopped (or restarted). */
  private timer(fn: () => void, ms: number): void {
    const life = this.life;
    const handle = this.o.setTimer(() => {
      this.timers.delete(handle);
      if (this.running && life === this.life) fn();
    }, Math.max(0, ms));
    this.timers.add(handle);
  }

  /** Resolves after `ms`, or at once when the feed stops (callers check `running`), so close work never hangs. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        this.sleepers.delete(wake);
        resolve();
      };
      this.sleepers.add(wake);
      const handle = this.o.setTimer(() => {
        this.timers.delete(handle);
        wake();
      }, ms);
      this.timers.add(handle);
    });
  }

  private armTick(life: number): void {
    this.timer(() => {
      if (life !== this.life) return;
      this.check();
      this.armTick(life);
    }, TICK_MS);
  }

  // --- connections -------------------------------------------------------------------------------------------

  private streamList(): string[] {
    if (this.symbols.size === 0) return [];
    const klines = [...this.symbols].map((s) => `${s.toLowerCase()}@kline_${this.o.tf}`);
    return ['!ticker@arr', '!markPrice@arr@1s', ...klines];
  }

  private isConnected(): boolean {
    const all = (g: Gen | null) => g !== null && g.conns.length > 0 && g.conns.every((c) => c.open);
    return all(this.cur) || all(this.old);
  }

  private closeGen(g: Gen | null): void {
    if (!g) return;
    for (const c of g.conns) {
      c.epoch++;
      c.sub?.close();
      c.sub = null;
      c.open = false;
    }
  }

  /** Open a new generation of connections. makeBeforeBreak keeps the current one until the new one is fully open. */
  private connect(makeBeforeBreak: boolean): void {
    this.closeGen(this.old);
    this.old = null;
    if (makeBeforeBreak && this.cur && this.cur.conns.some((c) => c.open)) this.old = this.cur;
    else this.closeGen(this.cur);
    const now = this.o.now();
    const streams = this.streamList();
    const conns: Conn[] = [];
    for (let i = 0; i < streams.length; i += STREAMS_PER_CONNECTION) {
      conns.push({ chunk: streams.slice(i, i + STREAMS_PER_CONNECTION), sub: null, open: false, epoch: 0, startedAt: now, lastMsg: now, attempts: 0, retryPending: false });
    }
    const g: Gen = { id: ++this.genSeq, conns, allOpenAt: 0 };
    this.cur = g;
    if (conns.length === 0) {
      this.closeGen(this.old);
      this.old = null;
    }
    for (let i = 0; i < conns.length; i++) this.openConn(g, i);
  }

  private openConn(g: Gen, i: number): void {
    const c = g.conns[i]!;
    c.sub?.close();
    const epoch = ++c.epoch;
    c.sub = null;
    c.open = false;
    c.retryPending = false;
    c.startedAt = this.o.now();
    try {
      const sub = this.o.client.stream(
        c.chunk,
        (m) => this.onMessage(g, i, epoch, m),
        (s) => this.onState(g, i, epoch, s),
      );
      if (epoch === c.epoch) c.sub = sub;
      else sub.close();
    } catch (e) {
      this.report(e);
      this.retryConn(g, i);
    }
  }

  /** Reopen one connection after its own backoff. */
  private retryConn(g: Gen, i: number): void {
    const c = g.conns[i]!;
    if (c.retryPending || g !== this.cur) return;
    c.retryPending = true;
    c.epoch++;
    c.sub?.close();
    c.sub = null;
    c.open = false;
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** c.attempts, RECONNECT_MAX_MS);
    c.attempts++;
    this.timer(() => {
      if (g === this.cur) this.openConn(g, i);
    }, delay);
  }

  private conn(g: Gen, i: number, epoch: number): Conn | null {
    if (!this.running || (g !== this.cur && g !== this.old)) return null;
    const c = g.conns[i];
    return c && c.epoch === epoch ? c : null;
  }

  private onState(g: Gen, i: number, epoch: number, s: 'open' | 'closed'): void {
    const c = this.conn(g, i, epoch);
    if (!c) return;
    const now = this.o.now();
    if (s === 'closed') {
      c.open = false;
      if (g === this.cur) this.retryConn(g, i);
      return;
    }
    c.open = true;
    c.lastMsg = now;
    if (g !== this.cur || !g.conns.every((x) => x.open)) return;
    if (g.allOpenAt === 0) g.allOpenAt = now;
    if (this.old) {
      this.closeGen(this.old); // make-before-break: the new generation is up
      this.old = null;
    }
    this.requestCatchUp();
    // A close right at the switch may never arrive on either socket: look for it once REST has it.
    // The first boundary whose catch-up time (boundary + REST_SETTLE_MS) is still ahead: opening at C + 1 s targets C.
    const next = barOpenFor(now - REST_SETTLE_MS, this.o.tf) + this.step;
    this.timer(() => this.requestCatchUp(), next + REST_SETTLE_MS - now);
  }

  // --- messages ----------------------------------------------------------------------------------------------

  private onMessage(g: Gen, i: number, epoch: number, m: unknown): void {
    const c = this.conn(g, i, epoch);
    if (!c) return;
    const now = this.o.now();
    c.lastMsg = now;
    c.attempts = 0;
    this.lastMessageAt = now;
    if (isRec(m) && typeof m.stream === 'string') {
      if (m.stream === '!ticker@arr') this.onTickers(m.data);
      else if (m.stream === '!markPrice@arr@1s') this.onMarks(m.data);
      else if (m.stream.endsWith(`@kline_${this.o.tf}`)) {
        this.lastKlineAt = now;
        if (g === this.cur) this.lastCurKlineAt = now;
        this.onKlineEvent(m.data);
      }
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
      p = { bars: new Map(), queued: false, firstAt: this.o.now() };
      this.pending.set(closeTime, p);
      this.timer(() => this.enqueue(closeTime), CLOSE_WAIT_MS);
    }
    p.bars.set(k.s, c);
    if (!p.queued && p.bars.size >= this.symbols.size) {
      p.queued = true;
      this.enqueue(closeTime);
    }
  }

  // --- watchdog ----------------------------------------------------------------------------------------------

  private overdue(): boolean {
    return this.symbols.size > 0 && this.o.now() >= this.lastEmitted + this.step + STALE_GRACE_MS;
  }

  private markStale(): void {
    if (this.stale) return;
    this.stale = true;
    this.staleSince = this.o.now();
  }

  /** Reconnect the whole feed (make-before-break), at most once per SILENCE_MS. */
  private staleReconnect(now: number): void {
    if (now - this.lastStaleReconnectAt < SILENCE_MS) return;
    this.lastStaleReconnectAt = now;
    this.connect(true);
  }

  private check(): void {
    const now = this.o.now();
    if (this.failedAt !== null && now - this.failedAt >= RETRY_MS) {
      this.failedAt = null;
      this.requestCatchUp();
    }
    if (this.overdue()) {
      if (!this.pending.has(this.lastEmitted + this.step)) this.markStale(); // no closed kline arrived at all
      this.requestCatchUp();
      this.staleReconnect(now);
    }
    const g = this.cur;
    if (g) {
      for (const [i, c] of g.conns.entries()) {
        if (c.open && now - c.lastMsg >= SILENCE_MS) {
          this.markStale();
          this.retryConn(g, i);
        } else if (!c.open && !c.retryPending && now - c.startedAt >= OPEN_TIMEOUT_MS) {
          this.retryConn(g, i);
        }
      }
      // Connections alive (e.g. tickers flowing) but no kline event at all: the kline streams are dead.
      if (this.symbols.size > 0 && g.allOpenAt > 0 && now - Math.max(this.lastKlineAt, g.allOpenAt) >= SILENCE_MS) {
        this.markStale();
        this.staleReconnect(now);
      }
      if (g.allOpenAt > 0 && now - g.allOpenAt >= ROTATE_MS) this.connect(true);
    }
    this.maybeClearStale();
  }

  private maybeClearStale(): void {
    if (
      this.stale &&
      this.cur !== null &&
      this.cur.conns.every((c) => c.open) &&
      this.lastCurKlineAt > this.staleSince &&
      !this.inCatchUp &&
      this.failedAt === null &&
      !this.overdue()
    ) {
      this.stale = false;
    }
  }

  // --- closes ------------------------------------------------------------------------------------------------

  /** Fire every close that is due and the stream did not deliver. */
  private requestCatchUp(): void {
    if (this.symbols.size === 0) return;
    this.enqueue(barOpenFor(this.o.now() - REST_SETTLE_MS, this.o.tf), true);
  }

  private enqueue(target: number, catchUp = false): void {
    // After a failed batch every path waits for the watchdog's retry (RETRY_MS), which then catches up in one batch.
    if (this.failedAt !== null) return;
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

  /**
   * Plan one symbol for openTimes [lo, hi]: bars already stored, stream bars, and where its write may start.
   * `from` is the first open to fetch or write; `storable` is false when the repo is too far behind to extend.
   */
  private planSymbol(s: string, lo: number, hi: number): SymbolPlan {
    const { repo, tf } = this.o;
    const step = this.step;
    const latest = repo.latest(s, tf);
    const bars = new Map<number, Candle>();
    let from = lo;
    let storable = true;
    if (latest !== null && latest.openTime + step < lo) {
      if (latest.openTime + step >= lo - GAP_FILL_BARS * step) from = latest.openTime + step; // small gap: fill it now
      else storable = false; // too far behind: emit, but leave the repair to loadHistory
    } else if (latest !== null) {
      from = latest.openTime + step;
      // Opens in [lo, latest] are already stored (e.g. loadHistory ran ahead of the feed): use them.
      for (const c of repo.range(s, tf, lo, Math.min(hi, latest.openTime))) bars.set(c.openTime, c);
    }
    for (let t = Math.max(from, lo); t <= hi; t += step) {
      const b = this.pending.get(t + step)?.bars.get(s);
      if (b) bars.set(t, b);
    }
    return { symbol: s, from, storable, bars, permanent: false };
  }

  /** Any open in [from, hi] without a bar (`batchOnly`: only the opens being emitted, [lo, hi]). */
  private hasHoles(p: SymbolPlan, lo: number, hi: number, batchOnly: boolean): boolean {
    for (let t = batchOnly ? Math.max(p.from, lo) : p.from; t <= hi; t += this.step) if (!p.bars.has(t)) return true;
    return false;
  }

  /** One REST fetch for [from, hi]. Permanent failures mark the symbol missing; transient ones throw. */
  private async fetchInto(p: SymbolPlan, hi: number): Promise<void> {
    if (p.from > hi) return;
    this.inCatchUp = true;
    let fetched: Candle[];
    try {
      fetched = await this.o.client.klines(p.symbol, this.o.tf, p.from, hi);
    } catch (e) {
      if (!isPermanent(e)) {
        const streak = (this.errorStreak.get(p.symbol) ?? 0) + 1;
        this.errorStreak.set(p.symbol, streak);
        // The same non-HTTP failure for one symbol, batch after batch (e.g. a malformed reply), stops stalling everyone.
        if (e instanceof HttpStatusError || streak < ERROR_STREAK_LIMIT) throw e;
      }
      this.report(e);
      p.permanent = true;
      return;
    }
    this.errorStreak.delete(p.symbol);
    for (const c of fetched) if (c.openTime >= p.from && c.openTime <= hi && !p.bars.has(c.openTime)) p.bars.set(c.openTime, c);
  }

  /** Write and fire every close in (lastEmitted, target], oldest first. Throws (writing nothing) on a transient failure. */
  private async emitThrough(target: number, catchUp: boolean): Promise<void> {
    if (!this.running || target <= this.lastEmitted) return;
    const step = this.step;
    const closes: number[] = [];
    for (let c = this.lastEmitted + step; c <= target; c += step) closes.push(c);
    const lo = closes[0]! - step;
    const hi = target - step;
    if (catchUp || closes.length > 1) this.inCatchUp = true;
    // Retries end by the pass deadline, counted from the first kline of the oldest close in the batch (else from now).
    const firsts = closes.map((c) => this.pending.get(c)?.firstAt).filter((t): t is number => t !== undefined);
    const deadline = (firsts.length > 0 ? Math.min(...firsts) : this.o.now()) + RETRY_DEADLINE_MS;

    const symbols = [...this.symbols];
    const plans = symbols.map((s) => this.planSymbol(s, lo, hi));
    // One fetch for every symbol with a hole anywhere it may write (gap fill included).
    await forEachLimit(
      plans.filter((p) => this.hasHoles(p, lo, hi, false)),
      REST_CONCURRENCY,
      (p) => this.fetchInto(p, hi),
    );
    // Retry rounds, shared by the whole batch, only for bars being emitted that REST did not have yet.
    for (const delay of MISSING_RETRY_MS) {
      const waiting = plans.filter((p) => !p.permanent && this.hasHoles(p, lo, hi, true));
      if (waiting.length === 0 || !this.running || this.o.now() + delay > deadline) break;
      await this.sleep(delay);
      if (!this.running) break;
      await forEachLimit(waiting, REST_CONCURRENCY, (p) => this.fetchInto(p, hi));
    }
    if (!this.running) return;

    const writes = new Map<string, Candle[]>();
    const behind: string[] = [];
    for (const p of plans) {
      if (!p.storable) {
        behind.push(p.symbol);
        if (!this.reportedBehind.has(p.symbol)) {
          this.reportedBehind.add(p.symbol);
          this.report(new RepoBehindError(p.symbol, this.o.repo.latest(p.symbol, this.o.tf)?.openTime ?? 0));
        }
        continue;
      }
      this.reportedBehind.delete(p.symbol);
      const write: Candle[] = [];
      for (let t = p.from; t <= hi; t += step) {
        const b = p.bars.get(t);
        if (!b) break; // never store past a hole
        write.push(b);
      }
      if (write.length > 0) writes.set(p.symbol, write);
    }
    this.o.repo.upsertMany(this.o.tf, writes);
    this.failedAt = null;

    for (const closeTime of closes) {
      if (!this.running) return;
      const open = closeTime - step;
      const bars = new Map<string, Candle>();
      const missing: string[] = [];
      for (const p of plans) {
        const b = p.bars.get(open);
        if (b) bars.set(p.symbol, b);
        else missing.push(p.symbol);
      }
      this.lastEmitted = closeTime;
      this.lastMissing = missing;
      this.lastBehind = behind;
      for (const k of [...this.pending.keys()]) if (k <= closeTime) this.pending.delete(k);
      if (missing.length > 0) this.report(new MissingBarsError(closeTime, missing));
      for (const cb of [...this.closeListeners]) {
        try {
          await cb(closeTime, bars, { missing: [...missing], behind: [...behind] });
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
