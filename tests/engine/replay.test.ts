import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Candle, FundingEvent, OrderIntent, PairRules } from '../../src/core/types.js';
import { DataGapError, loadCandles } from '../../src/data/csv.js';
import { PaperBroker } from '../../src/broker/broker.js';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import { barHooks, replay, splitOverfills } from '../../src/engine/replay.js';
import { StrategyLayer } from '../../src/engine/strategy-layer.js';
import { tradesCsv } from '../../src/report/summary.js';

const H4 = 14_400_000;
const rules = JSON.parse(readFileSync('tests/fixtures/BTCUSDT-rules.json', 'utf8')) as PairRules;
const probe01 = readFileSync('spike/probes/01-ma-cross.pine', 'utf8');
const TV = { initialCapital: 10_000, commissionPct: 0.05, slippageTicks: 0 };

// A short slice of the 4h fixture: Oct 2023 warm-up, then Jan-Feb 2024.
const FROM = Date.UTC(2024, 0, 1);
const TO = Date.UTC(2024, 2, 1);
const fixture = loadCandles('tests/fixtures/BTCUSDT_4h.csv', '4h').filter((c) => c.openTime >= Date.UTC(2023, 9, 1) && c.openTime < TO);

const sma = (xs: number[], i: number, n: number) => (i + 1 < n ? NaN : xs.slice(i + 1 - n, i + 1).reduce((s, x) => s + x, 0) / n);

/** Probe 01's first signal bar in range, worked out by hand from the closes. */
function firstSignalBar(candles: Candle[]): number {
  const closes = candles.map((c) => c.close);
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.openTime < FROM) continue;
    const [f, s, f1, s1] = [sma(closes, i, 10), sma(closes, i, 30), sma(closes, i - 1, 10), sma(closes, i - 1, 30)];
    if ((f > s && f1 <= s1) || (f < s && f1 >= s1)) return i;
  }
  throw new Error('no signal');
}

const base = { symbol: 'BTCUSDT', tf: '4h' as const, funding: [] as FundingEvent[], rules, startingBalance: 10_000, sizing: { kind: 'script' as const } };

describe('replay on the fixture (probe 01)', () => {
  it('replay fills signal at next open', async () => {
    const r = await replay({ ...base, source: probe01, candles: fixture, from: FROM, to: TO, mode: 'tradingview', tv: TV });
    const sig = firstSignalBar(fixture);
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0]!.entryTime).toBe(fixture[sig + 1]!.openTime);
    expect(r.trades[0]!.entryPrice).toBe(fixture[sig + 1]!.open);
    // TradingView Properties: commission 0.05 % on both legs.
    const t = r.trades[0]!;
    expect(t.fees).toBeCloseTo(t.qty * (t.entryPrice + t.exitPrice) * 0.0005, 6);
    expect(r.summary.tradeCount).toBe(r.trades.length);
    expect(r.equityCurve[0]!.time).toBe(FROM);
    expect(r.equityCurve.at(-1)!.time).toBe(fixture.at(-1)!.openTime);
  });

  it('process_orders_on_close = true fills on the signal bar at its close', async () => {
    const src = probe01.replace('pyramiding = 0)', 'pyramiding = 0, process_orders_on_close = true)');
    expect(src).not.toBe(probe01);
    const r = await replay({ ...base, source: src, candles: fixture, from: FROM, to: TO, mode: 'tradingview', tv: TV });
    const sig = firstSignalBar(fixture);
    expect(r.declaration.processOrdersOnClose).toBe(true);
    expect(r.trades[0]!.entryTime).toBe(fixture[sig]!.openTime);
    expect(r.trades[0]!.entryPrice).toBe(fixture[sig]!.close);
  });

  it('replay throws DataGapError on gapped fixture', async () => {
    const gapped = [...fixture.slice(0, 100), ...fixture.slice(101)];
    await expect(replay({ ...base, source: probe01, candles: gapped, from: FROM, to: TO, mode: 'tradingview', tv: TV })).rejects.toBeInstanceOf(DataGapError);
  });

  it('a gap after `to` does not matter', async () => {
    const gapped = [...fixture, ...fixture.slice(-1).map((c) => ({ ...c, openTime: c.openTime + 5 * H4 }))];
    const to = fixture.at(-1)!.openTime;
    const r = await replay({ ...base, source: probe01, candles: gapped, from: FROM, to, mode: 'tradingview', tv: TV });
    expect(r.equityCurve.at(-1)!.time).toBe(to);
  });

  it('rejects a script that does not compile', async () => {
    await expect(replay({ ...base, source: '//@version=6\nindicator("x")\nplot(close)\n', candles: fixture, from: FROM, to: TO, mode: 'tradingview', tv: TV })).rejects.toThrow(/strategy\(\) scripts only/);
  });
});

// ---------------------------------------------------------------- synthetic bars ----

