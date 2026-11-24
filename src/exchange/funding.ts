// Fetches each settled funding event exactly once, only for the symbols the caller asks about.
// The mark stream tells us each pair's next funding time; once it has passed we ask REST for the settled rate.
import type { FundingEvent } from '../core/types.js';
import type { ExchangeClient, MarkUpdate } from './client.js';
import type { FundingRepo } from '../store/candles.js';

/** How long after its funding time we keep asking for an unpublished event before giving up. */
const GIVE_UP_MS = 10 * 60_000;
/** Binance limits /fapi/v1/fundingRate to 500 requests per 5 minutes per IP; we stay under it. */
const GUARD_CALLS = 400;
const GUARD_WINDOW_MS = 5 * 60_000;
/** The fetch window around a funding time: [t - 1 s, t + 60 s]. */
const BEFORE_MS = 1000;
const AFTER_MS = 60_000;
/** primeFromInterval never queues more than this many past times for one symbol. */
const MAX_PRIME = 100;

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

export class FundingTracker {
  /** Funding times not yet fetched, per symbol. Passed times stay until fetched or given up on. */
  private readonly pending = new Map<string, Set<number>>();
  /** `${symbol}|${time}` of every event already returned or found in the repo. */
  private readonly done = new Set<string>();
  private readonly inflight = new Set<string>();
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

  /** Settled events for the given symbols whose funding time has passed. Each event is returned once. */
  async due(symbols: string[], now: number): Promise<DueFunding[]> {
    const out: DueFunding[] = [];
    for (const symbol of symbols) {
      const times = this.pending.get(symbol);
      if (!times) continue;
      for (const t of [...times].sort((a, b) => a - b)) {
        if (t > now) break;
        const key = `${symbol}|${t}`;
        if (this.inflight.has(key)) continue;
        // Already stored (e.g. before a restart): the consumer has applied it.
        if (this.o.repo.range(symbol, t - BEFORE_MS, t + AFTER_MS).length > 0) {
          this.finish(symbol, t);
          continue;
        }
        if (now - t > GIVE_UP_MS) {
          times.delete(t);
          this.log('funding_missing', { symbol, time: t });
          continue;
        }
        if (!this.takeCall(now)) return out; // guard full: defer the rest to a later call
        this.inflight.add(key);
        try {
          const events = await this.o.client.fundingHistory(symbol, t - BEFORE_MS, t + AFTER_MS);
          const event = events.find((e) => !this.done.has(`${symbol}|${e.time}`));
          if (!event) continue;
          this.o.repo.upsert(symbol, [event]);
          this.finish(symbol, t);
          this.done.add(`${symbol}|${event.time}`);
          out.push({ symbol, event });
        } catch (err) {
          this.log('funding_fetch_failed', { symbol, time: t, error: err instanceof Error ? err.message : String(err) });
        } finally {
          this.inflight.delete(key);
        }
      }
    }
    return out;
  }

  range(symbol: string, fromMs: number, toMs: number): FundingEvent[] {
    return this.o.repo.range(symbol, fromMs, toMs);
  }

  private track(symbol: string, t: number): void {
    if (this.done.has(`${symbol}|${t}`)) return;
    let set = this.pending.get(symbol);
    if (!set) this.pending.set(symbol, (set = new Set()));
    set.add(t);
  }

  private finish(symbol: string, t: number): void {
    this.pending.get(symbol)?.delete(t);
    this.done.add(`${symbol}|${t}`);
  }

  /** Reserves one fundingHistory call in the rolling window; false when the window is full. */
  private takeCall(now: number): boolean {
    while (this.callTimes.length > 0 && now - (this.callTimes[0] as number) >= GUARD_WINDOW_MS) this.callTimes.shift();
    if (this.callTimes.length >= GUARD_CALLS) return false;
    this.callTimes.push(now);
    return true;
  }
}
