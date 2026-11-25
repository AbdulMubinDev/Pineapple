// One live scanner run: a Pine strategy() over many perpetual pairs with ONE shared paper account (mode binance).
//
// - start(): compiles the script, loads every pair's history through the REST budget (bounded concurrency, retry with
//   backoff) and warm-starts one resident instance per pair that has enough history.
// - onClose(): one pass. Pairs are stepped one after another in descending 24h quote volume, so margin is reserved in
//   that order; each candle is stepped once per pair (processed keys are checked first); funding due for pairs with
//   a position or orders is pushed into their barHooks funding array before the bar that contains it; everything the
//   pass changed is committed in ONE RunRepo.commitPass.
// - onPrice() / onMark(): live stop/limit fills and liquidations between closes, committed at once (state only).
// - applyUniverse(): delistings close their positions; new listings warm up and join once their history suffices.
// - pause() drops entry intents (exits, stops, liquidation and funding carry on); stop() freezes the run.
//
// A rejected commit (DuplicatePassError, StalePassError) means memory is ahead of the database: the broker and the
// layers are reloaded from loadState(), every instance is rebuilt, and a state_reloaded warning is logged.
import { PaperBroker, type BrokerOptions } from '../broker/broker.js';
import { barOpenFor, tfToMs } from '../core/timeframe.js';
import type { Candle, Fill, FundingEvent, OrderIntent, PairRules } from '../core/types.js';
import { compileScript, type StrategyDeclaration } from '../engine/pine-runner.js';
import { barHooks, ScriptCompileError, type ReplayRejection } from '../engine/replay.js';
import { ResidentStrategy, scriptBounds, type ScriptBounds } from '../engine/resident.js';
import { StrategyLayer } from '../engine/strategy-layer.js';
import type { RestBudget } from '../exchange/budget.js';
import type { ExchangeClient, MarkUpdate, PairInfo } from '../exchange/client.js';
import type { FundingTracker } from '../exchange/funding.js';
import { loadHistory } from '../exchange/history.js';
import type { CloseInfo, LiveFeedStatus } from '../exchange/live-feed.js';
import type { CandleRepo } from '../store/candles.js';
import type { RunRepo, RunSetup } from '../store/runs.js';
import { RunLedger } from './ledger.js';
import { fundingBeforeLiveFill, pendingAfterLiveFill, settlePending, type PendingFunding } from './run-live.js';
import { catchUpBars, exposureFloor, fundingSteppedThrough, queueFunding, type PairPlan } from './run-pass.js';
import { BAR_STATE_WARNING, PASS_DEADLINE_MS, type Pair, type PassReport, type PendingReason, type ScannerStatus } from './types.js';
import {
  buildHtf,
  contiguousTail,
  forEachPooled,
  loadPairHistory,
  nativeTimeframe,
  WARMUP_BARS,
  WARMUP_CONCURRENCY,
  withRetry,
  type PairHistory,
} from './warmup.js';

export { BAR_STATE_WARNING, MAX_CATCHUP_BARS, type PassReport, type ScannerStatus } from './types.js';

