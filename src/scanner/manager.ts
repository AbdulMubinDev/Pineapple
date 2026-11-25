// Runs several ScannerRuns in one process: the memory-based run limit, one LiveFeed per chart timeframe shared by
// every run on it, one price/mark stream shared by all (review M-6), the hourly universe refresh, funding priming,
// and run control (pause / resume / stop, also when requested in the database by another process).
import type { DatabaseSync } from 'node:sqlite';
import { isTimeframe } from '../core/timeframe.js';
import type { Candle, Timeframe } from '../core/types.js';
import { fundingHoursFor } from '../exchange/binance.js';
import type { ExchangeClient, PairInfo } from '../exchange/client.js';
import { FundingTracker } from '../exchange/funding.js';
import { LiveFeed, type CloseInfo } from '../exchange/live-feed.js';
import { CandleRepo, FundingRepo } from '../store/candles.js';
import { RunRepo, type RunSetup } from '../store/runs.js';
import { PriceFeed } from './price-feed.js';
import { ScannerRun, type PassReport, type ScannerStatus } from './run.js';

/** Memory one run needs, and the process's own share (Global Constraints). */
export const RUN_MEMORY_MB = 512;
export const BASE_MEMORY_MB = 125;
export const DEFAULT_MEM_LIMIT_MB = 768;
export const UNIVERSE_REFRESH_MS = 3_600_000;
/** Settings an owner may still change after a run is approved; everything else is locked. */
const EDITABLE = new Set(['sizing', 'fees']);

/** RUN_LIMIT = max(1, floor((MEM_LIMIT_MB - 125) / 512)); MEM_LIMIT_MB from the environment, default 768. */
export function runLimit(memLimitMb?: number): number {
  const env = Number(process.env.MEM_LIMIT_MB);
  const mb = memLimitMb ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_MEM_LIMIT_MB);
  return Math.max(1, Math.floor((mb - BASE_MEMORY_MB) / RUN_MEMORY_MB));
}

export interface RunManagerOptions {
  db: DatabaseSync;
  client: ExchangeClient;
  now: () => number;
  setTimer: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  sleep?: (ms: number) => Promise<void>;
  memLimitMb?: number;
  /** Passed to each ScannerRun (tests use short histories). */
  warmupBars?: number;
  htfBars?: number;
  concurrency?: number;
  onReport?: (runId: number, report: PassReport) => void;
  /** Operator lines: warm-up progress, feed errors, refresh failures. runId null for the manager's own. */
  onEvent?: (runId: number | null, message: string) => void;
}

export type SettingsPatch = Partial<Pick<RunSetup, 'sizing' | 'fees'>>;

