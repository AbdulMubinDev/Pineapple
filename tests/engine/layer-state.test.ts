// StrategyLayer snapshot / restore (with the broker's): a live run restored from saved state must carry on
// exactly as if it had never stopped.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PaperBroker, type BrokerOptions } from '../../src/broker/broker.js';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import type { BrokerMode, Candle, FundingEvent, OrderIntent, PairRules } from '../../src/core/types.js';
import { loadCandles, loadFunding } from '../../src/data/csv.js';
import type { LayerState } from '../../src/engine/layer-state.js';
import { compileScript, runStrategy, type BarHooks, type PineOrderCall, type StrategyDeclaration } from '../../src/engine/pine-runner.js';
import { barHooks, tvPropertiesOf, type ReplayRejection } from '../../src/engine/replay.js';
import { StrategyLayer, type LayerOptions } from '../../src/engine/strategy-layer.js';

const SYM = 'BTCUSDT';
const H4 = 14_400_000;
const T0 = Date.UTC(2024, 0, 1);
const KYBER = readFileSync('tests/fixtures/KyberSwing.pine', 'utf8');
const fixtureRules = JSON.parse(readFileSync('tests/fixtures/BTCUSDT-rules.json', 'utf8')) as PairRules;
const FROM = Date.UTC(2024, 0, 1);
const TO = Date.UTC(2026, 10, 19) - 1;

const json = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * KyberSwing through barHooks, as replay() wires it. With `restoreAt`, the broker and the layer are
 * snapshotted (through JSON), restored and swapped in at the start of every bar it picks.
 */
async function kyber(mode: BrokerMode, restoreAt?: (idx: number) => boolean) {
  const candles = loadCandles('tests/fixtures/BTCUSDT_4h.csv', '4h').filter((c) => c.openTime <= TO);
  const compiled = await compileScript(KYBER, '4h', SYM);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  let decl: StrategyDeclaration;
  let bo: BrokerOptions;
  let funding: FundingEvent[] = [];
  if (mode === 'tradingview') {
    const tv = tvPropertiesOf(compiled.declaration);
    decl = { ...compiled.declaration, overridden: { initialCapital: tv.initialCapital, commission: tv.commissionPct, slippage: tv.slippageTicks } };
    const rate = tv.commissionPct / 100;
    bo = { startingBalance: tv.initialCapital, fees: { makerRate: rate, takerRate: rate, slippagePct: 0, slippageTicks: tv.slippageTicks }, mode, rules: () => fixtureRules, sizing: { kind: 'script' } };
  } else {
    decl = { ...compiled.declaration, overridden: { ...compiled.declaration.overridden, commission: DEFAULT_FEES.takerRate * 100, slippage: 0 } };
    bo = { startingBalance: 10_000, fees: DEFAULT_FEES, mode, rules: () => fixtureRules, sizing: { kind: 'script' } };
    funding = loadFunding('tests/fixtures/BTCUSDT_funding.csv');
  }
  const lo: LayerOptions = { rules: fixtureRules, from: FROM };
  const rejections: ReplayRejection[] = [];
  const equity: number[] = [];
  const wire = (broker: PaperBroker, layer: StrategyLayer) => ({
    broker,
    layer,
    hooks: barHooks({
      broker,
      layer,
      symbol: SYM,
      tf: '4h',
      mode,
      from: FROM,
      funding,
      processOrdersOnClose: decl.processOrdersOnClose === true,
      warmupEquity: bo.startingBalance,
      onRejected: (r) => rejections.push(r),
      onBarDone: () => equity.push(broker.account().equity),
    }),
  });
  const first = new PaperBroker(bo);
  let cur = wire(first, new StrategyLayer(decl, first, SYM, bo.sizing, lo));
  const seen = { restores: 0, midTrade: 0, heldForPendingEntry: 0 };
  const hooks: BarHooks = {
    before(bar, idx) {
      if (restoreAt && bar.openTime >= FROM && restoreAt(idx)) {
        const bs = json(cur.broker.snapshot());
        const ls = json(cur.layer.snapshot());
        seen.restores++;
        if (bs.positions[SYM] && ls.exits.some((e) => e.sent.length > 0)) seen.midTrade++;
        if (!bs.positions[SYM] && ls.exits.length > 0 && bs.orders.some((o) => o.tag === 'entry')) seen.heldForPendingEntry++;
        const b = PaperBroker.restore(bs, bo);
        cur = wire(b, StrategyLayer.restore(ls, decl, b, SYM, bo.sizing, lo));
      }
      return cur.hooks.before(bar, idx);
    },
    after: (bar, idx, calls) => cur.hooks.after(bar, idx, calls),
  };
  await runStrategy({ source: KYBER, symbol: SYM, tf: '4h', candles, syminfo: { mintick: fixtureRules.tickSize, qtyStep: fixtureRules.stepSize }, hooks });
  return {
    seen,
    out: {
      closed: cur.broker.closedTrades(),
      anomalies: cur.layer.anomalies(),
      attributions: cur.layer.attributions(),
      rejections,
      equity,
      broker: cur.broker.snapshot(),
      layer: cur.layer.snapshot(),
    },
  };
}

