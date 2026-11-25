import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import type { BrokerState, ClosedTrade, PairRules } from '../../src/core/types.js';
import type { StrategyDeclaration } from '../../src/engine/pine-runner.js';
import { StrategyLayer } from '../../src/engine/strategy-layer.js';
import { openDb } from '../../src/store/db.js';
import { DuplicatePassError, RunRepo, StalePassError, type PassCommit, type RunSetup } from '../../src/store/runs.js';

const rules: PairRules = {
  symbol: 'BTCUSDT',
  tickSize: 0.1,
  stepSize: 0.001,
  minNotional: 100,
  maxLeverage: 125,
  leverageEstimated: false,
  brackets: [{ notionalCap: Infinity, maintMarginRate: 0.004, maintAmount: 0 }],
};
const decl: StrategyDeclaration = {
  title: 't',
  pyramiding: 0,
  closeEntriesRule: 'FIFO',
  defaultQtyType: 'fixed',
  defaultQtyValue: 1,
  overridden: {},
};
const setup: RunSetup = {
  script: '//@version=6\nstrategy("t")\n',
  exchange: 'binance',
  tf: '4h',
  startingBalance: 10_000,
  sizing: { kind: 'fixed', notionalUsd: 500 },
  fees: { makerRate: 0.0002, takerRate: 0.0005, slippagePct: 0.0005 },
};
const H4 = 14_400_000;
const T0 = Date.UTC(2026, 10, 1);

const trade = (symbol: string, exitTime: number, over: Partial<ClosedTrade> = {}): ClosedTrade => ({
  symbol,
  side: 'long',
  entryTime: exitTime - 3 * H4,
  entryPrice: 100,
  exitTime,
  exitPrice: 110,
  qty: 2,
  pnl: 20,
  fees: 0.2,
  funding: -0.05,
  exitReason: 'signal',
  exitOrderId: 'L-X#3',
  ...over,
});

function brokerAndLayer() {
  const broker = new PaperBroker({ startingBalance: 10_000, fees: setup.fees, mode: 'binance', rules: () => rules, sizing: setup.sizing });
  const layer = new StrategyLayer(decl, broker, 'BTCUSDT', setup.sizing, { rules });
  return { broker, layer };
}

function pass(close: number, symbols: string[], over: Partial<PassCommit> = {}): PassCommit {
  const { broker, layer } = brokerAndLayer();
  return {
    close,
    processed: symbols.map((symbol) => ({ symbol, openTime: close - H4 })),
    broker: broker.snapshot(),
    layers: Object.fromEntries(symbols.map((s) => [s, { ...layer.snapshot(), symbol: s }])),
    trades: symbols.map((s) => trade(s, close - H4)),
    equity: { time: close, equity: 10_000 + close / 1e10 },
    logs: symbols.map((symbol) => ({ time: close, kind: 'skip', symbol, detail: { why: 'test' } })),
    fundingApplied: Object.fromEntries(symbols.map((s) => [s, close - H4])),
    ...over,
  };
}

let db: DatabaseSync;
let repo: RunRepo;
let now = T0;
beforeEach(() => {
  db = openDb(':memory:');
  now = T0;
  repo = new RunRepo(db, () => now);
});

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('RunRepo: runs and settings', () => {
  it('migrates to a new schema version without touching the candle tables', () => {
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    for (const t of ['candles', 'funding', 'runs', 'settings_history', 'run_state', 'processed_candles', 'trades', 'equity', 'run_log', 'funding_applied']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t).toBeDefined();
    }
  });

  it('creates, reads, lists and changes the status of runs; setup_json is plain JSON', () => {
    const a = repo.createRun({ name: 'alpha', setup });
    now += 1000;
    const b = repo.createRun({ name: 'beta', setup: { ...setup, tf: '1h' } });
    expect(repo.getRun(a)).toEqual({ id: a, name: 'alpha', status: 'running', createdAt: T0, setup });
    expect(repo.listRuns().map((r) => r.name)).toEqual(['alpha', 'beta']);
    repo.setStatus(a, 'paused');
    expect(repo.getRun(a)!.status).toBe('paused');
    expect(() => repo.setStatus(a, 'gone' as never)).toThrow();
    expect(() => repo.setStatus(999, 'stopped')).toThrow(/no run 999/);
    expect(repo.getRun(999)).toBeNull();
    expect(repo.getRun(b)!.setup.tf).toBe('1h');
    // Infinity (as in pair rules' notionalCap) can never reach setup_json.
    expect(() => repo.createRun({ name: 'bad', setup: { ...setup, startingBalance: Infinity } })).toThrow(/Infinity/);
    expect(repo.listRuns()).toHaveLength(2);
  });

  it('recordSetting changes the setup field and keeps its history', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    now = T0 + 5_000;
    const fees = { ...setup.fees, takerRate: 0.0004 };
    repo.recordSetting(id, 'fees', fees);
    now = T0 + 9_000;
    repo.recordSetting(id, 'sizing', { kind: 'script' });
    expect(repo.getRun(id)!.setup).toEqual({ ...setup, fees, sizing: { kind: 'script' } });
    expect(repo.settingsHistory(id)).toEqual([
      { time: T0 + 5_000, field: 'fees', old: setup.fees, new: fees },
      { time: T0 + 9_000, field: 'sizing', old: setup.sizing, new: { kind: 'script' } },
    ]);
    expect(() => repo.recordSetting(id, 'startingBalance', NaN)).toThrow(/NaN/);
    expect(repo.settingsHistory(id)).toHaveLength(2);
    // A field the stored setup did not have yet: its old value is recorded as null.
    const older: Partial<RunSetup> = { ...setup };
    delete older.exchange;
    const old = repo.createRun({ name: 'older', setup: older as RunSetup });
    repo.recordSetting(old, 'exchange', 'binance');
    expect(repo.settingsHistory(old).at(-1)).toMatchObject({ field: 'exchange', old: null, new: 'binance' });
  });
});

