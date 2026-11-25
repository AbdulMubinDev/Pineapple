// Resident strategy instances: one PineTS run per (run, pair), warm-started once over the pair's history and
// then stepped one closed bar at a time, with its history trimmed to a bound. Evidence and the PineTS
// internals relied on: docs/spike/pinets-findings.md, "Resident instances with bounded history" (2b.1-2b.7).
// tests/spike/resident.test.ts and tests/engine/resident.test.ts are the upgrade canaries.
//
// Pieces:
//  - FeedStore: chart candles plus each request.security timeframe, built incrementally from the chart bars
//    exactly as MemoryProvider aggregates them (the last higher-timeframe bar is the developing one).
//  - StoreProvider: the IProvider PineTS reads a FeedStore through (no network).
//  - installUpdateTailFix: our fix for PineTS's updateTail rollback bug (plain `params` arrays).
//  - trimContext / trimTaState / SlidingArray: the bounded-history trimming.
//  - SharedScript: one transpile per script source, shared by every instance of it.
//  - ResidentInstance: the stepping core (broker views in, order calls out).
//  - ResidentStrategy: the production driver, run by the same BarHooks as replay (barHooks()).
//
// Pure (imports `pinets` and pure engine modules only): it also runs bundled inside an isolated-vm isolate
// (spike/resident-bundle.ts).
import { PineTS, Indicator, type Context, type IProvider, type ISymbolInfo, type Kline } from 'pinets';
import type { Candle, PairRules, Timeframe } from '../core/types.js';
import { tfToMs } from '../core/timeframe.js';
import { installStrategyHooks, normaliseOrderArgs, type BrokerView, type OrderCall, type OrderMethod } from './hook-core.js';
import { OTHER_SYMBOL_MESSAGE, bucketClose, bucketOpen, periodOf, perpSymbolInfo, pineTimeframe, toKline, type Period } from './memory-provider.js';
import { callArg, callArgs, codeLines, securityCalls, toBrokerView, toPineOrderCall, type BarHooks } from './pine-runner.js';

export type Bar = Candle;

// ------------------------------------------------------------------ feed ----

/** A timeframe string as a canonical key ('ms:14400000', 'week', 'month'), or null if it is not one. */
function periodKey(timeframe: string): string | null {
  const p = periodOf(timeframe);
  if (!p) return null;
  return p.kind === 'ms' ? `ms:${p.ms}` : p.kind;
}

interface HtfSeries {
  period: Period;
  rows: Kline[];
}

export class FeedStore {
  chart: Kline[] = [];
  private readonly series = new Map<string, HtfSeries>();
  private readonly chartKey: string;

  /**
   * `htf`: the higher-timeframe candles for each request.security timeframe, ending with the (developing)
   * bucket of the last history bar. Omitted: a UTC-day series built from `history`.
   */
  constructor(
    readonly chartTf: string,
    readonly chartTfMs: number,
    readonly info: ISymbolInfo,
    history: Bar[] = [],
    htf?: Record<string, Bar[]>,
  ) {
    this.chartKey = `ms:${chartTfMs}`;
    if (!htf) {
      this.addSeries('D', []);
      for (const c of history) this.append(c);
      return;
    }
    for (const [tf, candles] of Object.entries(htf)) this.addSeries(tf, candles);
    for (const c of history) this.appendChart(c);
    const last = history[history.length - 1];
    if (!last) return;
    for (const [key, s] of this.series) {
      const end = s.rows[s.rows.length - 1];
      const open = bucketOpen(last.openTime, s.period);
      if (!end || end.openTime !== open) {
        throw new Error(`FeedStore: the ${key} candles must end with the bucket of the last history bar (${last.openTime})`);
      }
      // The developing bucket must be built from closed bars only: it ends at the last history bar's close, and
      // its range is that of the history bars in it (exactly, when the history holds the whole bucket so far).
      const inBucket = history.filter((c) => c.openTime >= open);
      const high = Math.max(...inBucket.map((c) => c.high));
      const low = Math.min(...inBucket.map((c) => c.low));
      const whole = history[0]!.openTime <= open;
      const ok = end.close === last.close && (whole ? end.high === high && end.low === low && end.open === inBucket[0]!.open : end.high >= high && end.low <= low);
      if (!ok) throw new Error(`FeedStore: the last ${key} candle (${end.openTime}) is not the aggregate of the closed history bars in it`);
    }
  }

  private addSeries(timeframe: string, candles: Bar[]): void {
    const key = periodKey(timeframe);
    const p = periodOf(timeframe);
    if (!key || !p) throw new Error(`FeedStore: unsupported timeframe ${timeframe}`);
    if (key === this.chartKey || this.series.has(key)) return;
    if (p.kind === 'ms' && (p.ms < this.chartTfMs || p.ms % this.chartTfMs !== 0)) {
      throw new Error(`MemoryProvider cannot build ${timeframe} candles from ${this.chartTf} candles`);
    }
    const rows = candles.map((c) => {
      if (bucketOpen(c.openTime, p) !== c.openTime) throw new Error(`FeedStore: ${timeframe} candle ${c.openTime} is not a bucket open`);
      return toKline(c, bucketClose(c.openTime, p));
    });
    this.series.set(key, { period: p, rows });
  }

  /** The UTC-day series (the spike's name for it). */
  get daily(): Kline[] {
    return this.series.get('ms:86400000')?.rows ?? [];
  }

  /** Rows served for `timeframe`, or null if this store does not hold it. */
  rows(timeframe: string): Kline[] | null {
    const key = periodKey(timeframe);
    if (key === null) return null;
    if (key === this.chartKey) return this.chart;
    return this.series.get(key)?.rows ?? null;
  }

