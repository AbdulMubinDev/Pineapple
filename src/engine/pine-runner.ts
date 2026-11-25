// PineTS as the script runtime only: our broker is the source of truth (docs/spike/pinets-findings.md,
// "Recommended hook design for Task 5").
//
//  - compileScript: validation (syntax, declaration kind, settings and read-backs we cannot honour,
//    then a short run on synthetic candles for the errors PineTS only raises at run time).
//  - runStrategy: the full-history driver. Per main-context bar it asks hooks.before for the broker's
//    view, feeds it through replaced strategy.* getters, runs the script, and hands the captured order
//    calls to hooks.after. The calls are never forwarded to PineTS's emulator.
//  - Data comes only from MemoryProvider (in-memory candles; higher timeframes built from them).
//
// PineTS internals relied on (pinets 0.13.1, exact-pinned): PreparedScript.fn mutable and reused by
// run(), with _pineVersion / _ltfSlices read off it; one call of it per bar with the Context;
// $.pine.strategy methods replaceable; $.idx, $.marketData, $.isSecondaryContext, $.warnings;
// Indicator#_sourcePropArgs (the declaration's own arguments). tests/spike is the upgrade canary.
import { Indicator, PineTS } from 'pinets';
import type { Candle, Timeframe } from '../core/types.js';
import { tfToMs } from '../core/timeframe.js';
import {
  FED_OPENTRADE_FIELDS,
  FED_GETTERS,
  STRATEGY_CONSTANTS,
  SIGNATURES,
  installStrategyHooks,
  normaliseOrderArgs,
  unsupportedMessage,
  type BrokerView,
  type OrderMethod,
} from './hook-core.js';
import { MemoryProvider, OTHER_SYMBOL_MESSAGE, perpSymbolInfo, pineTimeframe } from './memory-provider.js';
import type { ScriptView } from './strategy-layer.js';

/** One strategy.* order call, normalised to the Pine v6 signature. Absent and `na` arguments are omitted. */
export type PineOrderCall = {
  kind: 'entry' | 'exit' | 'close' | 'close_all' | 'order' | 'cancel' | 'cancel_all';
  id: string;
  direction?: 'long' | 'short';
  qty?: number;
  qtyPercent?: number;
  limit?: number;
  stop?: number;
  fromEntry?: string;
  profitTicks?: number;
  lossTicks?: number;
  ocaName?: string;
  ocaType?: 'cancel' | 'reduce' | 'none';
};

export interface StrategyDeclaration {
  title: string;
  pyramiding: number;
  marginLong?: number;
  marginShort?: number;
  closeEntriesRule: 'FIFO' | 'ANY';
  defaultQtyType: 'fixed' | 'cash' | 'percent_of_equity';
  defaultQtyValue: number;
  /** Fill market orders at the signal bar's close instead of the next open (the replay decides). */
  processOrdersOnClose?: boolean;
  /** Strategy Properties the declaration states itself (TradingView's defaults otherwise). Commission is a percent. */
  overridden: { initialCapital?: number; commission?: number; slippage?: number };
}

export type CompileError = { line: number; message: string };
export type CompileWarning = { line: number; message: string };
export type CompileResult =
  | {
      ok: true;
      declaration: StrategyDeclaration;
      /** The timeframe of every request.security call, as written ('D', '240', ...), deduplicated in order of first use. */
      securityTimeframes: string[];
      warnings?: CompileWarning[];
    }
  | { ok: false; errors: CompileError[] };

export interface BarHooks {
  before(bar: Candle, idx: number): ScriptView;
  after(bar: Candle, idx: number, calls: PineOrderCall[]): void;
}

export interface RunOptions {
  source: string;
  symbol: string;
  tf: Timeframe;
  candles: Candle[];
  syminfo: { mintick: number; qtyStep: number };
  hooks: BarHooks;
}

export const NOT_A_STRATEGY = 'v1 runs strategy() scripts only.';

// ------------------------------------------------------------------ order calls ----

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const TRAIL_ARGS = ['trail_price', 'trail_points', 'trail_offset'] as const;

