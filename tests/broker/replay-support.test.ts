// Broker additions for the replay (Task 6): liquidation in path order with stops, slippage in ticks,
// fill-at-close for process_orders_on_close, and the exit order id on closed trades.
import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import type { BrokerMode, Candle, FeeConfig, OrderIntent, PairRules } from '../../src/core/types.js';

const rules: PairRules = {
  symbol: 'BTCUSDT',
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 100,
  maxLeverage: 125,
  leverageEstimated: false,
  brackets: [{ notionalCap: 50_000, maintMarginRate: 0.004, maintAmount: 0 }],
};

function make(mode: BrokerMode = 'binance', fees: FeeConfig = DEFAULT_FEES) {
  const b = new PaperBroker({ startingBalance: 10_000, fees, mode, rules: () => rules, sizing: { kind: 'script' } });
  b.markToMarket('BTCUSDT', 50000);
  return b;
}

function order(o: Partial<OrderIntent>): OrderIntent {
  return { id: 'o1', symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 0.1, reduceOnly: false, tag: 'entry', leverage: 10, ...o };
}

const bar = (open: number, high: number, low: number, close: number, openTime = 1000): Candle => ({ openTime, open, high, low, close, volume: 1 });

/** Long 0.1 @ 50010 (10x): liquidation price 45189.76 (see margin.test.ts). */
function long10x() {
  const b = make();
  b.submit(order({}), 0);
  b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000));
  return b;
}

describe('onBarRange with the liquidation check (binance mode)', () => {
  it('liquidates when the path reaches the liquidation price before the stop', () => {
    const b = long10x();
    b.submit(order({ id: 'sl', side: 'sell', type: 'stop', stopPrice: 44000, tag: 'exit', reduceOnly: true }), 0);
    const fills = b.onBarRange('BTCUSDT', bar(50000, 50100, 43000, 49000, 5000), { liquidation: true });
    expect(fills.map((f) => f.orderId)).toEqual(['liquidation:BTCUSDT:5000']);
    expect(fills[0]!.price).toBeCloseTo(45189.76, 2);
    expect(b.position('BTCUSDT')).toBeNull();
    expect(b.openOrders('BTCUSDT')).toEqual([]);
    const t = b.closedTrades()[0]!;
    expect(t.exitReason).toBe('liquidation');
    expect(t.pnl).toBeCloseTo(-500.1, 8);
  });

  it('fills the stop when the path reaches it first, and does not liquidate afterwards', () => {
    const b = long10x();
    b.submit(order({ id: 'sl', side: 'sell', type: 'stop', stopPrice: 46000, tag: 'exit', reduceOnly: true }), 0);
    const fills = b.onBarRange('BTCUSDT', bar(50000, 50100, 43000, 49000, 5000), { liquidation: true });
    expect(fills.map((f) => f.orderId)).toEqual(['sl']);
    expect(b.closedTrades().map((t) => t.exitReason)).toEqual(['stop']);
  });

  it('follows the intrabar path: rising through the liquidation price before the stop liquidates a short', () => {
    // Short 0.1 @ 49990 (10x): liquidation price (499.9 + 4999) / 0.1004 = 54769.92; the buy stop at 56000 is past it.
    const b = make();
    b.submit(order({ side: 'sell' }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000));
    b.submit(order({ id: 'sl', side: 'buy', type: 'stop', stopPrice: 56000, tag: 'exit', reduceOnly: true }), 0);
    // |H-O| = 7000 >= |O-L| = 100: low first (O -> L -> H -> C); on L -> H the price reaches LP before 56000.
    const fills = b.onBarRange('BTCUSDT', bar(50000, 57000, 49900, 50000, 5000), { liquidation: true });
    expect(fills.map((f) => f.orderId)).toEqual(['liquidation:BTCUSDT:5000']);
  });

  it('a stop exactly at the liquidation price fills first (ties go to the stop)', () => {
    const b = long10x();
    b.submit(order({ id: 'sl', side: 'sell', type: 'stop', stopPrice: 50000, tag: 'exit', reduceOnly: true }), 0);
    // Gap open below both: both trigger at distance 0, the stop wins.
    const fills = b.onBarRange('BTCUSDT', bar(40000, 40100, 39000, 39500, 5000), { liquidation: true });
    expect(fills.map((f) => f.orderId)).toEqual(['sl']);
  });

  it('checks a position opened earlier on the same path', () => {
    const b = make();
    b.submit(order({ id: 'in', type: 'stop', stopPrice: 50500 }), 0);
    // O -> H (stop entry fills ~50510 after slippage) -> L (falls through its LP ~45640) -> C.
    // |H-O| = 600 < |O-L| = 7000: high first.
    const fills = b.onBarRange('BTCUSDT', bar(50000, 50600, 43000, 44000, 5000), { liquidation: true });
    expect(fills.map((f) => f.orderId)).toEqual(['in', 'liquidation:BTCUSDT:5000']);
    expect(b.position('BTCUSDT')).toBeNull();
  });

  it('without the option, onBarRange never liquidates (existing behaviour)', () => {
    const b = long10x();
    expect(b.onBarRange('BTCUSDT', bar(50000, 50100, 43000, 49000, 5000))).toEqual([]);
    expect(b.position('BTCUSDT')).not.toBeNull();
  });

  it('tradingview mode ignores the option', () => {
    const b = make('tradingview');
    b.submit(order({}), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000));
    expect(b.onBarRange('BTCUSDT', bar(50000, 50100, 1000, 49000, 5000), { liquidation: true })).toEqual([]);
    expect(b.position('BTCUSDT')).not.toBeNull();
  });
});