  /** Bars held in the chart and the longest higher-timeframe series. */
  sizes(): { chart: number; htf: number } {
    let htf = 0;
    for (const s of this.series.values()) htf = Math.max(htf, s.rows.length);
    return { chart: this.chart.length, htf };
  }

  /**
   * Forgets old candles once every instance reading this store is warm (warm starts need the history;
   * stepping only reads the last bars: updateTail asks for the higher-timeframe bars from the last one held).
   */
  trim(chartKeep: number, htfKeep: number): void {
    if (this.chart.length > 2 * chartKeep) this.chart = this.chart.slice(-chartKeep);
    for (const s of this.series.values()) if (s.rows.length > 2 * htfKeep) s.rows = s.rows.slice(-htfKeep);
  }

  private appendChart(c: Bar): void {
    const prev = this.chart[this.chart.length - 1];
    if (prev && c.openTime <= prev.openTime) throw new Error(`FeedStore: bar ${c.openTime} is not after ${prev.openTime}`);
    this.chart.push(toKline(c, c.openTime + this.chartTfMs));
  }

  /**
   * Appends a closed chart bar and folds it into every higher-timeframe series as MemoryProvider's
   * aggregateCandles does: a bar in the last bucket updates it, a bar past it opens the next one (the last
   * bucket is then final). Row objects are never mutated (PineTS may hold them): they are replaced.
   */
  append(c: Bar): void {
    this.appendChart(c);
    for (const s of this.series.values()) {
      const open = bucketOpen(c.openTime, s.period);
      const last = s.rows[s.rows.length - 1];
      if (last && last.openTime === open) {
        s.rows[s.rows.length - 1] = { ...last, high: Math.max(last.high, c.high), low: Math.min(last.low, c.low), close: c.close, volume: last.volume + c.volume };
      } else if (!last || open > last.openTime) {
        s.rows.push(toKline({ openTime: open, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }, bucketClose(open, s.period)));
      } else {
        throw new Error(`FeedStore: bar ${c.openTime} falls before the last higher-timeframe bucket ${last.openTime}`);
      }
    }
  }
}

/** IProvider over a FeedStore. `fixUpdateTail` marks PineTS instances whose rollback we repair. */
export class StoreProvider implements IProvider {
  readonly fixUpdateTail = true;
  constructor(private readonly store: FeedStore) {}

  private isChartSymbol(tickerId: string): boolean {
    const root = String((this.store.info as unknown as { root?: string }).root ?? '').toUpperCase();
    const id = String(tickerId).toUpperCase().replace(/^BINANCE:/, '').replace(/\.P$/, '');
    return root !== '' && id === root;
  }

  async getMarketData(tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number): Promise<Kline[]> {
    if (!this.isChartSymbol(tickerId)) throw new Error(OTHER_SYMBOL_MESSAGE);
    const src = this.store.rows(timeframe);
    if (!src) throw new Error(`StoreProvider has no ${timeframe} data`);
    // Scan from the end: live refreshes ask for the last bar or two.
    let lo = src.length;
    while (lo > 0 && (sDate === undefined || src[lo - 1]!.openTime >= sDate)) lo--;
    let hi = src.length;
    while (hi > lo && eDate !== undefined && src[hi - 1]!.openTime >= eDate) hi--;
    let rows = src.slice(lo, hi);
    if (limit && limit > 0) rows = rows.slice(-limit);
    return rows;
  }

  async getSymbolInfo(): Promise<ISymbolInfo> {
    return this.store.info;
  }

  configure(): void {}
}

// ------------------------------------------------------- updateTail fix ----

type Snapshot = { __arrays?: { a: unknown[]; len: number; last: unknown }[] } & Record<string, unknown>;
type PineInternals = {
  source?: { fixUpdateTail?: boolean };
  _snapshotVarState(ctx: unknown): Snapshot;
  _restoreVarState(ctx: unknown, s: Snapshot | null): void;
};

const SCOPES = ['const', 'var', 'let', 'params'] as const;

function isSeries(v: unknown): v is { data: unknown[] } {
  return v !== null && typeof v === 'object' && Array.isArray((v as { data?: unknown }).data) && typeof (v as { get?: unknown }).get === 'function';
}

function containers(ctx: Record<string, unknown>): Record<string, unknown>[] {
  const out = [ctx];
  const l = ctx.lctx as { forEach?: (f: (x: Record<string, unknown>) => void) => void } | undefined;
  l?.forEach?.((x) => out.push(x));
  return out;
}

function plainArrays(ctx: Record<string, unknown>): unknown[][] {
  const out: unknown[][] = [];
  for (const c of containers(ctx)) {
    for (const s of SCOPES) {
      const scope = c[s] as Record<string, unknown> | undefined;
      if (!scope) continue;
      for (const k of Object.keys(scope)) {
        const item = scope[k];
        if (Array.isArray(item)) out.push(item);
      }
    }
  }
  return out;
}

let fixInstalled = false;
/**
 * PineTS.updateTail() rolls a request.security context back to "before the last bar" with
 * _snapshotVarState/_restoreVarState, which truncate Series but not the plain arrays under
 * `params` (where request.security reads its values from). Those arrays then gain one stale entry
 * per refresh. This wraps both methods (prototype, so secondaries created inside PineTS are
 * covered) to also snapshot/restore plain arrays, only for PineTS instances fed by StoreProvider.
 */
