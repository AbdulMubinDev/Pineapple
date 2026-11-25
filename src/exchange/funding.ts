// Supplies settled funding events, fetching each from REST at most once, only for the symbols the caller asks about.
// The mark stream tells us each pair's next funding time; once it has passed we look the event up in the repo, else ask REST.
// The tracker never decides what has been applied: the caller passes `appliedThrough` and commits its own progress.
import type { FundingEvent } from '../core/types.js';
import type { ExchangeClient, MarkUpdate } from './client.js';
import type { FundingRepo } from '../store/candles.js';

/** How long after the first fetch attempt we keep asking for an unpublished event before giving up. */
const GIVE_UP_MS = 10 * 60_000;
/** Binance limits /fapi/v1/fundingRate to 500 requests per 5 minutes per IP; we stay under it. */
const GUARD_CALLS = 400;
const GUARD_WINDOW_MS = 5 * 60_000;
/** The fetch window around a funding time: [t - 1 s, t + 60 s]. */
const BEFORE_MS = 1000;
const AFTER_MS = 60_000;
/** primeFromInterval never queues more than this many past times for one symbol. */
const MAX_PRIME = 100;
/** Tracked times, first attempts and give-ups older than this are forgotten. */
const RETENTION_MS = 30 * 24 * 3_600_000;
/** Most tracked times / cached events kept per symbol. */
const MAX_PER_SYMBOL = 1000;

export interface FundingTrackerOptions {
  client: ExchangeClient;
  repo: FundingRepo;
  now: () => number;
  /** Structured log sink; defaults to console.warn. */
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface DueFunding {
  symbol: string;
  event: FundingEvent;
}

interface SymbolState {
  /** Known funding times. */
  times: Set<number>;
  /** Events fetched or found in the repo, by tracked funding time. No "applied" meaning. */
  events: Map<number, FundingEvent>;
  /** Lowest appliedThrough any caller has passed; older entries are pruned. */
  minApplied: number;
  /** When we last tried to fetch for this symbol (for fair ordering under the guard). */
  lastAttempt: number;
}

export class FundingTracker {
  private readonly symbols = new Map<string, SymbolState>();
  /** First fetch attempt per `${symbol}|${time}`. */
  private readonly firstAttempt = new Map<string, number>();
  /** `${symbol}|${time}` given up on (funding_missing logged); never tracked again. */
  private readonly gaveUp = new Set<string>();
  private readonly inflight = new Map<string, Promise<FundingEvent | undefined>>();
  /** Times of recent fundingHistory calls. */
  private readonly callTimes: number[] = [];
  private readonly log: (event: string, data: Record<string, unknown>) => void;

  constructor(private readonly o: FundingTrackerOptions) {
    this.log = o.log ?? ((event, data) => console.warn(event, JSON.stringify(data)));
  }

  onMark(m: MarkUpdate): void {
    if (Number.isFinite(m.nextFundingTime) && m.nextFundingTime > 0) this.track(m.symbol, m.nextFundingTime);
  }

  /**
   * Start tracking a symbol from its last known funding time: every `intervalHours` step after it, up to and
   * including the first one still in the future.
   */
  primeFromInterval(symbol: string, lastFundingTime: number, intervalHours: number): void {
    const step = intervalHours * 3_600_000;
    if (!(step > 0) || !Number.isFinite(lastFundingTime)) return;
    const now = this.o.now();
    const times: number[] = [];
    for (let t = lastFundingTime + step; ; t += step) {
      times.push(t);
      if (t > now) break;
    }
    for (const t of times.slice(-MAX_PRIME)) this.track(symbol, t);
  }

  /**
   * Every settled event with `time > appliedThrough(symbol)` whose funding time has passed, oldest first, for the
   * given symbols. Taken from the repo when stored there, else fetched once (within the call guard) and stored.
   * Nothing is marked applied here: the same arguments return the same events again.
   * `fetch: false` reads the repo only (no REST, no give-up bookkeeping): a pass uses it after a background prefetch.
   */
  async due(symbols: string[], now: number, appliedThrough: (symbol: string) => number, opts: { fetch?: boolean } = {}): Promise<DueFunding[]> {
    const fetch = opts.fetch !== false;
    this.pruneAttempts(now);
    const work: { symbol: string; st: SymbolState; applied: number }[] = [];
    for (const symbol of symbols) {
      const st = this.symbols.get(symbol);
      if (!st) continue;
      const applied = appliedThrough(symbol);
      if (applied < st.minApplied) st.minApplied = applied;
      this.prune(st, now);
      work.push({ symbol, st, applied });
    }
    // Least recently attempted first, so retries of an unpublished event cannot starve other symbols.
    const oldestUnresolved = (w: (typeof work)[number]): number =>
      Math.min(...[...w.st.times].filter((t) => t <= now && t > w.applied && !w.st.events.has(t)), Infinity);
    work.sort((a, b) => a.st.lastAttempt - b.st.lastAttempt || oldestUnresolved(a) - oldestUnresolved(b));

    const out: DueFunding[] = [];
    for (const { symbol, st, applied } of work) {
      for (const t of [...st.times].sort((a, b) => a - b)) {
        if (t > now) break;
        if (t <= applied) continue;
        let event = st.events.get(t);
        if (!event && !fetch) {
          event = this.stored(symbol, st, t);
        } else if (!event) {
          const key = `${symbol}|${t}`;
          const first = this.firstAttempt.get(key);
          if (first !== undefined && now - first > GIVE_UP_MS) {
            this.giveUp(symbol, st, t);
            continue;
          }
          // The repo is read first; only an actual fetch is subject to the guard (a full guard yields undefined).
          event = await this.resolve(symbol, st, t, now);
        }
        if (event && event.time > applied) out.push({ symbol, event });
      }
    }
    return out.sort((a, b) => a.event.time - b.event.time);
  }