describe('RunRepo: passes', () => {
  it('commitPass stores everything of a pass, and loadState gives the saved broker and layers back', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    const close = T0 + 10 * H4;
    const p = pass(close, ['BTCUSDT', 'ETHUSDT'], { trades: [trade('BTCUSDT', close - H4), { ...trade('ETHUSDT', close - H4), overfill: true } as ClosedTrade] });
    now = T0 + 1;
    repo.commitPass(id, p);
    expect(repo.loadState(id)).toEqual({ lastClose: close, broker: p.broker, layers: p.layers, updatedAt: T0 + 1 });
    expect(repo.isProcessed(id, 'BTCUSDT', close - H4)).toBe(true);
    expect(repo.isProcessed(id, 'BTCUSDT', close)).toBe(false);
    expect(repo.trades(id)).toEqual([
      { ...trade('BTCUSDT', close - H4), overfill: false },
      { ...trade('ETHUSDT', close - H4), overfill: true },
    ]);
    expect(repo.equityCurve(id)).toEqual([p.equity]);
    expect(repo.logs(id)).toEqual(p.logs);
    expect(repo.logs(id, 'nothing')).toEqual([]);
    expect(repo.appliedThrough(id, 'ETHUSDT')).toBe(close - H4);
    expect(repo.appliedThrough(id, 'SOLUSDT')).toBe(0);
    expect(repo.loadState(999)).toBeNull();
  });

  it('a later pass replaces the broker, merges layers by symbol and appends trades, equity and logs', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    const c1 = T0 + 10 * H4;
    const c2 = c1 + H4;
    repo.commitPass(id, pass(c1, ['BTCUSDT', 'ETHUSDT']));
    const { broker } = brokerAndLayer();
    broker.markToMarket('BTCUSDT', 123);
    const p2 = pass(c2, ['BTCUSDT'], { broker: broker.snapshot(), logs: [{ time: c2, kind: 'anomaly' }, { time: c2, kind: 'warning', detail: [1, 'x'] }] });
    repo.commitPass(id, p2);
    const s = repo.loadState(id)!;
    expect(s.lastClose).toBe(c2);
    expect(s.broker).toEqual(p2.broker);
    expect(Object.keys(s.layers).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(repo.trades(id)).toHaveLength(3);
    expect(repo.equityCurve(id).map((e) => e.time)).toEqual([c1, c2]);
    expect(repo.logs(id, 'anomaly')).toEqual([{ time: c2, kind: 'anomaly' }]);
    expect(repo.logs(id, 'warning')).toEqual([{ time: c2, kind: 'warning', detail: [1, 'x'] }]);
    expect(repo.appliedThrough(id, 'BTCUSDT')).toBe(c2 - H4);
    expect(repo.appliedThrough(id, 'ETHUSDT')).toBe(c1 - H4);
  });

  it('commitPass is atomic: when a trade insert throws, nothing of the pass is stored, processed keys included', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    const c1 = T0 + 10 * H4;
    repo.commitPass(id, pass(c1, ['BTCUSDT']));
    const before = repo.loadState(id);
    const c2 = c1 + H4;
    // Processed keys go in first; the second trade breaks the side CHECK.
    const bad = pass(c2, ['BTCUSDT', 'ETHUSDT'], { trades: [trade('BTCUSDT', c2 - H4), trade('ETHUSDT', c2 - H4, { side: 'sideways' as never })] });
    expect(() => repo.commitPass(id, bad)).toThrow();
    expect(repo.isProcessed(id, 'BTCUSDT', c2 - H4)).toBe(false);
    expect(repo.isProcessed(id, 'ETHUSDT', c2 - H4)).toBe(false);
    expect(repo.loadState(id)).toEqual(before);
    expect(repo.trades(id)).toHaveLength(1);
    expect(repo.equityCurve(id)).toHaveLength(1);
    expect(repo.logs(id)).toHaveLength(1);
    expect(repo.appliedThrough(id, 'ETHUSDT')).toBe(0);
    expect(count('processed_candles')).toBe(1);
  });

  it('state that JSON cannot hold (NaN, Infinity) is refused before anything is written', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    const p = pass(T0 + H4, ['BTCUSDT']);
    const broker = { ...p.broker, lastPrice: { BTCUSDT: NaN } } as BrokerState;
    expect(() => repo.commitPass(id, { ...p, broker })).toThrow(/NaN/);
    expect(() => repo.commitPass(id, { ...p, equity: { time: T0 + H4, equity: Infinity } })).toThrow(/Infinity/);
    expect(() => repo.commitPass(id, { ...p, logs: [{ time: 1, kind: 'x', detail: { v: NaN } }] })).toThrow(/NaN/);
    expect(repo.loadState(id)).toBeNull();
    expect(count('processed_candles') + count('trades') + count('equity') + count('run_log')).toBe(0);
  });

  /** Every row the run has, byte for byte (the JSON columns as stored). */
  const snapshotDb = () =>
    ['run_state', 'processed_candles', 'trades', 'equity', 'run_log', 'funding_applied'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all());

  it('duplicate closed kline is rejected: a second pass for a committed key throws and writes nothing', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    const close = T0 + 10 * H4;
    repo.commitPass(id, pass(close, ['BTCUSDT']));
    expect(repo.isProcessed(id, 'BTCUSDT', close - H4)).toBe(true);
    const before = snapshotDb();
    const state = repo.loadState(id);

    // The same kline again, with a different broker state.
    const { broker } = brokerAndLayer();
    broker.markToMarket('BTCUSDT', 999);
    now += 1;
    let err: unknown;
    try {
      repo.commitPass(id, pass(close, ['BTCUSDT'], { broker: broker.snapshot() }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DuplicatePassError);
    expect((err as DuplicatePassError).keys).toEqual([{ symbol: 'BTCUSDT', openTime: close - H4 }]);
    expect(snapshotDb()).toEqual(before);
    expect(repo.loadState(id)).toEqual(state);
  });

  it('a mixed pass (one duplicate key, one fresh) throws and writes nothing, the fresh key included', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    const close = T0 + 10 * H4;
    repo.commitPass(id, pass(close, ['BTCUSDT']));
    const before = snapshotDb();
    const mixed = pass(close, ['ETHUSDT', 'BTCUSDT']);
    expect(() => repo.commitPass(id, mixed)).toThrow(DuplicatePassError);
    expect(() => repo.commitPass(id, mixed)).toThrow(/BTCUSDT@/);
    expect(snapshotDb()).toEqual(before);
    expect(repo.isProcessed(id, 'ETHUSDT', close - H4)).toBe(false);
    expect(repo.appliedThrough(id, 'ETHUSDT')).toBe(0);
  });

  it('a stale pass (close before the last committed close) is rejected and writes nothing', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    const close = T0 + 10 * H4;
    repo.commitPass(id, pass(close, ['BTCUSDT']));
    const before = snapshotDb();
    expect(() => repo.commitPass(id, pass(close - H4, ['ETHUSDT']))).toThrow(StalePassError);
    expect(snapshotDb()).toEqual(before);
    // The same close again (another pair's late kline) is not stale.
    repo.commitPass(id, pass(close, ['ETHUSDT']));
    expect(repo.isProcessed(id, 'ETHUSDT', close - H4)).toBe(true);
  });

  it('the funding applied-through time never moves back', () => {
    const id = repo.createRun({ name: 'alpha', setup });
    repo.commitPass(id, pass(T0 + 2 * H4, ['BTCUSDT']));
    repo.commitPass(id, pass(T0 + 3 * H4, ['BTCUSDT'], { fundingApplied: { BTCUSDT: T0 } }));
    expect(repo.appliedThrough(id, 'BTCUSDT')).toBe(T0 + H4);
  });

  it('a run is per-run: another run sees none of it', () => {
    const a = repo.createRun({ name: 'alpha', setup });
    const b = repo.createRun({ name: 'beta', setup });
    repo.commitPass(a, pass(T0 + H4, ['BTCUSDT']));
    expect(repo.isProcessed(b, 'BTCUSDT', T0)).toBe(false);
    expect(repo.trades(b)).toEqual([]);
    expect(repo.appliedThrough(b, 'BTCUSDT')).toBe(0);
    expect(repo.loadState(b)).toBeNull();
    expect(() => repo.commitPass(999, pass(T0 + H4, ['BTCUSDT']))).toThrow();
  });
});
