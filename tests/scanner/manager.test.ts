// RunManager (src/scanner/manager.ts): the run limit, the shared live feeds (one LiveFeed per timeframe, one price
// stream for all), settings edits and run control, on FakeExchange streams and fake timers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEES } from '../../src/broker/costs.js';
import { tfToMs } from '../../src/core/timeframe.js';
import type { Candle, Timeframe } from '../../src/core/types.js';
import { FakeExchange } from '../../src/exchange/fake.js';
import { RunManager, runLimit } from '../../src/scanner/manager.js';
import type { PassReport } from '../../src/scanner/run.js';
import { openDb } from '../../src/store/db.js';
import { makeClock, makeTimers } from '../exchange/clock.js';
import { B0, HISTORY, START, STEP, TF, flat, pair, setupFor, signal } from './helpers.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function world(symbols: string[], tfs: Timeframe[] = [TF]) {
  const clock = makeClock(START);
  const timers = makeTimers(clock);
  const db = openDb(':memory:');
  const client = new FakeExchange({
    now: clock.now,
    sleep: clock.sleep,
    pairs: symbols.map((s) => pair(s)),
    tickers: symbols.map((s, i) => ({ symbol: s, quoteVolume: 1_000 - i, lastPrice: 100 })),
  });
  for (const s of symbols) {
    for (const tf of tfs) {
      const step = tfToMs(tf);
      const last = Math.floor(START / step) * step - step;
      client.setCandles(s, tf, Array.from({ length: HISTORY }, (_, i) => flat(last - (HISTORY - 1 - i) * step)));
    }
  }
  const reports: { runId: number; report: PassReport }[] = [];
  const m = new RunManager({
    db,
    client,
    now: clock.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sleep: clock.sleep,
    warmupBars: HISTORY,
    onReport: (runId, report) => reports.push({ runId, report }),
    onEvent: () => {},
  });
  /** The feed's close for bar k (openTime B0 + k * STEP): every symbol's closed kline on the stream. */
  const close = async (k: number, bars: Record<string, Candle>) => {
    await timers.advance(B0 + (k + 1) * STEP + 500 - clock.now());
    for (const [s, c] of Object.entries(bars)) client.pushKline(s, TF, c);
    await timers.advance(100);
    await m.idle();
  };
  return { clock, timers, db, client, m, reports, close };
}

