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

function make(mode: BrokerMode = 'binance', sizing: SizingRule = { kind: 'script' }) {
  const b = new PaperBroker(opts(mode, sizing));
  b.markToMarket('BTCUSDT', 50000);
  return b;
}

let n = 0;
function order(o: Partial<OrderIntent>): OrderIntent {
  n += 1;
  return {
    id: `o${n}`,
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

describe('PaperBroker fills', () => {
  it('market buy fills at next open plus slippage', () => {
    const b = make();
    expect(b.submit(order({ id: 'm1' }), 0)).toEqual({ accepted: true });
    expect(b.position('BTCUSDT')).toBeNull();
    const fills = b.onBarOpen('BTCUSDT', bar(50000, 50100, 49900, 50050));
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBeCloseTo(50010, 8);
    expect(fills[0]!.fee).toBeCloseTo(2.5005, 8);
    expect(fills[0]!.liquidity).toBe('taker');
    expect(b.account().balance).toBeCloseTo(9997.4995, 8);
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(0.1, 10);
  });

  it('rejects order that rounds to zero lots', () => {
    const b = make();
    expect(b.submit(order({ qty: 0.0004 }), 0)).toEqual({ accepted: false, reason: 'zero_qty_after_rounding' });
    b.onBarOpen('BTCUSDT', bar(50000, 50100, 49900, 50050));
    expect(b.position('BTCUSDT')).toBeNull();
  });

  it('rejects below min notional', () => {
    const b = make();
    expect(b.submit(order({ qty: 0.001 }), 0)).toEqual({ accepted: false, reason: 'below_min_notional' });
  });

  it('rejects when margin exceeds free balance', () => {
    const b = make();
    expect(b.submit(order({ qty: 1, leverage: 1 }), 0)).toEqual({ accepted: false, reason: 'no_free_balance' });
  });

  it('tradingview mode skips lot rounding and min notional', () => {
    const b = make('tradingview');
    expect(b.submit(order({ qty: 0.0004 }), 0)).toEqual({ accepted: true });
  });

  it('throws when no reference price is known', () => {
    const b = new PaperBroker(opts());
    expect(() => b.submit(order({}), 0)).toThrow();
  });

  it('fixed sizing derives qty from notional / last price', () => {
    const b = make('binance', { kind: 'fixed', notionalUsd: 5000 });
    expect(b.submit(order({ qty: 999 }), 0)).toEqual({ accepted: true });
    b.onBarOpen('BTCUSDT', bar(50000, 50100, 49900, 50050));
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(0.1, 10);
  });

  it('reduce-only orders are never rejected for margin', () => {
    const b = make();
    b.submit(order({ qty: 0.1, leverage: 1 }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50100, 49900, 50050));
    expect(b.submit(order({ side: 'sell', reduceOnly: true, tag: 'exit', qty: 0.1, leverage: 1 }), 1)).toEqual({
      accepted: true,
    });
  });

  it('gapped stop fills at open', () => {
    const b = make();
    b.submit(order({ qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50100, 49900, 50000, 1000));
    b.submit(order({ id: 's1', side: 'sell', type: 'stop', stopPrice: 49000, reduceOnly: true, tag: 'exit' }), 1);
    const bar2 = bar(48000, 48500, 47500, 48200, 2000);
    b.onBarOpen('BTCUSDT', bar2);
    const fills = b.onBarRange('BTCUSDT', bar2);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBeCloseTo(47990.4, 8);
    expect(b.position('BTCUSDT')).toBeNull();
    expect(b.closedTrades()[0]!.exitReason).toBe('stop');
  });

  it('intrabar path picks stop before limit when low is nearer open', () => {
    const b = make();
    b.markToMarket('BTCUSDT', 100);
    b.submit(order({ qty: 5 }), 0);
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 1000));
    b.submit(order({ id: 'stop', side: 'sell', type: 'stop', stopPrice: 96, reduceOnly: true, tag: 'exit', qty: 5 }), 1);
    b.submit(order({ id: 'tp', side: 'sell', type: 'limit', limitPrice: 108, reduceOnly: true, tag: 'exit', qty: 5 }), 1);
    // |high-open| = 10 > |open-low| = 5 -> open, low, high, close
    const fills = b.onBarRange('BTCUSDT', bar(100, 110, 95, 105, 2000));
    expect(fills.map((f) => f.orderId)).toEqual(['stop']);
    expect(b.closedTrades()[0]!.exitReason).toBe('stop');
    expect(b.openOrders('BTCUSDT')).toHaveLength(0);
  });

  it('intrabar path picks limit before stop when high is nearer open', () => {
    const b = make('tradingview');
    b.submit(order({ qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 1000));
    b.submit(order({ id: 'stop', side: 'sell', type: 'stop', stopPrice: 90, reduceOnly: true, tag: 'exit' }), 1);
    b.submit(order({ id: 'tp', side: 'sell', type: 'limit', limitPrice: 104, reduceOnly: true, tag: 'exit' }), 1);
    const fills = b.onBarRange('BTCUSDT', bar(100, 105, 89, 95, 2000));
    expect(fills.map((f) => f.orderId)).toEqual(['tp']);
    expect(fills[0]!.liquidity).toBe('maker');
    expect(fills[0]!.price).toBe(104);
    expect(b.closedTrades()[0]!.exitReason).toBe('target');
  });

  it('OCA cancels sibling on fill', () => {
    const b = make('tradingview');
    b.submit(order({ qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 1000));
    const oca = {
      ocaGroup: 'g1',
      ocaType: 'cancel' as const,
      reduceOnly: true,
      tag: 'exit' as const,
      side: 'sell' as const,
    };
    b.submit(order({ id: 'stop', type: 'stop', stopPrice: 90, ...oca }), 1);
    b.submit(order({ id: 'tp', type: 'limit', limitPrice: 104, ...oca }), 1);
    expect(b.openOrders('BTCUSDT')).toHaveLength(2);
    const fills = b.onBarRange('BTCUSDT', bar(100, 105, 89, 95, 2000));
    expect(fills).toHaveLength(1);
    expect(b.openOrders('BTCUSDT')).toHaveLength(0);
  });

  it('snapshot/restore round-trips to identical account()', () => {
    const b = make();
    b.submit(order({ qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50100, 49900, 50050));
    b.submit(order({ id: 'resting', side: 'sell', type: 'limit', limitPrice: 52000, reduceOnly: true, tag: 'exit' }), 1);
    b.markToMarket('BTCUSDT', 50500);
    const state = JSON.parse(JSON.stringify(b.snapshot()));
    expect(state).toEqual(b.snapshot());
    const r = PaperBroker.restore(state, opts());
    expect(r.account()).toEqual(b.account());
    expect(r.position('BTCUSDT')).toEqual(b.position('BTCUSDT'));
    expect(r.openOrders()).toEqual(b.openOrders());
    expect(r.snapshot()).toEqual(b.snapshot());
  });

  it('reversal closes the old position and opens the remainder', () => {
    const b = make('tradingview');
    b.submit(order({ qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(100, 100, 100, 100, 1000));
    b.submit(order({ side: 'sell', qty: 0.3 }), 1);
    b.onBarOpen('BTCUSDT', bar(110, 110, 110, 110, 2000));
    expect(b.position('BTCUSDT')?.qty).toBeCloseTo(-0.2, 10);
    expect(b.closedTrades()).toHaveLength(1);
    expect(b.closedTrades()[0]!.exitReason).toBe('signal');
    expect(b.closedTrades()[0]!.qty).toBeCloseTo(0.1, 10);
  });
});

describe('PaperBroker live support: forceClose, setFees, setSizing, realisedNet', () => {
  it('forceClose books a delisting trade', () => {
    const b = make();
    b.markToMarket('ETHUSDT', 2000);
    b.submit(order({ id: 'e', qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000, 1000)); // long 0.1 @ 50010 (slippage), fee 2.5005
    b.submit(order({ id: 'sl', side: 'sell', type: 'stop', stopPrice: 45000, reduceOnly: true, tag: 'exit' }), 1000);
    b.submit(order({ id: 'add', type: 'limit', limitPrice: 40000 }), 1000);
    b.submit(order({ id: 'other', symbol: 'ETHUSDT', type: 'limit', limitPrice: 1 }), 1000);
    const fills = b.forceClose('BTCUSDT', 49000, 2000, 'delisting');
    // No slippage, the taker fee.
    expect(fills).toEqual([
      { orderId: 'delisting:BTCUSDT:2000', symbol: 'BTCUSDT', time: 2000, price: 49000, qty: 0.1, side: 'sell', fee: 0.1 * 49000 * 0.0005, liquidity: 'taker' },
    ]);
    const t = b.closedTrades()[0]!;
    expect(t).toMatchObject({ symbol: 'BTCUSDT', side: 'long', exitPrice: 49000, exitTime: 2000, qty: 0.1, exitReason: 'delisting', exitOrderId: 'delisting:BTCUSDT:2000' });
    expect(t.pnl).toBeCloseTo(-101, 8);
    expect(t.fees).toBeCloseTo(2.5005 + 2.45, 10);
    expect(b.position('BTCUSDT')).toBeNull();
    expect(b.openOrders('BTCUSDT')).toEqual([]);
    expect(b.openOrders().map((o) => o.id)).toEqual(['other']);
    expect(b.account().balance).toBeCloseTo(10_000 - 2.5005 - 101 - 2.45, 8);
    expect(b.realisedNet('BTCUSDT')).toBe(t.pnl - t.fees + t.funding);
  });

  it('snapshot refuses a non-finite number rather than saving it as null', () => {
    const b = make();
    b.markToMarket('ETHUSDT', NaN);
    expect(() => b.snapshot()).toThrow(/PaperBroker snapshot: ETHUSDT is NaN/);
  });

  it('forceClose with no position only cancels the orders', () => {
    const b = make();
    b.submit(order({ id: 'lim', type: 'limit', limitPrice: 40000 }), 0);
    expect(b.forceClose('BTCUSDT', 50000, 2000, 'delisting')).toEqual([]);
    expect(b.openOrders()).toEqual([]);
    expect(b.closedTrades()).toEqual([]);
  });

  it('setFees applies from the next fill only', () => {
    const b = make();
    b.submit(order({ id: 'e', qty: 0.1 }), 0);
    b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000, 1000));
    const feesBefore = b.account().feesPaid;
    b.submit(order({ id: 'x', side: 'sell', reduceOnly: true, tag: 'exit' }), 1000);
    b.setFees({ makerRate: 0, takerRate: 0.001, slippagePct: 0 });
    // A fill already made keeps its fee; the pending order fills with the new fees.
    expect(b.account().feesPaid).toBe(feesBefore);
    const [f] = b.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000, 2000));
    expect(f).toMatchObject({ price: 50000, fee: 0.1 * 50000 * 0.001 });
    expect(b.closedTrades()[0]!.fees).toBeCloseTo(2.5005 + 5, 10);
    // The edit survives a restart.
    const r = PaperBroker.restore(JSON.parse(JSON.stringify(b.snapshot())), opts());
    r.submit(order({ id: 'e2', qty: 0.1 }), 2000);
    expect(r.onBarOpen('BTCUSDT', bar(50000, 50000, 50000, 50000, 3000))[0]).toMatchObject({ price: 50000, fee: 0.1 * 50000 * 0.001 });
  });

  it('setFees keeps the reservation a pending opening order already holds', () => {
    const b = new PaperBroker({ ...opts(), startingBalance: 1_000 });
    b.markToMarket('BTCUSDT', 50000);
    // 0.1 @ 50000, 10x: margin 500 + fee 2.5 = 502.5 reserved, 497.5 left.
    expect(b.submit(order({ id: 'a', type: 'limit', limitPrice: 40000, qty: 0.1 }), 0)).toEqual({ accepted: true });
    b.setFees({ ...DEFAULT_FEES, takerRate: 0.01 });
    // At the new fee 0.09 needs 450 + 45 = 495: it fits only while 'a' still reserves 502.5 (not 550).
    expect(b.submit(order({ id: 'b', type: 'limit', limitPrice: 40000, qty: 0.09 }), 0)).toEqual({ accepted: true });
    expect(b.submit(order({ id: 'c', type: 'limit', limitPrice: 40000, qty: 0.003 }), 0)).toEqual({ accepted: false, reason: 'no_free_balance' });
  });

  it('setSizing applies from the next submit; orders already queued keep their qty', () => {
    const b = make();
    b.submit(order({ id: 'a', type: 'limit', limitPrice: 40000, qty: 0.1 }), 0);
    b.setSizing({ kind: 'fixed', notionalUsd: 1000 });
    b.submit(order({ id: 'b', type: 'limit', limitPrice: 40000, qty: 0.5 }), 0);
    expect(b.openOrders().map((o) => [o.id, o.qty])).toEqual([['a', 0.1], ['b', 0.02]]);
    expect(b.sizingRule()).toEqual({ kind: 'fixed', notionalUsd: 1000 });
    const r = PaperBroker.restore(JSON.parse(JSON.stringify(b.snapshot())), opts());
    expect(r.sizingRule()).toEqual({ kind: 'fixed', notionalUsd: 1000 });
  });

  it('realisedNet keeps a running per-symbol total of closed trades, also across a restore', () => {
    const b = make('tradingview');
    for (let i = 0; i < 3; i++) {
      b.submit(order({ id: `e${i}`, qty: 0.1 }), 0);
      b.onBarOpen('BTCUSDT', bar(100 + i, 100 + i, 100 + i, 100 + i, 1000 + i));
      b.submit(order({ id: `x${i}`, side: 'sell', qty: 0.1, reduceOnly: true, tag: 'exit' }), 0);
      b.onBarOpen('BTCUSDT', bar(110 - i, 110 - i, 110 - i, 110 - i, 2000 + i));
    }
    let want = 0;
    for (const t of b.closedTrades()) want += t.pnl - t.fees + t.funding;
    expect(b.realisedNet('BTCUSDT')).toBe(want);
    expect(b.realisedNet('ETHUSDT')).toBe(0);
    const s = JSON.parse(JSON.stringify(b.snapshot()));
    expect(PaperBroker.restore(s, opts('tradingview')).realisedNet('BTCUSDT')).toBe(want);
    // An older state without the running totals rebuilds them from its closed trades.
    delete s.realisedNet;
    expect(PaperBroker.restore(s, opts('tradingview')).realisedNet('BTCUSDT')).toBe(want);
  });
});