const T0 = Date.UTC(2024, 0, 1);
/** 60 flat bars at `price`, with overrides by index. */
function bars(over: Record<number, [number, number, number, number]>, price = 100, n = 60): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const [open, high, low, close] = over[i] ?? [price, price + 0.5, price - 0.5, price];
    return { openTime: T0 + i * H4, open, high, low, close, volume: 1 };
  });
}
const NOFEE = { initialCapital: 10_000, commissionPct: 0, slippageTicks: 0 };

describe('replay wiring (synthetic bars)', () => {
  it('overfill round trips stay out of the summary and the CSV, and are listed with their P&L', async () => {
    // Pyramiding 1, two stop entries from flat: both fill on bar 41's rise (one broker call), so the
    // second is an add past the cap. TradingView would cancel it; the layer closes it at bar 42's open.
    const src = [
      '//@version=6',
      'strategy("of", pyramiding = 1, initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 1)',
      'if bar_index == 40',
      '    strategy.entry("A", strategy.long, stop = 101)',
      '    strategy.entry("B", strategy.long, stop = 102)',
      'if bar_index == 45',
      '    strategy.close_all()',
    ].join('\n');
    const candles = bars({ 41: [100, 105, 99.5, 104] }, 100).map((c, i) => (i > 41 ? { ...c, open: 104, high: 104.5, low: 103.5, close: 104 } : c));
    const r = await replay({ ...base, source: src, candles, from: T0, to: candles.at(-1)!.openTime, mode: 'tradingview', tv: NOFEE });
    expect(r.anomalies.map((a) => a.kind)).toEqual(['pyramiding_overfill']);
    expect(r.overfills).toHaveLength(1);
    // The broker averages the two lots (101.5); the replay restates each side at its own lot's price.
    expect(r.overfills[0]).toMatchObject({ entryTime: candles[41]!.openTime, exitTime: candles[42]!.openTime, qty: 1, entryPrice: 102, exitPrice: 104 });
    expect(r.overfills[0]!.pnl).toBeCloseTo(2, 10);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ exitTime: candles[46]!.openTime, qty: 1, entryPrice: 101, exitPrice: 104 });
    expect(r.summary.tradeCount).toBe(1);
    expect(r.summary.netProfit).toBeCloseTo(3, 10); // TradingView: 104 - 101
    // Script + overfill = the broker's total.
    expect(r.summary.netProfit + r.overfills[0]!.pnl).toBeCloseTo(r.account.balance - 10_000, 10);
    expect(tradesCsv(r.trades).trim().split('\n')).toHaveLength(2);
  });

  it('splitOverfills: a script close that absorbed overfill quantity is split, fees and funding by quantity', () => {
    const t = {
      symbol: 'BTCUSDT',
      side: 'long' as const,
      entryTime: 1,
      entryPrice: 101.5,
      exitTime: 9,
      exitPrice: 104,
      qty: 2,
      pnl: 5,
      fees: 0.4,
      funding: -0.2,
      exitReason: 'signal' as const,
      exitOrderId: 'BTCUSDT|CA|3',
    };
    const plain = { ...t, exitOrderId: 'other', exitTime: 20 };
    const { trades, overfills } = splitOverfills(
      [t, plain],
      [{ orderId: 'BTCUSDT|CA|3', time: 9, parts: [{ kind: 'script', qty: 1, entryPrice: 101, pnl: 3 }, { kind: 'overfill', qty: 1, entryPrice: 102, pnl: 2 }] }],
    );
    expect(trades).toEqual([{ ...t, qty: 1, entryPrice: 101, pnl: 3, fees: 0.2, funding: -0.1 }, plain]);
    expect(overfills).toEqual([{ ...t, qty: 1, entryPrice: 102, pnl: 2, fees: 0.2, funding: -0.1 }]);
  });

  it('lists rejections from submit and from fill time', async () => {
    const src = [
      '//@version=6',
      'strategy("rj", initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 1)',
      'if bar_index == 40',
      '    strategy.entry("L", strategy.long, qty = 1000)',
    ].join('\n');
    const candles = bars({});
    const r = await replay({ ...base, source: src, candles, from: T0, to: candles.at(-1)!.openTime, mode: 'tradingview', tv: NOFEE });
    expect(r.rejections).toEqual([{ stage: 'submit', orderId: 'BTCUSDT|E|L', time: candles[40]!.openTime, reason: 'no_free_balance' }]);
    expect(r.trades).toEqual([]);
  });

  it('bars before `from` are warm-up: their calls never reach the broker', async () => {
    const src = [
      '//@version=6',
      'strategy("wu", initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 1)',
      'if bar_index == 10 or bar_index == 40',
      '    strategy.entry("L", strategy.long)',
      'if bar_index == 50',
      '    strategy.close_all()',
    ].join('\n');
    const candles = bars({});
    const from = candles[20]!.openTime;
    const r = await replay({ ...base, source: src, candles, from, to: candles.at(-1)!.openTime, mode: 'tradingview', tv: NOFEE });
    expect(r.trades.map((t) => t.entryTime)).toEqual([candles[41]!.openTime]);
    expect(r.equityCurve[0]).toEqual({ time: from, equity: 10_000 });
    expect(r.equityCurve).toHaveLength(40);
  });

  it('candles after `to` are not replayed', async () => {
    const src = [
      '//@version=6',
      'strategy("to", initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 1)',
      'if bar_index == 40',
      '    strategy.entry("L", strategy.long)',
      'if bar_index == 50',
      '    strategy.close_all()',
    ].join('\n');
    const candles = bars({});
    const r = await replay({ ...base, source: src, candles, from: T0, to: candles[45]!.openTime, mode: 'tradingview', tv: NOFEE });
    expect(r.trades).toEqual([]);
    expect(r.openPosition).toMatchObject({ qty: 1 });
    expect(r.equityCurve.at(-1)!.time).toBe(candles[45]!.openTime);
  });

  it('tradingview mode slippage is ticks x mintick on market and stop fills', async () => {
    const src = [
      '//@version=6',
      'strategy("sl", initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 1)',
      'if bar_index == 40',
      '    strategy.entry("L", strategy.long)',
      'strategy.exit("X", from_entry = "L", stop = 95)',
    ].join('\n');
    const candles = bars({ 44: [100, 100.5, 90, 92] });
    const r = await replay({ ...base, source: src, candles, from: T0, to: candles.at(-1)!.openTime, mode: 'tradingview', tv: { ...NOFEE, slippageTicks: 3 } });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.entryPrice).toBeCloseTo(100.3, 10);
    expect(r.trades[0]!.exitPrice).toBeCloseTo(94.7, 10);
    expect(r.trades[0]!.exitReason).toBe('stop');
  });

  it('binance mode: funding applies (markPrice 0 uses the last price) and liquidation beats a farther stop', async () => {
    const src = [
      '//@version=6',
      'strategy("bn", initial_capital = 1000, default_qty_type = strategy.fixed, default_qty_value = 1, margin_long = 1)',
      'if bar_index == 40',
      '    strategy.entry("L", strategy.long)',
      'strategy.exit("X", from_entry = "L", stop = 95)',
    ].join('\n');
    // 100x long from bar 41's open (100.1 after slippage and tick rounding, margin 1.001):
    // LP = (1.001 - 100.1) / (0.004 - 1) = 99.497. Bars 41-42 stay above it; bar 43 runs high first, then down to 94.
    const tight: [number, number, number, number] = [100, 100.2, 99.8, 100];
    const candles = bars({ 41: tight, 42: tight, 43: [100, 100.2, 94, 96] });
    const funding: FundingEvent[] = [{ time: candles[42]!.openTime + 3_600_000, rate: 0.001, markPrice: 0 }];
    const r = await replay({ ...base, source: src, candles, funding, from: T0, to: candles.at(-1)!.openTime, mode: 'binance', startingBalance: 1000 });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.exitReason).toBe('liquidation');
    expect(t.exitTime).toBe(candles[43]!.openTime);
    expect(t.funding).toBeCloseTo(-0.1, 10); // long pays 1 x 100 (bar 42's open) x 0.001
    expect(r.openPosition).toBeNull();
  });
});