/** A normalised PineTS call (spike/hook-core shape) as a PineOrderCall. */
export function toPineOrderCall(method: OrderMethod, args: Record<string, unknown>): PineOrderCall {
  const call: PineOrderCall = { kind: method, id: method === 'close_all' || method === 'cancel_all' ? '' : String(args.id ?? '') };
  const set = <K extends keyof PineOrderCall>(k: K, v: PineOrderCall[K] | undefined) => {
    if (v !== undefined) call[k] = v;
  };
  if (method === 'entry' || method === 'order') {
    const d = args.direction;
    set('direction', d === 'long' || d === 'short' ? d : undefined);
    set('qty', num(args.qty));
    set('limit', num(args.limit));
    set('stop', num(args.stop));
    set('ocaName', str(args.oca_name));
    const t = args.oca_type;
    set('ocaType', t === 'cancel' || t === 'reduce' || t === 'none' ? t : undefined);
  } else if (method === 'exit') {
    for (const k of TRAIL_ARGS) {
      if (num(args[k]) !== undefined) throw new Error(`strategy.exit trailing stops (${k}) are not supported in v1`);
    }
    set('fromEntry', str(args.from_entry));
    set('qty', num(args.qty));
    set('qtyPercent', num(args.qty_percent));
    set('profitTicks', num(args.profit));
    set('limit', num(args.limit));
    set('lossTicks', num(args.loss));
    set('stop', num(args.stop));
    set('ocaName', str(args.oca_name));
  } else if (method === 'close' || method === 'close_all') {
    if (args.immediately === true) throw new Error(`strategy.${method}(immediately = true) is not supported in v1`);
    if (method === 'close') {
      set('qty', num(args.qty));
      set('qtyPercent', num(args.qty_percent));
    }
  }
  return call;
}

export function toBrokerView(v: ScriptView): BrokerView {
  return {
    position_size: v.positionSize,
    position_avg_price: v.positionAvgPrice,
    equity: v.equity,
    netprofit: v.netProfit,
    openprofit: v.openProfit,
    opentrades: v.opentrades.map((t) => ({
      id: t.entryId,
      size: t.size,
      entry_price: t.entryPrice,
      entry_bar_index: t.entryBarIndex,
      entry_time: t.entryTime,
      profit: t.profit,
    })),
  };
}

// ------------------------------------------------------------------ the runner ----

type Ctx = {
  idx: number;
  isSecondaryContext: boolean;
  marketData: { openTime: number }[];
  pine: { strategy: Record<string, unknown> };
  warnings?: { message: string; method: string; bar: number }[];
};

async function execute(o: RunOptions): Promise<Ctx> {
  const indicator = new Indicator(o.source);
  const prepared = indicator.prepare();
  const original = prepared.fn as unknown as ((ctx: Ctx) => Promise<unknown>) & Record<string, unknown>;
  let patched: Ctx | null = null;
  let view: BrokerView | null = null;
  let calls: PineOrderCall[] = [];
  let lastBar = -1;

  const wrapped = async ($: Ctx) => {
    if ($.isSecondaryContext) return original($);
    if (patched !== $) {
      if (patched) throw new Error('runStrategy: PineTS started a second main context');
      installStrategyHooks($.pine.strategy, {
        onCall: (method, raw) => {
          calls.push(toPineOrderCall(method, normaliseOrderArgs(method, raw)));
          return undefined;
        },
        view: () => view!,
        guardUnfed: true,
      });
      patched = $;
    }
    const idx = $.idx;
    const bar = o.candles[idx];
    if (!bar || $.marketData[idx]?.openTime !== bar.openTime) throw new Error(`runStrategy: PineTS bar ${idx} is not candle ${idx}`);
    // A full run executes the script once per bar; anything else would double-count order calls.
    if (idx !== lastBar + 1) throw new Error(`runStrategy: bar ${idx} ran out of order (after ${lastBar})`);
    lastBar = idx;
    view = toBrokerView(o.hooks.before(bar, idx));
    calls = [];
    const result = await original($);
    o.hooks.after(bar, idx, calls);
    return result;
  };
  for (const k of ['_pineVersion', '_ltfSlices']) (wrapped as unknown as Record<string, unknown>)[k] = original[k];
  prepared.fn = wrapped as unknown as typeof prepared.fn;

  const provider = new MemoryProvider(o.candles, o.tf, perpSymbolInfo(o.symbol, o.syminfo));
  const pine = new PineTS(provider, `BINANCE:${o.symbol}.P`, pineTimeframe(o.tf));
  const ctx = (await pine.run(indicator)) as unknown as Ctx;
  if (lastBar !== o.candles.length - 1) throw new Error(`runStrategy: ran ${lastBar + 1} of ${o.candles.length} bars`);
  return ctx;
}

