import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import type { Candle, OrderIntent, PairRules, SizingRule } from '../../src/core/types.js';
import type { PineOrderCall, StrategyDeclaration } from '../../src/engine/pine-runner.js';
import { StrategyLayer } from '../../src/engine/strategy-layer.js';

const SYM = 'BTCUSDT';
const H4 = 14_400_000;
const T0 = Date.UTC(2024, 0, 1);

const rules: PairRules = {
  symbol: SYM,
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 5,
  maxLeverage: 125,
  leverageEstimated: false,
  brackets: [],
};

const decl = (over: Partial<StrategyDeclaration> = {}): StrategyDeclaration => ({
  title: 'test',
  pyramiding: 0,
  closeEntriesRule: 'FIFO',
  defaultQtyType: 'fixed',
  defaultQtyValue: 1,
  overridden: {},
  ...over,
});

const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ openTime: T0 + i * H4, open: o, high: h, low: l, close: c, volume: 1 });
const flatBar = (i: number, price = 50_000) => bar(i, price, price, price, price);

const entry = (id: string, direction: 'long' | 'short', more: Partial<PineOrderCall> = {}): PineOrderCall => ({ kind: 'entry', id, direction, ...more });
const exit = (id: string, more: Partial<PineOrderCall> = {}): PineOrderCall => ({ kind: 'exit', id, ...more });

/** A broker plus layer driven the way the replay (Task 6) drives them. */
function rig(o: { d?: Partial<StrategyDeclaration>; sizing?: SizingRule; balance?: number; from?: number } = {}) {
  const sizing = o.sizing ?? { kind: 'script' };
  const broker = new PaperBroker({
    startingBalance: o.balance ?? 1_000_000,
    fees: { makerRate: 0, takerRate: 0, slippagePct: 0 },
    mode: 'tradingview',
    rules: () => rules,
    sizing,
  });
  const layer = new StrategyLayer(decl(o.d), broker, SYM, sizing, { rules, from: o.from });
  const rejected: OrderIntent[] = [];
  /** Intents this returns true for are treated as rejected at submit (never reach the broker). */
  const ctl: { reject?: (i: OrderIntent) => boolean } = {};
  const submit = (intents: OrderIntent[], now: number) => {
    for (const i of intents) if (ctl.reject?.(i) || !broker.submit(i, now).accepted) rejected.push(i);
  };
  let idx = 0;
  return {
    broker,
    layer,
    rejected,
    ctl,
    /** hooks.before: the bar's broker events, then the script's view. */
    before(b: Candle) {
      submit(layer.onFills(broker.onBarOpen(SYM, b), b, idx), b.openTime);
      submit(layer.onFills(broker.onBarRange(SYM, b), b, idx), b.openTime);
      broker.markToMarket(SYM, b.close);
      return layer.scriptView();
    },
    /** hooks.after: the script's calls become intents and go to the broker. */
    after(b: Candle, calls: PineOrderCall[]) {
      broker.markToMarket(SYM, b.close);
      const intents = layer.toIntents(calls, b);
      submit(intents, b.openTime);
      idx++;
      return intents;
    },
  };
}

