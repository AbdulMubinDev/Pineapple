// Q7: run PineTS inside an isolated-vm isolate. The isolate has no Node APIs (no require, fs,
// process, fetch, timers); it gets the PineTS browser bundle as a script, the candles as a copied
// array and the Pine source as a string, and returns plain JSON.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
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

// The Q1/Q2 hook inside the isolate. The hook core (normaliser, recorder, getters) is the engine's own
// src/engine/hook-core.ts, bundled by esbuild into the global `HookCore`: one source, no copy. Only the
// per-bar wrapper below is isolate-specific. The broker stays in the host and is called once per bar
// through an ivm.Reference that returns the view as JSON.
let hookCoreJs: Promise<string> | null = null;
export function hookCoreBundle(): Promise<string> {
  hookCoreJs ??= build({
    entryPoints: [fileURLToPath(new URL('../src/engine/hook-core.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    globalName: 'HookCore',
    platform: 'neutral',
    target: 'es2022',
    write: false,
  }).then((out) => out.outputFiles[0]!.text);
  return hookCoreJs;
}

const ISOLATE_HOOK = `
globalThis.__runHooked = async function (src, candles, brokerRef) {
  const calls = [];
  let patched = null, view = null;
  const patch = ($) => HookCore.installStrategyHooks($.pine.strategy, {
    onCall: (m, raw) => { calls.push({ bar: $.idx, time: $.marketData[$.idx].openTime, method: m, args: HookCore.normaliseOrderArgs(m, raw) }); },
    view: brokerRef ? () => view : undefined,
  });
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
    await context.eval(await hookCoreBundle());
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