  range(symbol: string, fromMs: number, toMs: number): FundingEvent[] {
    return this.o.repo.range(symbol, fromMs, toMs);
  }

  private resolve(symbol: string, st: SymbolState, t: number, now: number): Promise<FundingEvent | undefined> {
    const key = `${symbol}|${t}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.lookup(symbol, st, t, now).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Funding times tracked for `symbol` in (after, upTo], oldest first (whether resolved or not). */
  passedTimes(symbol: string, after: number, upTo: number): number[] {
    const st = this.symbols.get(symbol);
    if (!st) return [];
    return [...st.times].filter((t) => t > after && t <= upTo).sort((a, b) => a - b);
  }

  /** The event for tracked time `t` if the repo holds it. */
  private stored(symbol: string, st: SymbolState, t: number): FundingEvent | undefined {
    const ev = this.o.repo.range(symbol, t - BEFORE_MS, t + AFTER_MS)[0];
    if (ev) st.events.set(t, ev);
    return ev;
  }

  private async lookup(symbol: string, st: SymbolState, t: number, now: number): Promise<FundingEvent | undefined> {
    // Stored by the history loader, catch-up or an earlier run: use it without REST.
    const stored = this.stored(symbol, st, t);
    if (stored) return stored;
    if (!this.takeCall(now)) return undefined;
    const key = `${symbol}|${t}`;
    if (!this.firstAttempt.has(key)) this.firstAttempt.set(key, now);
    st.lastAttempt = now;
    try {
      const event = (await this.o.client.fundingHistory(symbol, t - BEFORE_MS, t + AFTER_MS))[0];
      if (!event) return undefined;
      this.o.repo.upsert(symbol, [event]);
      st.events.set(t, event);
      this.firstAttempt.delete(key);
      return event;
    } catch (err) {
      this.log('funding_fetch_failed', { symbol, time: t, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  private giveUp(symbol: string, st: SymbolState, t: number): void {
    const key = `${symbol}|${t}`;
    this.gaveUp.add(key);
    this.firstAttempt.delete(key);
    st.times.delete(t);
    this.log('funding_missing', { symbol, time: t });
  }

  private track(symbol: string, t: number): void {
    if (this.gaveUp.has(`${symbol}|${t}`)) return;
    let st = this.symbols.get(symbol);
    if (!st) this.symbols.set(symbol, (st = { times: new Set(), events: new Map(), minApplied: Infinity, lastAttempt: -Infinity }));
    st.times.add(t);
  }

  /**
   * Bounds memory. Times are kept by age (30 days) and count only, never by what callers pass, so a run with a lower
   * appliedThrough still finds its events (from the repo when the cache dropped them). Only the event cache is pruned
   * by appliedThrough.
   */
  private prune(st: SymbolState, now: number): void {
    for (const t of st.times) {
      if (t < now - RETENTION_MS) {
        st.times.delete(t);
        st.events.delete(t);
      }
    }
    if (st.times.size > MAX_PER_SYMBOL) {
      for (const t of [...st.times].sort((a, b) => a - b).slice(0, st.times.size - MAX_PER_SYMBOL)) {
        st.times.delete(t);
        st.events.delete(t);
      }
    }
    for (const t of st.events.keys()) if (t <= st.minApplied) st.events.delete(t);
  }

  /** Drops firstAttempt and gaveUp entries for funding times past the retention. */
  private pruneAttempts(now: number): void {
    const old = (key: string): boolean => Number(key.slice(key.lastIndexOf('|') + 1)) < now - RETENTION_MS;
    for (const k of this.firstAttempt.keys()) if (old(k)) this.firstAttempt.delete(k);
    for (const k of this.gaveUp) if (old(k)) this.gaveUp.delete(k);
  }

  /** Reserves one fundingHistory call in the rolling window; false when the window is full. */
  private takeCall(now: number): boolean {
    while (this.callTimes.length > 0 && now - (this.callTimes[0] as number) >= GUARD_WINDOW_MS) this.callTimes.shift();
    if (this.callTimes.length >= GUARD_CALLS) return false;
    this.callTimes.push(now);
    return true;
  }
}