describe('layer snapshot round-trips mid-trade', () => {
  for (const mode of ['tradingview', 'binance'] as const) {
    it(`KyberSwing restored at every bar equals an uninterrupted run (${mode})`, { timeout: 180_000 }, async () => {
      const plain = await kyber(mode);
      const restored = await kyber(mode, () => true);
      expect(plain.out.closed.length).toBeGreaterThan(40);
      // The restores really happened mid-trade and with an exit held for an unfilled entry.
      expect(restored.seen.midTrade).toBeGreaterThan(100);
      expect(restored.seen.heldForPendingEntry).toBeGreaterThan(10);
      expect(JSON.stringify(restored.out)).toBe(JSON.stringify(plain.out));
      if (mode === 'binance') expect(plain.out.closed.some((t) => t.funding !== 0)).toBe(true);
    });
  }
});

// ------------------------------------------------------------------ small rigs ----

const rules: PairRules = { symbol: SYM, tickSize: 0.1, stepSize: 0.001, minNotional: 5, maxLeverage: 125, leverageEstimated: false, brackets: [] };
const decl = (over: Partial<StrategyDeclaration> = {}): StrategyDeclaration => ({
  title: 't',
  pyramiding: 0,
  closeEntriesRule: 'FIFO',
  defaultQtyType: 'fixed',
  defaultQtyValue: 1,
  overridden: {},
  ...over,
});
const flatBar = (i: number, p = 50_000): Candle => ({ openTime: T0 + i * H4, open: p, high: p, low: p, close: p, volume: 1 });
const brokerOpts: BrokerOptions = { startingBalance: 1_000_000, fees: { makerRate: 0, takerRate: 0, slippagePct: 0 }, mode: 'tradingview', rules: () => rules, sizing: { kind: 'script' } };

/** A broker and layer driven like barHooks; `restore()` swaps both for copies restored from JSON. */
function rig(d: Partial<StrategyDeclaration> = {}) {
  const broker0 = new PaperBroker(brokerOpts);
  broker0.markToMarket(SYM, 50_000);
  const s = { broker: broker0, layer: new StrategyLayer(decl(d), broker0, SYM, { kind: 'script' }, { rules }) };
  const ctl: { reject?: (i: OrderIntent) => boolean } = {};
  const sent: OrderIntent[] = [];
  const submit = (xs: OrderIntent[], t: number) => {
    for (const i of xs) {
      sent.push(i);
      if (!ctl.reject?.(i)) s.broker.submit(i, t);
    }
  };
  let idx = 0;
  return {
    s,
    ctl,
    sent,
    bar(b: Candle, calls: PineOrderCall[], extraSettles = 0) {
      submit(s.layer.onFills(s.broker.onBarOpen(SYM, b), b, idx), b.openTime);
      submit(s.layer.onFills(s.broker.onBarRange(SYM, b), b, idx), b.openTime);
      for (let k = 0; k < extraSettles; k++) submit(s.layer.onFills([], b, idx), b.openTime);
      s.layer.scriptView();
      submit(s.layer.toIntents(calls, b), b.openTime);
      idx++;
    },
    restore() {
      const bs = json(s.broker.snapshot());
      const ls: LayerState = json(s.layer.snapshot());
      s.broker = PaperBroker.restore(bs, brokerOpts);
      s.layer = StrategyLayer.restore(ls, decl(d), s.broker, SYM, { kind: 'script' }, { rules });
    },
  };
}

const entry = (id: string, more: Partial<PineOrderCall> = {}): PineOrderCall => ({ kind: 'entry', id, direction: 'long', qty: 1, ...more });