describe('barHooks (live wiring)', () => {
  const decl = { title: 't', pyramiding: 1, closeEntriesRule: 'FIFO' as const, defaultQtyType: 'fixed' as const, defaultQtyValue: 1, overridden: {} };
  const bar = (i: number): Candle => ({ openTime: i * H4, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  const wire = (admit?: (i: OrderIntent) => boolean) => {
    const sizing = { kind: 'script' as const };
    const broker = new PaperBroker({ startingBalance: 10_000, fees: DEFAULT_FEES, mode: 'binance', rules: () => rules, sizing });
    const layer = new StrategyLayer(decl, broker, 'BTCUSDT', sizing, { rules, from: H4 });
    const funding: FundingEvent[] = [];
    const hooks = barHooks({
      broker, layer, symbol: 'BTCUSDT', tf: '4h', mode: 'binance', from: H4, funding, processOrdersOnClose: false, warmupEquity: 10_000,
      ...(admit ? { admit } : {}),
    });
    return { broker, hooks, funding };
  };
  const entry = [{ kind: 'entry' as const, id: 'L', direction: 'long' as const, qty: 1 }];

  it('applies a funding event pushed into its array after construction (the live scanner adds them per pass)', () => {
    const { broker, hooks, funding } = wire();
    hooks.before(bar(1), 1);
    hooks.after(bar(1), 1, entry);
    hooks.before(bar(2), 2); // the entry fills at bar 2's open
    hooks.after(bar(2), 2, []);
    expect(broker.position('BTCUSDT')?.qty).toBe(1);
    funding.push({ time: 3 * H4 + 1_000, rate: 0.001, markPrice: 100 });
    hooks.before(bar(3), 3);
    expect(broker.account().fundingNet).toBeCloseTo(-0.1, 10);
  });

  it('admit false drops the intent unsent', () => {
    const { broker, hooks } = wire((i) => i.tag !== 'entry');
    hooks.before(bar(1), 1);
    hooks.after(bar(1), 1, entry);
    expect(broker.openOrders()).toEqual([]);
  });
});