interface FeedEntry {
  feed: LiveFeed;
  runs: Set<number>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class RunManager {
  readonly repo: RunRepo;
  readonly candles: CandleRepo;
  readonly fundingRepo: FundingRepo;
  readonly funding: FundingTracker;
  private readonly runs = new Map<number, ScannerRun>();
  private readonly feeds = new Map<Timeframe, FeedEntry>();
  private prices: PriceFeed | null = null;
  private universe: { pairs: PairInfo[]; volumes: Map<string, number>; at: number } | null = null;
  private readonly primed = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> = Promise.resolve();

  constructor(private readonly o: RunManagerOptions) {
    this.repo = new RunRepo(o.db, o.now);
    this.candles = new CandleRepo(o.db);
    this.fundingRepo = new FundingRepo(o.db);
    this.funding = new FundingTracker({
      client: o.client,
      repo: this.fundingRepo,
      now: o.now,
      log: (event, data) => {
        if (event === 'funding_missing') this.logToRuns(String(data.symbol), 'funding_missing', data);
        else this.event(null, `${event} ${JSON.stringify(data)}`);
      },
    });
  }

  /** Runs that are not stopped, in this process. */
  liveRuns(): number[] {
    return [...this.runs.entries()].filter(([, r]) => !r.isStopped).map(([id]) => id);
  }

  /**
   * Creates and starts a run: universe, warm-up, then the shared live feed. `onCreated` gets the id before the
   * warm-up (which takes minutes on the full universe). Throws `run limit reached (N)` past the limit.
   */
  async start(o: { name: string; setup: RunSetup }, onCreated?: (runId: number) => void): Promise<number> {
    const limit = runLimit(this.o.memLimitMb);
    if (this.liveRuns().length >= limit) throw new Error(`run limit reached (${limit})`);
    if (!isTimeframe(o.setup.tf)) throw new Error(`unsupported timeframe ${String(o.setup.tf)}`);
    const universe = await this.loadUniverse();
    if (this.liveRuns().length >= limit) throw new Error(`run limit reached (${limit})`);
    const runId = this.repo.createRun(o);
    const run = new ScannerRun({
      runId,
      repo: this.repo,
      candles: this.candles,
      client: this.o.client,
      funding: this.funding,
      setup: o.setup,
      now: this.o.now,
      ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
      ...(this.o.warmupBars === undefined ? {} : { warmupBars: this.o.warmupBars }),
      ...(this.o.htfBars === undefined ? {} : { htfBars: this.o.htfBars }),
      ...(this.o.concurrency === undefined ? {} : { concurrency: this.o.concurrency }),
      onEvent: (m) => this.event(runId, m),
    });
    this.runs.set(runId, run);
    onCreated?.(runId);
    try {
      await run.start(universe.pairs, universe.volumes);
    } catch (e) {
      run.stop();
      this.runs.delete(runId);
      this.repo.setStatus(runId, 'stopped');
      throw e;
    }
    if (run.isStopped) return runId; // stopped during its warm-up
    this.attach(runId, run);
    this.armRefresh();
    return runId;
  }

  // ------------------------------------------------------------------ feeds ----

  private attach(runId: number, run: ScannerRun): void {
    const tf = this.repo.getRun(runId)!.setup.tf;
    let entry = this.feeds.get(tf);
    if (!entry) {
      const feed = new LiveFeed({
        client: this.o.client,
        repo: this.candles,
        tf,
        symbols: run.symbols(),
        now: this.o.now,
        setTimer: this.o.setTimer,
        ...(this.o.clearTimer ? { clearTimer: this.o.clearTimer } : {}),
        lastCloseTime: run.lastCloseTime(),
        prices: false,
      });
      const e: FeedEntry = { feed, runs: new Set() };
      feed.onClose((closeTime, bars, info) => this.dispatch(e, closeTime, bars, info));
      feed.onError((err) => this.event(null, `${tf} feed: ${message(err)}`));
      this.feeds.set(tf, e);
      entry = e;
      entry.runs.add(runId);
      feed.start();
    } else {
      entry.runs.add(runId);
      this.updateFeedSymbols(tf);
    }
    const feed = entry.feed;
    run.attachFeed(() => feed.status());
    this.startPrices();
  }

  private async dispatch(e: FeedEntry, closeTime: number, bars: Map<string, Candle>, info: CloseInfo): Promise<void> {
    for (const id of [...e.runs]) {
      const run = this.runs.get(id);
      if (!run || run.isStopped) continue;
      try {
        this.o.onReport?.(id, await run.onClose(closeTime, bars, info));
      } catch (err) {
        this.event(id, `pass ${new Date(closeTime).toISOString()} failed: ${message(err)}`);
      }
    }
  }

  private updateFeedSymbols(tf: Timeframe): void {
    const entry = this.feeds.get(tf);
    if (!entry) return;
    const symbols = new Set<string>();
    for (const id of entry.runs) for (const s of this.runs.get(id)?.symbols() ?? []) symbols.add(s);
    entry.feed.setSymbols([...symbols].sort());
  }

  private startPrices(): void {
    if (this.prices) return;
    const p = new PriceFeed({ client: this.o.client, now: this.o.now, setTimer: this.o.setTimer, ...(this.o.clearTimer ? { clearTimer: this.o.clearTimer } : {}) });
    const live = () => [...this.runs.values()].filter((r) => !r.isStopped);
    p.onPrice((symbol, last, time) => {
      for (const r of live()) r.onPrice(symbol, last, time);
    });
    p.onMark((m) => {
      this.funding.onMark(m);
      for (const r of live()) r.onMark(m);
    });
    p.onVolume((symbol, q) => {
      for (const r of live()) r.setVolume(symbol, q);
    });
    p.onError((err) => this.event(null, `price feed: ${message(err)}`));
    this.prices = p;
    p.start();
  }

  // --------------------------------------------------------------- universe ----

  private async loadUniverse(): Promise<{ pairs: PairInfo[]; volumes: Map<string, number> }> {
    if (this.universe && this.o.now() - this.universe.at < UNIVERSE_REFRESH_MS) return this.universe;
    const [pairs, tickers, intervals] = await Promise.all([this.o.client.pairs(), this.o.client.tickers24h(), this.o.client.fundingIntervalHours()]);
    const volumes = new Map(tickers.map((t) => [t.symbol, t.quoteVolume]));
    const now = this.o.now();
    // Funding: track each pair from its last stored event (the mark stream announces the next one too).
    for (const p of pairs) {
      if (this.primed.has(p.symbol)) continue;
      this.primed.add(p.symbol);
      const last = this.fundingRepo.range(p.symbol, 0, now).at(-1);
      if (last) this.funding.primeFromInterval(p.symbol, last.time, fundingHoursFor(intervals, p.symbol));
    }
    this.universe = { pairs, volumes, at: now };
    return this.universe;
  }

  private armRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = this.o.setTimer(() => {
      this.refreshTimer = null;
      if (this.liveRuns().length === 0) return;
      this.refreshing = this.refreshUniverse()
        .catch((e: unknown) => this.event(null, `universe refresh failed: ${message(e)}`))
        .finally(() => this.armRefresh());
    }, UNIVERSE_REFRESH_MS);
  }

