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