/** Runs `source` over the whole of `candles`, one hooks.before / hooks.after pair per bar. */
export async function runStrategy(o: RunOptions): Promise<void> {
  await execute(o);
}

// ------------------------------------------------------------------ validation ----

/** The source with comments (and, unless `keepStrings`, string literals) blanked out, line by line (positions kept). */
export function codeLines(source: string, keepStrings = false): string[] {
  const out: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    let s = '';
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        if (ch === '\\') {
          s += keepStrings ? ch + (line[i + 1] ?? '') : '  ';
          i++;
        } else if (ch === quote) {
          quote = null;
          s += ch;
        } else s += keepStrings ? ch : ' ';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        s += ch;
      } else if (ch === '/' && line[i + 1] === '/') {
        break;
      } else s += ch;
    }
    out.push(s);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 1-based line of the first code (not comment or string) occurrence of `pattern`, else 0. */
function lineOf(lines: string[], pattern: RegExp): number {
  const i = lines.findIndex((l) => pattern.test(l));
  return i + 1;
}

const tokenLine = (lines: string[], token: string) => lineOf(lines, new RegExp(`(?<![\\w.])${escape(token)}(?![\\w])`));

const FED = new Set<string>([...Object.keys(SIGNATURES), ...FED_GETTERS, ...STRATEGY_CONSTANTS]);
const FED_OPENTRADES = new Set<string>(FED_OPENTRADE_FIELDS);
const WITH_MEMBERS = new Set(['opentrades', 'closedtrades', 'risk']);

/** strategy.* members the view does not feed (each reported once, at its first line). */
function unfedReadBacks(lines: string[]): CompileError[] {
  const seen = new Set<string>();
  const errors: CompileError[] = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/(?<![\w.])strategy\.([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/g)) {
      const name = m[1]!;
      const sub = m[2];
      let bad: string | null = null;
      if (!FED.has(name)) bad = WITH_MEMBERS.has(name) && sub ? `${name}.${sub}` : name;
      else if (name === 'opentrades' && sub && !FED_OPENTRADES.has(sub)) bad = `opentrades.${sub}`;
      if (bad && !seen.has(bad)) {
        seen.add(bad);
        errors.push({ line: i + 1, message: unsupportedMessage(bad) });
      }
    }
  });
  return errors;
}

/** Deterministic synthetic candles at `tf` for the validation run (no fixture files in src/). */
function syntheticCandles(n: number, tf: Timeframe): Candle[] {
  const out: Candle[] = [];
  const start = Date.UTC(2024, 0, 1);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  let close = 40_000;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = Math.max(1_000, open * (1 + 0.02 * Math.sin(i / 17) * 0.3 + 0.015 * rnd()));
    const high = Math.max(open, close) * (1 + 0.004 * (rnd() + 0.5));
    const low = Math.min(open, close) * (1 - 0.004 * (rnd() + 0.5));
    const r = (x: number) => Math.round(x * 10) / 10;
    out.push({ openTime: start + i * tfToMs(tf), open: r(open), high: r(high), low: r(low), close: r(close), volume: 100 + 50 * (rnd() + 0.5) });
  }
  return out;
}

const VALIDATION_BARS = 300;

export type SecurityCall = { line: number; text: string };

