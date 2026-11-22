// Q7 evidence outside vitest (used for the Linux container run):
//   npx tsx spike/isolate-cli.ts
// Runs probe 01 (range gate removed, all 8,508 fixture bars) inside an isolate and prints JSON.
import { readFileSync } from 'node:fs';
import { loadCandles } from '../src/data/csv.js';
import { runInIsolate } from './isolate.js';

const candles = loadCandles('tests/fixtures/BTCUSDT_4h.csv', '4h');
const src = readFileSync('spike/probes/01-ma-cross.pine', 'utf8').replace('time >= timestamp("UTC", 2024, 1, 1, 0, 0)', 'true');
const r = await runInIsolate(src, candles);
console.log(
  JSON.stringify({
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    bars: candles.length,
    closedTrades: r.closedTrades,
    netprofit: r.netprofit,
    heapUsedMB: +(r.heapUsedBytes / 1e6).toFixed(2),
    heapTotalMB: +(r.heapTotalBytes / 1e6).toFixed(2),
    externalMB: +(r.externalBytes / 1e6).toFixed(2),
    runMs: Math.round(r.runMs),
    hostGlobals: r.hostGlobals,
  }),
);
