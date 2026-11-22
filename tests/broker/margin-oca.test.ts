import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import type { BrokerMode, Candle, OrderIntent, PairRules, SizingRule } from '../../src/core/types.js';

const rules: PairRules = {
  symbol: 'BTCUSDT',
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 100,
  maxLeverage: 125,
  leverageEstimated: false,
  brackets: [],
};

function opts(mode: BrokerMode = 'binance', sizing: SizingRule = { kind: 'script' }) {
  return { startingBalance: 10_000, fees: DEFAULT_FEES, mode, rules: () => rules, sizing };
}

function make(mode: BrokerMode = 'binance', sizing: SizingRule = { kind: 'script' }, price = 50000) {
  const b = new PaperBroker(opts(mode, sizing));
  b.markToMarket('BTCUSDT', price);
  return b;
}

let n = 0;
function order(o: Partial<OrderIntent>): OrderIntent {
  n += 1;
  return {
    id: `x${n}`,
    symbol: 'BTCUSDT',
    side: 'buy',
    type: 'market',
    qty: 0.1,
    reduceOnly: false,
    tag: 'entry',
    leverage: 10,
    ...o,
  };
}

function bar(open: number, high: number, low: number, close: number, openTime = 1000): Candle {
  return { openTime, open, high, low, close, volume: 1 };
}

describe('margin reservation', () => {
  it('pending opening orders reserve margin at submit', () => {
    const b = make();
    expect(b.submit(order({ qty: 0.15, leverage: 1 }), 0)).toEqual({ accepted: true });
    expect(b.submit(order({ qty: 0.15, leverage: 1 }), 0)).toEqual({ accepted: false, reason: 'no_free_balance' });
  });

  it('resting limit entries reserve margin too', () => {
    const b = make();
    expect(b.submit(order({ type: 'limit', limitPrice: 49000, qty: 0.15, leverage: 1 }), 0)).toEqual({ accepted: true });
    expect(b.submit(order({ qty: 0.15, leverage: 1 }), 0)).toEqual({ accepted: false, reason: 'no_free_balance' });
  });

  it('re-checks at fill time against the actual fill price and records a rejection', () => {
    const b = make();
    expect(b.submit(order({ id: 'big', qty: 0.15, leverage: 1 }), 0)).toEqual({ accepted: true });
    const fills = b.onBarOpen('BTCUSDT', bar(70000, 70100, 69900, 70000, 5000));
    expect(fills).toHaveLength(0);
    expect(b.position('BTCUSDT')).toBeNull();
    expect(b.account().balance).toBe(10_000);
    expect(b.openOrders()).toHaveLength(0);
    expect(b.rejections()).toEqual([{ orderId: 'big', symbol: 'BTCUSDT', time: 5000, reason: 'no_free_balance' }]);
  });

  it('rejections survive snapshot/restore', () => {
    const b = make();
    b.submit(order({ id: 'big', qty: 0.15, leverage: 1 }), 0);
    b.onBarOpen('BTCUSDT', bar(70000, 70100, 69900, 70000, 5000));
    const r = PaperBroker.restore(JSON.parse(JSON.stringify(b.snapshot())), opts());
    expect(r.rejections()).toEqual(b.rejections());
    expect(r.snapshot()).toEqual(b.snapshot());
  });
});

describe('fixed sizing', () => {
  it('opposing entry closes the old position and reverses by notional/ref', () => {
    const b = make('tradingview', { kind: 'fixed', notionalUsd: 5000 }, 100);
    b.submit(order({ qty: 999 }), 0); // 5000 / 100 = 50 long
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 1000));
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(50, 8);
    b.submit(order({ side: 'sell', qty: 999 }), 1);
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 2000));
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(-50, 8);
    expect(b.closedTrades()).toHaveLength(1);
    expect(b.closedTrades()[0]!.qty).toBeCloseTo(50, 8);
  });
});

describe('fixed sizing at leverage 1', () => {
  it('a full reversal is accepted and fills even when the new side needs more than current free margin', () => {
    const b = make('tradingview', { kind: 'fixed', notionalUsd: 5000 }, 100);
    expect(b.submit(order({ qty: 999, leverage: 1 }), 0)).toEqual({ accepted: true });
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 1000)); // long 50 @100.02, margin ~5001
    expect(b.account().freeMargin).toBeLessThan(5000);
    expect(b.submit(order({ side: 'sell', qty: 999, leverage: 1 }), 1)).toEqual({ accepted: true });
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 2000));
    expect(b.rejections()).toEqual([]);
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(-50, 8);
    expect(b.closedTrades()).toHaveLength(1);
    expect(b.account().freeMargin).toBeGreaterThan(0);
  });
});

describe('reduce-only min notional', () => {
  it('reduce-only dust closes are accepted, normal orders are not', () => {
    const b = make();
    b.submit(order({ qty: 0.002, leverage: 10 }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000));
    expect(b.submit(order({ side: 'sell', qty: 0.001 }), 1)).toEqual({ accepted: false, reason: 'below_min_notional' });
    expect(b.submit(order({ side: 'sell', qty: 0.001, reduceOnly: true, tag: 'exit' }), 1)).toEqual({ accepted: true });
    // still floors to step
    expect(b.submit(order({ side: 'sell', qty: 0.0004, reduceOnly: true, tag: 'exit' }), 1)).toEqual({
      accepted: false,
      reason: 'zero_qty_after_rounding',
    });
  });
});