export function installUpdateTailFix(): void {
  if (fixInstalled) return;
  fixInstalled = true;
  const P = PineTS.prototype as unknown as PineInternals;
  const snap = P._snapshotVarState;
  const restore = P._restoreVarState;
  P._snapshotVarState = function (this: PineInternals, ctx: unknown) {
    const s = snap.call(this, ctx);
    if (this.source?.fixUpdateTail) s.__arrays = plainArrays(ctx as Record<string, unknown>).map((a) => ({ a, len: a.length, last: a[a.length - 1] }));
    return s;
  };
  P._restoreVarState = function (this: PineInternals, ctx: unknown, s: Snapshot | null) {
    restore.call(this, ctx, s);
    if (!s?.__arrays) return;
    for (const e of s.__arrays) {
      if (e.a.length > e.len) e.a.length = e.len;
      if (e.len > 0) e.a[e.len - 1] = e.last;
    }
  };
}

// ---------------------------------------------------------------- trimming ----

type AnyRec = Record<string, unknown>;

/**
 * Drops the `n` oldest entries IN PLACE (same array object: other holders keep seeing it) and
 * re-allocates the backing store at the new size. `splice(0, n)` keeps the old capacity, so a
 * buffer that once held 3,000 bars would keep 3,000 slots.
 */
function dropFront(a: unknown[], n: number): number {
  if (n <= 0) return 0;
  const tail = a.slice(n);
  a.length = 0;
  for (const v of tail) a.push(v);
  return n;
}

/**
 * PineTS's ta window buffers (ta/utils/history.ts `History`, inside CarryHistory / nonNaWindow
 * state) keep max(5000, 2 x length) entries and never shrink their typed arrays. Their users call
 * `keepFor(length)` before `compact()` on every call, so between bars we can (1) cut a buffer to
 * the `keep` its users last asked for, (2) re-allocate its arrays to fit, and (3) reset `keep` to
 * 0 so the next call's keepFor(length) sets it to 2 x length instead of the 5000 floor.
 */
type History = {
  v: Float64Array;
  nan: Int32Array;
  ph: Float64Array | null;
  pl: Float64Array | null;
  qh: Float64Array | null;
  ql: Float64Array | null;
  off: number;
  start: number;
  end: number;
  keep: number;
  keepFor: unknown;
  compact: unknown;
};
const isHistory = (x: unknown): x is History =>
  !!x && typeof x === 'object' && (x as History).v instanceof Float64Array && typeof (x as History).keepFor === 'function' && typeof (x as History).compact === 'function';

function shrinkHistory(h: History): void {
  const need = h.keep;
  const size = h.end - h.start;
  // (1) As compact() does (drop the oldest, move what is held to physical 0), minus its
  //     "only when the buffer is 3/4 full" condition.
  const drop = need > 0 && size > need ? size - need : 0;
  const from = h.off + drop;
  const held = size - drop;
  // (2) Arrays sized to fit (re-allocated only when over twice what is held).
  const cap = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(held, 1) * 2)));
  const realloc = h.v.length > 2 * cap;
  if (drop === 0 && from === 0 && !realloc) {
    h.keep = 0;
    return;
  }
  const move = <T extends Float64Array | Int32Array>(a: T, n: number, make: (len: number) => T): T => {
    if (!realloc) {
      a.copyWithin(0, from, from + n);
      return a;
    }
    const b = make(Math.max(cap + 1, n));
    b.set(a.subarray(from, from + n));
    return b;
  };
  h.v = move(h.v, held, (n) => new Float64Array(n - 1));
  h.nan = move(h.nan, held + 1, (n) => new Int32Array(n));
  if (h.ph) h.ph = move(h.ph, held + 1, (n) => new Float64Array(n));
  if (h.pl) h.pl = move(h.pl, held + 1, (n) => new Float64Array(n));
  if (h.qh) h.qh = move(h.qh, held + 1, (n) => new Float64Array(n));
  if (h.ql) h.ql = move(h.ql, held + 1, (n) => new Float64Array(n));
  h.off = 0;
  h.start += drop;
  // (3) The next call's keepFor(length) sets the real need.
  h.keep = 0;
}

/**
 * The highest/lowest monotonic deques (history.ts, next to History: idx/val arrays read from
 * `head`) only drop their dead prefix once head > 1024. Between bars we drop it as soon as it is
 * the larger half, shifting the saved head the same way (the next bar commits first anyway).
 */
type Deque = { idx: number[]; val: number[]; head: number; saved: { head: number } };
const isDeque = (x: unknown): x is Deque =>
  !!x && typeof x === 'object' && Array.isArray((x as Deque).idx) && Array.isArray((x as Deque).val) && typeof (x as Deque).head === 'number' && typeof (x as Deque).saved === 'object';

function compactDeque(d: Deque): void {
  if (d.head < 32 || d.head * 2 < d.idx.length) return;
  const h = d.head;
  d.idx = d.idx.slice(h);
  d.val = d.val.slice(h);
  d.head = 0;
  d.saved = { ...d.saved, head: Math.max(0, d.saved.head - h) };
}

const taEntries = (ctx: AnyRec): unknown[] => {
  const ta = ctx.taState as AnyRec | undefined;
  if (!ta) return [];
  const out: unknown[] = [];
  for (const s of Object.values(ta)) {
    out.push(s);
    if (s && typeof s === 'object' && !isHistory(s) && !isDeque(s)) for (const x of Object.values(s as AnyRec)) out.push(x);
  }
  return out;
};

export function trimTaState(ctx: AnyRec): void {
  for (const x of taEntries(ctx)) {
    if (isHistory(x)) shrinkHistory(x);
    else if (isDeque(x)) compactDeque(x);
  }
}

/** Plot / result / alert history: written per bar, never read back by the script. Keeps the last. */
function trimOutputs(ctx: AnyRec): void {
  const cut = (d: unknown) => {
    if (Array.isArray(d) && d.length > 8) dropFront(d, d.length - 1);
  };
  const plots = ctx.plots as Record<string, { data?: unknown[] }> | undefined;
  for (const k of Object.keys(plots ?? {})) cut(plots![k]!.data);
  // alert() events and runtime warnings: the host drains them; keep only the newest.
  cut(ctx.alerts);
  cut(ctx.warnings);
  const result = ctx.result as unknown;
  if (Array.isArray(result)) cut(result);
  else if (result && typeof result === 'object') for (const v of Object.values(result)) cut(v);
}