describe('slippage in ticks (TradingView Properties)', () => {
  const tvFees: FeeConfig = { makerRate: 0.0005, takerRate: 0.0005, slippagePct: 0, slippageTicks: 2 };

  it('market and stop fills move ticks x tickSize against the trader; limits do not', () => {
    const b = make('tradingview', tvFees);
    b.submit(order({ id: 'm' }), 0);
    const [m] = b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000));
    expect(m!.price).toBeCloseTo(50000.2, 8);
    expect(m!.fee).toBeCloseTo(0.1 * 50000.2 * 0.0005, 10);
    b.submit(order({ id: 'sl', side: 'sell', type: 'stop', stopPrice: 49000, tag: 'exit', reduceOnly: true }), 0);
    const [s] = b.onBarRange('BTCUSDT', bar(50000, 50000, 48000, 48500, 5000));
    expect(s!.price).toBeCloseTo(48999.8, 8);
    b.submit(order({ id: 'lim', type: 'limit', limitPrice: 48000 }), 0);
    const [l] = b.onBarRange('BTCUSDT', bar(48500, 48600, 47000, 47500, 9000));
    expect(l!.price).toBe(48000);
  });
});

describe('fillMarketAt (process_orders_on_close)', () => {
  it('fills pending market orders at the given price plus slippage, leaving resting orders alone', () => {
    const b = make('tradingview', { makerRate: 0, takerRate: 0, slippagePct: 0, slippageTicks: 1 });
    b.submit(order({ id: 'm' }), 0);
    b.submit(order({ id: 'st', type: 'stop', stopPrice: 40000 }), 0); // already through: still waits for a price event
    const fills = b.fillMarketAt('BTCUSDT', 51000, 7000);
    expect(fills).toEqual([{ orderId: 'm', symbol: 'BTCUSDT', time: 7000, price: 51000.1, qty: 0.1, side: 'buy', fee: 0, liquidity: 'taker' }]);
    expect(b.position('BTCUSDT')).toMatchObject({ qty: 0.1, entryPrice: 51000.1, openTime: 7000 });
    expect(b.openOrders('BTCUSDT').map((o) => o.id)).toEqual(['st']);
    expect(b.lastPriceOf('BTCUSDT')).toBe(51000);
  });
});

describe('closed trades carry the order id that closed them', () => {
  it('signal, stop and liquidation exits', () => {
    const b = long10x();
    b.submit(order({ id: 'x', side: 'sell', reduceOnly: true, tag: 'exit' }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000, 2000));
    b.submit(order({ id: 'o2' }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000, 3000));
    b.onMark('BTCUSDT', 1000, 4000);
    expect(b.closedTrades().map((t) => t.exitOrderId)).toEqual(['x', 'liquidation:BTCUSDT:4000']);
  });
});
