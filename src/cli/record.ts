// Usage: npx tsx src/cli/record.ts --symbol BTCUSDT --tf 4h --from 2019-09-08 --to 2026-11-18
// Records public Binance USDT-M candles + funding to data/<SYMBOL>_<tf>.csv and data/<SYMBOL>_funding.csv.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { isTimeframe } from '../core/timeframe.js';
import { fetchFundingHistory, fetchKlines } from '../data/binance-rest.js';
import { loadCandles, writeCandles, writeFunding } from '../data/csv.js';

const DAY_MS = 86_400_000;

function parseDate(label: string, s: string | undefined): number {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`--${label} must be YYYY-MM-DD`);
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`--${label} is not a valid date: ${s}`);
  return t;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string' },
      tf: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string', default: 'data' },
    },
  });
  const symbol = values.symbol?.toUpperCase();
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) throw new Error('--symbol is required (e.g. BTCUSDT)');
  const tf = values.tf;
  if (!tf || !isTimeframe(tf)) throw new Error('--tf must be one of 15m,30m,1h,2h,4h,6h,8h,12h,1d');
  const fromMs = parseDate('from', values.from);
  const toMs = parseDate('to', values.to) + DAY_MS - 1; // --to is inclusive of that whole UTC day
  if (toMs < fromMs) throw new Error('--to is before --from');
  const outDir = values.out ?? 'data';

  const candlePath = join(outDir, `${symbol}_${tf}.csv`);
  const fundingPath = join(outDir, `${symbol}_funding.csv`);

  console.log(`Fetching ${symbol} ${tf} klines ${values.from} -> ${values.to} ...`);
  const candles = await fetchKlines(symbol, tf, fromMs, toMs);
  writeCandles(candlePath, candles);
  loadCandles(candlePath, tf); // throws DataGapError if the recording has a hole
  console.log(`  wrote ${candles.length} candles to ${candlePath} (gap check passed)`);

  console.log(`Fetching ${symbol} funding history ...`);
  const funding = await fetchFundingHistory(symbol, fromMs, toMs);
  writeFunding(fundingPath, funding);
  console.log(`  wrote ${funding.length} funding events to ${fundingPath}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