/** Every history buffer of a run context (data series, scopes, user-function scopes). */
function buffers(ctx: AnyRec): unknown[][] {
  const out: unknown[][] = [];
  const data = ctx.data as Record<string, unknown>;
  for (const k of Object.keys(data ?? {})) if (isSeries(data[k])) out.push(data[k].data);
  for (const c of containers(ctx)) {
    for (const s of SCOPES) {
      const scope = c[s] as AnyRec | undefined;
      if (!scope) continue;
      for (const k of Object.keys(scope)) {
        const item = scope[k];
        if (isSeries(item)) out.push(item.data);
        else if (Array.isArray(item)) out.push(item);
      }
    }
  }
  return out;
}

/**
 * Bounds a run context's history. Runs when the context holds more than `keep` + `slack` bars and cuts
 * back to `keep` (amortised O(1) per bar). Safe because PineTS reads every Series and `params`
 * array relative to its end (Series.get, $.param); the exceptions are handled:
 *  - main context: each buffer is trimmed on its own; barstate.isconfirmed (which indexes
 *    closeTime.data by absolute bar) is overridden by the instance;
 *  - request.security contexts (uniform = true): request.security reads `params[expr][i]` with
 *    i found in data.openTime.data, so every buffer drops the SAME number of oldest entries, and
 *    the stored rollback snapshot (`_varSnapshot`) is shifted by what each buffer lost.
 */
export function trimContext(ctx: AnyRec, keep: number, uniform: boolean, slack = keep): void {
  trimOutputs(ctx);
  const data = ctx.data as Record<string, { data: unknown[] }>;
  const barsHeld = data.openTime?.data.length ?? 0;
  if (barsHeld <= keep + slack) return;
  const D = barsHeld - keep;
  const want = (len: number) => (uniform ? Math.min(D, len - keep) : len - keep);
  const dropped = new Map<unknown[], number>();
  for (const a of buffers(ctx)) {
    const n = dropFront(a, want(a.length));
    if (n > 0) dropped.set(a, n);
  }
  // Shift the rollback snapshot (used by updateTail on security contexts).
  const snap = ctx._varSnapshot as (Snapshot & { main?: AnyRec; lctx?: AnyRec[] }) | undefined;
  if (snap) {
    const shift = (cont: AnyRec, sn: AnyRec | undefined) => {
      if (!sn) return;
      for (const s of SCOPES) {
        const scope = cont[s] as AnyRec | undefined;
        const ss = sn[s] as Record<string, { len: number }> | undefined;
        if (!scope || !ss) continue;
        for (const k of Object.keys(ss)) {
          const item = scope[k];
          const n = isSeries(item) ? dropped.get(item.data) : undefined;
          if (n) ss[k]!.len -= n;
        }
      }
    };
    const cs = containers(ctx);
    shift(cs[0]!, snap.main);
    cs.slice(1).forEach((c, i) => shift(c, snap.lctx?.[i]));
    for (const e of snap.__arrays ?? []) e.len -= dropped.get(e.a) ?? 0;
  }
}

