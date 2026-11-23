// Task 2 spike: how PineTS 0.13.1 lets OUR broker be the source of truth.
//
// The hook (see docs/spike/pinets-findings.md, "Recommended hook design"):
//   1. Transpile once with the public `Indicator` API and wrap the prepared per-bar function.
//      PineTS calls that function once per bar with the run's Context (`$`), AFTER its own
//      broker step for the bar and BEFORE the script body: our per-bar hook point.
//   2. On the first bar, replace the order primitives on `$.pine.strategy` (entry/exit/close/
//      close_all/order/cancel/cancel_all) with recorders. They are NOT forwarded to PineTS's
//      emulator unless `forward` says so, so the emulator never fills anything.
//   3. Replace the read-back getters (position_size, position_avg_price, equity, netprofit,
//      openprofit, opentrades) with functions that read the broker view for the current bar.
//
// No network: PineTS is only ever given in-memory candles (an array or MemoryProvider).
import { readFileSync } from 'node:fs';
import { PineTS, Indicator, type Context, type IProvider, type ISymbolInfo, type Kline } from 'pinets';
import { loadCandles } from '../src/data/csv.js';
import type { Candle } from '../src/core/types.js';

export const H4_MS = 14_400_000;
export const DAY_MS = 86_400_000;
export const TICKER = 'BINANCE:BTCUSDT.P';
export const CHART_TF = '240';

/** TradingView comparison window: Jan 1 2024 00:00 UTC up to the end of Nov 18 2026. */
export const MA_CROSS_WINDOW = { from: Date.UTC(2024, 0, 1), to: Date.UTC(2026, 10, 19) };
export const KYBER_WINDOW = MA_CROSS_WINDOW;

export function probeSource(name: string): string {
  if (name === '08-kyberswing') return readFileSync('tests/fixtures/KyberSwing.pine', 'utf8');
  return readFileSync(`spike/probes/${name}.pine`, 'utf8');
}

export function fixtureCandles(): Candle[] {
  return loadCandles('tests/fixtures/BTCUSDT_4h.csv', '4h');
}