/** The text of the call starting at line `i`, column `start`, up to its closing paren (it may span lines). */
export function callTextAt(lines: string[], i: number, start: number): string {
  let depth = 0;
  let text = '';
  let quote: string | null = null;
  for (let li = i; li < lines.length; li++) {
    const src = li === i ? lines[li]!.slice(start) : lines[li]!;
    for (let k = 0; k < src.length; k++) {
      const ch = src[k]!;
      text += ch;
      if (quote) {
        if (ch === '\\') text += src[++k] ?? '';
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return text;
    }
    text += '\n';
  }
  return text;
}

/** Every request.security(...) call (comments blanked, strings kept): its first line and its text up to the closing paren. */
export function securityCalls(lines: string[]): SecurityCall[] {
  const calls: SecurityCall[] = [];
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/(?<![\w.])request\.security\s*\(/g)) calls.push({ line: i + 1, text: callTextAt(lines, i, m.index) });
  });
  return calls;
}

const stringLiteral = (s: string) => /^\s*(["'])(.*)\1\s*$/s.exec(s)?.[2];
/** A single string literal and nothing else (no concatenation, no escapes). */
const plainLiteral = (s: string) => /^\s*(?:"([^"\\]*)"|'([^'\\]*)')\s*$/.exec(s)?.slice(1).find((x) => x !== undefined);

/** A call argument: by name if passed as `name = ...`, else the positional one at `index`. */
export function callArg(args: string[], name: string, index: number): string | undefined {
  const named = (a: string) => /^\s*([A-Za-z_]\w*)\s*=(?!=)([\s\S]*)$/.exec(a);
  for (const a of args) {
    const m = named(a);
    if (m && m[1] === name) return m[2];
  }
  const positional = args.filter((a) => !named(a));
  return positional[index];
}

/**
 * The timeframe a request.security argument names, if it is known before the run: a string literal,
 * timeframe.period (the chart's), or a variable assigned once from a literal or from an input's default
 * (input.timeframe("D", ...)). Anything else (a runtime expression, a reassigned variable) is undefined.
 */
function literalTimeframe(expr: string, lines: string[], tf: Timeframe): string | undefined {
  const lit = plainLiteral(expr);
  if (lit !== undefined) return lit;
  const name = expr.trim();
  if (name === 'timeframe.period') return pineTimeframe(tf);
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  if (lines.some((l) => new RegExp(`(?<![\\w.])${name}\\s*:=`).test(l))) return undefined;
  const decl = new RegExp(`^\\s*(?:(?:var|varip|const|simple|series)\\s+)*(?:string\\s+)?${name}\\s*=(?!=)`);
  const at = lines.flatMap((l, i) => {
    const m = decl.exec(l);
    return m ? [{ i, col: m[0].length }] : [];
  });
  if (at.length !== 1) return undefined;
  const { i, col } = at[0]!;
  const rhs = lines[i]!.slice(col);
  const direct = plainLiteral(rhs);
  if (direct !== undefined) return direct;
  if (!/^\s*input(?:\.timeframe|\.string)?\s*\(/.test(rhs)) return undefined;
  const text = callTextAt(lines, i, col);
  // Nothing may follow the input call (input.timeframe("D") + "x" is an expression).
  const parts = text.split('\n');
  const last = parts.length === 1 ? rhs : lines[i + parts.length - 1]!;
  if (last.slice(parts.at(-1)!.length).trim() !== '') return undefined;
  const v = callArg(callArgs(text), 'defval', 0);
  return v === undefined ? undefined : plainLiteral(v);
}

/** The timeframes of `calls` as written (deduplicated, in order of first use), and the calls whose timeframe is not known. */
function securityTimeframesOf(calls: SecurityCall[], lines: string[], tf: Timeframe): { timeframes: string[]; errors: CompileError[] } {
  const timeframes: string[] = [];
  const errors: CompileError[] = [];
  for (const c of calls) {
    const arg = callArg(callArgs(c.text), 'timeframe', 1);
    const t = arg === undefined ? undefined : literalTimeframe(arg, lines, tf);
    if (t === undefined) errors.push({ line: c.line, message: `request.security timeframe on line ${c.line} must be a literal in v1` });
    else if (!timeframes.includes(t)) timeframes.push(t);
  }
  return { timeframes, errors };
}

/** A call's arguments as written, split at top-level commas. */
export function callArgs(text: string): string[] {
  const inner = text.slice(text.indexOf('(') + 1);
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k]!;
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += inner[++k] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
      cur += ch;
    } else if (ch === ')' || ch === ']') {
      if (depth === 0) break;
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(cur);
      cur = '';
    } else cur += ch;
  }
  args.push(cur);
  return args;
}

