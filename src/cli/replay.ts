// Usage:
//   npx tsx src/cli/replay.ts --script <file.pine> --symbol BTCUSDT --tf 4h --from 2024-01-01 --to 2026-11-18 \
//     --mode tradingview [--tv '{"initialCapital":10000,"commissionPct":0.05,"slippageTicks":0}']
//   (binance mode: --mode binance [--balance 10000] [--notional 1000 for fixed sizing])
// Reads <SYMBOL>_<tf>.csv, <SYMBOL>_funding.csv and <SYMBOL>-rules.json from --data, else data/, else
// tests/fixtures/. Never uses the network. Prints the summary and writes results/<script>-trades.csv.
// Without --tv, tradingview mode uses the Properties the script's declaration states.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { isTimeframe } from '../core/timeframe.js';
import type { BrokerMode, FundingEvent, PairRules, SizingRule } from '../core/types.js';
import { loadCandles, loadFunding } from '../data/csv.js';
import { replay, type TvProperties } from '../engine/replay.js';
import { tradeNet, tradesCsv } from '../report/summary.js';

const DAY_MS = 86_400_000;

function parseDate(label: string, s: string | undefined): number {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`--${label} must be YYYY-MM-DD`);
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`--${label} is not a valid date: ${s}`);
  return t;
}

function parseTv(s: string): TvProperties {
  const v = JSON.parse(s) as Record<string, unknown>;
  const n = (k: string) => {
    const x = v[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new Error(`--tv.${k} must be a non-negative number`);
    return x;
  };
  return { initialCapital: n('initialCapital'), commissionPct: n('commissionPct'), slippageTicks: n('slippageTicks') };
}

/** The first of the candidate directories that holds `file`. */
function find(file: string, dirs: string[]): string | null {
  for (const d of dirs) if (existsSync(join(d, file))) return join(d, file);
  return null;
}

const usd = (n: number) => n.toFixed(2);
const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z');

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      script: { type: 'string' },
      symbol: { type: 'string' },
      tf: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      mode: { type: 'string', default: 'tradingview' },
      tv: { type: 'string' },
      balance: { type: 'string', default: '10000' },
      notional: { type: 'string' },
      data: { type: 'string' },
      out: { type: 'string', default: 'results' },
    },
  });
  if (!values.script) throw new Error('--script is required');
  const symbol = values.symbol?.toUpperCase();
  if (!symbol || !/^[A-Z0-9]{3,20}$/.test(symbol)) throw new Error('--symbol is required (e.g. BTCUSDT)');
  const tf = values.tf;
  if (!tf || !isTimeframe(tf)) throw new Error('--tf must be one of 15m,30m,1h,2h,4h,6h,8h,12h,1d');
  const from = parseDate('from', values.from);
  const to = parseDate('to', values.to) + DAY_MS - 1; // --to is inclusive of that whole UTC day
  if (to < from) throw new Error('--to is before --from');
  const mode = values.mode as BrokerMode;
  if (mode !== 'tradingview' && mode !== 'binance') throw new Error('--mode must be tradingview or binance');
  const tv = values.tv !== undefined ? parseTv(values.tv) : undefined;
  const startingBalance = Number(values.balance);
  if (!(startingBalance > 0)) throw new Error('--balance must be positive');
  const sizing: SizingRule = values.notional !== undefined ? { kind: 'fixed', notionalUsd: Number(values.notional) } : { kind: 'script' };
  if (sizing.kind === 'fixed' && !(sizing.notionalUsd > 0)) throw new Error('--notional must be positive');

  const dirs = values.data !== undefined ? [values.data] : ['data', join('tests', 'fixtures')];
  const candlePath = find(`${symbol}_${tf}.csv`, dirs);
  if (!candlePath) throw new Error(`no ${symbol}_${tf}.csv in ${dirs.join(' or ')} (record it with src/cli/record.ts)`);
  const fundingPath = find(`${symbol}_funding.csv`, dirs);
  if (!fundingPath && mode === 'binance') throw new Error(`no ${symbol}_funding.csv in ${dirs.join(' or ')}`);
  const rulesPath = find(`${symbol}-rules.json`, dirs);
  if (!rulesPath) throw new Error(`no ${symbol}-rules.json in ${dirs.join(' or ')}`);

  const source = readFileSync(values.script, 'utf8');
  const candles = loadCandles(candlePath, tf);
  const funding: FundingEvent[] = fundingPath ? loadFunding(fundingPath) : [];
  const rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as PairRules;

  console.log(`Replaying ${values.script} on ${symbol} ${tf}, ${values.from} -> ${values.to}, ${mode} mode`);
  console.log(`  data: ${candlePath} (${candles.length} candles), ${fundingPath ?? 'no funding file'}, ${rulesPath}`);
  const r = await replay({ source, symbol, tf, candles, funding, from, to, mode, tv, rules, startingBalance, sizing });
  if (mode === 'tradingview') {
    const p = r.declaration.overridden;
    console.log(`  Properties: initial capital ${p.initialCapital}, commission ${p.commission} %, slippage ${p.slippage} ticks`);
  }

  const s = r.summary;
  const rows: [string, string][] = [
    ['Total closed trades', String(s.tradeCount)],
    ['Percent profitable', `${s.winRatePct.toFixed(2)} %`],
    ['Profit factor', Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(3) : 'inf'],
    ['Net profit', `${usd(s.netProfit)} USD (${s.netProfitPct.toFixed(2)} %)`],
    ['Avg winning trade', `${usd(s.avgWin)} USD`],
    ['Avg losing trade', `${usd(s.avgLoss)} USD`],
    ['Largest winning trade', `${usd(s.biggestWin)} USD`],
    ['Largest losing trade', `${usd(s.biggestLoss)} USD`],
    ['Max drawdown (bar close)', `${s.maxDrawdownPct.toFixed(2)} %`],
    ['Fees paid', `${usd(r.account.feesPaid)} USD`],
    ['Funding net', `${usd(r.account.fundingNet)} USD`],
    ['Final equity', `${usd(r.account.equity)} USD (start ${usd(r.startingBalance)})`],
  ];
  console.log('');
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(w)}  ${v}`);
  if (r.openPosition) {
    const p = r.openPosition;
    console.log(`  ${'Open position at end'.padEnd(w)}  ${p.qty > 0 ? 'long' : 'short'} ${Math.abs(p.qty).toFixed(8)} @ ${p.entryPrice} since ${iso(p.openTime)}`);
  }

  console.log(`\nAnomalies: ${r.anomalies.length}`);
  for (const a of r.anomalies) console.log(`  ${iso(a.time)}  ${a.kind}  ${a.orderId}`);
  console.log(`Rejections: ${r.rejections.length}`);
  for (const x of r.rejections) console.log(`  ${iso(x.time)}  ${x.stage}  ${x.reason}  ${x.orderId}`);
  console.log(`Overfill round trips (not in the summary or CSV): ${r.overfills.length}`);
  for (const t of r.overfills) console.log(`  ${iso(t.entryTime)} -> ${iso(t.exitTime)}  ${t.side} ${t.qty.toFixed(8)}  net ${usd(tradeNet(t))} USD`);

  mkdirSync(values.out, { recursive: true });
  const csvPath = join(values.out, `${basename(values.script, extname(values.script))}-trades.csv`);
  writeFileSync(csvPath, tradesCsv(r.trades));
  console.log(`\nWrote ${r.trades.length} trades to ${csvPath}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