describe('resting exits', () => {
  it('a TP touched before its entry fills stays resting', () => {
    const b = make('tradingview', { kind: 'script' }, 100);
    b.submit(order({ id: 'entry', type: 'limit', limitPrice: 95, qty: 1 }), 0);
    b.submit(
      order({ id: 'tp', side: 'sell', type: 'limit', limitPrice: 110, reduceOnly: true, tag: 'exit', qty: 1 }),
      0,
    );
    expect(b.onBarRange('BTCUSDT', bar(100, 111, 99, 100, 1000))).toHaveLength(0);
    expect(b.openOrders().map((x) => x.id).sort()).toEqual(['entry', 'tp']);
    const fills = b.onBarRange('BTCUSDT', bar(100, 101, 94, 96, 2000));
    expect(fills.map((f) => f.orderId)).toEqual(['entry']);
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(1, 10);
    expect(b.openOrders().map((x) => x.id)).toEqual(['tp']);
  });
});

describe('OCA', () => {
  const group = (type: 'cancel' | 'reduce') => ({ ocaGroup: 'g', ocaType: type });

  it('cancel: filling one entry removes its sibling', () => {
    const b = make('tradingview', { kind: 'script' }, 100);
    b.submit(order({ id: 'a', type: 'limit', limitPrice: 99, qty: 0.1, ...group('cancel') }), 0);
    b.submit(order({ id: 'b', type: 'limit', limitPrice: 97, qty: 0.1, ...group('cancel') }), 0);
    const fills = b.onBarRange('BTCUSDT', bar(100, 101, 96, 100, 1000));
    expect(fills.map((f) => f.orderId)).toEqual(['a']);
    expect(b.openOrders()).toHaveLength(0);
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(0.1, 10);
  });

  it('reduce: sibling qty is reduced by the filled qty and the group fills once per bar', () => {
    const b = make('tradingview', { kind: 'script' }, 100);
    b.submit(order({ id: 'a', type: 'limit', limitPrice: 99, qty: 0.3, ...group('reduce') }), 0);
    b.submit(order({ id: 'b', type: 'limit', limitPrice: 97, qty: 0.5, ...group('reduce') }), 0);
    // path open -> high -> low: both limits are crossed, but only the group's first fill may happen
    const fills = b.onBarRange('BTCUSDT', bar(100, 101, 96, 100, 1000));
    expect(fills.map((f) => f.orderId)).toEqual(['a']);
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(0.3, 10);
    const rest = b.openOrders();
    expect(rest).toHaveLength(1);
    expect(rest[0]!.id).toBe('b');
    expect(rest[0]!.qty).toBeCloseTo(0.2, 10);
  });

  it('different OCA groups are independent and both fill in one bar', () => {
    const b = make('tradingview', { kind: 'script' }, 100);
    b.submit(order({ id: 'a', type: 'limit', limitPrice: 99, qty: 0.1, ocaGroup: 'g' }), 0);
    b.submit(order({ id: 'b', type: 'limit', limitPrice: 97, qty: 0.1, ocaGroup: 'h' }), 0);
    const fills = b.onBarRange('BTCUSDT', bar(100, 101, 96, 100, 1000));
    expect(fills.map((f) => f.orderId)).toEqual(['a', 'b']);
  });
});

describe('money maths', () => {
  it('gapped stop trade: gross pnl, fees and balance', () => {
    const b = make();
    b.submit(order({ qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50100, 49900, 50000, 1000));
    b.submit(order({ id: 's', side: 'sell', type: 'stop', stopPrice: 49000, reduceOnly: true, tag: 'exit' }), 1);
    const g = bar(48000, 48500, 47500, 48200, 2000);
    b.onBarOpen('BTCUSDT', g);
    b.onBarRange('BTCUSDT', g);
    const t = b.closedTrades()[0]!;
    expect(t.pnl).toBeCloseTo(0.1 * (47990.4 - 50010), 8); // -201.96
    expect(t.pnl).toBeCloseTo(-201.96, 8);
    expect(t.fees).toBeCloseTo(2.5005 + 2.39952, 8);
    expect(t.funding).toBe(0);
    expect(b.account().balance).toBeCloseTo(10_000 - 201.96 - 2.5005 - 2.39952, 8);
    expect(b.account().feesPaid).toBeCloseTo(2.5005 + 2.39952, 8);
  });

  it('average entry after an add, and usedMargin through open, add, reduce, close', () => {
    const b = make('tradingview', { kind: 'script' }, 100);
    b.submit(order({ qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 1000)); // fills 100.02
    expect(b.account().usedMargin).toBeCloseTo((0.1 * 100.02) / 10, 10);
    b.submit(order({ qty: 0.1 }), 1);
    b.onBarOpen('BTCUSDT', bar(110, 110, 110, 110, 2000)); // fills 110.022
    const p = b.position('BTCUSDT')!;
    expect(p.qty).toBeCloseTo(0.2, 10);
    expect(p.entryPrice).toBeCloseTo((100.02 + 110.022) / 2, 8);
    const full = (0.1 * 100.02) / 10 + (0.1 * 110.022) / 10;
    expect(b.account().usedMargin).toBeCloseTo(full, 10);

    b.submit(order({ side: 'sell', qty: 0.1, reduceOnly: true, tag: 'exit' }), 2);
    b.onBarOpen('BTCUSDT', bar(120, 120, 120, 120, 3000));
    expect(b.position('BTCUSDT')!.qty).toBeCloseTo(0.1, 10);
    expect(b.account().usedMargin).toBeCloseTo(full / 2, 10);
    expect(b.position('BTCUSDT')!.entryPrice).toBeCloseTo((100.02 + 110.022) / 2, 8);

    b.submit(order({ side: 'sell', qty: 0.1, reduceOnly: true, tag: 'exit' }), 3);
    b.onBarOpen('BTCUSDT', bar(120, 120, 120, 120, 4000));
    expect(b.position('BTCUSDT')).toBeNull();
    expect(b.account().usedMargin).toBe(0);
    expect(b.closedTrades()).toHaveLength(2);
  });
});
