// Shared fixtures for the scanner tests: FakeExchange pairs with flat history, a test script with price-level signals,
// and a ScannerRun wired to an in-memory database on fake time.
import { barOpenFor, tfToMs } from '../../src/core/timeframe.js';
import type { Candle, FeeConfig, SizingRule } from '../../src/core/types.js';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import type { PairInfo } from '../../src/exchange/client.js';
import { FakeExchange } from '../../src/exchange/fake.js';
import { FundingTracker } from '../../src/exchange/funding.js';
import { ScannerRun } from '../../src/scanner/run.js';
import { CandleRepo, FundingRepo } from '../../src/store/candles.js';
import { openDb } from '../../src/store/db.js';
import { RunRepo, type RunSetup } from '../../src/store/runs.js';
import { makeClock } from '../exchange/clock.js';

export const TF = '15m' as const;
export const STEP = tfToMs(TF);
/** The clock starts one minute into bar B0; the history ends with the bar before it. */
export const B0 = barOpenFor(1_700_000_000_000, TF);
export const START = B0 + 60_000;
export const HISTORY = 150;

/**
 * Enters long when a bar closes above 150 while flat, with a stop at 90 (sent once the entry fills).
 * Fixed sizing (4,000 USD notional at leverage 1) makes the margin each entry needs predictable.
 */
export const SCRIPT = [
  '//@version=6',
  'strategy("scan-test", overlay = true)',
  'if close > 150 and strategy.position_size == 0',
  '    strategy.entry("L", strategy.long)',
  '    strategy.exit("X", "L", stop = 90)',
  '',
].join('\n');

export const flat = (openTime: number, close = 100): Candle => ({ openTime, open: 100, high: Math.max(101, close + 1), low: 99, close, volume: 10 });
export const signal = (openTime: number): Candle => flat(openTime, 160);

export function pair(symbol: string, onboardDate = 0): PairInfo {
  return {
    symbol,
    onboardDate,
    rules: {
      symbol,
      tickSize: 0.01,
      stepSize: 0.001,
      minNotional: 5,
      maxLeverage: 20,
      leverageEstimated: true,
      brackets: [{ notionalCap: Infinity, maintMarginRate: 0.01, maintAmount: 0 }],
      bracketsEstimated: true,
    },
  };
}

/** HISTORY flat bars ending with the bar that closed at B0 (openTime B0 - STEP). */
export const historyBars = (n = HISTORY, lastOpen = B0 - STEP): Candle[] => Array.from({ length: n }, (_, i) => flat(lastOpen - (n - 1 - i) * STEP));

export function setupFor(o: { sizing?: SizingRule; fees?: FeeConfig; balance?: number; script?: string } = {}): RunSetup {
  return {
    script: o.script ?? SCRIPT,
    exchange: 'binance',
    tf: TF,
    startingBalance: o.balance ?? 10_000,
    sizing: o.sizing ?? { kind: 'fixed', notionalUsd: 4_000 },
    fees: o.fees ?? DEFAULT_FEES,
  };
}

export function world(symbols: string[], o: { history?: Record<string, number> } = {}) {
  const clock = makeClock(START);
  const db = openDb(':memory:');
  const repo = new RunRepo(db, clock.now);
  const candles = new CandleRepo(db);
  const fundingRepo = new FundingRepo(db);
  const pairs = symbols.map((s) => pair(s));
  const client = new FakeExchange({
    now: clock.now,
    sleep: clock.sleep,
    pairs,
    tickers: symbols.map((s, i) => ({ symbol: s, quoteVolume: 1_000_000 * (symbols.length - i), lastPrice: 100 })),
  });
  for (const s of symbols) client.setCandles(s, TF, historyBars(o.history?.[s] ?? HISTORY));
  const tracker = new FundingTracker({ client, repo: fundingRepo, now: clock.now, log: () => {} });
  return { clock, db, repo, candles, fundingRepo, client, tracker, pairs };
}

/** A started ScannerRun over `symbols`; volumes fall in the order given (first = highest). */
export async function startedRun(symbols: string[], o: Parameters<typeof setupFor>[0] & { history?: Record<string, number> } = {}) {
  const w = world(symbols, o);
  const setup = setupFor(o);
  const runId = w.repo.createRun({ name: 'test', setup });
  const run = new ScannerRun({ runId, repo: w.repo, candles: w.candles, client: w.client, funding: w.tracker, setup, now: w.clock.now, sleep: w.clock.sleep, warmupBars: HISTORY });
  const volumes = new Map(symbols.map((s, i) => [s, 1_000_000 * (symbols.length - i)]));
  await run.start(w.pairs, volumes);
  /** Bar k after the history (k = 0: openTime B0), closing at B0 + (k + 1) * STEP. */
  const barOpen = (k: number) => B0 + k * STEP;
  /** One close: every given bar (a symbol -> candle map), stored as the feed would, the clock 1 s past the close. */
  const close = async (k: number, bars: Record<string, Candle>, info = { missing: [] as string[], behind: [] as string[] }) => {
    const closeTime = barOpen(k) + STEP;
    w.clock.set(closeTime + 1_000);
    for (const [s, c] of Object.entries(bars)) {
      w.candles.upsert(s, TF, [c]);
      w.client.setCandles(s, TF, [...historyBars(), ...Array.from({ length: k + 1 }, (_, i) => (i === k ? c : flat(barOpen(i))))]);
    }
    return run.onClose(closeTime, new Map(Object.entries(bars)), info);
  };
  const flatAll = (k: number, syms = symbols) => Object.fromEntries(syms.map((s) => [s, flat(barOpen(k))]));
  return { ...w, setup, runId, run, volumes, barOpen, close, flatAll };
}
