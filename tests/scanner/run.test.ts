// ScannerRun (src/scanner/run.ts): one live run over many pairs with one shared paper account, on FakeExchange and
// fake time. Passes are driven by calling onClose directly, as the manager's LiveFeed listener does.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResidentStrategy } from '../../src/engine/resident.js';
import { ScriptCompileError } from '../../src/engine/replay.js';
import { ScannerRun } from '../../src/scanner/run.js';
import { B0, HISTORY, STEP, TF, flat, historyBars, pair, setupFor, signal, startedRun, world } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const T = 60_000;

describe('ScannerRun passes', () => {
  it('pass steps pairs by volume and commits once', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT', 'BUSDT', 'CUSDT']);
    t.run.setVolume('CUSDT', 9e9); // the live ticker stream raised C above the others
    const commits = vi.spyOn(t.repo, 'commitPass');
    const r = await t.close(0, t.flatAll(0));
    expect(r.stepped).toEqual(['CUSDT', 'AUSDT', 'BUSDT']);
    expect(r.scanned).toBe(3);
    expect(r.errors).toEqual([]);
    expect(r.closeTime).toBe(B0 + STEP);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]![1].processed).toEqual(['CUSDT', 'AUSDT', 'BUSDT'].map((symbol) => ({ symbol, openTime: B0 })));
    for (const s of ['AUSDT', 'BUSDT', 'CUSDT']) expect(t.repo.isProcessed(t.runId, s, B0)).toBe(true);
    expect(t.repo.equityCurve(t.runId).at(-1)).toEqual({ time: B0 + STEP, equity: 10_000 });

    // The same close again (a feed repeat): nothing is stepped twice and nothing is committed.
    const again = await t.run.onClose(B0 + STEP, new Map(Object.entries(t.flatAll(0))), { missing: [], behind: [] });
    expect(again.scanned).toBe(0);
    expect(again.skipped.processed?.sort()).toEqual(['AUSDT', 'BUSDT', 'CUSDT']);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(t.run.status()).toMatchObject({ universe: 3, scannedLastPass: 0, lastPassAt: t.clock.now() });
  });

  it('signals beyond free balance are rejected in volume order', { timeout: 60_000 }, async () => {
    // 10,000 USD and 4,000 USD per entry at leverage 1: room for two.
    const t = await startedRun(['AUSDT', 'BUSDT', 'CUSDT']);
    await t.close(0, { AUSDT: signal(B0), BUSDT: signal(B0), CUSDT: signal(B0) });
    const rejections = t.repo.logs(t.runId, 'rejection');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ symbol: 'CUSDT', detail: { reason: 'no_free_balance', stage: 'submit' } });
    await t.close(1, t.flatAll(1));
    const positions = t.repo.loadState(t.runId)!.broker.positions;
    expect(Object.keys(positions).sort()).toEqual(['AUSDT', 'BUSDT']);
  });

  it('script error on one pair flags only that pair', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT', 'BADUSDT', 'CUSDT']);
    const step = ResidentStrategy.prototype.step;
    vi.spyOn(ResidentStrategy.prototype, 'step').mockImplementation(async function (this: ResidentStrategy, bar) {
      if ((this as unknown as { o: { symbol: string } }).o.symbol === 'BADUSDT') throw new Error('boom');
      return step.call(this, bar);
    });
    const r = await t.close(0, t.flatAll(0));
    expect(r.errors).toEqual([{ symbol: 'BADUSDT', message: expect.stringContaining('boom') }]);
    expect(r.stepped).toEqual(['AUSDT', 'CUSDT']);
    const r2 = await t.close(1, t.flatAll(1));
    expect(r2.errors).toEqual([]);
    expect(r2.skipped.error).toEqual(['BADUSDT']);
    expect(r2.stepped).toEqual(['AUSDT', 'CUSDT']);
    expect(t.repo.isProcessed(t.runId, 'BADUSDT', B0)).toBe(false);
    expect(t.repo.isProcessed(t.runId, 'CUSDT', B0 + STEP)).toBe(true);
    expect(t.run.status().skipped.error).toBe(1);
  });

  it('a missing bar skips the pair for that close; it catches up from the stored bar on the next', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT', 'BUSDT']);
    const r = await t.close(0, { AUSDT: flat(B0) }, { missing: ['BUSDT'], behind: [] });
    expect(r.skipped.missing_bar).toEqual(['BUSDT']);
    expect(t.repo.logs(t.runId, 'missing_bar')).toMatchObject([{ symbol: 'BUSDT' }]);
    t.candles.upsert('BUSDT', TF, [flat(B0)]); // REST had it later; the feed stored it
    const r2 = await t.close(1, t.flatAll(1));
    expect(r2.stepped).toEqual(['AUSDT', 'BUSDT']);
    expect(t.repo.isProcessed(t.runId, 'BUSDT', B0)).toBe(true);
    expect(t.repo.isProcessed(t.runId, 'BUSDT', B0 + STEP)).toBe(true);
  });

  it('a behind pair is skipped until loadHistory repairs it, then rejoins', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT', 'BUSDT']);
    // B's bar 0 never reached the repo (the feed reported it behind); REST has it.
    const r = await t.close(0, t.flatAll(0), { missing: [], behind: ['BUSDT'] });
    expect(r.skipped.behind).toEqual(['BUSDT']);
    expect(t.repo.logs(t.runId, 'behind')).toMatchObject([{ symbol: 'BUSDT' }]);
    t.client.setCandles('BUSDT', TF, [...historyBars(), flat(B0)]);
    await t.run.idle();
    const r2 = await t.close(1, { AUSDT: flat(B0 + STEP), BUSDT: flat(B0 + STEP) });
    expect(r2.stepped).toEqual(['AUSDT', 'BUSDT']);
    expect(t.repo.isProcessed(t.runId, 'BUSDT', B0)).toBe(true);
  });
});