describe('StrategyLayer', () => {
  it('opposite entry reverses position', () => {
    const r = rig();
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 })]);
    expect(r.before(flatBar(1)).positionSize).toBe(1);
    const intents = r.after(flatBar(1), [entry('S', 'short', { qty: 1 })]);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ side: 'sell', type: 'market', qty: 2, tag: 'entry', reduceOnly: false, entryId: 'S' });
    expect(r.before(flatBar(2))).toMatchObject({ positionSize: -1, openTrades: 1 });
    expect(r.layer.scriptView().opentrades[0]).toMatchObject({ entryId: 'S', size: -1, entryPrice: 50_000, entryBarIndex: 2 });
  });

  it('pyramiding 0 ignores second same-direction entry', () => {
    const r = rig({ d: { pyramiding: 0 } });
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    expect(r.after(flatBar(1), [entry('L2', 'long', { qty: 1 })])).toEqual([]);
    expect(r.before(flatBar(2)).positionSize).toBe(1);
  });

  it('pyramiding 2 allows two entries, blocks the third', () => {
    const r = rig({ d: { pyramiding: 2 } });
    expect(r.after(flatBar(0), [entry('L1', 'long', { qty: 1 })])).toHaveLength(1);
    r.before(flatBar(1));
    expect(r.after(flatBar(1), [entry('L2', 'long', { qty: 1 })])).toHaveLength(1);
    expect(r.before(flatBar(2))).toMatchObject({ positionSize: 2, openTrades: 2 });
    expect(r.after(flatBar(2), [entry('L3', 'long', { qty: 1 })])).toEqual([]);
    expect(r.before(flatBar(3))).toMatchObject({ positionSize: 2, openTrades: 2 });
  });

  it('exit with stop+limit creates reduce-only OCA pair tied to fromEntry', () => {
    const r = rig();
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    const intents = r.after(flatBar(1), [exit('X', { fromEntry: 'L', stop: 48_000, limit: 52_000 })]);
    expect(intents).toHaveLength(2);
    const stop = intents.find((i) => i.type === 'stop')!;
    const limit = intents.find((i) => i.type === 'limit')!;
    expect(stop).toMatchObject({ side: 'sell', qty: 1, stopPrice: 48_000, reduceOnly: true, tag: 'exit', entryId: 'L' });
    expect(limit).toMatchObject({ side: 'sell', qty: 1, limitPrice: 52_000, reduceOnly: true, tag: 'exit', entryId: 'L' });
    expect(stop.ocaGroup).toBeDefined();
    expect(stop.ocaGroup).toBe(limit.ocaGroup);
    expect(stop.ocaType).toBe('cancel');
    expect(r.broker.openOrders(SYM)).toHaveLength(2);
  });

  it('percent_of_equity sizes from broker equity', () => {
    const r = rig({ balance: 10_000, d: { defaultQtyType: 'percent_of_equity', defaultQtyValue: 50 } });
    expect(r.broker.account().equity).toBe(10_000);
    const intents = r.after(flatBar(0, 50_000), [entry('L', 'long')]);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.qty).toBe(0.1);
  });

  it('fixed sizing rule overrides script qty', () => {
    const r = rig({ sizing: { kind: 'fixed', notionalUsd: 200 } });
    const intents = r.after(flatBar(0, 50_000), [entry('L', 'long', { qty: 1 })]);
    expect(intents[0]!.qty).toBe(0.004);
  });

  it('rejected entry leaves scriptView flat', () => {
    const r = rig({ balance: 100 });
    const intents = r.after(flatBar(0, 50_000), [entry('L', 'long', { qty: 1 }), exit('X', { fromEntry: 'L', stop: 49_000 })]);
    expect(intents).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
    expect(r.before(flatBar(1))).toEqual({
      positionSize: 0,
      positionAvgPrice: NaN,
      equity: 100,
      openTrades: 0,
      netProfit: 0,
      openProfit: 0,
      opentrades: [],
    });
    expect(r.broker.openOrders(SYM)).toEqual([]);
  });

  it('warm-up orders are discarded', () => {
    const r = rig({ balance: 10_000, from: T0 + 2 * H4 });
    expect(r.before(flatBar(0))).toMatchObject({ positionSize: 0, equity: 10_000, openTrades: 0 });
    expect(r.after(flatBar(0), [entry('L', 'long', { qty: 1 }), exit('X', { fromEntry: 'L', stop: 1 })])).toEqual([]);
    expect(r.before(flatBar(1))).toMatchObject({ positionSize: 0, equity: 10_000, openTrades: 0 });
    expect(r.after(flatBar(1), [entry('L', 'long', { qty: 1 })])).toEqual([]);
    expect(r.broker.openOrders(SYM)).toEqual([]);
    // From `from` on, calls count.
    r.before(flatBar(2));
    expect(r.after(flatBar(2), [entry('L', 'long', { qty: 1 })])).toHaveLength(1);
  });

  it('pending exit survives until its entry fills', () => {
    const r = rig();
    const intents = r.after(flatBar(0, 50_000), [
      entry('L', 'long', { qty: 1, limit: 49_000 }),
      exit('X', { fromEntry: 'L', stop: 48_000, limit: 51_000 }),
    ]);
    // Only the entry goes to the broker; the exit waits in the layer.
    expect(intents.map((i) => i.tag)).toEqual(['entry']);
    // Bar 1 touches the take-profit level but not the entry.
    r.before(bar(1, 50_000, 51_500, 49_500, 50_500));
    r.after(bar(1, 50_000, 51_500, 49_500, 50_500), []);
    expect(r.broker.position(SYM)).toBeNull();
    expect(r.broker.openOrders(SYM).map((o) => o.tag)).toEqual(['entry']);
    // Bar 2 fills the entry at 49,000; the exit goes live at the broker right after the fill.
    r.before(bar(2, 50_000, 50_200, 48_900, 49_800));
    expect(r.broker.position(SYM)).toMatchObject({ qty: 1, entryPrice: 49_000 });
    const live = r.broker.openOrders(SYM);
    expect(live).toHaveLength(2);
    expect(live.find((o) => o.type === 'stop')).toMatchObject({ side: 'sell', stopPrice: 48_000, reduceOnly: true, entryId: 'L' });
    expect(live.find((o) => o.type === 'limit')).toMatchObject({ side: 'sell', limitPrice: 51_000, reduceOnly: true, entryId: 'L' });
    // Bar 3 reaches the take-profit: the trade closes there and the stop is cancelled with it.
    r.after(bar(2, 50_000, 50_200, 48_900, 49_800), []);
    r.before(bar(3, 49_800, 51_200, 49_700, 51_000));
    expect(r.broker.position(SYM)).toBeNull();
    expect(r.broker.closedTrades()[0]).toMatchObject({ entryPrice: 49_000, exitPrice: 51_000, exitReason: 'target' });
    expect(r.broker.openOrders(SYM)).toEqual([]);
  });

  it('margin 0 maps to pair max leverage', () => {
    const r = rig({ d: { marginLong: 0, marginShort: 20 } });
    expect(r.after(flatBar(0), [entry('L', 'long', { qty: 0.01 })])[0]!.leverage).toBe(125);
    const s = rig({ d: { marginLong: 0, marginShort: 20 } });
    expect(s.after(flatBar(0), [entry('S', 'short', { qty: 0.01 })])[0]!.leverage).toBe(5);
    const d = rig();
    expect(d.after(flatBar(0), [entry('L', 'long', { qty: 0.01 })])[0]!.leverage).toBe(1);
  });

  // ------------------------------------------------------------------ more semantics ----

  it('market exit goes live on the fill bar of a market entry (stop can hit on the entry bar)', () => {
    const r = rig();
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 }), exit('X', { fromEntry: 'L', stop: 49_000 })]);
    r.before(bar(1, 50_000, 50_100, 48_500, 49_500));
    expect(r.broker.position(SYM)).toBeNull();
    expect(r.broker.closedTrades()[0]).toMatchObject({ entryPrice: 50_000, exitPrice: 49_000, exitReason: 'stop' });
  });

  it('re-issuing strategy.exit with the same id updates the resting order', () => {
    const r = rig();
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 }), exit('X', { fromEntry: 'L', stop: 48_000 })]);
    r.before(flatBar(1));
    // Same level again: nothing new to send.
    expect(r.after(flatBar(1), [exit('X', { fromEntry: 'L', stop: 48_000 })])).toEqual([]);
    r.before(flatBar(2));
    const moved = r.after(flatBar(2), [exit('X', { fromEntry: 'L', stop: 48_500 })]);
    expect(moved).toHaveLength(1);
    expect(r.broker.openOrders(SYM)).toEqual([expect.objectContaining({ type: 'stop', stopPrice: 48_500 })]);
    // All legs na: the exit is withdrawn.
    r.before(flatBar(3));
    r.after(flatBar(3), [exit('X', { fromEntry: 'L' })]);
    expect(r.broker.openOrders(SYM)).toEqual([]);
  });

  it('an exit for an entry that is neither open nor pending places nothing', () => {
    const r = rig();
    expect(r.after(flatBar(0), [exit('X', { fromEntry: 'L', stop: 48_000 })])).toEqual([]);
    r.before(flatBar(1));
    r.after(flatBar(1), [entry('L', 'long', { qty: 1 })]);
    r.before(flatBar(2));
    expect(r.broker.openOrders(SYM)).toEqual([]);
  });

  it('profit / loss ticks convert with mintick from the fill price', () => {
    const r = rig();
    r.after(flatBar(0), [entry('S', 'short', { qty: 1 }), exit('X', { fromEntry: 'S', profitTicks: 1000, lossTicks: 500 })]);
    r.before(flatBar(1, 50_000));
    const live = r.broker.openOrders(SYM);
    expect(live.find((o) => o.type === 'limit')).toMatchObject({ side: 'buy', limitPrice: 49_900 });
    expect(live.find((o) => o.type === 'stop')).toMatchObject({ side: 'buy', stopPrice: 50_050 });
  });

  it('of profit and limit, the level nearer the entry is used (Pine v6)', () => {
    const r = rig();
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 }), exit('X', { fromEntry: 'L', profitTicks: 1000, limit: 50_500 })]);
    r.before(flatBar(1, 50_000));
    expect(r.broker.openOrders(SYM)).toEqual([expect.objectContaining({ type: 'limit', limitPrice: 50_100 })]);
  });

  it('close and close_all are market reduce-only orders; close of an unknown entry does nothing', () => {
    const r = rig({ d: { pyramiding: 2, closeEntriesRule: 'ANY' } });
    r.after(flatBar(0), [entry('A', 'long', { qty: 1 }), entry('B', 'long', { qty: 2 })]);
    r.before(flatBar(1));
    expect(r.layer.scriptView().opentrades.map((t) => [t.entryId, t.size])).toEqual([['A', 1], ['B', 2]]);
    expect(r.after(flatBar(1), [{ kind: 'close', id: 'nope' }])).toEqual([]);
    const c = r.after(flatBar(1), [{ kind: 'close', id: 'B' }]);
    expect(c).toEqual([expect.objectContaining({ type: 'market', side: 'sell', qty: 2, reduceOnly: true, tag: 'exit', entryId: 'B' })]);
    r.before(flatBar(2));
    expect(r.layer.scriptView().opentrades.map((t) => t.entryId)).toEqual(['A']);
    const all = r.after(flatBar(2), [{ kind: 'close_all', id: '' }]);
    expect(all).toEqual([expect.objectContaining({ type: 'market', side: 'sell', qty: 1, reduceOnly: true })]);
    expect(r.before(flatBar(3))).toMatchObject({ positionSize: 0, openTrades: 0 });
  });

  it('close_entries_rule FIFO closes the earliest trade first; ANY closes the named one', () => {
    for (const [rule, left] of [['FIFO', 'B'], ['ANY', 'A']] as const) {
      const r = rig({ d: { pyramiding: 2, closeEntriesRule: rule } });
      r.after(flatBar(0, 50_000), [entry('A', 'long', { qty: 1 })]);
      r.before(flatBar(1, 50_000));
      r.after(flatBar(1, 50_000), [entry('B', 'long', { qty: 1 })]);
      r.before(flatBar(2, 51_000));
      r.after(flatBar(2, 51_000), [{ kind: 'close', id: 'B' }]);
      r.before(flatBar(3, 51_000));
      expect(r.layer.scriptView().opentrades.map((t) => t.entryId)).toEqual([left]);
    }
  });

  it('cancel and cancel_all withdraw pending orders and exits', () => {
    const r = rig();
    r.after(flatBar(0), [entry('L', 'long', { qty: 1, limit: 40_000 }), exit('X', { fromEntry: 'L', stop: 39_000 })]);
    r.before(flatBar(1));
    expect(r.broker.openOrders(SYM)).toHaveLength(1);
    r.after(flatBar(1), [{ kind: 'cancel', id: 'L' }]);
    expect(r.broker.openOrders(SYM)).toEqual([]);
    // The held exit went with its entry: a later fill of a new 'L' has no stale stop.
    r.before(flatBar(2));
    r.after(flatBar(2), [entry('L', 'long', { qty: 1 })]);
    r.before(flatBar(3));
    expect(r.broker.openOrders(SYM)).toEqual([]);
    r.after(flatBar(3), [exit('X', { fromEntry: 'L', stop: 45_000 }), entry('M', 'long', { qty: 1, stop: 60_000 })]);
    // X goes live; M is a same-direction add, which pyramiding 0 blocks.
    expect(r.broker.openOrders(SYM)).toEqual([expect.objectContaining({ type: 'stop', stopPrice: 45_000, tag: 'exit' })]);
    r.after(flatBar(3), [{ kind: 'cancel_all', id: '' }]);
    expect(r.broker.openOrders(SYM)).toEqual([]);
  });

  it('an entry in the same batch as cancel_all is dropped; one after it stays', () => {
    const r = rig();
    expect(r.after(flatBar(0), [entry('A', 'long', { qty: 1 }), { kind: 'cancel_all', id: '' }])).toEqual([]);
    expect(r.after(flatBar(1), [{ kind: 'cancel_all', id: '' }, entry('A', 'long', { qty: 1 })])).toHaveLength(1);
  });

  // ------------------------------------------------------------------ fix round 1 ----

  it('an exit id fills once per trade: qty_percent = 50 re-issued every bar closes exactly half', () => {
    const r = rig();
    const tp = exit('tp', { fromEntry: 'L', qtyPercent: 50, limit: 49_000 }); // marketable: fills at the next open
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    r.after(flatBar(1), [tp]);
    expect(r.before(flatBar(2)).positionSize).toBe(0.5);
    for (let i = 2; i < 6; i++) {
      expect(r.after(flatBar(i), [tp])).toEqual([]);
      expect(r.before(flatBar(i + 1)).positionSize).toBe(0.5);
    }
    expect(r.broker.closedTrades().map((t) => t.qty)).toEqual([0.5]);
    // Another exit id still acts on the rest; a new trade gets the old id again.
    r.after(flatBar(6), [exit('x2', { fromEntry: 'L', limit: 49_000 })]);
    expect(r.before(flatBar(7)).positionSize).toBe(0);
    r.after(flatBar(7), [entry('L', 'long', { qty: 1 })]);
    r.before(flatBar(8));
    r.after(flatBar(8), [tp]);
    expect(r.before(flatBar(9)).positionSize).toBe(0.5);
  });

  it('pyramiding 1: two entries on one bar from flat give one trade', () => {
    const r = rig({ d: { pyramiding: 1 } });
    const intents = r.after(flatBar(0), [entry('A', 'long', { qty: 1 }), entry('B', 'long', { qty: 1 })]);
    expect(intents.map((i) => i.entryId)).toEqual(['A']);
    expect(r.before(flatBar(1))).toMatchObject({ positionSize: 1, openTrades: 1 });
  });

  it('pyramiding is counted at fill: a resting add waits off the broker while the cap is full', () => {
    const r = rig({ d: { pyramiding: 2 } });
    r.after(flatBar(0), [entry('A', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    // Two resting adds: both may be placed (one slot left), only the first to fill counts.
    expect(r.after(flatBar(1), [entry('B', 'long', { qty: 1, limit: 49_000 }), entry('C', 'long', { qty: 1, limit: 48_000 })])).toHaveLength(2);
    r.before(bar(2, 50_000, 50_000, 48_900, 49_500)); // B fills; the cap is full, C leaves the broker
    expect(r.layer.scriptView().opentrades.map((t) => t.entryId)).toEqual(['A', 'B']);
    expect(r.broker.openOrders(SYM)).toEqual([]);
    r.after(bar(2, 50_000, 50_000, 48_900, 49_500), [{ kind: 'close', id: 'A' }]);
    // A closes at the open: room again, so C is back at the broker and fills on this bar's low.
    r.before(bar(3, 49_500, 49_600, 47_900, 48_500));
    expect(r.layer.scriptView().opentrades.map((t) => t.entryId)).toEqual(['B', 'C']);
    expect(r.layer.anomalies()).toEqual([]);
  });

  it('two resting adds filling inside one broker call: the one past the cap is closed and logged', () => {
    const r = rig({ d: { pyramiding: 2 } });
    r.after(flatBar(0), [entry('A', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    r.after(flatBar(1), [entry('B', 'long', { qty: 1, limit: 49_000 }), entry('C', 'long', { qty: 1, limit: 48_000 })]);
    const v = r.before(bar(2, 50_000, 50_000, 47_500, 48_500)); // both levels on one path
    expect(v.opentrades.map((t) => t.entryId)).toEqual(['A', 'B']);
    expect(v.positionSize).toBe(3); // the overfill is in the broker until the next open
    expect(r.layer.anomalies()).toEqual([{ kind: 'pyramiding_overfill', orderId: 'BTCUSDT|E|C', time: T0 + 2 * H4 }]);
    r.after(bar(2, 50_000, 50_000, 47_500, 48_500), []);
    expect(r.before(flatBar(3, 48_500))).toMatchObject({ positionSize: 2, openTrades: 2 });
  });

  it('overfill round trip: closing fills are restated at each lot\'s own price', () => {
    const r = rig({ d: { pyramiding: 2 } });
    r.after(flatBar(0), [entry('A', 'long', { qty: 1 })]);
    r.before(flatBar(1)); // A @ 50000
    r.after(flatBar(1), [entry('B', 'long', { qty: 1, limit: 49_000 }), entry('C', 'long', { qty: 1, limit: 48_000 })]);
    r.before(bar(2, 50_000, 50_000, 47_500, 48_500)); // B @ 49000, C @ 48000 (overfill)
    r.after(bar(2, 50_000, 50_000, 47_500, 48_500), [{ kind: 'close_all', id: '' }]);
    r.before(flatBar(3, 51_000)); // the overfill close, then close_all, both at 51000
    const [of, all] = r.layer.attributions();
    expect(of!.parts).toEqual([{ kind: 'overfill', qty: 1, entryPrice: 48_000, pnl: 3_000 }]);
    expect(all!.parts).toEqual([{ kind: 'script', qty: 2, entryPrice: 49_500, pnl: 3_000 }]);
    // Broker: avg 49000 for all three, 3 x 2000 = 6000 = 3000 + 3000.
    expect(r.broker.closedTrades().reduce((s, t) => s + t.pnl, 0)).toBeCloseTo(6_000, 8);
    expect(r.layer.anomalies().map((a) => a.kind)).toEqual(['pyramiding_overfill']);
  });

  it('a script close that takes the overfill quantity first is split and logged as overfill_absorbed', () => {
    const r = rig({ d: { pyramiding: 2 } });
    r.after(flatBar(0), [entry('A', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    r.after(flatBar(1), [entry('B', 'long', { qty: 1, limit: 49_000 }), entry('C', 'long', { qty: 1, limit: 48_000 })]);
    r.ctl.reject = (i) => i.id.includes('|OF|'); // the overfill close never reaches the broker
    r.before(bar(2, 50_000, 50_000, 47_500, 48_500));
    r.after(bar(2, 50_000, 50_000, 47_500, 48_500), [{ kind: 'close_all', id: '' }]);
    r.before(flatBar(3, 51_000));
    expect(r.broker.position(SYM)).toBeNull();
    const [all] = r.layer.attributions();
    expect(all!.parts).toEqual([
      { kind: 'script', qty: 2, entryPrice: 49_500, pnl: 3_000 },
      { kind: 'overfill', qty: 1, entryPrice: 48_000, pnl: 3_000 },
    ]);
    expect(r.layer.anomalies().map((a) => a.kind)).toEqual(['pyramiding_overfill', 'overfill_absorbed']);
  });

  it('no overfill, no attributions', () => {
    const r = rig();
    r.after(flatBar(0), [entry('A', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    r.after(flatBar(1), [{ kind: 'close_all', id: '' }]);
    r.before(flatBar(2, 51_000));
    expect(r.layer.attributions()).toEqual([]);
  });

  it('FIFO close("B") pairs with A in opentrades but takes B\'s own lot: a second close("B") does nothing', () => {
    // TradingView's two books (PineTS 0.13.1 openTradeList / closeMatching, and the emulator-parity test
    // in pine-runner.test.ts): the script sees B open, while B's own quantity is gone.
    const r = rig({ d: { pyramiding: 2, closeEntriesRule: 'FIFO' } });
    r.after(flatBar(0), [entry('A', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    r.after(flatBar(1), [entry('B', 'long', { qty: 1 })]);
    r.before(flatBar(2));
    r.after(flatBar(2), [{ kind: 'close', id: 'B' }]);
    expect(r.before(flatBar(3)).opentrades.map((t) => t.entryId)).toEqual(['B']);
    expect(r.after(flatBar(3), [{ kind: 'close', id: 'B' }])).toEqual([]);
    expect(r.before(flatBar(4)).positionSize).toBe(1);
    expect(r.after(flatBar(4), [{ kind: 'close', id: 'A' }])).toHaveLength(1);
    expect(r.before(flatBar(5))).toMatchObject({ positionSize: 0, openTrades: 0 });
  });

  it('an exit leg the broker did not take is sent again and logged', () => {
    const r = rig();
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 })]);
    r.before(flatBar(1));
    r.ctl.reject = (i) => i.tag === 'exit';
    r.after(flatBar(1), [exit('X', { fromEntry: 'L', stop: 48_000 })]);
    expect(r.broker.openOrders(SYM)).toEqual([]);
    r.ctl.reject = undefined;
    r.before(flatBar(2));
    expect(r.broker.openOrders(SYM)).toEqual([expect.objectContaining({ type: 'stop', stopPrice: 48_000 })]);
    expect(r.layer.anomalies()).toEqual([{ kind: 'exit_leg_resent', orderId: 'BTCUSDT|X|X|L|stop', time: T0 + 2 * H4 }]);
  });

  it('a held exit is dropped when its pending entry is rejected at the broker', () => {
    const r = rig({ balance: 1_000 });
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 }), exit('X', { fromEntry: 'L', stop: 45_000 })]);
    expect(r.rejected.map((i) => i.entryId)).toEqual(['L']);
    r.before(flatBar(1));
    r.after(flatBar(1), [entry('L', 'long', { qty: 0.01 })]); // fits; the stale exit must not come with it
    r.before(flatBar(2));
    expect(r.broker.position(SYM)).toMatchObject({ qty: 0.01 });
    expect(r.broker.openOrders(SYM)).toEqual([]);
  });

  it('a liquidation fill (binance mode onMark) empties the open trades', () => {
    const broker = new PaperBroker({
      startingBalance: 10_000,
      fees: { makerRate: 0, takerRate: 0, slippagePct: 0 },
      mode: 'binance',
      rules: () => rules,
      sizing: { kind: 'script' },
    });
    const layer = new StrategyLayer(decl({ marginLong: 0 }), broker, SYM, { kind: 'script' }, { rules });
    broker.markToMarket(SYM, 50_000);
    for (const i of layer.toIntents([entry('L', 'long', { qty: 1 })], flatBar(0))) broker.submit(i, T0);
    layer.onFills(broker.onBarOpen(SYM, flatBar(1)), flatBar(1), 1);
    expect(layer.scriptView()).toMatchObject({ positionSize: 1, openTrades: 1 });
    expect(layer.onFills(broker.onMark(SYM, 40_000, T0 + H4), flatBar(1), 1)).toEqual([]);
    expect(layer.scriptView()).toMatchObject({ positionSize: 0, openTrades: 0, opentrades: [] });
  });

  it('a fill the layer was not told about is caught by scriptView', () => {
    const r = rig();
    r.after(flatBar(0), [entry('L', 'long', { qty: 1 })]);
    r.broker.onBarOpen(SYM, flatBar(1)); // fill not passed to onFills
    expect(() => r.layer.scriptView()).toThrow(/out of sync with the broker/);
  });

  it('strategy.equity in the view is the broker equity, with open profit', () => {
    const r = rig({ balance: 10_000 });
    r.after(flatBar(0, 50_000), [entry('L', 'long', { qty: 0.1 })]);
    const v = r.before(bar(1, 50_000, 51_000, 50_000, 51_000));
    expect(v).toMatchObject({ positionSize: 0.1, positionAvgPrice: 50_000, openProfit: 100, equity: 10_100, netProfit: 0 });
    expect(v.opentrades[0]).toMatchObject({ profit: 100, entryTime: T0 + H4 });
  });
});
