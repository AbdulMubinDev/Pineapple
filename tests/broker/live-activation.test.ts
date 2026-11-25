// Ruling H2: live fills between closes. Only what was active when a bar opened is walked on that bar's path; a
// market order submitted mid-bar does not fill at that bar's open.
import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import type { Candle, OrderIntent, PairRules } from '../../src/core/types.js';

const rules: PairRules = {
  symbol: 'BTCUSDT',
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 5,
  maxLeverage: 125,
  leverageEstimated: false,
  brackets: [{ notionalCap: Infinity, maintMarginRate: 0.004, maintAmount: 0 }],
};
const OPEN = 900_000 * 1000; // the forming bar's open
const MID = OPEN + 300_000; // a live tick five minutes in
const bar: Candle = { openTime: OPEN, open: 100, high: 101, low: 80, close: 100, volume: 1 };

function make() {
  const b = new PaperBroker({ startingBalance: 10_000, fees: DEFAULT_FEES, mode: 'binance', rules: () => rules, sizing: { kind: 'script' } });
  b.markToMarket('BTCUSDT', 100);
  return b;
}
const order = (o: Partial<OrderIntent>): OrderIntent => ({ id: 'e', symbol: 'BTCUSDT', side: 'buy', type: 'market', qty: 1, reduceOnly: false, tag: 'entry', leverage: 1, ...o });

describe('live activation (H2)', () => {
  it('a live entry fill, then the bar walk: an earlier low through the stop does not exit it', () => {
    const b = make();
    // The bar first dipped to 80, then a live tick at 100.5 fills a buy stop entry at 100.5 mid-bar.
    b.submit(order({ type: 'stop', stopPrice: 100.5 }), OPEN);
    expect(b.onPrice('BTCUSDT', 100.5, MID)).toHaveLength(1);
    b.submit(order({ id: 'sl', side: 'sell', type: 'stop', stopPrice: 90, tag: 'exit', reduceOnly: true }), MID);
    // The close pass walks the bar's whole path (100 -> 80 -> 101 -> 100): the stop went live after the low.
    expect(b.onBarRange('BTCUSDT', bar, { liquidation: true })).toEqual([]);
    expect(b.position('BTCUSDT')?.qty).toBe(1);
    // Active from the next bar on.
    const next: Candle = { openTime: OPEN + 900_000, open: 100, high: 100, low: 85, close: 88, volume: 1 };
    expect(b.onBarRange('BTCUSDT', next).map((f) => f.orderId)).toEqual(['sl']);
  });

  it('a mid-bar position is not liquidated by an earlier extreme of the bar', () => {
    const b = make();
    // 50x long opened by a live tick: liquidation near 98.4, below the bar's earlier low of 80.
    b.submit(order({ type: 'limit', limitPrice: 100, leverage: 50 }), OPEN);
    expect(b.onPrice('BTCUSDT', 100, MID)).toHaveLength(1);
    expect(b.onBarRange('BTCUSDT', bar, { liquidation: true })).toEqual([]);
    expect(b.position('BTCUSDT')).not.toBeNull();
    // An add mid-bar also moves the liquidation price: the same holds for a position added to after the open.
    const c = make();
    c.submit(order({ leverage: 50 }), OPEN - 900_000);
    c.onBarOpen('BTCUSDT', { ...bar, openTime: OPEN - 900_000, low: 100 });
    c.submit(order({ id: 'add', type: 'limit', limitPrice: 100, leverage: 50 }), OPEN);
    c.onPrice('BTCUSDT', 100, MID);
    expect(c.position('BTCUSDT')?.qty).toBe(2);
    expect(c.onBarRange('BTCUSDT', bar, { liquidation: true })).toEqual([]);
    // Opened at a bar boundary (replay): the same low liquidates.
    const d = make();
    d.submit(order({ leverage: 50 }), OPEN - 900_000);
    d.onBarOpen('BTCUSDT', { ...bar, low: 100 });
    expect(d.onBarRange('BTCUSDT', bar, { liquidation: true }).map((f) => f.orderId)[0]).toMatch(/^liquidation:/);
  });

  it('a market order submitted mid-bar fills at the next tick, not at that bar open', () => {
    const b = make();
    b.submit(order({}), MID);
    expect(b.onBarOpen('BTCUSDT', bar)).toEqual([]);
    expect(b.onPrice('BTCUSDT', 99, MID + 1_000, { markets: false })).toEqual([]);
    const fills = b.fillMarketAt('BTCUSDT', 99.5, MID + 2_000, { submittedAfter: OPEN });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ time: MID + 2_000 });
    expect(fills[0]!.price).toBe(99.6); // 99.5 plus slippage, rounded up to the 0.1 tick
    // A market order from the close (submitted at a bar boundary) still waits for the next bar's open.
    b.submit(order({ id: 'close-made', side: 'sell', tag: 'exit', reduceOnly: true }), OPEN - 900_000);
    expect(b.fillMarketAt('BTCUSDT', 99.5, MID + 3_000, { submittedAfter: OPEN })).toEqual([]);
    expect(b.onBarOpen('BTCUSDT', { ...bar, openTime: OPEN + 900_000 }).map((f) => f.orderId)).toEqual(['close-made']);
  });
});