describe('ScannerRun lifecycle', () => {
  it('delisted pair closes its position', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT', 'BUSDT']);
    await t.close(0, { AUSDT: signal(B0), BUSDT: flat(B0) });
    await t.close(1, t.flatAll(1)); // A's entry fills at bar 1's open
    expect(t.repo.loadState(t.runId)!.broker.positions.AUSDT).toBeDefined();
    t.clock.set(t.clock.now() + T);
    await t.run.applyUniverse([pair('BUSDT')], t.volumes);
    const trades = t.repo.trades(t.runId);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ symbol: 'AUSDT', exitReason: 'delisting', exitPrice: 100 });
    expect(t.repo.logs(t.runId, 'delisting')).toMatchObject([{ symbol: 'AUSDT', detail: { hadPosition: true } }]);
    const state = t.repo.loadState(t.runId)!;
    expect(state.broker.positions.AUSDT).toBeUndefined();
    expect(state.broker.orders.filter((o) => o.symbol === 'AUSDT')).toEqual([]);
    expect(t.run.status().universe).toBe(1);
    expect(t.run.symbols()).toEqual(['BUSDT']);
    // A's bars are no longer stepped.
    const r = await t.close(2, t.flatAll(2));
    expect(r.stepped).toEqual(['BUSDT']);
  });

  it('new listing joins when history suffices', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT', 'NEWUSDT'], { history: { NEWUSDT: 50 } });
    expect(t.run.status().skipped.insufficient_history).toBe(1);
    expect(t.repo.logs(t.runId, 'skip')).toMatchObject([{ symbol: 'NEWUSDT', detail: { reason: 'insufficient_history', bars: 50 } }]);
    for (let k = 0; k < 3; k++) {
      const r = await t.close(k, { AUSDT: flat(t.barOpen(k)) });
      expect(r.skipped.insufficient_history).toEqual(['NEWUSDT']);
    }
    // Three closes later it has enough bars.
    t.client.setCandles('NEWUSDT', TF, historyBars(HISTORY, t.barOpen(2)));
    await t.run.applyUniverse(t.pairs, t.volumes);
    expect(t.run.status().skipped.insufficient_history ?? 0).toBe(0);
    const r = await t.close(3, t.flatAll(3));
    expect(r.stepped).toEqual(['AUSDT', 'NEWUSDT']);
  });

  it('pause drops entries but keeps stops and funding', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT', 'BUSDT']);
    await t.close(0, { AUSDT: signal(B0), BUSDT: flat(B0) }); // A's entry is accepted before the pause
    // A funding event inside bar 1, announced by the mark stream; REST has it.
    const ft = t.barOpen(1) + 5 * T;
    t.client.setFunding('AUSDT', [{ time: ft, rate: 0.001, markPrice: 100 }]);
    t.tracker.onMark({ symbol: 'AUSDT', markPrice: 100, fundingRate: 0.001, nextFundingTime: ft, time: t.clock.now() });
    t.run.pause();
    await t.close(1, { AUSDT: flat(t.barOpen(1)), BUSDT: signal(t.barOpen(1)) });
    expect(t.repo.logs(t.runId, 'paused_entry_dropped')).toMatchObject([{ symbol: 'BUSDT' }]);
    let state = t.repo.loadState(t.runId)!;
    expect(state.broker.positions.AUSDT?.qty).toBe(25); // 4,000 USD at 160
    expect(state.broker.positions.BUSDT).toBeUndefined();
    expect(state.broker.fundingNet).toBeCloseTo(-25 * 100 * 0.001, 10); // the event pushed after the hooks were built
    expect(t.repo.appliedThrough(t.runId, 'AUSDT')).toBe(ft);
    // The stop at 90 still works while paused.
    await t.close(2, { AUSDT: { openTime: t.barOpen(2), open: 100, high: 101, low: 80, close: 85, volume: 1 }, BUSDT: flat(t.barOpen(2)) });
    const trades = t.repo.trades(t.runId);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ symbol: 'AUSDT', exitReason: 'stop' });
    expect(trades[0]!.funding).toBeCloseTo(-2.5, 10);
    state = t.repo.loadState(t.runId)!;
    expect(state.broker.positions.AUSDT).toBeUndefined();
    // Resumed: entries go through again.
    t.run.resume();
    await t.close(3, { AUSDT: flat(t.barOpen(3)), BUSDT: signal(t.barOpen(3)) });
    expect(t.repo.loadState(t.runId)!.broker.orders.some((o) => o.symbol === 'BUSDT' && o.tag === 'entry')).toBe(true);
  });

  it('live price fills a stop between closes and commits it', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT', 'BUSDT']);
    await t.close(0, { AUSDT: signal(B0), BUSDT: flat(B0) });
    await t.close(1, t.flatAll(1));
    const commits = vi.spyOn(t.repo, 'commitPass');
    t.clock.set(t.clock.now() + 30_000);
    t.run.onPrice('BUSDT', 50, t.clock.now()); // nothing resting for B: no commit
    expect(commits).not.toHaveBeenCalled();
    t.run.onPrice('AUSDT', 85, t.clock.now());
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]![1].processed).toEqual([]);
    const trades = t.repo.trades(t.runId);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ symbol: 'AUSDT', exitReason: 'stop', exitTime: t.clock.now() });
    expect(t.repo.loadState(t.runId)!.broker.positions.AUSDT).toBeUndefined();
    // The next close does not close it again.
    await t.close(2, t.flatAll(2));
    expect(t.repo.trades(t.runId)).toHaveLength(1);
  });

  it('stop freezes the run: no more passes and nothing is committed', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT']);
    await t.close(0, { AUSDT: signal(B0) });
    t.run.stop();
    const commits = vi.spyOn(t.repo, 'commitPass');
    const r = await t.close(1, t.flatAll(1));
    expect(r.scanned).toBe(0);
    t.run.onPrice('AUSDT', 10, t.clock.now());
    expect(commits).not.toHaveBeenCalled();
  });

  it('a rejected commit (stale pass) reloads the state and rebuilds the instances', { timeout: 60_000 }, async () => {
    const t = await startedRun(['AUSDT']);
    await t.close(0, { AUSDT: signal(B0) });
    // Another writer moved the saved state past this close: the in-memory state is behind the database.
    const saved = t.repo.loadState(t.runId)!;
    t.repo.commitPass(t.runId, { close: B0 + 10 * STEP, processed: [], broker: saved.broker, layers: {}, trades: [], equity: { time: B0 + 10 * STEP, equity: 10_000 }, logs: [], fundingApplied: {} });
    const r = await t.close(1, t.flatAll(1));
    expect(r.errors).toEqual([]);
    expect(t.repo.logs(t.runId, 'state_reloaded')).toHaveLength(1);
    expect(t.repo.isProcessed(t.runId, 'AUSDT', B0 + STEP)).toBe(false);
    // The rebuilt run goes on with the saved state (the pending entry included).
    t.clock.set(B0 + 11 * STEP + 1_000);
    t.candles.upsert('AUSDT', TF, Array.from({ length: 10 }, (_, i) => flat(B0 + (i + 1) * STEP)));
    const r2 = await t.run.onClose(B0 + 12 * STEP, new Map([['AUSDT', flat(B0 + 11 * STEP)]]), { missing: [], behind: [] });
    expect(r2.stepped).toEqual(['AUSDT']);
    expect(t.repo.loadState(t.runId)!.broker.positions.AUSDT).toBeDefined();
  });
});

