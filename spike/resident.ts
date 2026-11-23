// Task 2b: resident script instances with bounded history.
//
// Pure module (imports only `pinets` and ./hook-core): runs in Node and, bundled with esbuild, inside
// an isolated-vm isolate (spike/resident-isolate.ts).
//
// Pieces:
//  - FeedStore: one per symbol, shared by every instance on that symbol. Chart candles plus UTC-day
//    candles built incrementally (the current day is the developing day). Instances keep no copy.
//  - SharedScript: one transpile per script source, shared by all its instances. The prepared
//    per-bar function is wrapped once; each run context is bound to its instance on first sight.
//  - ResidentInstance: one PineTS run, warm-started over the store's history in one page, then
//    stepped one closed bar per step(). Order calls are recorded, read-backs come from `broker`.
//  - Daily request.security contexts are refreshed incrementally by PineTS's own updateTail(),
//    with our fix for its rollback bug (installUpdateTailFix).
//  - trim(): after each step, drops history beyond `keep` bars from every growing buffer.
import { PineTS, Indicator, type Context, type IProvider, type ISymbolInfo, type Kline } from 'pinets';
import { installStrategyHooks, normaliseOrderArgs, type BrokerView, type OrderCall, type OrderMethod } from '../src/engine/hook-core.js';

export const H4_MS = 14_400_000;
export const DAY_MS = 86_400_000;

export interface Bar {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const kline = (c: Bar, tfMs: number): Kline => ({
  openTime: c.openTime,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
  volume: c.volume,
  closeTime: c.openTime + tfMs,
  quoteAssetVolume: 0,
  numberOfTrades: 0,
  takerBuyBaseAssetVolume: 0,
  takerBuyQuoteAssetVolume: 0,
  ignore: 0,
});

// ------------------------------------------------------------------ feed ----

export class FeedStore {
  chart: Kline[] = [];
  daily: Kline[] = [];

  constructor(
    readonly chartTf: string,
    readonly chartTfMs: number,
    readonly info: ISymbolInfo,
    history: Bar[] = [],
  ) {
    for (const c of history) this.append(c);
  }

  /**
   * Forgets old candles once every instance on this symbol is warm (warm starts need the history;
   * stepping only reads the last bars: updateTail asks for the daily bars from the last one held).
   */
  trim(chartKeep: number, dailyKeep: number): void {
    if (this.chart.length > 2 * chartKeep) this.chart = this.chart.slice(-chartKeep);
    if (this.daily.length > 2 * dailyKeep) this.daily = this.daily.slice(-dailyKeep);
  }

  /** Appends a closed chart bar and folds it into the (developing) UTC day. Objects are never mutated. */
  append(c: Bar): void {
    this.chart.push(kline(c, this.chartTfMs));
    const day = Math.floor(c.openTime / DAY_MS) * DAY_MS;
    const last = this.daily[this.daily.length - 1];
    if (last && last.openTime === day) {
      this.daily[this.daily.length - 1] = {
        ...last,
        high: Math.max(last.high, c.high),
        low: Math.min(last.low, c.low),
        close: c.close,
        volume: last.volume + c.volume,
      };
    } else {
      this.daily.push(kline({ openTime: day, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }, DAY_MS));
    }
  }
}

/** IProvider over a FeedStore. `fixUpdateTail` marks PineTS instances whose rollback we repair. */
export class StoreProvider implements IProvider {
  readonly fixUpdateTail = true;
  constructor(private readonly store: FeedStore) {}