describe('LayerState', () => {
  it('is plain JSON (exitsFilled as arrays) and round-trips unchanged', () => {
    const r = rig();
    r.bar(flatBar(0), [entry('L')]);
    r.bar(flatBar(1), [{ kind: 'exit', id: 'H', fromEntry: 'L', qtyPercent: 50, limit: 50_000 }]);
    r.bar(flatBar(2), [{ kind: 'exit', id: 'X', fromEntry: 'L', stop: 40_000 }]);
    const s = r.s.layer.snapshot();
    expect(json(s)).toEqual(s);
    expect(s.lots).toEqual([expect.objectContaining({ entryId: 'L', exitsFilled: ['H'] })]);
    expect(s.seq).toBeTypeOf('number');
    const again = StrategyLayer.restore(json(s), decl(), r.s.broker, SYM, { kind: 'script' }, { rules }).snapshot();
    expect(again).toEqual(s);
  });

  it('restored seq never reuses an order id', () => {
    const ids = (r: ReturnType<typeof rig>) => r.sent.map((i) => i.id).filter((id) => /\|(C|CA|OF)\|/.test(id));
    const drive = (r: ReturnType<typeof rig>, restoreAt?: number) => {
      for (let i = 0; i < 8; i++) {
        if (i === restoreAt) r.restore();
        r.bar(flatBar(i), i % 2 === 0 ? [entry('L')] : [i % 4 === 1 ? { kind: 'close', id: 'L' } : { kind: 'close_all', id: '' }]);
      }
    };
    const plain = rig();
    drive(plain);
    const restored = rig();
    drive(restored, 5);
    expect(ids(restored)).toEqual(ids(plain));
    expect(new Set(ids(restored)).size).toBe(ids(restored).length);
    expect(ids(restored).length).toBeGreaterThanOrEqual(4);
    expect(restored.s.layer.snapshot().seq).toBe(plain.s.layer.snapshot().seq);
  });

  it('exit re-send counters survive a restore', () => {
    const drive = (restoreAt?: number) => {
      const r = rig();
      r.ctl.reject = (i) => i.tag === 'exit';
      for (let i = 0; i < 9; i++) {
        if (i === restoreAt) r.restore();
        r.bar(flatBar(i), i === 0 ? [entry('L')] : [{ kind: 'exit', id: 'X', fromEntry: 'L', stop: 40_000 }], 2);
      }
      return r.s.layer.anomalies();
    };
    const plain = drive();
    expect(plain.filter((a) => a.kind === 'exit_leg_abandoned')).toHaveLength(1);
    expect(drive(4)).toEqual(plain);
  });

  it('restore defaults sizing to the broker\'s current rule, and the check compares the rule, not its JSON', () => {
    const b = new PaperBroker({ ...brokerOpts, sizing: { kind: 'fixed', notionalUsd: 1_000 } });
    b.markToMarket(SYM, 50_000);
    const reordered = { notionalUsd: 1_000, kind: 'fixed' } as const;
    const layer = new StrategyLayer(decl(), b, SYM, reordered, { rules });
    b.setSizing({ kind: 'fixed', notionalUsd: 2_000 });
    const r = StrategyLayer.restore(json(layer.snapshot()), decl(), b, SYM, undefined, { rules });
    expect(r.toIntents([entry('L', { qty: undefined })], flatBar(0))[0]!.qty).toBe(0.04);
  });

  it('a fee edit before a restart still sizes with the new fees after it', () => {
    const d = { defaultQtyType: 'percent_of_equity' as const, defaultQtyValue: 100, marginLong: 100 };
    const b = new PaperBroker({ ...brokerOpts, startingBalance: 10_000 });
    b.markToMarket(SYM, 50_000);
    const layer = new StrategyLayer(decl(d), b, SYM, { kind: 'script' }, { rules });
    b.setFees({ makerRate: 0.01, takerRate: 0.01, slippagePct: 0 });
    const b2 = PaperBroker.restore(json(b.snapshot()), { ...brokerOpts, startingBalance: 10_000 });
    const r = StrategyLayer.restore(json(layer.snapshot()), decl(d), b2, SYM, undefined, { rules });
    expect(r.toIntents([entry('L', { qty: undefined })], flatBar(0))[0]!.qty).toBe(0.198);
  });

  it('restore checks the state version', () => {
    const r = rig();
    const s = json(r.s.layer.snapshot()) as unknown as Record<string, unknown>;
    s.version = 99;
    expect(() => StrategyLayer.restore(s as unknown as LayerState, decl(), r.s.broker, SYM, { kind: 'script' }, { rules })).toThrow(/version/);
  });
});
