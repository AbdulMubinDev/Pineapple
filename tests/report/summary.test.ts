import { describe, expect, it } from 'vitest';
import type { ClosedTrade } from '../../src/core/types.js';
import { formatPrice, summarize, tradeNet, tradesCsv } from '../../src/report/summary.js';

const trade = (pnl: number, more: Partial<ClosedTrade> = {}): ClosedTrade => ({
  symbol: 'BTCUSDT',
  side: 'long',
  entryTime: Date.UTC(2024, 0, 1),
  entryPrice: 40_000,
  exitTime: Date.UTC(2024, 0, 2),
  exitPrice: 41_000,
  qty: 0.1,
  pnl,
  fees: 0,
  funding: 0,
  exitReason: 'signal',
  ...more,
});

describe('summarize', () => {
  it('summary of known trades', () => {
    const s = summarize([trade(100), trade(-50), trade(200), trade(-25)], 10_000, []);
    expect(s.tradeCount).toBe(4);
    expect(s.winRatePct).toBe(50);
    expect(s.profitFactor).toBe(4); // 300 / 75
    expect(s.biggestWin).toBe(200);
    expect(s.biggestLoss).toBe(-50); // the largest losing trade (see the task report on the brief's -25)
    expect(s.avgWin).toBe(150);
    expect(s.avgLoss).toBe(-37.5);
    expect(s.netProfit).toBe(225);
    expect(s.netProfitPct).toBeCloseTo(2.25, 12);
  });

  it('max drawdown from equity curve', () => {
    const curve = [10_000, 11_000, 9_900, 12_000].map((equity, i) => ({ time: i, equity }));
    expect(summarize([], 10_000, curve).maxDrawdownPct).toBeCloseTo(10, 12);
  });

  it('profit factor is Infinity without losses; an empty run is all zeros', () => {
    expect(summarize([trade(10)], 10_000, []).profitFactor).toBe(Infinity);
    expect(summarize([], 10_000, [])).toEqual({
      tradeCount: 0,
      winRatePct: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
      biggestWin: 0,
      biggestLoss: 0,
      maxDrawdownPct: 0,
      netProfit: 0,
      netProfitPct: 0,
    });
  });

  it('wins and losses are net of fees and funding (TradingView counts net profit)', () => {
    // Gross +3 but 5 in fees: a loss. Gross -1 with +4 funding received: a win.
    const s = summarize([trade(3, { fees: 5 }), trade(-1, { funding: 4 })], 10_000, []);
    expect(tradeNet(trade(3, { fees: 5 }))).toBe(-2);
    expect(s.winRatePct).toBe(50);
    expect(s.biggestWin).toBe(3);
    expect(s.biggestLoss).toBe(-2);
    expect(s.netProfit).toBe(1);
  });

  it('a drawdown from the starting balance counts even before a new high', () => {
    const curve = [9_000, 9_500].map((equity, i) => ({ time: i, equity }));
    expect(summarize([], 10_000, curve).maxDrawdownPct).toBeCloseTo(10, 12);
  });
});

describe('formatPrice', () => {
  it('8 dp, trailing zeros trimmed, no exponent notation', () => {
    expect(formatPrice(40_000)).toBe('40000');
    expect(formatPrice(101.50000000001)).toBe('101.5');
    expect(formatPrice(0.00000123)).toBe('0.00000123');
    expect(formatPrice(1.5e-7)).toBe('0.00000015');
    expect(formatPrice(0)).toBe('0');
    expect(formatPrice(-1e-10)).toBe('0');
    expect(formatPrice(-2.5)).toBe('-2.5');
  });

  it('the CSV writes tiny prices the same way', () => {
    const row = tradesCsv([trade(1, { entryPrice: 1.5e-7, exitPrice: 2e-7 })]).split('\n')[1]!;
    expect(row.split(',')[3]).toBe('0.00000015');
    expect(row.split(',')[5]).toBe('0.0000002');
  });
});

describe('tradesCsv', () => {
  it('writes one row per trade: quantities 8 dp, USD 2 dp, UTC times', () => {
    const csv = tradesCsv([trade(123.456, { fees: 1.005, funding: -0.4, qty: 0.123456789 })]);
    const [header, row, end] = csv.split('\n');
    expect(header).toBe('symbol,side,entryTime,entryPrice,exitTime,exitPrice,qty,pnl,fees,funding,net,exitReason');
    expect(row).toBe('BTCUSDT,long,2024-01-01T00:00:00.000Z,40000,2024-01-02T00:00:00.000Z,41000,0.12345679,123.46,1.00,-0.40,122.05,signal');
    expect(end).toBe('');
  });
});
