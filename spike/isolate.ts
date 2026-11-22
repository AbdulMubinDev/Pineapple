// Q7: run PineTS inside an isolated-vm isolate. The isolate has no Node APIs (no require, fs,
// process, fetch, timers); it gets the PineTS browser bundle as a script, the candles as a copied
// array and the Pine source as a string, and returns plain JSON.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ivm from 'isolated-vm';
import type { Candle } from '../src/core/types.js';

const H4_MS = 14_400_000;

export interface IsolateResult {
  closedTrades: number;
  netprofit: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  runMs: number;
  /** What the isolate sees for Node/host globals (all should be "undefined"). */
  hostGlobals: Record<string, string>;
}

export function pinetsBrowserBundle(): string {
  const main = createRequire(import.meta.url).resolve('pinets'); // dist/pinets.min.cjs
  return readFileSync(join(dirname(main), 'pinets.min.browser.js'), 'utf8');
}

// The Q1/Q2 hook as plain JS for inside the isolate (same logic as hookScript/normaliseOrderArgs in
// probe.ts; the Q7 test checks both produce the same calls). The broker stays in the host and is
// called once per bar through an ivm.Reference that returns the view as JSON.
const ISOLATE_HOOK = `
globalThis.__runHooked = async function (src, candles, brokerRef) {
  const SIG = {
    entry: ['id','direction','qty','limit','stop','oca_name','oca_type','comment','alert_message','disable_alert'],
    order: ['id','direction','qty','limit','stop','oca_name','oca_type','comment','alert_message','disable_alert'],
    exit: ['id','from_entry','qty','qty_percent','profit','limit','loss','stop','trail_price','trail_points','trail_offset','oca_name','comment','comment_profit','comment_loss','comment_trailing','alert_message','alert_profit','alert_loss','alert_trailing','disable_alert'],
    close: ['id','comment','qty','qty_percent','alert_message','immediately','disable_alert'],
    close_all: ['comment','alert_message','immediately','disable_alert'],
    cancel: ['id'],
    cancel_all: [],
  };
  const cur = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (typeof v.get === 'function' && Array.isArray(v.data)) return v.get(0);
    if ('__value' in v) return v.__value;
    return v;
  };
  const isBag = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && !('__value' in v);
  const norm = (m, raw) => {
    const args = Object.fromEntries(SIG[m].map((k) => [k, undefined]));
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if (isBag(a)) { for (const [k, v] of Object.entries(a)) args[k] = cur(v); break; }
      if (SIG[m][i] !== undefined && a !== undefined) args[SIG[m][i]] = cur(a);
    }
    return args;
  };
  const calls = [];
  let patched = null, view = null;
  const patch = ($) => {
    const ns = $.pine.strategy;
    for (const m of Object.keys(SIG)) ns[m] = (...raw) => { calls.push({ bar: $.idx, time: $.marketData[$.idx].openTime, method: m, args: norm(m, raw) }); };
    if (brokerRef) {
      ns.position_size = () => view.position_size;
      ns.position_avg_price = () => view.position_avg_price;
      ns.equity = () => view.equity;
      ns.netprofit = () => view.netprofit;
      ns.openprofit = () => view.openprofit;
      ns.opentrades = () => {
        const l = view.opentrades, n = l.length, at = (i) => l[Number.isNaN(Number(i)) ? 0 : Number(i)];
        return { __value: n, valueOf: () => n, toString: () => String(n), [Symbol.toPrimitive]: () => n,
          size: (i) => at(i)?.size ?? 0, entry_price: (i) => at(i)?.entry_price ?? NaN, entry_id: (i) => at(i)?.id ?? '',
          entry_bar_index: (i) => at(i)?.entry_bar_index ?? NaN, entry_time: (i) => at(i)?.entry_time ?? NaN, profit: (i) => at(i)?.profit ?? 0 };
      };
    }
  };
  const ind = new PineTSLib.Indicator(src);
  const prepared = ind.prepare();
  const orig = prepared.fn;
  const wrapped = async ($) => {
    if (!$.isSecondaryContext) {
      if (patched !== $) { patch($); patched = $; }
      if (brokerRef) view = JSON.parse(brokerRef.applySync(undefined, [$.idx]));
    }
    return orig($);
  };
  wrapped._pineVersion = orig._pineVersion;
  wrapped._ltfSlices = orig._ltfSlices;
  prepared.fn = wrapped;
  await new PineTSLib.PineTS(candles, 'BINANCE:BTCUSDT.P', '240').run(ind);
  return JSON.stringify(calls);
};
`;

/** Runs `source` with the hook inside an isolate; `broker(bar)` runs in the host. Returns the calls. */
export async function runHookedInIsolate(
  source: string,
  candles: Candle[],
  broker?: (bar: number) => unknown,
  memoryLimitMb = 256,
): Promise<{ calls: unknown[]; heapUsedBytes: number }> {
  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('globalThis', jail.derefInto());
    await context.eval('globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };');
    await (await isolate.compileScript(pinetsBrowserBundle(), { filename: 'pinets.min.browser.js' })).run(context);
    await context.eval(ISOLATE_HOOK);
    const klines = candles.map((c) => ({ ...c, closeTime: c.openTime + H4_MS }));
    const run = (await jail.get('__runHooked', { reference: true })) as ivm.Reference<(...a: unknown[]) => Promise<string>>;
    const brokerRef = broker ? new ivm.Reference((bar: number) => JSON.stringify(broker(bar))) : undefined;
    const json = (await run.apply(undefined, [source, new ivm.ExternalCopy(klines).copyInto(), brokerRef], {
      result: { promise: true, copy: true },
    })) as string;
    const heap = await isolate.getHeapStatistics();
    return { calls: JSON.parse(json) as unknown[], heapUsedBytes: heap.used_heap_size };
  } finally {
    isolate.dispose();
  }
}

export async function runInIsolate(source: string, candles: Candle[], memoryLimitMb = 256): Promise<IsolateResult> {
  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('globalThis', jail.derefInto());
    await context.eval('globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };');
    await (await isolate.compileScript(pinetsBrowserBundle(), { filename: 'pinets.min.browser.js' })).run(context);
    const klines = candles.map((c) => ({ ...c, closeTime: c.openTime + H4_MS }));
    await jail.set('__candles', new ivm.ExternalCopy(klines).copyInto());
    await jail.set('__src', source);
    const t0 = performance.now();
    const json = (await context.eval(
      `(async () => {
        const pine = new PineTSLib.PineTS(__candles, 'BINANCE:BTCUSDT.P', '240');
        const ctx = await pine.run(__src);
        const hostGlobals = {};
        for (const k of ['require', 'process', 'fetch', 'setTimeout', 'Buffer', 'module']) hostGlobals[k] = typeof globalThis[k];
        return JSON.stringify({ closedTrades: ctx.strategy.closedtrades.length, netprofit: ctx.strategy.netprofit, hostGlobals });
      })()`,
      { promise: true },
    )) as string;
    const runMs = performance.now() - t0;
    const heap = await isolate.getHeapStatistics();
    const r = JSON.parse(json) as Pick<IsolateResult, 'closedTrades' | 'netprofit' | 'hostGlobals'>;
    return { ...r, runMs, heapUsedBytes: heap.used_heap_size, heapTotalBytes: heap.total_heap_size, externalBytes: heap.externally_allocated_size };
  } finally {
    isolate.dispose();
  }
}