describe('RunManager', () => {
  it('run limit enforced', { timeout: 60_000 }, async () => {
    vi.stubEnv('MEM_LIMIT_MB', '768');
    expect(runLimit()).toBe(1);
    expect(runLimit(2_000)).toBe(3);
    expect(runLimit(300)).toBe(1);
    const t = world(['AUSDT']);
    const first = await t.m.start({ name: 'one', setup: setupFor() });
    await expect(t.m.start({ name: 'two', setup: setupFor() })).rejects.toThrow('run limit reached (1)');
    expect(t.m.repo.listRuns().map((r) => r.name)).toEqual(['one']);
    t.m.stop(first);
    expect(t.m.repo.getRun(first)!.status).toBe('stopped');
    await expect(t.m.start({ name: 'three', setup: setupFor() })).resolves.toBeGreaterThan(first);
    t.m.shutdown();
  });

  it('a stream close runs a pass; one price stream serves the feeds of every timeframe', { timeout: 60_000 }, async () => {
    vi.stubEnv('MEM_LIMIT_MB', '2000');
    const t = world(['AUSDT', 'BUSDT'], ['15m', '30m']);
    const fast = await t.m.start({ name: 'fast', setup: setupFor() });
    await t.m.start({ name: 'slow', setup: { ...setupFor(), tf: '30m' } });
    const live = t.client.connections.filter((c) => !c.closed);
    expect(live.filter((c) => c.streams.includes('!ticker@arr'))).toHaveLength(1);
    expect(live.filter((c) => c.streams.includes('!markPrice@arr@1s'))).toHaveLength(1);
    expect(live.filter((c) => c.streams.some((s) => s.endsWith('@kline_15m')))).toHaveLength(1);
    expect(live.filter((c) => c.streams.some((s) => s.endsWith('@kline_30m')))).toHaveLength(1);

    await t.close(0, { AUSDT: flat(B0), BUSDT: flat(B0) });
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toMatchObject({ runId: fast, report: { closeTime: B0 + STEP, scanned: 2, stepped: ['AUSDT', 'BUSDT'] } });
    expect(t.m.status(fast)).toMatchObject({ universe: 2, scannedLastPass: 2, feed: { connected: true } });
    t.m.shutdown();
  });

  it('fees edit applies from next pass and is logged', { timeout: 60_000 }, async () => {
    const t = world(['AUSDT']);
    const id = await t.m.start({ name: 'fees', setup: setupFor() });
    await t.close(0, { AUSDT: signal(B0) }); // the entry is queued at the default fees
    const fees = { makerRate: 0.0002, takerRate: 0.001, slippagePct: 0.0002 };
    await t.m.updateSettings(id, { fees });
    expect(t.m.repo.settingsHistory(id)).toMatchObject([{ field: 'fees', old: DEFAULT_FEES, new: fees }]);
    expect(t.m.repo.getRun(id)!.setup.fees).toEqual(fees);
    await t.close(1, { AUSDT: flat(B0 + STEP) }); // it fills at bar 1's open: 25 at 100 x (1 + 0.0002)
    const broker = t.m.repo.loadState(id)!.broker;
    expect(broker.positions.AUSDT?.qty).toBe(25);
    expect(broker.feesPaid).toBeCloseTo(25 * 100 * 1.0002 * 0.001, 9);
    await t.m.updateSettings(id, { sizing: { kind: 'fixed', notionalUsd: 2_000 } });
    expect(t.m.repo.settingsHistory(id).map((s) => s.field)).toEqual(['fees', 'sizing']);
    expect(t.m.repo.loadState(id)!.broker.sizing).toEqual({ kind: 'fixed', notionalUsd: 2_000 });
    t.m.shutdown();
  });

  it('locked fields throw', { timeout: 60_000 }, async () => {
    const t = world(['AUSDT']);
    const id = await t.m.start({ name: 'locked', setup: setupFor() });
    for (const patch of [{ tf: '1h' }, { script: 'x' }, { startingBalance: 5 }, { exchange: 'other' }, { fees: DEFAULT_FEES, tf: '1h' }]) {
      await expect(t.m.updateSettings(id, patch as never)).rejects.toThrow('locked after approval');
    }
    expect(t.m.repo.settingsHistory(id)).toEqual([]);
    await expect(t.m.updateSettings(999, { fees: DEFAULT_FEES })).rejects.toThrow('no live run 999');
    t.m.shutdown();
  });

  it('pause, resume and stop requested in the database (another process) are applied by syncFromDb', { timeout: 60_000 }, async () => {
    const t = world(['AUSDT']);
    const id = await t.m.start({ name: 'ctl', setup: setupFor() });
    t.m.repo.setStatus(id, 'paused');
    t.m.syncFromDb();
    expect(t.m.status(id).warnings).toContain('paused');
    t.m.repo.setStatus(id, 'running');
    t.m.syncFromDb();
    expect(t.m.status(id).warnings).not.toContain('paused');
    t.m.repo.setStatus(id, 'stopped');
    t.m.syncFromDb();
    expect(t.m.liveRuns()).toEqual([]);
    expect(t.client.connections.filter((c) => !c.closed)).toEqual([]); // the last run took the feeds with it
    t.m.shutdown();
  });

  it('the hourly universe refresh reaches each run and its feed', { timeout: 60_000 }, async () => {
    const t = world(['AUSDT', 'BUSDT']);
    const id = await t.m.start({ name: 'refresh', setup: setupFor() });
    // BUSDT is delisted; the refresh runs on the hour.
    t.client.setPairs([pair('AUSDT')]);
    await t.timers.advance(3_600_000);
    await t.m.idle();
    expect(t.m.status(id).universe).toBe(1);
    const klines = t.client.connections.filter((c) => !c.closed).flatMap((c) => c.streams).filter((s) => s.includes('@kline_'));
    expect(klines).toEqual(['ausdt@kline_15m']);
    expect(t.m.repo.logs(id, 'delisting')).toMatchObject([{ symbol: 'BUSDT', detail: { hadPosition: false } }]);
    t.m.shutdown();
  });
});
