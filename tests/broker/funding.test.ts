import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import type { BrokerMode, Candle, OrderIntent, PairRules } from '../../src/core/types.js';

const rules: PairRules = {
  symbol: 'BTCUSDT',
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 100,
  maxLeverage: 125,
  leverageEstimated: false,
  brackets: [],
};

const opts = (mode: BrokerMode) => ({
  startingBalance: 10_000,
  fees: DEFAULT_FEES,
  mode,
  rules: () => rules,
  sizing: { kind: 'script' as const },
});

function open(side: 'buy' | 'sell', mode: BrokerMode = 'binance') {
  const b = new PaperBroker(opts(mode));
  b.markToMarket('BTCUSDT', 50000);
  const o: OrderIntent = { id: 'o1', symbol: 'BTCUSDT', side, type: 'market', qty: 0.1, reduceOnly: false, tag: 'entry', leverage: 10 };
  b.submit(o, 0);
  const c: Candle = { openTime: 1000, open: 50000, high: 50000, low: 50000, close: 50000, volume: 1 };
  b.onBarOpen('BTCUSDT', c);
  return b;
}

const ev = (time: number, rate = 0.0001, markPrice = 50000) => ({ time, rate, markPrice });

describe('funding', () => {
  it('long pays positive funding', () => {
    const b = open('buy');
    const before = b.account().balance;
    expect(b.applyFunding('BTCUSDT', ev(2000))).toBeCloseTo(-0.5, 10);
    expect(b.account().balance).toBeCloseTo(before - 0.5, 10);
    expect(b.account().fundingNet).toBeCloseTo(-0.5, 10);
  });

  it('short receives positive funding', () => {
    const b = open('sell');
    expect(b.applyFunding('BTCUSDT', ev(2000))).toBeCloseTo(0.5, 10);
  });

  it('no funding on position opened at funding time', () => {
    const b = open('buy');
    expect(b.applyFunding('BTCUSDT', ev(1000))).toBe(0);
    expect(b.account().fundingNet).toBe(0);
  });

  it('no funding without a position', () => {
    const b = open('buy');
    expect(b.applyFunding('ETHUSDT', ev(2000))).toBe(0);
  });

  it('tradingview mode ignores funding', () => {
    const b = open('buy', 'tradingview');
    expect(b.applyFunding('BTCUSDT', ev(2000))).toBe(0);
    expect(b.account().fundingNet).toBe(0);
  });

  it('funding accrues onto the closed trade', () => {
    const b = open('buy');
    b.applyFunding('BTCUSDT', ev(2000));
    b.applyFunding('BTCUSDT', ev(3000, -0.0002));
    b.submit({ id: 'x', symbol: 'BTCUSDT', side: 'sell', type: 'market', qty: 0.1, reduceOnly: true, tag: 'exit', leverage: 10 }, 0);
    b.onBarOpen('BTCUSDT', { openTime: 4000, open: 50000, high: 50000, low: 50000, close: 50000, volume: 1 });
    // -0.5 + 1.0
    expect(b.closedTrades()[0]?.funding).toBeCloseTo(0.5, 10);
  });

  it('old funding rows with markPrice 0 use the last price', () => {
    const b = open('buy');
    b.markToMarket('BTCUSDT', 40000);
    // -0.1 * 40000 * 0.0001 = -0.4
    expect(b.applyFunding('BTCUSDT', ev(2000, 0.0001, 0))).toBeCloseTo(-0.4, 10);
  });

  it('markPrice 0 and no last price applies nothing', () => {
    const s = open('buy').snapshot();
    s.lastPrice = {};
    const r = PaperBroker.restore(s, opts('binance'));
    expect(r.applyFunding('BTCUSDT', ev(2000, 0.0001, 0))).toBe(0);
    expect(r.account().fundingNet).toBe(0);
  });
});