  async getMarketData(_tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number): Promise<Kline[]> {
    const tf = String(timeframe).toUpperCase();
    const src = tf === this.store.chartTf.toUpperCase() ? this.store.chart : tf === 'D' || tf === '1D' ? this.store.daily : null;
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

export function trimTaState(ctx: AnyRec): void {
  const ta = ctx.taState as AnyRec | undefined;
  if (!ta) return;
  const visit = (x: unknown) => {
    if (isHistory(x)) shrinkHistory(x);
    else if (isDeque(x)) compactDeque(x);
  };
  for (const s of Object.values(ta)) {
    visit(s);
    if (s && typeof s === 'object' && !isHistory(s) && !isDeque(s)) for (const x of Object.values(s as AnyRec)) visit(x);
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

/**
 * Bounds a run context's history. Runs when the context holds more than 2 x `keep` bars and cuts
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
  const cut = (a: unknown[]) => {
    const n = dropFront(a, want(a.length));
    if (n > 0) dropped.set(a, n);
  };
  for (const k of Object.keys(data)) if (isSeries(data[k])) cut(data[k].data);
  for (const c of containers(ctx)) {
    for (const s of SCOPES) {
      const scope = c[s] as AnyRec | undefined;
      if (!scope) continue;
      for (const k of Object.keys(scope)) {
        const item = scope[k];
        if (isSeries(item)) cut(item.data);
        else if (Array.isArray(item)) cut(item);
      }
    }
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

  /** Keeps bars from absolute index `from` on (cuts when 2 x the kept span has built up). */
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
      if (!$.isSecondaryContext) {
        let inst = this.owners.get($);
        if (!inst) {
          inst = this.pending!;
          this.pending = null;
          this.owners.set($, inst);
          inst.attach($);
        }
        inst.beforeBar($);
      }
      return original($);
    };
    for (const k of ['_pineVersion', '_ltfSlices']) (wrapped as unknown as AnyRec)[k] = original[k];
    prepared.fn = wrapped as unknown as typeof prepared.fn;
  }
}

export interface InstanceOptions {
  broker: (bar: number) => BrokerView;
  /** Chart bars of history kept (none = keep everything). Must cover the script's longest lookback. */
  keep?: number;
  /** Bars kept in request.security contexts (default: keep). Must cover lookbacks inside the request. */
  htfKeep?: number;
  /** Extra bars a buffer may gather before it is cut back (default: keep; the cut costs O(keep)). */
  slack?: number;
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

  /** Warm start over everything the store holds now (one page), then ready to step. */
  static async create(script: SharedScript, store: FeedStore, opts: InstanceOptions): Promise<ResidentInstance> {
    installUpdateTailFix();
    const inst = new ResidentInstance(script, store, opts);
    const first = store.chart[0]!.openTime;
    // sDate: request.security sizes its history from it (not from marketData[0], which trimming frees).
    inst.pine = new PineTS(new StoreProvider(store), store.info.tickerid, store.chartTf, undefined, first, Number.MAX_SAFE_INTEGER);
    await inst.pine.ready();
    // Before run(): the run's context takes `marketData` from pine.data at start.
    if (opts.keep) inst.chart = slideChart(inst.pine as unknown as AnyRec, null);
    inst.gen = inst.pine.run(script.indicator, undefined, Math.max(store.chart.length, 1)) as AsyncGenerator<Context>;
    script.pending = inst;
    const r = await inst.gen.next();
    if (r.done) throw new Error('warm-up ended the run');
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
    });
    // Only closed bars are stepped: confirmed. (PineTS reads closeTime.data[idx] absolutely here.)
    Object.defineProperty($.pine.barstate, 'isconfirmed', { get: () => true, configurable: true });
  }

  beforeBar($: Ctx): void {
    if ($.length < $.marketData.length) $.length = $.marketData.length;
    if ($.idx !== this.lastBar) {
      this.lastBar = $.idx;
      // New bar: cached request.security contexts pull the new daily data via updateTail().
      $.dataVersion = ($.dataVersion ?? 0) + 1;
    }
    this.view = this.opts.broker($.idx);
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

  private trim(): void {
    const keep = this.opts.keep;
    if (!keep || !this.ctx) return;
    const slack = this.opts.slack ?? keep;
    trimContext(this.ctx as unknown as AnyRec, keep, false, slack);
    trimTaState(this.ctx as unknown as AnyRec);
    for (const sa of this.chart) sa.dropBefore(this.ctx.idx + 1 - keep, slack);
    for (const v of Object.values(this.ctx.cache)) {
      const sec = v as { context?: AnyRec; pineTS?: AnyRec; _sliding?: SlidingArray[] } | undefined;
      if (sec?.context && sec.pineTS) {
        const hk = this.opts.htfKeep ?? keep;
        const hs = Math.min(slack, hk);
        trimContext(sec.context, hk, true, hs);
        trimTaState(sec.context);
        // The secondary's own chart arrays: updateTail replaces / appends its last bars only.
        sec._sliding ??= slideChart(sec.pineTS, sec.context);
        const held = (sec.pineTS.data as unknown[]).length;
        for (const sa of sec._sliding) sa.dropBefore(held - hk, hs);
      }
    }
  }
}