const CHART_FIELDS = ['data', 'open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'openTime', 'closeTime'] as const;

/**
 * An array PineTS can keep indexing by absolute bar number while only the newest bars are held:
 * a Proxy whose `length` and indexes are offset by `base`. Reads below `base` give undefined,
 * except index 0, which keeps the first bar.
 * (Deleting old entries of a plain array does not shrink it.)
 */
export class SlidingArray {
  base = 0;
  buf: unknown[];
  readonly proxy: unknown[];

  private readonly first: unknown;

  constructor(initial: unknown[]) {
    this.buf = initial.slice();
    this.first = initial[0];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.proxy = new Proxy([] as unknown[], {
      get(_t, prop) {
        if (prop === 'length') return self.base + self.buf.length;
        if (typeof prop === 'string') {
          const i = Number(prop);
          // Index 0 stays readable (chart.left_visible_bar_time, drawing helpers and request.security
          // read marketData[0].openTime); other dropped bars read as undefined.
          if (prop !== '' && Number.isInteger(i) && i >= 0) return i < self.base ? (i === 0 ? self.first : undefined) : self.buf[i - self.base];
          if (prop === 'push') return (...v: unknown[]) => self.buf.push(...v) + self.base;
        }
        const v = Reflect.get(self.buf, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(self.buf) : v;
      },
      set(_t, prop, value) {
        const i = Number(prop);
        if (typeof prop === 'string' && prop !== '' && Number.isInteger(i) && i >= 0) {
          if (i >= self.base) self.buf[i - self.base] = value;
          return true;
        }
        return Reflect.set(self.buf, prop, value);
      },
    });
  }

  /** Keeps bars from absolute index `from` on (cuts when `slack` bars beyond it have built up). */
  dropBefore(from: number, slack: number): void {
    const n = from - this.base;
    if (n <= 0 || n < slack) return;
    this.buf = this.buf.slice(n);
    this.base = from;
  }
}

/** Replaces a PineTS instance's chart arrays (and its context's marketData) with SlidingArrays. */
function slideChart(pine: AnyRec, ctx: AnyRec | null): SlidingArray[] {
  const out: SlidingArray[] = [];
  for (const f of CHART_FIELDS) {
    const sa = new SlidingArray(pine[f] as unknown[]);
    pine[f] = sa.proxy;
    out.push(sa);
  }
  if (ctx) ctx.marketData = pine.data;
  return out;
}

// -------------------------------------------------------- shared script ----

type Ctx = Context & {
  idx: number;
  length: number;
  dataVersion: number;
  isSecondaryContext: boolean;
  marketData: { openTime: number }[];
  cache: AnyRec;
  plots: Record<string, { data?: { value: unknown }[] }>;
  pine: { strategy: Record<string, (...a: unknown[]) => unknown>; barstate: object };
};

export class SharedScript {
  readonly indicator: Indicator;
  private readonly owners = new WeakMap<object, ResidentInstance>();
  /** The instance whose run starts next (runs start one at a time). */
  pending: ResidentInstance | null = null;

  constructor(source: string) {
    this.indicator = new Indicator(source);
    const prepared = this.indicator.prepare();
    const original = prepared.fn as unknown as ((ctx: Ctx) => Promise<unknown>) & AnyRec;
    const wrapped = async ($: Ctx) => {
      if ($.isSecondaryContext) return original($);
      let inst = this.owners.get($);
      if (!inst) {
        inst = this.pending ?? undefined;
        if (!inst) throw new Error('SharedScript: a run context started with no instance being created');
        this.pending = null;
        this.owners.set($, inst);
        inst.attach($);
      }
      inst.beforeBar($);
      const r = await original($);
      inst.afterBar($);
      return r;
    };
    for (const k of ['_pineVersion', '_ltfSlices']) (wrapped as unknown as AnyRec)[k] = original[k];
    prepared.fn = wrapped as unknown as typeof prepared.fn;
  }
}

export interface InstanceOptions {
  /** The broker view for main-context bar `bar` (opening at `time`), asked before the script runs on it. */
  broker: (bar: number, time: number) => BrokerView;
  /** After the script ran on main-context bar `bar`, with the order calls it made (drained). Without it, calls wait for drain(). */
  afterBar?: (bar: number, calls: OrderCall[]) => void;
  /** Chart bars of history kept (none = keep everything). Must cover the script's longest lookback. */
  keep?: number;
  /** Bars kept in request.security contexts (default: keep). Must cover lookbacks inside the request. */
  htfKeep?: number;
  /** Extra bars a buffer may gather before it is cut back (default: keep; the cut costs O(keep)). */
  slack?: number;
  /** Unfed strategy.* read-backs throw instead of returning PineTS's empty emulator (see hook-core). */
  guardUnfed?: boolean;
}

/** How much history an instance holds now (bars per buffer; see ResidentStrategy.held). */
export interface HeldHistory {
  /** Bars the instance has run (warm-up included). */
  bars: number;
  /** Main-context bars held in its data series. */
  chartBars: number;
  /** Chart bars held by the sliding chart arrays. */
  chartSlots: number;
  /** The longest main-context buffer (series, params, user-function scopes). */
  longestBuffer: number;
  /** request.security contexts: bars held, and their longest buffer. */
  htfBars: number;
  longestHtfBuffer: number;
  /** The longest ta window buffer (typed-array slots). */
  taSlots: number;
}

export class ResidentInstance {
  readonly calls: OrderCall[] = [];
  ctx: Ctx | null = null;
  private view: BrokerView | null = null;
  private lastBar = -1;
  private chart: SlidingArray[] = [];
  private gen!: AsyncGenerator<Context>;
  private pine!: PineTS;

  private constructor(
    private readonly script: SharedScript,
    private readonly store: FeedStore,
    private readonly opts: InstanceOptions,
  ) {}

  /**
   * Warm start over everything the store holds now (one page), then ready to step. Calls must never
   * overlap (the script's next run context is handed to the instance being created): await each one.
   */
  static async create(script: SharedScript, store: FeedStore, opts: InstanceOptions): Promise<ResidentInstance> {
    if (script.pending) throw new Error('ResidentInstance.create: another instance of this script is being created (await each create)');
    installUpdateTailFix();
    const first = store.chart[0];
    if (!first) throw new Error('ResidentInstance.create: the store holds no chart bars');
    const inst = new ResidentInstance(script, store, opts);
    // sDate: request.security sizes its history from it (not from marketData[0], which trimming frees).
    inst.pine = new PineTS(new StoreProvider(store), store.info.tickerid, store.chartTf, undefined, first.openTime, Number.MAX_SAFE_INTEGER);
    await inst.pine.ready();
    // Before run(): the run's context takes `marketData` from pine.data at start.
    if (opts.keep) inst.chart = slideChart(inst.pine as unknown as AnyRec, null);
    inst.gen = inst.pine.run(script.indicator, undefined, Math.max(store.chart.length, 1)) as AsyncGenerator<Context>;
    script.pending = inst;
    try {
      const r = await inst.gen.next();
      if (r.done) throw new Error('warm-up ended the run');
    } finally {
      if (script.pending === inst) script.pending = null;
    }
    inst.trim();
    return inst;
  }

  attach($: Ctx): void {
    this.ctx = $;
    installStrategyHooks($.pine.strategy, {
      onCall: (method: OrderMethod, raw: unknown[]) => {
        this.calls.push({ bar: $.idx, time: $.marketData[$.idx]!.openTime, method, args: normaliseOrderArgs(method, raw) });
        return undefined;
      },
      view: () => this.view!,
      guardUnfed: this.opts.guardUnfed,
    });
    // Only closed bars are stepped: confirmed. (PineTS reads closeTime.data[idx] absolutely here.)
    Object.defineProperty($.pine.barstate, 'isconfirmed', { get: () => true, configurable: true });
  }

  beforeBar($: Ctx): void {
    if ($.length < $.marketData.length) $.length = $.marketData.length;
    if ($.idx !== this.lastBar) {
      this.lastBar = $.idx;
      // New bar: cached request.security contexts pull the new higher-timeframe data via updateTail().
      $.dataVersion = ($.dataVersion ?? 0) + 1;
    }
    this.view = this.opts.broker($.idx, $.marketData[$.idx]!.openTime);
  }

  afterBar($: Ctx): void {
    if (this.opts.afterBar) this.opts.afterBar($.idx, this.drain());
  }

  /** Hands over (and forgets) the order calls recorded since the last drain. */
  drain(): OrderCall[] {
    return this.calls.splice(0, this.calls.length);
  }

  /** Runs the script on the store's newest bar (the caller appended it to the store). */
  async step(): Promise<void> {
    const k = this.store.chart[this.store.chart.length - 1]!;
    const p = this.pine as unknown as AnyRec & { data: Kline[] };
    p.data.push(k);
    (p.open as number[]).push(k.open);
    (p.high as number[]).push(k.high);
    (p.low as number[]).push(k.low);
    (p.close as number[]).push(k.close);
    (p.volume as number[]).push(k.volume);
    (p.hl2 as number[]).push((k.high + k.low) / 2);
    (p.hlc3 as number[]).push((k.high + k.low + k.close) / 3);
    (p.ohlc4 as number[]).push((k.open + k.high + k.low + k.close) / 4);
    (p.hlcc4 as number[]).push((k.high + k.low + k.close + k.close) / 4);
    (p.openTime as number[]).push(k.openTime);
    (p.closeTime as number[]).push(k.closeTime);
    const r = await this.gen.next();
    if (r.done) throw new Error('run ended');
    this.trim();
  }

  /** Ends the PineTS run (the generator); the instance cannot step afterwards. */
  close(): void {
    void this.gen?.return(undefined as unknown as Context).catch(() => undefined);
    this.ctx = null;
  }

  private secondaries(): { context: AnyRec; pineTS: AnyRec; _sliding?: SlidingArray[] }[] {
    const out: { context: AnyRec; pineTS: AnyRec; _sliding?: SlidingArray[] }[] = [];
    for (const v of Object.values(this.ctx?.cache ?? {})) {
      const sec = v as { context?: AnyRec; pineTS?: AnyRec; _sliding?: SlidingArray[] } | undefined;
      if (sec?.context && sec.pineTS) out.push(sec as { context: AnyRec; pineTS: AnyRec; _sliding?: SlidingArray[] });
    }
    return out;
  }

  held(): HeldHistory {
    const ctx = this.ctx as unknown as AnyRec | null;
    const longest = (c: AnyRec) => Math.max(0, ...buffers(c).map((a) => a.length));
    const barsOf = (c: AnyRec) => (c.data as Record<string, { data: unknown[] }>).openTime?.data.length ?? 0;
    let taSlots = 0;
    const ta = (c: AnyRec) => {
      for (const x of taEntries(c)) if (isHistory(x)) taSlots = Math.max(taSlots, x.v.length);
    };
    if (!ctx) return { bars: 0, chartBars: 0, chartSlots: 0, longestBuffer: 0, htfBars: 0, longestHtfBuffer: 0, taSlots: 0 };
    ta(ctx);
    let htfBars = 0;
    let longestHtfBuffer = 0;
    for (const sec of this.secondaries()) {
      htfBars = Math.max(htfBars, barsOf(sec.context));
      longestHtfBuffer = Math.max(longestHtfBuffer, longest(sec.context));
      ta(sec.context);
    }
    return {
      bars: this.lastBar + 1,
      chartBars: barsOf(ctx),
      chartSlots: this.chart.length ? Math.max(...this.chart.map((s) => s.buf.length)) : (ctx.marketData as unknown[]).length,
      longestBuffer: longest(ctx),
      htfBars,
      longestHtfBuffer,
      taSlots,
    };
  }

  private trim(): void {
    const keep = this.opts.keep;
    if (!keep || !this.ctx) return;
    const slack = this.opts.slack ?? keep;
    trimContext(this.ctx as unknown as AnyRec, keep, false, slack);
    trimTaState(this.ctx as unknown as AnyRec);
    for (const sa of this.chart) sa.dropBefore(this.ctx.idx + 1 - keep, slack);
    const hk = this.opts.htfKeep ?? keep;
    const hs = Math.min(slack, hk);
    for (const sec of this.secondaries()) {
      trimContext(sec.context, hk, true, hs);
      trimTaState(sec.context);
      // The secondary's own chart arrays: updateTail replaces / appends its last bars only.
      sec._sliding ??= slideChart(sec.pineTS, sec.context);
      const held = (sec.pineTS.data as unknown[]).length;
      for (const sa of sec._sliding) sa.dropBefore(held - hk, hs);
    }
  }
}

// ------------------------------------------------------------ strategy ----

export interface ResidentOptions {
  source: string;
  symbol: string;
  tf: Timeframe;
  rules: PairRules;
  /** Closed chart bars, oldest first, contiguous: the warm start runs over all of them. */
  history: Candle[];
  /**
   * Per request.security timeframe (compileScript's securityTimeframes): its candles, ending with the bucket
   * of the last history bar. They must be `aggregateCandles(history, tf)`, or the same built from stored
   * CLOSED chart bars reaching further back: never an exchange kline of the timeframe, whose developing bar
   * includes the unclosed chart bar. FeedStore rejects a last bucket that is not the closed bars' aggregate.
   */
  htf: Record<string, Candle[]>;
  /** The only callbacks. `from` must be after the history, so warm-up bars see a flat account (as in replay). */
  hooks: BarHooks;
  keep: number;
  htfKeep: number;
  /** Extra bars a buffer may gather before it is cut back (default keep; htfKeep in request.security contexts). */
  slack?: number;
}

/** One transpile per script source while any instance of it is alive. */
const scripts = new Map<string, { script: SharedScript; refs: number }>();
let createQueue: Promise<unknown> = Promise.resolve();

/**
 * A live strategy instance for one pair, driven by the same BarHooks as replay (barHooks()), so stepping
 * gives replay's event order: hooks.before (fills, funding, marks; the script's view), the script,
 * hooks.after (its order calls) for every closed bar. Plan 3 moves it into an isolate: create's options are
 * JSON apart from `hooks`.
 */
export class ResidentStrategy {
  private current: Candle | null = null;
  private lastIdx = -1;
  private busy = false;
  private disposed = false;
  private failed: unknown = null;
  private core: ResidentInstance | null = null;
  private store: FeedStore | null;
  private hooks: BarHooks | null;

  /** The warm-up history, dropped once the warm start is done (the store keeps only what stepping needs). */
  private warm: Candle[] | null;
  private readonly o: Pick<ResidentOptions, 'symbol' | 'tf' | 'keep' | 'htfKeep'>;

  private constructor(
    o: ResidentOptions,
    store: FeedStore,
    private readonly source: string,
  ) {
    this.o = { symbol: o.symbol, tf: o.tf, keep: o.keep, htfKeep: o.htfKeep };
    this.store = store;
    this.hooks = o.hooks;
    this.warm = o.history;
  }

  /** Warm start over `history`. Creates run one at a time (spike 2b.7): concurrent calls wait in a queue. */
  static create(o: ResidentOptions): Promise<ResidentStrategy> {
    const run = createQueue.then(() => ResidentStrategy.build(o));
    createQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private static async build(o: ResidentOptions): Promise<ResidentStrategy> {
    if (o.history.length === 0) throw new Error(`ResidentStrategy(${o.symbol}): no history to warm up on`);
    for (const [k, v] of [['keep', o.keep], ['htfKeep', o.htfKeep]] as const) {
      if (!Number.isInteger(v) || v < 1) throw new Error(`ResidentStrategy(${o.symbol}): ${k} must be a positive integer`);
    }
    const tfMs = tfToMs(o.tf);
    for (let i = 1; i < o.history.length; i++) {
      if (o.history[i]!.openTime !== o.history[i - 1]!.openTime + tfMs) throw new Error(`ResidentStrategy(${o.symbol}): history has a gap after ${o.history[i - 1]!.openTime}`);
    }
    const info = perpSymbolInfo(o.symbol, { mintick: o.rules.tickSize, qtyStep: o.rules.stepSize });
    const store = new FeedStore(pineTimeframe(o.tf), tfMs, info, o.history, o.htf);
    let entry = scripts.get(o.source);
    if (!entry) {
      entry = { script: new SharedScript(o.source), refs: 0 };
      scripts.set(o.source, entry);
    }
    entry.refs++;
    const self = new ResidentStrategy(o, store, o.source);
    try {
      self.core = await ResidentInstance.create(entry.script, store, {
        broker: (idx, time) => self.before(idx, time),
        afterBar: (idx, calls) => self.after(idx, calls),
        keep: o.keep,
        htfKeep: o.htfKeep,
        slack: o.slack,
        guardUnfed: true,
      });
    } catch (e) {
      self.release();
      throw e;
    }
    self.warm = null;
    store.trim(o.keep, o.htfKeep);
    return self;
  }

  private barAt(idx: number): Candle {
    const bar = this.warm ? this.warm[idx] : this.current;
    if (!bar) throw new Error(`ResidentStrategy(${this.o.symbol}): no candle for bar ${idx}`);
    return bar;
  }

  private before(idx: number, time: number) {
    // One before/after pair per bar, in order: a repeat would double the broker's work and the order calls.
    if (idx !== this.lastIdx + 1) throw new Error(`ResidentStrategy(${this.o.symbol}): bar ${idx} ran out of order (after ${this.lastIdx})`);
    this.lastIdx = idx;
    const bar = this.barAt(idx);
    if (time !== bar.openTime) throw new Error(`ResidentStrategy(${this.o.symbol}): PineTS bar ${idx} is not candle ${bar.openTime}`);
    return toBrokerView(this.live().hooks.before(bar, idx));
  }

  private after(idx: number, calls: OrderCall[]): void {
    this.live().hooks.after(this.barAt(idx), idx, calls.map((c) => toPineOrderCall(c.method, c.args)));
  }

  /** Runs hooks.before, the script and hooks.after for one new closed bar (the next after the last one). */
  async step(bar: Candle): Promise<void> {
    const { store, core } = this.live();
    if (this.failed) throw new Error(`ResidentStrategy(${this.o.symbol}): an earlier step failed: ${String(this.failed)}`);
    if (this.busy) throw new Error(`ResidentStrategy(${this.o.symbol}): step() while a step is running`);
    const last = store.chart[store.chart.length - 1]!;
    const tfMs = tfToMs(this.o.tf);
    if (bar.openTime !== last.openTime + tfMs) throw new Error(`ResidentStrategy(${this.o.symbol}): bar ${bar.openTime} does not follow ${last.openTime}`);
    this.busy = true;
    try {
      this.current = bar;
      store.append(bar);
      if (!core) throw new Error(`ResidentStrategy(${this.o.symbol}): not created`);
      await core.step();
      store.trim(this.o.keep, this.o.htfKeep);
    } catch (e) {
      this.failed = e instanceof Error ? e.message : e;
      throw e;
    } finally {
      this.busy = false;
    }
  }

  /** How much history the instance and its candle store hold (for bounds checks and monitoring). */
  held(): HeldHistory & { storeChart: number; storeHtf: number } {
    const { store, core } = this.live();
    const s = store.sizes();
    return { ...core!.held(), storeChart: s.chart, storeHtf: s.htf };
  }

  /** The newest value of plot `title` (plots keep only their last entries). */
  lastPlot(title: string): unknown {
    const d = this.live().core?.ctx?.plots[title]?.data;
    return d?.[d.length - 1]?.value;
  }

  /** Ends the instance and drops everything it holds. Not while a step is running (await it first). */
  dispose(): void {
    if (this.disposed) return;
    if (this.busy) throw new Error(`ResidentStrategy(${this.o.symbol}): dispose() while a step is running`);
    this.disposed = true;
    this.core?.close();
    this.core = null;
    this.store = null;
    this.hooks = null;
    this.current = null;
    this.warm = null;
    this.release();
  }

  private live(): { store: FeedStore; core: ResidentInstance | null; hooks: BarHooks } {
    if (this.disposed || !this.store || !this.hooks) throw new Error(`ResidentStrategy(${this.o.symbol}): disposed`);
    return { store: this.store, core: this.core, hooks: this.hooks };
  }

  private release(): void {
    const e = scripts.get(this.source);
    if (e && --e.refs <= 0) scripts.delete(this.source);
  }
}

// ---------------------------------------------------------------- bounds ----

const KEEP_FLOOR = 100;
const HTF_KEEP_FLOOR = 50;
const BOUND_FACTOR = 3;
/** Words after which `[` opens a tuple or a list, never a history reference. */
const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'else', 'for', 'to', 'by', 'in', 'while', 'switch', 'var', 'varip', 'return', 'export', 'import', 'method', 'type']);

type Ref = { line: number; offset: number | null };

export interface ScriptBounds {
  keep: number;
  htfKeep: number;
  /**
   * What the script reads that behaves differently live (a static scan; comments and strings ignored):
   * barstate.* (every stepped bar is the last, realtime one) and bar_index (it counts from the warm start).
   */
  uses: { barstate: boolean; barIndex: boolean };
}

/** Every `x[n]` history reference in `lines` (comments and strings blanked); offset null = not a literal. */
function historyRefs(lines: string[], firstLine = 1): Ref[] {
  const refs: Ref[] = [];
  lines.forEach((l, li) => {
    for (let i = 0; i < l.length; i++) {
      if (l[i] !== '[') continue;
      let j = i - 1;
      while (j >= 0 && (l[j] === ' ' || l[j] === '\t')) j--;
      if (j < 0) continue;
      const ch = l[j]!;
      if (/[A-Za-z0-9_]/.test(ch)) {
        let w = j;
        while (w > 0 && /[A-Za-z0-9_]/.test(l[w - 1]!)) w--;
        if (KEYWORDS.has(l.slice(w, j + 1))) continue;
      } else if (ch !== ')' && ch !== ']') continue;
      // The bracket's content, to its matching `]` (on this line: Pine offsets do not span lines).
      let depth = 0;
      let k = i;
      for (; k < l.length; k++) {
        if (l[k] === '[') depth++;
        else if (l[k] === ']' && --depth === 0) break;
      }
      const inner = l.slice(i + 1, k).trim();
      if (inner === '') continue; // a type: float[]
      refs.push({ line: firstLine + li, offset: /^\d+$/.test(inner) ? Number(inner) : null });
    }
  });
  return refs;
}

/** Names the script defines itself (variables, tuple parts, functions). */
function definedNames(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    const fn = /^\s*(?:method\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*=>/.exec(l);
    if (fn) out.add(fn[1]!);
    const v = /^\s*(?:(?:var|varip|const|simple|series)\s+)*(?:[A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])?\s+)?([A-Za-z_]\w*)\s*:?=(?!=)/.exec(l);
    if (v) out.add(v[1]!);
    const t = /^\s*\[([^\]]*)\]\s*=(?!=)/.exec(l);
    if (t) for (const n of t[1]!.split(',')) if (n.trim()) out.add(n.trim());
  }
  return out;
}