/** The request.security call a MemoryProvider error belongs to, else the first call, else 0. */
function securityErrorLine(calls: SecurityCall[], message: string, symbol: string): number {
  if (calls.length === 0) return 0;
  if (message === OTHER_SYMBOL_MESSAGE) {
    const own = new RegExp(`^(?:BINANCE:)?${escape(symbol)}(?:\\.P)?$`, 'i');
    const other = calls.find((c) => {
      const sym = stringLiteral(callArg(callArgs(c.text), 'symbol', 0) ?? '');
      return sym !== undefined && !own.test(sym);
    });
    return (other ?? calls[0]!).line;
  }
  const tf = /cannot build (\S+) candles/.exec(message)?.[1];
  if (tf) {
    const hit = calls.find((c) => stringLiteral(callArg(callArgs(c.text), 'timeframe', 1) ?? '')?.toUpperCase() === tf.toUpperCase());
    if (hit) return hit.line;
  }
  return calls[0]!.line;
}

/** request.security(..., lookahead_on) whose expression has no history offset: it repaints on history. */
function lookaheadWarnings(calls: SecurityCall[]): CompileWarning[] {
  return calls
    .filter((c) => /(?<![\w])lookahead_on(?![\w])/.test(c.text) && !/[\w)\]]\s*\[/.test(c.text))
    .map((c) => ({ line: c.line, message: 'request.security with lookahead_on and no [1] offset uses unclosed higher-timeframe data' }));
}

function errorLine(lines: string[], message: string, calls: SecurityCall[] = [], symbol = 'BTCUSDT'): number {
  if (message === OTHER_SYMBOL_MESSAGE || /^MemoryProvider /.test(message)) return securityErrorLine(calls, message, symbol);
  const pos = /\bat (\d+):\d+/.exec(message);
  if (pos) return Number(pos[1]);
  const undeclared = /^Undeclared identifier "([^"]+)"/.exec(message);
  if (undeclared) return tokenLine(lines, undeclared[1]!);
  const notFn = /^([\w.]+) is not a function/.exec(message);
  if (notFn) return tokenLine(lines, notFn[1]!);
  return 0;
}

function readDeclaration(ind: Indicator): StrategyDeclaration {
  const p = ind.prop as Record<string, unknown>;
  // A PineTS internal (filled by getDeclarationType()): fail loudly if an upgrade renames it rather
  // than silently reporting nothing as overridden.
  const raw = (ind as unknown as { _sourcePropArgs?: unknown })._sourcePropArgs;
  if (raw === null || typeof raw !== 'object') throw new Error('PineTS Indicator#_sourcePropArgs is missing: cannot read the strategy() arguments');
  const src = raw as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const qtyType = p.default_qty_type;
  const overridden: StrategyDeclaration['overridden'] = {};
  if (typeof src.initial_capital === 'number') overridden.initialCapital = src.initial_capital;
  if (typeof src.commission_value === 'number') overridden.commission = src.commission_value;
  if (typeof src.slippage === 'number') overridden.slippage = src.slippage;
  return {
    title: typeof src.title === 'string' ? src.title : '',
    pyramiding: n(p.pyramiding, 0),
    marginLong: typeof p.margin_long === 'number' ? p.margin_long : undefined,
    marginShort: typeof p.margin_short === 'number' ? p.margin_short : undefined,
    closeEntriesRule: String(p.close_entries_rule ?? 'FIFO').toUpperCase() === 'ANY' ? 'ANY' : 'FIFO',
    defaultQtyType: qtyType === 'cash' || qtyType === 'percent_of_equity' ? qtyType : 'fixed',
    defaultQtyValue: n(p.default_qty_value, 1),
    processOrdersOnClose: p.process_orders_on_close === true,
    overridden,
  };
}