  /** Rebuilds the universe now and hands it to every live run, then updates the feeds' symbols. */
  async refreshUniverse(): Promise<void> {
    this.universe = null;
    const u = await this.loadUniverse();
    for (const id of this.liveRuns()) {
      const run = this.runs.get(id)!;
      // Symbols first (delistings leave the feed), again after the new listings joined.
      const tf = this.repo.getRun(id)!.setup.tf;
      await run.applyUniverse(u.pairs, u.volumes);
      this.updateFeedSymbols(tf);
    }
  }

  // ---------------------------------------------------------------- control ----

  private live(runId: number): ScannerRun {
    const run = this.runs.get(runId);
    if (!run || run.isStopped) throw new Error(`no live run ${runId}`);
    return run;
  }

  pause(runId: number): void {
    this.live(runId).pause();
    this.repo.setStatus(runId, 'paused');
  }

  resume(runId: number): void {
    this.live(runId).resume();
    this.repo.setStatus(runId, 'running');
  }

  /** Frozen for good: no more passes, nothing is closed. The last run on a feed stops it. */
  stop(runId: number): void {
    const run = this.runs.get(runId);
    run?.stop();
    if (this.repo.getRun(runId)?.status !== 'stopped') this.repo.setStatus(runId, 'stopped');
    for (const [tf, e] of this.feeds) {
      if (!e.runs.delete(runId)) continue;
      if (e.runs.size === 0) {
        e.feed.stop();
        this.feeds.delete(tf);
      } else this.updateFeedSymbols(tf);
    }
    if (this.liveRuns().length === 0) this.stopShared();
  }

  /** Owner edits after approval: sizing and fees only, from the next pass on; anything else is locked. */
  async updateSettings(runId: number, patch: SettingsPatch): Promise<void> {
    for (const k of Object.keys(patch)) if (!EDITABLE.has(k)) throw new Error(`${k} is locked after approval`);
    const run = this.live(runId);
    const rate = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (patch.fees && !(rate(patch.fees.makerRate) && rate(patch.fees.takerRate) && rate(patch.fees.slippagePct))) throw new Error('fees: rates must be finite and >= 0');
    if (patch.sizing && patch.sizing.kind === 'fixed' && !(patch.sizing.notionalUsd > 0 && Number.isFinite(patch.sizing.notionalUsd))) {
      throw new Error('sizing: notionalUsd must be a positive number');
    }
    if (patch.sizing) {
      await run.setSizing(patch.sizing);
      this.repo.recordSetting(runId, 'sizing', patch.sizing);
    }
    if (patch.fees) {
      await run.setFees(patch.fees);
      this.repo.recordSetting(runId, 'fees', patch.fees);
    }
  }

  /** Applies pause / resume / stop that another process (the CLI) wrote to the runs table. */
  syncFromDb(): void {
    for (const id of this.liveRuns()) {
      const status = this.repo.getRun(id)?.status;
      const run = this.runs.get(id)!;
      if (status === 'stopped') this.stop(id);
      else if (status === 'paused' && !run.isPaused) run.pause();
      else if (status === 'running' && run.isPaused) run.resume();
    }
  }

  status(runId: number): ScannerStatus {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`no run ${runId} in this process`);
    return run.status();
  }

  /** Resolves once queued closes, passes and background repairs have settled. */
  async idle(): Promise<void> {
    await this.refreshing;
    for (const e of this.feeds.values()) await e.feed.settled();
    for (const r of this.runs.values()) await r.idle();
  }

  /** Stops the feeds and timers (the runs keep their status: a restart resumes them). */
  shutdown(): void {
    for (const e of this.feeds.values()) e.feed.stop();
    this.feeds.clear();
    this.stopShared();
  }

  private stopShared(): void {
    this.prices?.stop();
    this.prices = null;
    if (this.refreshTimer !== null) (this.o.clearTimer ?? clearTimeout)(this.refreshTimer);
    this.refreshTimer = null;
  }

  private event(runId: number | null, m: string): void {
    this.o.onEvent?.(runId, m);
  }

  /** A FundingTracker give-up, logged as funding_missing in every live run trading that symbol. */
  private logToRuns(symbol: string, kind: string, detail: unknown): void {
    for (const id of this.liveRuns()) if (this.runs.get(id)!.symbols().includes(symbol)) this.runs.get(id)!.note(kind, symbol, detail);
  }
}