export interface ScannerRunOptions {
  runId: number;
  repo: RunRepo;
  candles: CandleRepo;
  client: ExchangeClient;
  funding: FundingTracker;
  setup: RunSetup;
  now: () => number;
  /** For retry backoff (default: real time). */
  sleep?: (ms: number) => Promise<void>;
  /** Chart bars loaded per pair (default WARMUP_BARS). */
  warmupBars?: number;
  htfBars?: number;
  concurrency?: number;
  /** Progress lines for an operator (warm-up counts, retries). */
  onEvent?: (message: string) => void;
  /** The pairs this run wants bars for changed (a delisting, a listing joined): the manager updates its feed. */
  onSymbolsChanged?: () => void;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ScannerRun {
  readonly runId: number;
  private readonly o: ScannerRunOptions;
  private readonly tfMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bars: number;
  private broker: PaperBroker;
  /** Bumped whenever the broker is replaced (reload), so a pair built for an older broker is rebuilt. */
  private brokerGen = 0;
  private decl: StrategyDeclaration | null = null;
  private secTfs: string[] = [];
  private bounds: ScriptBounds | null = null;
  private readonly rules = new Map<string, PairRules>();
  private readonly pairs = new Map<string, Pair>();
  /** Every layer this run built, delisted ones included (their trades are attributed until committed). */
  private readonly layers = new Map<string, StrategyLayer>();
  private readonly pending = new Map<string, { info: PairInfo; reason: PendingReason }>();
  private volumes = new Map<string, number>();
  private paused = false;
  private stopped = false;
  private lock: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private readonly background = new Set<Promise<unknown>>();
  private readonly ledger: RunLedger;
  private warmCovers = 0;
  private lastReport: PassReport | null = null;
  private lastPassAt = 0;
  private feedStatus: (() => LiveFeedStatus) | null = null;
  private wasBanned = false;
  /** Symbols with market intents a live fill made, by the open of the bar they were made in (H2: next tick fills them). */
  private readonly liveMarket = new Map<string, number>();
  /** Funding held by positions closed live before the event settled (charged once it resolves). */
  private pendingFunding: PendingFunding[] = [];
  private prefetching: Promise<void> | null = null;

  constructor(o: ScannerRunOptions) {
    this.o = o;
    this.runId = o.runId;
    this.tfMs = tfToMs(o.setup.tf);
    this.sleep = o.sleep ?? realSleep;
    this.bars = o.warmupBars ?? WARMUP_BARS;
    this.broker = new PaperBroker(this.brokerOptions());
    this.ledger = new RunLedger(o.repo, o.runId, o.now);
  }

  private brokerOptions(): BrokerOptions {
    const s = this.o.setup;
    return {
      startingBalance: s.startingBalance,
      fees: s.fees,
      mode: 'binance',
      sizing: s.sizing,
      rules: (symbol) => {
        const r = this.rules.get(symbol);
        if (!r) throw new Error(`no pair rules for ${symbol}`);
        return r;
      },
    };
  }

  // ------------------------------------------------------------------ start ----

  async start(universe: PairInfo[], volumes: Map<string, number>): Promise<void> {
    const { setup } = this.o;
    const bounds = scriptBounds(setup.script);
    if ('error' in bounds) throw new ScriptCompileError([{ line: 0, message: bounds.error }]);
    this.volumes = new Map(volumes);
    const ordered = this.byVolume(universe);
    const compiled = await compileScript(setup.script, setup.tf, ordered[0]?.symbol ?? 'BTCUSDT');
    if (!compiled.ok) throw new ScriptCompileError(compiled.errors);
    this.bounds = bounds;
    this.secTfs = compiled.securityTimeframes;
    // Binance costs: the declaration's commission stands for the run's taker rate; the broker applies slippagePct.
    this.decl = { ...compiled.declaration, overridden: { ...compiled.declaration.overridden, commission: setup.fees.takerRate * 100, slippage: 0 } };
    const now = this.o.now();
    if (bounds.uses.barstate || bounds.uses.barIndex) this.log('script_warning', undefined, { message: BAR_STATE_WARNING, uses: bounds.uses });
    for (const w of compiled.warnings ?? []) this.log('script_warning', undefined, { line: w.line, message: w.message });

    await this.warm(ordered, 'start');
    this.warmCovers = barOpenFor(this.o.now(), setup.tf);
    if (!this.stopped) await this.exclusive(() => this.commit(this.ledger.lastClose, [], new Set(this.pairs.keys()), {}, now));
  }

  /** The last close the warm-up covers: pass it to LiveFeed as lastCloseTime. */
  lastCloseTime(): number {
    return this.warmCovers;
  }

  /** Pairs this run wants bars for. */
  symbols(): string[] {
    return [...this.pairs.keys()];
  }

  attachFeed(status: () => LiveFeedStatus): void {
    this.feedStatus = status;
  }

  setVolume(symbol: string, quoteVolume: number): void {
    if (Number.isFinite(quoteVolume)) this.volumes.set(symbol, quoteVolume);
  }

  private byVolume<T extends { symbol: string } | { info: PairInfo }>(xs: T[]): T[] {
    const sym = (x: T) => ('symbol' in x ? x.symbol : x.info.symbol);
    const vol = (x: T) => this.volumes.get(sym(x)) ?? 0;
    return [...xs].sort((a, b) => vol(b) - vol(a) || (sym(a) < sym(b) ? -1 : 1));
  }

  /** Loads and warm-starts `infos` (bounded concurrency). Each pair joins as soon as it is ready. */
  private async warm(infos: PairInfo[], why: 'start' | 'refresh'): Promise<void> {
    for (const info of infos) {
      this.rules.set(info.symbol, info.rules);
      this.pending.set(info.symbol, { info, reason: 'loading' });
    }
    let done = 0;
    const started = this.o.now();
    await forEachPooled(infos, this.o.concurrency ?? WARMUP_CONCURRENCY, async (info) => {
      try {
        if (this.stopped) return;
        const h = await withRetry(() => this.loadPair(info), this.sleep, {
          cancelled: () => this.stopped,
          onRetry: (n, ms, e) => this.o.onEvent?.(`${info.symbol}: warm-up attempt ${n} failed (${message(e)}); retrying in ${ms / 1000} s`),
        });
        await this.join(info, h);
      } catch (e) {
        this.pending.set(info.symbol, { info, reason: 'warmup_failed' });
        this.log('warning', info.symbol, { reason: 'warmup_failed', message: message(e) });
      } finally {
        done++;
        if (done % 25 === 0 || done === infos.length) {
          this.o.onEvent?.(`warm-up (${why}) ${done}/${infos.length} pairs, ${this.pairs.size} live, ${((this.o.now() - started) / 1000).toFixed(0)} s`);
        }
      }
    });
  }

  private loadPair(info: PairInfo): Promise<PairHistory> {
    return loadPairHistory({
      client: this.o.client,
      candles: this.o.candles,
      symbol: info.symbol,
      tf: this.o.setup.tf,
      onboardDate: info.onboardDate,
      securityTimeframes: this.secTfs,
      now: this.o.now(),
      bars: this.bars,
      ...(this.o.htfBars === undefined ? {} : { htfBars: this.o.htfBars }),
    });
  }

  private required(): number {
    return this.bounds!.keep;
  }

  /** Builds the pair's instance on the current broker and adds it (rebuilt if the broker was replaced meanwhile). */
  private async join(info: PairInfo, h: PairHistory): Promise<void> {
    const symbol = info.symbol;
    if (h.history.length < this.required()) {
      this.pending.set(symbol, { info, reason: 'insufficient_history' });
      this.log('skip', symbol, { reason: 'insufficient_history', bars: h.history.length, required: this.required() });
      return;
    }
    for (;;) {
      const gen = this.brokerGen;
      const layer = new StrategyLayer(this.decl!, this.broker, symbol, this.broker.sizingRule(), { rules: info.rules, from: h.history.at(-1)!.openTime + this.tfMs });
      const p = await this.build(info, layer, h);
      const added = await this.exclusive(() => {
        if (this.stopped || gen !== this.brokerGen) {
          p.inst?.dispose();
          return this.stopped;
        }
        this.layers.set(symbol, layer);
        this.ledger.track(symbol, layer);
        this.pairs.set(symbol, p);
        this.pending.delete(symbol);
        if (this.warmCovers > 0) this.o.onSymbolsChanged?.(); // a listing joined a live run: the feed needs it
        return true;
      });
      if (added) return;
    }
  }

  /** A resident instance over `h` for `layer`, wired through barHooks to the current broker. */
  private async build(info: PairInfo, layer: StrategyLayer, h: PairHistory): Promise<Pair> {
    const last = h.history.at(-1)!;
    const funding: FundingEvent[] = [];
    const symbol = info.symbol;
    const hooks = barHooks({
      broker: this.broker,
      layer,
      symbol,
      tf: this.o.setup.tf,
      mode: 'binance',
      from: last.openTime + this.tfMs,
      funding,
      processOrdersOnClose: this.decl!.processOrdersOnClose === true,
      warmupEquity: this.broker.account().equity,
      onRejected: (r) => this.onRejected(symbol, r),
      admit: (i) => this.admit(symbol, i),
    });
    const inst = await ResidentStrategy.create({
      source: this.o.setup.script,
      symbol,
      tf: this.o.setup.tf,
      rules: info.rules,
      history: h.history,
      htf: h.htf,
      hooks,
      keep: this.bounds!.keep,
      htfKeep: this.bounds!.htfKeep,
    });
    const through = this.o.repo.appliedThrough(this.runId, symbol);
    return { info, layer, inst, funding, last, idx: h.history.length - 1, warmEnd: last.openTime, state: 'ok', fundingThrough: through, repairing: false };
  }

  private onRejected(symbol: string, r: ReplayRejection): void {
    this.log('rejection', symbol, { stage: r.stage, orderId: r.orderId, reason: r.reason, time: r.time });
  }

  /**
   * Paused: an entry is dropped (logged paused_entry_dropped). A reversal keeps its closing part, sent reduce-only
   * for the position's size; only its opening part is dropped.
   */
  private admit(symbol: string, i: OrderIntent): OrderIntent | null {
    if (!this.paused || i.tag !== 'entry' || i.reduceOnly) return i;
    const pos = this.broker.position(symbol);
    const reverses = pos !== null && (pos.qty > 0) !== (i.side === 'buy');
    this.log('paused_entry_dropped', symbol, { orderId: i.id, side: i.side, type: i.type, ...(reverses ? { kept: 'closing_part' } : {}) });
    return reverses ? { ...i, qty: Math.abs(pos.qty), reduceOnly: true } : null;
  }

  // ------------------------------------------------------------------- pass ----

  async onClose(closeTime: number, bars: Map<string, Candle>, info: CloseInfo = { missing: [], behind: [] }): Promise<PassReport> {
    return this.exclusive(() => this.pass(closeTime, bars, info));
  }

  private async pass(closeTime: number, bars: Map<string, Candle>, info: CloseInfo): Promise<PassReport> {
    const t0 = this.o.now();
    const report: PassReport = { closeTime, scanned: 0, stepped: [], skipped: {}, durationMs: 0, latencyMs: 0, rejected: false, errors: [] };
    const skip = (reason: string, symbol: string) => (report.skipped[reason] ??= []).push(symbol);
    if (this.stopped) return this.finish(report, t0);
    this.checkBanned();
    this.settlePendingFunding();
    for (const [symbol, p] of this.pending) skip(p.reason, symbol);
    const missing = new Set(info.missing);
    const behind = new Set(info.behind);

    const plans: PairPlan[] = [];
    let ahead = false;
    for (const p of this.byVolume([...this.pairs.values()])) {
      const symbol = p.info.symbol;
      const bar = bars.get(symbol);
      if (p.state === 'error') skip('error', symbol);
      else if (missing.has(symbol) || !bar) {
        skip('missing_bar', symbol);
        this.log('missing_bar', symbol, { closeTime });
      } else if (bar.openTime <= p.last.openTime) skip('processed', symbol);
      else if (behind.has(symbol)) {
        skip('behind', symbol);
        this.log('behind', symbol, { closeTime, lastStepped: p.last.openTime });
        this.repair(p);
      } else {
        const seq = catchUpBars(p, bar, this.o.candles, this.o.setup.tf);
        if (seq === 'behind') {
          skip('behind', symbol);
          this.log('behind', symbol, { closeTime, lastStepped: p.last.openTime });
          this.repair(p);
        } else if (seq.some((c) => this.o.repo.isProcessed(this.runId, symbol, c.openTime))) {
          // Committed already but not stepped here: memory and the database disagree. Nothing of this pass is stepped:
          // the whole run reloads the saved state, and the next close catches every pair up from it.
          skip('processed', symbol);
          ahead = true;
        } else plans.push({ p, seq });
      }
    }
    if (ahead) {
      this.ledger.log('state_reloaded', undefined, { reason: 'processed_ahead', closeTime });
      await this.reload();
      report.rejected = true;
      return this.finish(report, t0);
    }

    const fundingApplied = await queueFunding(
      { broker: this.broker, funding: this.o.funding, closeTime, appliedThrough: (s) => this.o.repo.appliedThrough(this.runId, s), log: (k, s, d) => this.log(k, s, d) },
      plans,
    );
    const processed: { symbol: string; openTime: number }[] = [];
    const touched = new Set<string>();
    for (const { p, seq } of plans) {
      const symbol = p.info.symbol;
      touched.add(symbol);
      try {
        for (const bar of seq) {
          await p.inst!.step(bar);
          p.last = bar;
          p.idx++;
          processed.push({ symbol, openTime: bar.openTime });
        }
        report.stepped.push(symbol);
      } catch (e) {
        p.state = 'error';
        report.errors.push({ symbol, message: message(e) });
        this.log('skip', symbol, { reason: 'error', message: message(e), bar: p.last.openTime + this.tfMs });
        try {
          p.inst?.dispose();
        } catch {
          // a failed step leaves nothing running
        }
        p.inst = null;
      }
      const through = fundingSteppedThrough(p, this.o.setup.tf);
      if (through > p.fundingThrough) {
        p.fundingThrough = through;
        fundingApplied[symbol] = through;
      }
    }
    report.scanned = report.stepped.length;
    const changed = processed.length > 0 || touched.size > 0 || this.ledger.pendingLogs > 0 || Object.keys(fundingApplied).length > 0;
    if (!this.stopped && changed) {
      const latency = this.o.now() - closeTime;
      if (latency > PASS_DEADLINE_MS) this.log('warning', undefined, { reason: 'deadline_missed', closeTime, latencyMs: latency });
      if (!this.commit(closeTime, processed, touched, fundingApplied, closeTime)) {
        report.rejected = true;
        await this.reload();
      }
    }
    this.prefetchFunding();
    return this.finish(report, t0);
  }

  private finish(report: PassReport, t0: number): PassReport {
    const now = this.o.now();
    report.durationMs = now - t0;
    report.latencyMs = now - report.closeTime;
    this.lastReport = report;
    this.lastPassAt = now;
    return report;
  }

  // ---------------------------------------------------------------- funding ----

  /**
   * Resolves the funding the next passes and live fills will need, between passes and through the REST budget, so a
   * pass reads it from the repo: pairs with a position or orders, and funding pending after a live close. One at a time.
   */
  prefetchFunding(): void {
    if (this.stopped || this.prefetching) return;
    const now = this.o.now();
    const floors = new Map<string, number>();
    for (const p of this.pairs.values()) {
      const s = p.info.symbol;
      if (this.broker.position(s) === null && this.broker.openOrders(s).length === 0) continue;
      floors.set(s, exposureFloor(this.broker, s, Math.max(p.fundingThrough, this.o.repo.appliedThrough(this.runId, s)), p.last.openTime + this.tfMs));
    }
    for (const x of this.pendingFunding) floors.set(x.symbol, Math.min(floors.get(x.symbol) ?? Infinity, x.time - 1));
    if (floors.size === 0) return;
    const task = this.o.funding
      .due([...floors.keys()], now, (s) => floors.get(s)!)
      .then(() => undefined)
      .catch((e: unknown) => this.o.onEvent?.(`funding prefetch failed: ${message(e)}`))
      .finally(() => {
        this.prefetching = null;
        this.background.delete(task);
      });
    this.prefetching = task;
    this.background.add(task);
  }

  /** Charges pending funding whose event the repo now holds (inside the lock). */
  private settlePendingFunding(): void {
    if (this.pendingFunding.length === 0) return;
    const { remaining, settled } = settlePending(this.broker, this.o.funding, this.pendingFunding);
    this.pendingFunding = remaining;
    for (const x of settled) this.log('warning', x.symbol, { reason: 'funding_after_live_close', time: x.time, qty: x.qty, rate: x.rate, amount: x.amount });
  }

  // ------------------------------------------------------------- live fills ----

  /**
   * A live last price (committed at once when anything fills):
   *  - market intents a live fill made earlier in this bar fill at this tick (H2), not at a bar open;
   *  - resting stop/limit orders trigger on the move from the last price. Market orders made at a close still wait
   *    for the next bar's open, as in replay.
   * Before anything can fill, the open position pays the funding that settled since its last funding (resolved only).
   */
  onPrice(symbol: string, last: number, time: number): void {
    if (this.stopped || this.busy > 0) return;
    const p = this.pairs.get(symbol);
    if (!p) return;
    const since = this.liveMarket.get(symbol);
    if (since === undefined && !this.broker.openOrders(symbol).some((o) => o.type !== 'market')) return;
    const before = this.broker.position(symbol);
    const through = fundingBeforeLiveFill(this.broker, this.o.funding, p, time);
    const fills: Fill[] = [];
    if (since !== undefined) {
      this.liveMarket.delete(symbol);
      fills.push(...this.broker.fillMarketAt(symbol, last, time, { submittedAfter: since - 1 }));
    }
    fills.push(...this.broker.onPrice(symbol, last, time, { markets: false }));
    this.afterLiveFills(p, fills, time, before, through);
  }

  /** A live mark price: liquidation of an open position (committed at once). */
  onMark(m: MarkUpdate): void {
    if (this.stopped || this.busy > 0) return;
    const p = this.pairs.get(m.symbol);
    if (!p || this.broker.position(m.symbol) === null) return;
    const before = this.broker.position(m.symbol);
    const through = fundingBeforeLiveFill(this.broker, this.o.funding, p, m.time);
    this.afterLiveFills(p, this.broker.onMark(m.symbol, m.markPrice, m.time), m.time, before, through);
  }

  private afterLiveFills(p: Pair, fills: Fill[], time: number, before: ReturnType<PaperBroker['position']>, through: number | null): void {
    const symbol = p.info.symbol;
    const fundingApplied: Record<string, number> = through === null ? {} : { [symbol]: through };
    if (fills.length === 0 && through === null) return;
    if (fills.length > 0) {
      const bar = this.formingBar(p, time);
      for (const intent of p.layer.onFills(fills, bar, p.idx + 1)) {
        const i = this.admit(symbol, intent);
        if (!i) continue;
        const r = this.broker.submit(i, time);
        if (!r.accepted) this.onRejected(symbol, { stage: 'submit', orderId: i.id, time, reason: r.reason });
        else if (i.type === 'market') this.liveMarket.set(symbol, Math.min(this.liveMarket.get(symbol) ?? Infinity, bar.openTime));
      }
      for (const x of pendingAfterLiveFill(this.o.funding, symbol, before, this.broker.position(symbol), p.fundingThrough, time)) {
        this.pendingFunding.push(x);
        this.log('warning', symbol, { reason: 'funding_pending', time: x.time, qty: x.qty });
      }
    }
    if (!this.commit(this.ledger.lastClose, [], new Set([symbol]), fundingApplied, time)) void this.exclusive(() => this.reload());
  }

  /** The bar that is forming now (live fills between closes belong to it). */
  private formingBar(p: Pair, time: number): Candle {
    const price = this.broker.lastPriceOf(p.info.symbol) ?? p.last.close;
    return { openTime: Math.max(p.last.openTime + this.tfMs, barOpenFor(time, this.o.setup.tf)), open: price, high: price, low: price, close: price, volume: 0 };
  }

  // --------------------------------------------------------------- universe ----

  /** The hourly universe: delisted pairs close their positions and leave; new (or still too young) pairs warm up. */
  async applyUniverse(next: PairInfo[], volumes: Map<string, number>): Promise<void> {
    if (this.stopped) return;
    const keep = new Set(next.map((i) => i.symbol));
    // 1. Delistings, committed before anything else (and before the feed drops their streams).
    await this.exclusive(async () => {
      if (this.stopped) return;
      this.volumes = new Map(volumes);
      for (const s of [...this.pending.keys()]) if (!keep.has(s)) this.pending.delete(s);
      // A rejected commit reloads the saved state, where the delisted pairs still hold their positions: delist again.
      for (let attempt = 0; attempt < 2; attempt++) {
        const gone = [...this.pairs.values()].filter((p) => !keep.has(p.info.symbol));
        if (gone.length === 0) break;
        const touched = new Set<string>();
        for (const p of gone) this.delist(p, touched);
        if (this.commit(this.ledger.lastClose, [], touched, {}, this.o.now())) {
          for (const p of gone) this.pairs.delete(p.info.symbol); // dropped once their forceClose is committed
          break;
        }
        await this.reload();
      }
    });
    // 2. The feed follows at once; 3. new listings warm up and join one by one (each updates the feed again).
    this.o.onSymbolsChanged?.();
    const additions = next.filter((i) => !this.pairs.has(i.symbol) && this.pending.get(i.symbol)?.reason !== 'loading');
    if (additions.length > 0) await this.warm(this.byVolume(additions), 'refresh');
  }

  /** Closes a leaving pair's position at its last price and retires its layer and instance (removed after the commit). */
  private delist(p: Pair, touched: Set<string>): void {
    const symbol = p.info.symbol;
    const hadPosition = this.broker.position(symbol) !== null;
    const price = this.broker.lastPriceOf(symbol) ?? p.last.close;
    const now = this.o.now();
    const fills = this.broker.forceClose(symbol, price, now, 'delisting');
    if (fills.length > 0) p.layer.onFills(fills, this.formingBar(p, now), p.idx + 1);
    p.layer.onDelisted();
    p.inst?.dispose();
    p.inst = null;
    this.liveMarket.delete(symbol);
    touched.add(symbol);
    this.log('delisting', symbol, { hadPosition, price });
  }

  // ---------------------------------------------------------------- repairs ----

  /** A behind pair: reload its history in the background (through the budget); it rejoins via catch-up or a re-warm. */
  private repair(p: Pair): void {
    if (p.repairing) return;
    p.repairing = true;
    const symbol = p.info.symbol;
    const task = withRetry(
      () => loadHistory({ client: this.o.client, repo: this.o.candles, symbol, tf: this.o.setup.tf, bars: this.bars, now: this.o.now(), onboardDate: p.info.onboardDate }),
      this.sleep,
      { cancelled: () => this.stopped },
    )
      .then(() =>
        this.exclusive(async () => {
          if (this.stopped || this.pairs.get(symbol) !== p) return;
          // The stored bars must reach back to the last stepped one, else catch-up cannot bridge it: warm up again.
          const next = this.o.candles.range(symbol, this.o.setup.tf, p.last.openTime + this.tfMs, p.last.openTime + this.tfMs)[0];
          const latest = this.o.candles.latest(symbol, this.o.setup.tf);
          if (!next && latest && latest.openTime > p.last.openTime) await this.rewarm(p, 'gap_after_repair');
        }),
      )
      .catch((e: unknown) => this.log('warning', symbol, { reason: 'repair_failed', message: message(e) }))
      .finally(() => {
        p.repairing = false;
        this.background.delete(task);
      });
    this.background.add(task);
  }

  /**
   * Warm the pair's instance up again on the stored history (its layer and the broker are kept). Holds the lock. The
   * history ends at `through` (a reload: the last bar the database has processed, so later bars are stepped again),
   * else at the newest stored closed bar.
   */
  private async rewarm(p: Pair, reason: string, through?: number): Promise<void> {
    const symbol = p.info.symbol;
    const latest = this.o.candles.latest(symbol, this.o.setup.tf);
    const newest = Math.min(latest?.openTime ?? p.last.openTime, barOpenFor(this.o.now(), this.o.setup.tf) - this.tfMs);
    const to = through === undefined ? newest : Math.min(through, newest);
    const history = contiguousTail(this.o.candles.range(symbol, this.o.setup.tf, to - (this.bars - 1) * this.tfMs, to), this.o.setup.tf);
    if (history.length < this.required()) return;
    const htf = this.htfFromRepo(symbol, history);
    p.inst?.dispose();
    const fresh = await this.build(p.info, p.layer, { history, htf });
    Object.assign(p, { inst: fresh.inst, funding: fresh.funding, last: fresh.last, idx: fresh.idx, warmEnd: through === undefined ? fresh.last.openTime : p.warmEnd });
    // After a reload every pair is re-warmed: the one state_reloaded warning says so.
    if (reason !== 'state_reloaded') this.log('warning', symbol, { reason: 'rewarm', why: reason, lastStepped: fresh.last.openTime });
  }

  /** Background repairs settle (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
    await this.lock;
  }

  // ----------------------------------------------------------------- commit ----

  /** Commits everything new (see RunLedger). False when rejected as a duplicate or stale pass: the caller reloads. */
  private commit(close: number, processed: { symbol: string; openTime: number }[], touched: Set<string>, fundingApplied: Record<string, number>, equityTime: number): boolean {
    if (this.stopped) return true;
    return this.ledger.commit({ broker: this.broker, layers: this.layers, close, processed, touched, fundingApplied, equityTime });
  }

  /**
   * Memory and the database disagree: reload broker and layers from loadState() and rebuild every instance. Each pair
   * rolls back to the database's view: its instance is warmed up through the last bar the database has processed for
   * it (or its first warm-up end), so bars stepped in a rejected pass are stepped again from the stored candles at the
   * next close. A pair flagged `error` stays flagged (no instance). Live-fill bookkeeping is dropped with the state.
   */
  private async reload(): Promise<void> {
    const state = this.o.repo.loadState(this.runId);
    for (const p of this.pairs.values()) p.inst?.dispose();
    this.broker = state ? PaperBroker.restore(state.broker, this.brokerOptions()) : new PaperBroker(this.brokerOptions());
    this.brokerGen++;
    this.ledger.reset(this.broker, state?.lastClose ?? 0);
    this.liveMarket.clear();
    this.pendingFunding = [];
    for (const p of [...this.pairs.values()]) {
      const symbol = p.info.symbol;
      const saved = state?.layers[symbol];
      const through = this.o.repo.lastProcessed(this.runId, symbol) ?? p.warmEnd;
      const opts = { rules: p.info.rules, from: through + this.tfMs };
      p.layer = saved ? StrategyLayer.restore(saved, this.decl!, this.broker, symbol, this.broker.sizingRule(), opts) : new StrategyLayer(this.decl!, this.broker, symbol, this.broker.sizingRule(), opts);
      this.layers.set(symbol, p.layer);
      this.ledger.track(symbol, p.layer);
      p.inst = null;
      p.fundingThrough = this.o.repo.appliedThrough(this.runId, symbol);
      if (p.state === 'error') continue;
      await this.rewarm(p, 'state_reloaded', through);
      if (!p.inst) {
        // Too little stored history to warm up on: it waits for the next universe refresh like a young pair.
        this.pairs.delete(symbol);
        this.pending.set(symbol, { info: p.info, reason: 'insufficient_history' });
      }
    }
    // The reloaded state is the saved one; this writes the state_reloaded warning (and the re-warm notes).
    this.commit(this.ledger.lastClose, [], new Set(), {}, this.o.now());
  }

  // ---------------------------------------------------------------- control ----

  /**
   * From now on entries are dropped (admit). Resting entry orders (not reduce-only) are cancelled now, each logged
   * paused_entry_dropped; exits, stops, liquidation and funding carry on.
   */
  async pause(): Promise<void> {
    this.paused = true;
    await this.exclusive(() => {
      if (this.stopped) return;
      const touched = new Set<string>();
      for (const o of this.broker.openOrders()) {
        if (o.tag !== 'entry' || o.reduceOnly) continue;
        this.broker.cancel(o.id);
        touched.add(o.symbol);
        this.log('paused_entry_dropped', o.symbol, { orderId: o.id, side: o.side, type: o.type, resting: true });
      }
      if (touched.size > 0 && !this.commit(this.ledger.lastClose, [], touched, {}, this.o.now())) return this.reload();
    });
  }

  resume(): void {
    this.paused = false;
  }

  /** Frozen: no more passes or commits; positions stay as they are. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.exclusive(() => {
      for (const p of this.pairs.values()) p.inst?.dispose();
    });
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Owner edits after approval, from the next pass on (applied between passes). */
  async setFees(fees: RunSetup['fees']): Promise<void> {
    await this.exclusive(() => {
      this.broker.setFees(fees);
      this.commit(this.ledger.lastClose, [], new Set(), {}, this.o.now());
    });
  }

  async setSizing(sizing: RunSetup['sizing']): Promise<void> {
    await this.exclusive(() => {
      this.broker.setSizing(sizing);
      this.commit(this.ledger.lastClose, [], new Set(), {}, this.o.now());
    });
  }

  status(): ScannerStatus {
    const skipped: Record<string, number> = {};
    for (const [reason, syms] of Object.entries(this.lastReport?.skipped ?? {})) skipped[reason] = syms.length;
    for (const reason of ['insufficient_history', 'warmup_failed', 'loading'] as const) delete skipped[reason];
    for (const p of this.pending.values()) skipped[p.reason] = (skipped[p.reason] ?? 0) + 1;
    const errors = [...this.pairs.values()].filter((p) => p.state === 'error').length;
    if (errors > 0) skipped.error = errors;
    const warnings: string[] = [];
    if (this.budget()?.banned) warnings.push('rest_banned');
    if (this.paused) warnings.push('paused');
    return {
      universe: this.pairs.size + this.pending.size,
      scannedLastPass: this.lastReport?.scanned ?? 0,
      skipped,
      lastPassAt: this.lastPassAt,
      lastPassMs: this.lastReport?.durationMs ?? 0,
      feed: this.feedStatus?.() ?? null,
      warnings,
    };
  }

  // ---------------------------------------------------------------- helpers ----

  private budget(): RestBudget | undefined {
    return (this.o.client as { budget?: RestBudget }).budget;
  }

  private checkBanned(): void {
    const banned = this.budget()?.banned === true;
    if (banned && !this.wasBanned) this.log('warning', undefined, { reason: 'rest_banned' });
    this.wasBanned = banned;
  }

  /** A log entry from outside the run (e.g. the shared FundingTracker's funding_missing), written with the next commit. */
  note(kind: string, symbol: string | undefined, detail: unknown): void {
    if (!this.stopped) this.log(kind, symbol, detail);
  }

  private log(kind: string, symbol: string | undefined, detail: unknown): void {
    this.ledger.log(kind, symbol, detail);
  }

  /** Runs `fn` after everything queued before it; live ticks are ignored while anything is queued. */
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    this.busy++;
    const run = this.lock.then(fn).finally(() => this.busy--);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** The higher-timeframe series for `history` from what the repo holds (no REST): for a re-warm. */
  private htfFromRepo(symbol: string, history: Candle[]): Record<string, Candle[]> {
    const out: Record<string, Candle[]> = {};
    for (const pineTf of this.secTfs) {
      const native = nativeTimeframe(pineTf);
      out[pineTf] = buildHtf(history, pineTf, native ? this.o.candles.range(symbol, native, 0, this.o.now()) : []);
    }
    return out;
  }
}