/**
 * The history a resident instance of `source` must keep, from a static scan of its `x[n]` references:
 * keep = max(100, 3 x the longest n), htfKeep = max(50, 3 x the longest n inside request.security
 * expressions). An expression that uses a variable or function of the script takes the whole script's
 * longest n (PineTS evaluates the script in the request.security context). An offset that is not an
 * integer literal (an input, a runtime expression) cannot be bounded.
 */
export function scriptBounds(source: string): ScriptBounds | { error: string } {
  const lines = codeLines(source);
  const refs = historyRefs(lines);
  const bad = refs.find((r) => r.offset === null);
  if (bad) return { error: `history offset on line ${bad.line} cannot be bounded in v1` };
  const longest = Math.max(0, ...refs.map((r) => r.offset!));
  const names = definedNames(lines);
  let htfLongest = 0;
  // The calls' text with strings blanked too (codeLines keeps string quotes, so positions match).
  for (const call of securityCalls(lines)) {
    const expr = callArg(callArgs(call.text), 'expression', 2) ?? '';
    const own = historyRefs(expr.split('\n'), call.line);
    const usesScript = [...expr.matchAll(/(?<![\w.])([A-Za-z_]\w*)(?![\w])/g)].some((m) => names.has(m[1]!));
    htfLongest = Math.max(htfLongest, usesScript ? longest : 0, ...own.map((r) => r.offset!));
  }
  const uses = (re: RegExp) => lines.some((l) => re.test(l));
  return {
    keep: Math.max(KEEP_FLOOR, BOUND_FACTOR * longest),
    htfKeep: Math.max(HTF_KEEP_FLOOR, BOUND_FACTOR * htfLongest),
    uses: { barstate: uses(/(?<![\w.])barstate\./), barIndex: uses(/(?<![\w.])bar_index(?!\w)/) },
  };
}
