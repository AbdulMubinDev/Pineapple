// Every Binance REST call goes through this budget. Binance allows 2400 weight/min per IP; we stay at half (1200).

export const REST_LIMIT_PER_MIN = 1200;
export const DEFAULT_RETRY_AFTER_MS = 60_000;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

/** Weight of /fapi/v1/klines by `limit`. */
export function klineWeight(limit: number): number {
  if (limit < 100) return 1;
  if (limit < 500) return 2;
  if (limit <= 1000) return 5;
  return 10;
}
export const FUNDING_WEIGHT = 1;
export const EXCHANGE_INFO_WEIGHT = 1;
export const FUNDING_INFO_WEIGHT = 1;
export const TICKER_24H_WEIGHT = 40;

export interface BudgetOptions {
  limitPerMin: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Sliding 60 s window of charged weight, plus server-reported usage, 429 back-off and 418 ban. */
export class RestBudget {
  // Weight is charged per attempt, so a retried request after 429/418 is charged again. This is deliberate and
  // conservative: we may wait slightly longer than needed, never go over the limit.
  private events: { t: number; w: number; seq: number }[] = [];
  private seq = 0;
  private pausedUntil = 0;
  private bannedUntil = 0;
  /** `seq` is the charge counter at observation time: charges with seq >= it came after the server's reading. */
  private observed: { at: number; used: number; seq: number } | null = null;

  constructor(private readonly o: BudgetOptions) {}

  /** True while a 418 ban is in force: surface it to the operator. */
  get banned(): boolean {
    return this.o.now() < this.bannedUntil;
  }

  /** Resolves once `weight` fits in the window and no back-off or ban is active, and charges it. */
  async acquire(weight: number): Promise<void> {
    if (weight > this.o.limitPerMin) throw new Error(`weight ${weight} exceeds the per-minute limit ${this.o.limitPerMin}`);
    for (;;) {
      const now = this.o.now();
      const resume = Math.max(this.pausedUntil, this.bannedUntil);
      if (resume > now) {
        await this.o.sleep(resume - now);
        continue;
      }
      while (this.events.length > 0 && this.events[0]!.t <= now - WINDOW_MS) this.events.shift();
      const local = this.events.reduce((s, e) => s + e.w, 0);
      const obs = this.observed && now - this.observed.at < WINDOW_MS ? this.observed : null;
      // The server's reading already includes charges made before it (and other processes' usage); add only what we charged since.
      const serverTotal = obs === null ? 0 : obs.used + this.events.filter((e) => e.seq >= obs.seq).reduce((s, e) => s + e.w, 0);
      const serverBound = obs !== null && serverTotal > local;
      const used = serverBound ? serverTotal : local;
      if (used + weight <= this.o.limitPerMin) {
        this.events.push({ t: now, w: weight, seq: this.seq++ });
        return;
      }
      const freeAt = serverBound ? obs.at + WINDOW_MS : (this.events[0]?.t ?? now) + WINDOW_MS;
      await this.o.sleep(Math.max(1, freeAt - now));
    }
  }

  /** Record the server's X-MBX-USED-WEIGHT-1M. */
  observe(usedWeight1m: number): void {
    if (Number.isFinite(usedWeight1m) && usedWeight1m >= 0) this.observed = { at: this.o.now(), used: usedWeight1m, seq: this.seq };
  }

  /** HTTP 429: pause all acquires for `ms`. */
  backoff(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.o.now() + ms);
  }

  /** HTTP 418 (IP ban): stop all REST for `ms` and raise the `banned` flag. */
  ban(ms: number): void {
    this.bannedUntil = Math.max(this.bannedUntil, this.o.now() + ms);
  }
}

/** A non-2xx reply (after retries for 429/418). `status` lets callers tell a bad request from a transient failure. */
export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export interface RestResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: unknown;
}

function retryAfterMs(res: RestResponse): number {
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : DEFAULT_RETRY_AFTER_MS;
}

/** One budgeted REST call: charge, send, read the used-weight header, retry after 429/418, return the JSON body. */
export async function budgetedGet(budget: RestBudget, weight: number, doGet: () => Promise<RestResponse>): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    await budget.acquire(weight);
    const res = await doGet();
    const used = res.headers.get('x-mbx-used-weight-1m');
    if (used !== null) budget.observe(Number(used));
    if (res.status === 429 || res.status === 418) {
      if (res.status === 429) budget.backoff(retryAfterMs(res));
      else budget.ban(retryAfterMs(res));
      if (attempt >= MAX_ATTEMPTS) throw new HttpStatusError(res.status, `HTTP ${res.status}: gave up after ${attempt} attempts`);
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, `HTTP ${res.status}`);
    if (res.body === null) throw new Error('response body was not JSON');
    return res.body;
  }
}
