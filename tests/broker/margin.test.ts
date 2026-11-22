import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import { leverageInForce, liquidationPrice, maintenance } from '../../src/broker/margin.js';
import type { BrokerMode, Candle, OrderIntent, PairRules } from '../../src/core/types.js';

const rules: PairRules = {
  symbol: 'BTCUSDT',
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 100,
  maxLeverage: 125,
  leverageEstimated: false,
  brackets: [
    { notionalCap: 50_000, maintMarginRate: 0.004, maintAmount: 0 },
    { notionalCap: 250_000, maintMarginRate: 0.005, maintAmount: 50 },
  ],
};

function make(mode: BrokerMode = 'binance') {
  const b = new PaperBroker({ startingBalance: 10_000, fees: DEFAULT_FEES, mode, rules: () => rules, sizing: { kind: 'script' } });
  b.markToMarket('BTCUSDT', 50000);
  return b;
}

function order(o: Partial<OrderIntent>): OrderIntent {
  return { id: 'o1', symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.1, reduceOnly: false, tag: 'entry', leverage: 10, ...o };
}

const bar = (open: number): Candle => ({ openTime: 1000, open, high: open, low: open, close: open, volume: 1 });

describe('leverageInForce', () => {
  it('derives leverage from the script margin pct, capped by max leverage, floor 1', () => {
    expect(leverageInForce(undefined, 125)).toBe(1);
    expect(leverageInForce(10, 125)).toBe(10);
    expect(leverageInForce(1, 20)).toBe(20);
    expect(leverageInForce(500, 20)).toBe(1);
  });
});

describe('maintenance', () => {
  it('picks the bracket containing the notional', () => {
    expect(maintenance(5000, rules.brackets)).toEqual({ rate: 0.004, amount: 0 });
    expect(maintenance(50_000, rules.brackets)).toEqual({ rate: 0.004, amount: 0 });
    expect(maintenance(60_000, rules.brackets)).toEqual({ rate: 0.005, amount: 50 });
    expect(maintenance(9e9, rules.brackets)).toEqual({ rate: 0.005, amount: 50 });
  });
});

describe('liquidationPrice', () => {
  it('long 10x', () => {
    const lp = liquidationPrice({ side: 1, qty: 1, entryPrice: 50000, isolatedMargin: 5000, mmr: 0.004, maintAmount: 0 });
    expect(lp).toBeCloseTo(45180.72, 2);
  });
  it('short 10x', () => {
    // (5000 + 50000) / (0.004 + 1) = 54780.88
    const lp = liquidationPrice({ side: -1, qty: 1, entryPrice: 50000, isolatedMargin: 5000, mmr: 0.004, maintAmount: 0 });
    expect(lp).toBeCloseTo(54780.88, 2);
  });
});

describe('liquidation', () => {
  it('liquidates on mark cross and books full margin loss', () => {
    const b = make();
    b.submit(order({}), 0);
    b.onBarOpen('BTCUSDT', bar(50000)); // fills at 50010, margin 500.1, fee 2.5005
    expect(b.position('BTCUSDT')?.margin).toBeCloseTo(500.1, 8);
    expect(b.onMark('BTCUSDT', 46000, 2000)).toEqual([]);
    const fills = b.onMark('BTCUSDT', 45000, 3000);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.price).toBeCloseTo(45189.76, 2);
    expect(fills[0]?.side).toBe('sell');
    expect(b.position('BTCUSDT')).toBeNull();
    const t = b.closedTrades()[0];
    expect(t?.exitReason).toBe('liquidation');
    expect(t?.pnl).toBeCloseTo(-500.1, 8);
    expect(t?.exitPrice).toBeCloseTo(45189.76, 2);
    expect(t?.fees).toBeCloseTo(2.5005, 8);
    expect(b.account().balance).toBeCloseTo(10000 - 2.5005 - 500.1, 8);
  });

  it('liquidates a short when mark rises through LP and cancels its resting exits', () => {
    const b = make();
    b.submit(order({ side: 'sell' }), 0);
    b.onBarOpen('BTCUSDT', bar(50000));
    b.submit(order({ id: 'tp', side: 'buy', type: 'limit', limitPrice: 40000, tag: 'exit', reduceOnly: true }), 0);
    expect(b.onMark('BTCUSDT', 54000, 2000)).toEqual([]);
    expect(b.onMark('BTCUSDT', 56000, 3000)).toHaveLength(1);
    expect(b.openOrders('BTCUSDT')).toEqual([]);
    expect(b.closedTrades()[0]?.exitReason).toBe('liquidation');
  });

  it('tradingview mode ignores liquidation', () => {
    const b = make('tradingview');
    b.submit(order({}), 0);
    b.onBarOpen('BTCUSDT', bar(50000));
    expect(b.onMark('BTCUSDT', 1000, 2000)).toEqual([]);
    expect(b.position('BTCUSDT')).not.toBeNull();
  });
});