export function toKline(c: Candle, tfMs: number): Kline {
  return {
    ...c,
    closeTime: c.openTime + tfMs,
    quoteAssetVolume: 0,
    numberOfTrades: 0,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

/** UTC-day candles from 4h candles (Binance and TradingView crypto days start at 00:00 UTC). */
export function aggregateDaily(c4h: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of c4h) {
    const day = Math.floor(c.openTime / DAY_MS) * DAY_MS;
    const last = out[out.length - 1];
    if (last && last.openTime === day) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ openTime: day, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  return out;
}

/** Symbol facts PineTS's broker uses (tick grid, qty step). Values for Binance BTCUSDT perpetual. */
export const BTCUSDT_PERP_SYMINFO = {
  ticker: 'BTCUSDT.P',
  tickerid: TICKER,
  prefix: 'BINANCE',
  root: 'BTCUSDT',
  description: 'BTCUSDT Perpetual',
  type: 'crypto',
  basecurrency: 'BTC',
  currency: 'USDT',
  timezone: 'Etc/UTC',
  session: '24x7',
  mintick: 0.1,
  minmove: 1,
  pricescale: 10,
  pointvalue: 1,
  mincontract: 0.001,
} as unknown as ISymbolInfo;

/**
 * In-memory data source: serves the chart's 4h candles and daily candles aggregated from them.
 * push() grows it (bar-by-bar mode): the daily candle of the current day is then the developing
 * day built from the 4h bars seen so far, which is what TradingView shows on a realtime bar.
 */
export class MemoryProvider implements IProvider {
  private readonly c4h: Candle[];
  public readonly requests: { timeframe: string; sDate?: number; eDate?: number }[] = [];

  constructor(candles4h: Candle[], private readonly info: ISymbolInfo = BTCUSDT_PERP_SYMINFO) {
    this.c4h = candles4h.slice();
  }

  push(c: Candle): void {
    this.c4h.push(c);
  }

  async getMarketData(_tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number): Promise<Kline[]> {
    this.requests.push({ timeframe, sDate, eDate });
    const tf = String(timeframe).toUpperCase();
    const src =
      tf === '240' || tf === '4H'
        ? this.c4h.map((c) => toKline(c, H4_MS))
        : tf === 'D' || tf === '1D'
          ? aggregateDaily(this.c4h).map((c) => toKline(c, DAY_MS))
          : null;
    if (!src) throw new Error(`MemoryProvider has no ${timeframe} data`);
    let rows = src.filter((k) => (sDate === undefined || k.openTime >= sDate) && (eDate === undefined || k.openTime < eDate));
    if (limit && limit > 0) rows = rows.slice(-limit);
    return rows.map((k) => ({ ...k }));
  }

  async getSymbolInfo(): Promise<ISymbolInfo> {
    return this.info;
  }

  configure(): void {}
}

// ---------------------------------------------------------------- the hook ----

import { SIGNATURES, normaliseOrderArgs, scalarList, type BrokerView, type OrderCall, type OrderMethod } from './hook-core.js';
export { normaliseOrderArgs, type BrokerTrade, type BrokerView, type OrderCall, type OrderMethod } from './hook-core.js';

export interface HookOptions {
  /** Broker state for this bar, read before the script runs on it. Omit to leave PineTS's getters. */
  broker?: (bar: number, ctx: Context) => BrokerView;
  /** Also pass the call to PineTS's emulator (true, or a per-call predicate). Default: never. */
  forward?: boolean | ((call: OrderCall) => boolean);
  /** Called before the script's first execution on each new bar of the main context. */
  onNewBar?: (ctx: Ctx) => void;
}


export type Ctx = Context & {
  idx: number;
  length: number;
  dataVersion: number;
  isSecondaryContext: boolean;
  marketData: { openTime: number }[];
  pine: { strategy: Record<string, (...a: unknown[]) => unknown> };
  plots: Record<string, { data: { value: unknown }[] }>;
};

export interface HookedScript {
  indicator: Indicator;
  calls: OrderCall[];
  lastContext: () => Ctx | null;
  /** How many times the namespace was patched (once per run context). */
  patchCount: () => number;
}

export function hookScript(source: string, opts: HookOptions = {}): HookedScript {
  const indicator = new Indicator(source);
  const calls: OrderCall[] = [];
  const prepared = indicator.prepare();
  const original = prepared.fn as ((ctx: Ctx) => Promise<unknown>) & Record<string, unknown>;
  let patched: Ctx | null = null;
  let view: BrokerView | null = null;
  let lastBar = -1;
  let patchCount = 0;

  const patch = ($: Ctx) => {
    const ns = $.pine.strategy;
    for (const method of Object.keys(SIGNATURES) as OrderMethod[]) {
      const orig = ns[method]!;
      ns[method] = (...raw: unknown[]) => {
        const call: OrderCall = { bar: $.idx, time: $.marketData[$.idx]!.openTime, method, args: normaliseOrderArgs(method, raw) };
        calls.push(call);
        const fwd = typeof opts.forward === 'function' ? opts.forward(call) : opts.forward === true;
        return fwd ? orig(...raw) : undefined;
      };
    }
    if (opts.broker) {
      ns.position_size = () => view!.position_size;
      ns.position_avg_price = () => view!.position_avg_price;
      ns.equity = () => view!.equity;
      ns.netprofit = () => view!.netprofit;
      ns.openprofit = () => view!.openprofit;
      ns.opentrades = () => scalarList(view!.opentrades);
    }
  };

  const wrapped = async ($: Ctx) => {
    if (!$.isSecondaryContext) {
      if (patched !== $) {
        patch($);
        patched = $;
        patchCount++;
      }
      // Bars appended after the run started (bar-by-bar mode) also count for barstate.islast.
      if ($.length < $.marketData.length) $.length = $.marketData.length;
      if ($.idx !== lastBar) {
        lastBar = $.idx;
        opts.onNewBar?.($);
      }
      if (opts.broker) view = opts.broker($.idx, $);
    }
    return original($);
  };
  // The runtime reads these off the transpiled function.
  for (const k of ['_pineVersion', '_ltfSlices']) (wrapped as unknown as Record<string, unknown>)[k] = original[k];
  prepared.fn = wrapped as unknown as typeof prepared.fn;
  return { indicator, calls, lastContext: () => patched, patchCount: () => patchCount };
}

export interface RunOptions extends HookOptions {
  /** Feed PineTS through MemoryProvider (symbol info + daily candles) instead of a bare array. */
  provider?: boolean;
}

export async function runScript(source: string, candles: Candle[], opts: RunOptions = {}) {
  const hooked = hookScript(source, opts);
  const src = opts.provider ? new MemoryProvider(candles) : candles.map((c) => toKline(c, H4_MS));
  const pine = new PineTS(src, TICKER, CHART_TF);
  const ctx = await pine.run(hooked.indicator);
  return { ctx: ctx as unknown as Ctx, calls: hooked.calls, pine };
}

// ------------------------------------------------------------ bar-by-bar ----

/** Appends a closed bar to a running PineTS (its public per-field arrays) for the paginated loop. */
function appendBar(pine: PineTS, k: Kline): void {
  pine.data.push(k);
  pine.open.push(k.open);
  pine.high.push(k.high);
  pine.low.push(k.low);
  pine.close.push(k.close);
  pine.volume.push(k.volume);
  pine.hl2.push((k.high + k.low) / 2);
  pine.hlc3.push((k.high + k.low + k.close) / 3);
  pine.ohlc4.push((k.open + k.high + k.low + k.close) / 4);
  pine.hlcc4.push((k.high + k.low + k.close + k.close) / 4);
  pine.openTime.push(k.openTime);
  pine.closeTime.push(k.closeTime);
}

/**
 * PineTS's own refresh: a bumped dataVersion makes each cached request.security context call
 * PineTS.updateTail(), which pulls the new higher-timeframe candles from the provider and
 * re-executes the secondary's tail. Evidence (Q5): the values it then returns are wrong.
 */
function bumpDataVersion($: Ctx): void {
  $.dataVersion = ($.dataVersion ?? 0) + 1;
}

/** Workaround: forget the cached request.security contexts; the next call rebuilds them in full. */
function dropSecurityCache($: Ctx): void {
  const c = $ as unknown as { cache: Record<string, unknown>; secondaryContextCount?: number };
  for (const [k, v] of Object.entries(c.cache)) {
    if (v && typeof v === 'object' && 'pineTS' in v) delete c.cache[k];
  }
  // PineTS counts secondary contexts per run (limit 40, as TradingView); rebuilt ones are not new.
  c.secondaryContextCount = 0;
}

export interface StepperOptions extends RunOptions {
  /**
   * How request.security contexts see newly pushed bars (default 'rebuild'):
   *  - 'rebuild': drop them on every bar (correct for every form, cost grows with history);
   *  - 'day-boundary': drop them only on a bar that opens or closes a UTC day (enough for daily
   *    requests, whose values change only there: lookahead_on + [1], and the default form);
   *  - 'updateTail': PineTS's own refresh (gives wrong values, kept as evidence).
   */
  htfRefresh?: 'rebuild' | 'day-boundary' | 'updateTail';
  /** Bars to warm up on before stepping: processed as one page, like a full run (warm start). */
  history?: Candle[];
}

/**
 * One script instance kept alive in memory: each push() appends one closed bar and runs the script
 * on that bar only. Uses run(code, undefined, pageSize = 1): the paginated generator re-reads
 * `data.length` before every page, so a bar appended before next() is processed next.
 */
export async function createStepper(source: string, opts: StepperOptions = {}) {
  const history = opts.history ?? [];
  // With a provider, an eDate keeps PineTS out of its live-polling mode: we append bars ourselves.
  const provider = opts.provider ? new MemoryProvider(history) : null;
  const pine = provider
    ? new PineTS(provider, TICKER, CHART_TF, undefined, 0, Number.MAX_SAFE_INTEGER)
    : new PineTS(history.map((c) => toKline(c, H4_MS)), TICKER, CHART_TF);
  await pine.ready();
  const refresh: ((ctx: Ctx) => void) | undefined = !provider
    ? undefined
    : opts.htfRefresh === 'updateTail'
      ? bumpDataVersion
      : opts.htfRefresh === 'day-boundary'
        ? ($) => {
            const t = $.marketData[$.idx]!.openTime;
            if (t % DAY_MS === 0 || (t + H4_MS) % DAY_MS === 0) dropSecurityCache($);
          }
        : dropSecurityCache;
  const hooked = hookScript(source, {
    ...opts,
    // Warm-up bars run in one page with the security contexts built from the full history: no refresh.
    onNewBar: refresh ? ($) => ($.idx >= history.length ? refresh($) : undefined) : undefined,
  });
  // One page holds the whole history (warm start, same speed as a full run); after that every
  // next() finds exactly one appended bar.
  const gen = pine.run(hooked.indicator, undefined, Math.max(history.length, 1)) as AsyncGenerator<Context>;
  if (history.length > 0) {
    const r = await gen.next();
    if (r.done) throw new Error('PineTS paginated run ended during warm-up');
  }
  return {
    calls: hooked.calls,
    pine,
    async push(c: Candle): Promise<void> {
      provider?.push(c);
      appendBar(pine, toKline(c, H4_MS));
      const r = await gen.next();
      if (r.done) throw new Error('PineTS paginated run ended');
    },
    /** The run's context, as the hook last saw it. */
    context: () => hooked.lastContext(),
    patchCount: () => hooked.patchCount(),
  };
}

// ------------------------------------------------------------ validation ----

export type CompileResult = { ok: true } | { ok: false; message: string; line?: number; column?: number };

export function compileCheck(source: string): CompileResult & { line?: number } {
  try {
    new Indicator(source).prepare();
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const m = /\bat (\d+):(\d+)/.exec(message);
    return m ? { ok: false, message, line: Number(m[1]), column: Number(m[2]) } : { ok: false, message };
  }
}

export function declarationOf(source: string): { kind: 'indicator' | 'strategy' | 'library' | null; args: Record<string, unknown> } {
  const ind = new Indicator(source);
  return { kind: ind.getDeclarationType(), args: { ...ind.prop } };
}

// ------------------------------------------------------------ emulator stats ----

interface ClosedTrade {
  entry_time: number;
  profit: number;
}

/** TradingView strategy-tester style summary of PineTS's own emulator, for trades entered in the window. */
export function emulatorStats(ctx: unknown, window: { from: number; to: number }) {
  const s = (ctx as { strategy: { closedtrades: ClosedTrade[]; initial_capital: number } }).strategy;
  const trades = s.closedtrades.filter((t) => t.entry_time >= window.from && t.entry_time < window.to);
  const wins = trades.filter((t) => t.profit > 0);
  const grossProfit = wins.reduce((a, t) => a + t.profit, 0);
  const grossLoss = -trades.filter((t) => t.profit < 0).reduce((a, t) => a + t.profit, 0);
  const net = trades.reduce((a, t) => a + t.profit, 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    trades: trades.length,
    winRatePct: r2((100 * wins.length) / Math.max(trades.length, 1)),
    profitFactor: r2(grossLoss > 0 ? grossProfit / grossLoss : Infinity),
    netProfitPct: r2((100 * net) / s.initial_capital),
  };
}
