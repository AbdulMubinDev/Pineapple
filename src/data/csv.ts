import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tfToMs } from '../core/timeframe.js';
import type { Candle, FundingEvent, Timeframe } from '../core/types.js';

export class DataGapError extends Error {
  constructor(public readonly firstMissing: number) {
    super(`Data gap: first missing bar openTime ${firstMissing} (${new Date(firstMissing).toISOString()})`);
    this.name = 'DataGapError';
  }
}

const CANDLE_HEADER = 'openTime,open,high,low,close,volume';
const FUNDING_HEADER = 'time,rate,markPrice';

// Quantities are written with 8 dp (Binance precision); rounding happens only at output.
const q = (n: number): string => n.toFixed(8);

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function readRows(path: string, header: string): string[][] {
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  if (lines[0] !== header) throw new Error(`Unexpected CSV header in ${path}: ${lines[0] ?? '(empty)'}`);
  return lines.slice(1).map((l) => l.split(','));
}

function num(s: string | undefined, path: string): number {
  const n = Number(s);
  if (s === undefined || s === '' || !Number.isFinite(n)) throw new Error(`Bad numeric field "${s}" in ${path}`);
  return n;
}

export function writeCandles(path: string, candles: Candle[]): void {
  ensureDir(path);
  const rows = candles.map((c) => `${c.openTime},${q(c.open)},${q(c.high)},${q(c.low)},${q(c.close)},${q(c.volume)}`);
  writeFileSync(path, [CANDLE_HEADER, ...rows].join('\n') + '\n');
}

export function loadCandles(path: string, tf: Timeframe): Candle[] {
  const step = tfToMs(tf);
  const out: Candle[] = [];
  for (const r of readRows(path, CANDLE_HEADER)) {
    const c: Candle = {
      openTime: num(r[0], path),
      open: num(r[1], path),
      high: num(r[2], path),
      low: num(r[3], path),
      close: num(r[4], path),
      volume: num(r[5], path),
    };
    const prev = out[out.length - 1];
    if (prev && c.openTime !== prev.openTime + step) {
      // Backwards/duplicate bars are corruption too; report the bar we expected next.
      throw new DataGapError(prev.openTime + step);
    }
    out.push(c);
  }
  return out;
}

export function writeFunding(path: string, events: FundingEvent[]): void {
  ensureDir(path);
  const rows = events.map((e) => `${e.time},${q(e.rate)},${q(e.markPrice)}`);
  writeFileSync(path, [FUNDING_HEADER, ...rows].join('\n') + '\n');
}

export function loadFunding(path: string): FundingEvent[] {
  return readRows(path, FUNDING_HEADER).map((r) => ({
    time: num(r[0], path),
    rate: num(r[1], path),
    markPrice: num(r[2], path),
  }));
}