describe('ScannerRun start', () => {
  const make = (symbols: string[], script?: string, bars?: number) => {
    const w = world(symbols, bars === undefined ? {} : { history: Object.fromEntries(symbols.map((s) => [s, bars])) });
    const setup = setupFor(script === undefined ? {} : { script });
    const runId = w.repo.createRun({ name: 'start', setup });
    const run = new ScannerRun({ runId, repo: w.repo, candles: w.candles, client: w.client, funding: w.tracker, setup, now: w.clock.now, sleep: w.clock.sleep, warmupBars: HISTORY });
    return { ...w, runId, run, volumes: new Map(symbols.map((s, i) => [s, 100 - i])) };
  };

  it('a script that does not compile throws ScriptCompileError', async () => {
    const t = make(['AUSDT'], '//@version=6\nstrategy("bad")\nx = close[length]\n');
    await expect(t.run.start(t.pairs, t.volumes)).rejects.toBeInstanceOf(ScriptCompileError);
  });

  it('barstate / bar_index use is logged as a script warning', { timeout: 60_000 }, async () => {
    const t = make(['AUSDT'], '//@version=6\nstrategy("w")\nif barstate.isconfirmed and bar_index > 10\n    strategy.entry("L", strategy.long)\n');
    await t.run.start(t.pairs, t.volumes);
    const w = t.repo.logs(t.runId, 'script_warning');
    expect(w).toHaveLength(1);
    expect(w[0]!.detail).toMatchObject({ message: expect.stringContaining('restart may change bar_index') });
  });

  it('warm-up retries a transient failure with backoff and passes onboardDate', { timeout: 60_000 }, async () => {
    const t = make(['AUSDT', 'BUSDT'], undefined, 120);
    t.client.scriptKlines('AUSDT', 503, 503);
    // 120 bars since listing, 150 wanted: without onboardDate the loader would ask for the head before the listing.
    const onboard = historyBars(120)[0]!.openTime;
    await t.run.start(t.pairs.map((p) => ({ ...p, onboardDate: onboard })), t.volumes);
    const starts = t.client.calls.filter((c) => c.url.includes('/klines')).map((c) => Number(new URL(c.url).searchParams.get('startTime')));
    expect(Math.min(...starts)).toBe(onboard);
    expect(t.clock.sleeps.filter((ms) => ms === 2_000 || ms === 4_000)).toEqual([2_000, 4_000]);
    expect(t.run.symbols().sort()).toEqual(['AUSDT', 'BUSDT']);
    expect(t.run.status().universe).toBe(2);
  });

  it('a REST ban shows as a status warning', { timeout: 60_000 }, async () => {
    const t = make(['AUSDT']);
    await t.run.start(t.pairs, t.volumes);
    t.client.budget.ban(60_000);
    expect(t.run.status().warnings).toContain('rest_banned');
  });

  it('the feed status is reported once attached', { timeout: 60_000 }, async () => {
    const t = make(['AUSDT']);
    await t.run.start(t.pairs, t.volumes);
    const feed = { connected: true, stale: false, lastMessageAt: 5, catchingUp: false, missing: [], behind: [] };
    t.run.attachFeed(() => feed);
    expect(t.run.status().feed).toEqual(feed);
    expect(t.run.lastCloseTime()).toBe(B0);
  });
});