/**
 * Validates a pasted script for `symbol`'s `tf` chart (request.security on that symbol is its own).
 * Async because the last check runs it (PineTS runs are async): unknown functions and unsupported data
 * requests only show up then.
 */
export async function compileScript(source: string, tf: Timeframe = '4h', symbol = 'BTCUSDT'): Promise<CompileResult> {
  const lines = codeLines(source);
  const withStrings = codeLines(source, true);
  const calls = securityCalls(withStrings);
  const fail = (errors: CompileError[]): CompileResult => ({ ok: false, errors: errors.sort((a, b) => a.line - b.line) });

  const ind = new Indicator(source);
  try {
    ind.prepare();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail([{ line: errorLine(lines, message), message }]);
  }
  const kind = ind.getDeclarationType();
  if (kind !== 'strategy') {
    return fail([{ line: lineOf(lines, /(?<![\w.])(indicator|library|strategy)\s*\(/), message: NOT_A_STRATEGY }]);
  }

  const p = ind.prop as Record<string, unknown>;
  const errors: CompileError[] = [];
  const setting = (name: string, message: string) => errors.push({ line: tokenLine(lines, name), message });
  if (p.calc_on_order_fills === true) setting('calc_on_order_fills', 'calc_on_order_fills = true is not supported in v1');
  if (p.commission_type !== undefined && p.commission_type !== 'percent') {
    setting('commission_type', `commission_type = ${String(p.commission_type)} is not supported in v1`);
  }
  if (Number(p.backtest_fill_limits_assumption ?? 0) !== 0) setting('backtest_fill_limits_assumption', 'backtest_fill_limits_assumption is not supported in v1');
  if (p.use_bar_magnifier === true) setting('use_bar_magnifier', 'use_bar_magnifier = true is not supported in v1');
  errors.push(...unfedReadBacks(lines));
  lines.forEach((l, i) => {
    const t = /(?<![\w.])(trail_price|trail_points|trail_offset)\s*=/.exec(l);
    if (t) errors.push({ line: i + 1, message: `strategy.exit trailing stops (${t[1]}) are not supported in v1` });
  });
  const immediately = lineOf(lines, /(?<![\w.])immediately\s*=\s*true\b/);
  if (immediately > 0) errors.push({ line: immediately, message: 'strategy.close(immediately = true) is not supported in v1' });
  // The live engine loads each higher timeframe up front, so it has to know them before the run.
  const security = securityTimeframesOf(calls, withStrings, tf);
  errors.push(...security.errors);
  if (errors.length > 0) return fail(errors);

  const declaration = readDeclaration(ind);
  const flat: ScriptView = {
    positionSize: 0,
    positionAvgPrice: NaN,
    equity: declaration.overridden.initialCapital ?? 1_000_000,
    openTrades: 0,
    netProfit: 0,
    openProfit: 0,
    opentrades: [],
  };
  try {
    const ctx = await execute({
      source,
      symbol,
      tf,
      candles: syntheticCandles(VALIDATION_BARS, tf),
      syminfo: { mintick: 0.1, qtyStep: 0.001 },
      hooks: { before: () => flat, after: () => {} },
    });
    // Unsupported data requests (request.financial, ...) do not throw: PineTS returns na and warns.
    const methods = [...new Set((ctx.warnings ?? []).map((w) => w.method))];
    for (const m of methods) errors.push({ line: tokenLine(lines, m), message: `${m} is not supported in v1` });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ line: errorLine(lines, message, calls, symbol), message });
  }
  if (errors.length > 0) return fail(errors);
  const warnings = lookaheadWarnings(calls);
  const ok = { ok: true as const, declaration, securityTimeframes: security.timeframes };
  return warnings.length > 0 ? { ...ok, warnings } : ok;
}
