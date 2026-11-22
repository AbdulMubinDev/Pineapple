// Task 2 spike: one block per capability question in docs/spike/pinets-findings.md.
// `it.fails` marks a capability PineTS 0.13.1 does NOT have (the body asserts the capability and is
// expected to fail); the comment next to it says why. Never delete one: if PineTS gains the
// capability, the `it.fails` starts failing and tells us. Each `it.fails` has a positive companion
// test that pins the specific failure, so an unrelated crash cannot pass as "expected fail".
// Timings print only with SPIKE_LOG=1.
import { readFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types.js';
import {
  KYBER_WINDOW,
  MA_CROSS_WINDOW,
  aggregateDaily,
  compileCheck,
  createStepper,
  declarationOf,
  emulatorStats,
  fixtureCandles,
  probeSource,
  runScript,
  type BrokerView,
  type OrderCall,
} from '../../spike/probe.js';
import { runHookedInIsolate, runInIsolate } from '../../spike/isolate.js';

const H4 = 14_400_000;
const DAY = 86_400_000;
const log = process.env.SPIKE_LOG ? console.log : () => {};

// No network in the spike: any fetch fails the run loudly, and we check none was attempted.
const fetchSpy = vi.fn(() => {
  throw new Error('network access attempted in spike tests');
});

let candles: Candle[];
beforeAll(() => {
  vi.stubGlobal('fetch', fetchSpy);
  candles = fixtureCandles();
});
afterAll(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const plot = (ctx: { plots: Record<string, { data: { value: unknown }[] }> }, name: string): unknown[] =>
  (ctx.plots[name]?.data ?? []).map((p) => p.value);

const ofMethod = (calls: OrderCall[], m: OrderCall['method']) => calls.filter((c) => c.method === m);
const ungated = (name: string) => probeSource(name).replace('time >= timestamp("UTC", 2024, 1, 1, 0, 0)', 'true');

const FLAT_10K: BrokerView = { position_size: 0, position_avg_price: NaN, equity: 10_000, netprofit: 0, openprofit: 0, opentrades: [] };

describe('Q1 order calls', () => {
  it('exposes order calls per bar (probe 01: entry with id, direction, default qty)', async () => {
    const { calls } = await runScript(probeSource('01-ma-cross'), candles);
    const entries = ofMethod(calls, 'entry');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.args).toMatchObject({ id: expect.stringMatching(/^(L|S)$/), direction: expect.stringMatching(/^(long|short)$/) });
    // probe 01 passes no qty: the recorder reports it as not given, so our broker applies the
    // strategy() default (100% of equity).
    expect(entries.every((e) => e.args.qty === undefined)).toBe(true);
    expect(entries[0]!.time).toBe(candles[entries[0]!.bar]!.openTime);
    expect(entries[0]!.time).toBeGreaterThanOrEqual(MA_CROSS_WINDOW.from); // the script's own range gate
  });

  it('captures every primitive with its arguments (probe 02) and the emulator sees none of them', async () => {
    const { calls, ctx } = await runScript(probeSource('02-exit-brackets'), candles);
    expect(ofMethod(calls, 'entry')[0]!.args).toMatchObject({ id: 'L', direction: 'long', qty: 0.1, comment: 'go long' });
    const exit = ofMethod(calls, 'exit')[0]!;
    expect(exit.args).toMatchObject({ id: 'L-x', from_entry: 'L', qty: undefined, trail_points: undefined });
    const bar = candles[exit.bar]!;
    expect(exit.args.stop).toBeCloseTo(bar.close * 0.97, 6);
    expect(exit.args.limit).toBeCloseTo(bar.close * 1.05, 6);
    expect(ofMethod(calls, 'close')[0]!.args).toMatchObject({ id: 'L', comment: 'cross down' });
    const order = ofMethod(calls, 'order')[0]!;
    expect(order.args).toMatchObject({ id: 'Dip', direction: 'long', qty: 0.05 });
    expect(order.args.limit).toBeCloseTo(candles[order.bar]!.close * 0.9, 6);
    expect(order.bar % 50).toBe(0);
    const cancel = ofMethod(calls, 'cancel')[0]!;
    expect(cancel.args).toEqual({ id: 'Dip' });
    expect(cancel.bar % 50).toBe(3);
    expect(ofMethod(calls, 'cancel_all').map((c) => c.bar % 500)).toContain(499);
    expect(ofMethod(calls, 'close_all')[0]!.args).toMatchObject({ comment: 'flatten' });
    // Not forwarded: PineTS's broker emulator never received an order.
    const s = (ctx as unknown as { strategy: { closedtrades: unknown[]; opentrades: unknown[]; pending_orders: unknown[] } }).strategy;
    expect(s.closedtrades.length + s.opentrades.length + s.pending_orders.length).toBe(0);
  });

  it('captures KyberSwing equity-sized entries and their stop-only exits (probe 08)', async () => {
    const { calls } = await runScript(probeSource('08-kyberswing'), candles, { provider: true, broker: () => FLAT_10K });
    const entries = ofMethod(calls, 'entry');
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const close = candles[entry.bar]!.close;
      expect(entry.args.id).toMatch(/^(Long|Short)$/);
      expect(entry.args.qty as number).toBeGreaterThan(0);
      // qty is capped at equity * maxLev / close, and the fed equity is 10,000.
      expect(entry.args.qty as number).toBeLessThanOrEqual((10_000 * 3) / close + 1e-9);
      // The script's exit on the entry bar carries the initial stop: close -/+ 2 ATR.
      const long = entry.args.id === 'Long';
      const exit = calls.find((c) => c.bar === entry.bar && c.method === 'exit' && c.args.id === (long ? 'L-X' : 'S-X'))!;
      expect(exit.args.from_entry).toBe(entry.args.id);
      expect(exit.args.limit).toBeUndefined();
      const stop = exit.args.stop as number;
      expect(Number.isFinite(stop)).toBe(true);
      if (long) expect(stop).toBeLessThan(close);
      else expect(stop).toBeGreaterThan(close);
    }
  });
});

describe('Q2 broker state', () => {
  const view = (bar: number): BrokerView => ({
    position_size: bar % 7 === 0 ? 0 : 0.25,
    position_avg_price: 12_345 + bar,
    equity: 20_000 + bar,
    netprofit: 1_000 + bar,
    openprofit: 50 + bar,
    opentrades:
      bar % 7 === 0 ? [] : [{ id: 'L', size: 0.25, entry_price: 12_345 + bar, entry_bar_index: bar - 1, entry_time: 1_700_000_000_000 + bar, profit: 7 + bar }],
  });

  it('feeds every read-back from our broker, opentrades helpers included (probe 04)', async () => {
    const slice = candles.slice(0, 300);
    const { ctx, calls } = await runScript(probeSource('04-equity-sizing'), slice, { broker: view });
    const n = plot(ctx, 'pos').length;
    expect(n).toBe(300);
    const col = (name: string) => plot(ctx, name);
    for (let i = 0; i < n; i++) {
      const v = view(i);
      const t = v.opentrades[0];
      expect(col('pos')[i]).toBe(v.position_size);
      expect(col('avg')[i]).toBe(v.position_avg_price);
      expect(col('equity')[i]).toBe(v.equity);
      expect(col('netprofit')[i]).toBe(v.netprofit);
      expect(col('openprofit')[i]).toBe(v.openprofit);
      expect(col('opentrades')[i]).toBe(v.opentrades.length);
      expect(col('ot.size')[i]).toBe(t?.size ?? 0);
      expect(col('ot.entry_price')[i]).toBe(t?.entry_price ?? NaN);
      expect(col('ot.entry_id_is_L')[i]).toBe(t ? 1 : 0);
      expect(col('ot.entry_bar_index')[i]).toBe(t?.entry_bar_index ?? NaN);
      expect(col('ot.entry_time')[i]).toBe(t?.entry_time ?? NaN);
      expect(col('ot.profit')[i]).toBe(t?.profit ?? 0);
      if (i > 0) expect(col('posPrev')[i]).toBe(view(i - 1).position_size); // strategy.position_size[1]
    }
    // Sizing used OUR equity: qty = equity * 0.5 / close on the entry bar.
    const entries = ofMethod(calls, 'entry');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.bar % 7).toBe(0); // the script only enters when our broker says flat
      expect(e.args.qty).toBeCloseTo(((20_000 + e.bar) * 0.5) / slice[e.bar]!.close, 9);
    }
    // Exits keyed off OUR avg price: close < avg*0.98 never true at avg ~12k while BTC > 16k.
    expect(ofMethod(calls, 'close').length).toBe(0);
  });

  it('exits when OUR avg price says so (probe 04, avg far above price)', async () => {
    const slice = candles.slice(0, 100);
    const { calls } = await runScript(probeSource('04-equity-sizing'), slice, {
      broker: () => ({ ...FLAT_10K, position_size: 1, position_avg_price: 1e9, opentrades: [{ id: 'L', size: 1, entry_price: 1e9, entry_bar_index: 0, entry_time: 0 }] }),
    });
    expect(ofMethod(calls, 'close').length).toBe(100);
    expect(ofMethod(calls, 'entry').length).toBe(0);
  });

  it('a script reading strategy.opentrades sees our open-trade count (probe 03)', async () => {
    const slice = candles.slice(0, 200);
    const { ctx, calls } = await runScript(probeSource('03-pyramiding'), slice, {
      broker: (bar) => ({
        ...FLAT_10K,
        position_size: 0.03,
        opentrades: bar < 100 ? [] : [1, 2, 3].map((k) => ({ id: 'L', size: 0.01, entry_price: 1, entry_bar_index: k, entry_time: 0 })),
      }),
    });
    expect(plot(ctx, 'opentrades').slice(100).every((v) => v === 3)).toBe(true);
    const entries = ofMethod(calls, 'entry');
    expect(entries.filter((c) => c.bar < 100).length).toBeGreaterThan(0); // green bars before 100 do enter
    expect(entries.filter((c) => c.bar >= 100).length).toBe(0); // "opentrades < 3" gate used our count
  });
});

describe('Q3 bar-by-bar running', () => {
  it('runs one bar at a time with state kept, matching a full run (probe 01, 1,000 bars), patching once', async () => {
    const bars = candles.slice(2000, 3000);
    const full = await runScript(ungated('01-ma-cross'), bars);
    const stepper = await createStepper(ungated('01-ma-cross'));
    const t0 = performance.now();
    for (const c of bars) await stepper.push(c);
    const usPerBar = ((performance.now() - t0) * 1000) / bars.length;
    log(`[Q3] stepped probe 01: ${usPerBar.toFixed(1)} us/bar over ${bars.length} bars`);
    expect(stepper.calls.length).toBeGreaterThan(0);
    expect(stepper.calls).toEqual(full.calls);
    expect(stepper.patchCount()).toBe(1); // one run context for the whole stepped run
    expect(usPerBar).toBeLessThan(5_000);
  });

  it('steps KyberSwing (daily request.security) bar by bar with the same order calls as a full run', async () => {
    const bars = candles.slice(0, 3000);
    const broker = () => FLAT_10K;
    const full = await runScript(probeSource('08-kyberswing'), bars, { provider: true, broker });
    const stepper = await createStepper(probeSource('08-kyberswing'), { provider: true, broker, htfRefresh: 'day-boundary' });
    const t0 = performance.now();
    for (const c of bars) await stepper.push(c);
    log(`[Q3] stepped KyberSwing: ${(((performance.now() - t0) * 1000) / bars.length).toFixed(1)} us/bar over ${bars.length} bars`);
    expect(ofMethod(stepper.calls, 'entry').length).toBeGreaterThan(0);
    expect(stepper.calls).toEqual(full.calls);
    expect(stepper.patchCount()).toBe(1);
  }, 120_000);
});

describe('Q4 saving state', () => {
  // Context holds closures (namespace methods bound to the context), class instances, promises and
  // the transpiled function: neither structuredClone nor v8.serialize can copy it.
  it.fails('serialises per-bar state with structuredClone', async () => {
    const { ctx } = await runScript(probeSource('01-ma-cross'), candles.slice(0, 200));
    expect(() => structuredClone(ctx)).not.toThrow();
  });
  it.fails('serialises per-bar state with v8.serialize', async () => {
    const { ctx } = await runScript(probeSource('01-ma-cross'), candles.slice(0, 200));
    expect(() => serialize(ctx)).not.toThrow();
  });
  it('fails to serialise for the documented reason (DataCloneError on a Promise)', async () => {
    const { ctx } = await runScript(probeSource('01-ma-cross'), candles.slice(0, 200));
    expect(() => structuredClone(ctx)).toThrow(/could not be cloned/);
    expect(() => serialize(ctx)).toThrow(/could not be cloned/);
  });

  it('warm start: one page over the history, then stepping, equals a full run (probe 01)', async () => {
    const bars = candles.slice(0, 1500);
    const full = await runScript(ungated('01-ma-cross'), bars);
    const t0 = performance.now();
    const stepper = await createStepper(ungated('01-ma-cross'), { history: bars.slice(0, 1000) });
    const warmMs = performance.now() - t0;
    for (const c of bars.slice(1000)) await stepper.push(c);
    log(`[Q4] probe 01 warm start over 1,000 bars: ${warmMs.toFixed(1)} ms`);
    expect(stepper.calls.filter((c) => c.bar >= 1000).length).toBeGreaterThan(0);
    expect(stepper.calls).toEqual(full.calls);
    expect(stepper.patchCount()).toBe(1);
  });

  it('warm start for KyberSwing: a 3,000-bar window reproduces the full-history entries, a 1,000-bar window does not', async () => {
    const N = candles.length;
    const TAIL = 500;
    const broker = () => FLAT_10K;
    const key = (c: OrderCall) => `${c.time}|${JSON.stringify(c.args)}`;
    const full = await runScript(probeSource('08-kyberswing'), candles, { provider: true, broker });
    const want = ofMethod(full.calls, 'entry').filter((c) => c.bar >= N - TAIL).map(key);
    expect(want.length).toBeGreaterThan(3);
    const replay = async (window: number) => {
      const t0 = performance.now();
      const st = await createStepper(probeSource('08-kyberswing'), {
        provider: true,
        broker,
        htfRefresh: 'day-boundary',
        history: candles.slice(N - TAIL - window, N - TAIL),
      });
      const warmMs = performance.now() - t0;
      for (const c of candles.slice(N - TAIL)) await st.push(c);
      log(`[Q4] KyberSwing warm start over ${window} bars: ${warmMs.toFixed(0)} ms`);
      return ofMethod(st.calls, 'entry').filter((c) => c.time >= candles[N - TAIL]!.openTime).map(key);
    };
    expect(await replay(3000)).toEqual(want);
    // 1,000 4h bars (+30 days PineTS adds for the daily request) are under the 200 daily bars
    // the EMA-200 regime needs: the windowed instance misses entries the full history takes.
    const short = await replay(1000);
    expect(short.filter((k) => want.includes(k)).length).toBeLessThan(want.length);
  }, 120_000);
});

describe('Q5 higher timeframes', () => {
  const daily = () => aggregateDaily(candles);
  const dayOf = (t: number) => Math.floor(t / DAY) * DAY;

  function expected(dailyCloses: Map<number, number>, openTime: number) {
    const d = dayOf(openTime);
    const prev = dailyCloses.get(d - DAY);
    const today = dailyCloses.get(d);
    const lastOfDay = openTime + H4 === d + DAY;
    return { prevOn: prev, default: lastOfDay ? today : prev };
  }

  function check(ctx: Parameters<typeof plot>[0], bars: Candle[], minChecked = 1000) {
    const closes = new Map(daily().map((c) => [c.openTime, c.close]));
    const prevOn = plot(ctx, 'prevOn');
    const def = plot(ctx, 'default');
    const tClose = plot(ctx, 'tupleClose');
    let checked = 0;
    for (let i = 12; i < bars.length; i++) {
      const e = expected(closes, bars[i]!.openTime);
      expect(prevOn[i]).toBe(e.prevOn);
      expect(def[i]).toBe(e.default);
      expect(tClose[i]).toBe(e.prevOn);
      checked++;
    }
    expect(checked).toBeGreaterThan(minChecked);
  }

  // With an array source the daily request re-reads the SAME 4h array as if it were daily bars.
  it.fails('gives TradingView daily values from a plain 4h candle array', async () => {
    const bars = candles.slice(0, 1500);
    const { ctx } = await runScript(probeSource('05-mtf-daily'), bars);
    check(ctx, bars);
  });

  it('with a plain array, "daily" values are the previous / current 4h close and syminfo is empty', async () => {
    const bars = candles.slice(0, 1500);
    const { ctx } = await runScript(probeSource('05-mtf-daily'), bars);
    const prevOn = plot(ctx, 'prevOn');
    const def = plot(ctx, 'default');
    for (let i = 1; i < bars.length; i++) {
      expect(prevOn[i]).toBe(bars[i - 1]!.close);
      expect(def[i]).toBe(bars[i]!.close);
    }
    const syminfo = (ctx as unknown as { pine: { syminfo: Record<string, unknown> } }).pine.syminfo;
    expect(syminfo.tickerid).toBeUndefined();
    expect(syminfo.mintick).toBeUndefined();
    expect(syminfo.mincontract).toBeUndefined();
    const withProvider = await runScript(probeSource('05-mtf-daily'), bars.slice(0, 10), { provider: true });
    expect((withProvider.ctx as unknown as { pine: { syminfo: Record<string, unknown> } }).pine.syminfo).toMatchObject({ mintick: 0.1, mincontract: 0.001 });
  });

  it('gives TradingView non-repainting, default-lookahead and tuple values when a provider serves daily candles', async () => {
    const bars = candles.slice(0, 1500);
    const { ctx } = await runScript(probeSource('05-mtf-daily'), bars, { provider: true });
    check(ctx, bars);
    // Tuple element 2: ta.ema(close, 3)[1] of DAILY closes (Pine's SMA-seeded EMA), as of the previous day.
    const d = daily();
    const ema = new Map<number, number>();
    let e = NaN;
    for (let i = 0; i < d.length; i++) {
      if (i === 2) e = (d[0]!.close + d[1]!.close + d[2]!.close) / 3;
      else if (i > 2) e = 0.5 * d[i]!.close + 0.5 * e;
      ema.set(d[i]!.openTime, e);
    }
    const tEma = plot(ctx, 'tupleEma');
    let checked = 0;
    for (let i = 24; i < bars.length; i++) {
      expect(tEma[i] as number).toBeCloseTo(ema.get(dayOf(bars[i]!.openTime) - DAY)!, 6);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  // PineTS's own tail refresh (dataVersion bump -> updateTail) keeps returning stale daily values:
  // its rollback truncates Series state but not the plain `params` arrays the values are read from.
  it.fails('gives TradingView daily values bar by bar via PineTS updateTail', async () => {
    const bars = candles.slice(0, 300);
    const stepper = await createStepper(probeSource('05-mtf-daily'), { provider: true, htfRefresh: 'updateTail' });
    for (const c of bars) await stepper.push(c);
    check(stepper.context()!, bars, 250);
  });

  it('via updateTail, the daily value lags: day 1 close is still returned on days 3 to 8', async () => {
    const bars = candles.slice(0, 60);
    const stepper = await createStepper(probeSource('05-mtf-daily'), { provider: true, htfRefresh: 'updateTail' });
    for (const c of bars) await stepper.push(c);
    const prevOn = plot(stepper.context()!, 'prevOn');
    const d = daily();
    // TV: bars 12-17 read day 2's close, 18-23 day 3's, ... Received: day 1's close until bar 47.
    expect(prevOn.slice(12, 48)).toEqual(new Array(36).fill(d[0]!.close));
    expect(new Set(d.slice(1, 7).map((c) => c.close)).has(d[0]!.close)).toBe(false);
  });

  it('gives the same daily values bar by bar when request.security contexts are rebuilt each bar', async () => {
    const bars = candles.slice(0, 600);
    const stepper = await createStepper(probeSource('05-mtf-daily'), { provider: true });
    for (const c of bars) await stepper.push(c);
    check(stepper.context()!, bars, 500);
  }, 60_000);

  it('gives the same daily values bar by bar when they are rebuilt only at UTC day boundaries', async () => {
    const bars = candles.slice(0, 1500);
    const stepper = await createStepper(probeSource('05-mtf-daily'), { provider: true, htfRefresh: 'day-boundary' });
    for (const c of bars) await stepper.push(c);
    check(stepper.context()!, bars);
  }, 60_000);

  it("KyberSwing's daily regime needs daily candles: provider vs bare array give different entries", async () => {
    const withDaily = await runScript(probeSource('08-kyberswing'), candles, { provider: true, broker: () => FLAT_10K });
    const bare = await runScript(probeSource('08-kyberswing'), candles, { broker: () => FLAT_10K });
    const e1 = ofMethod(withDaily.calls, 'entry').map((c) => c.time);
    const e2 = ofMethod(bare.calls, 'entry').map((c) => c.time);
    expect(e1.length).toBeGreaterThan(0);
    expect(e1).not.toEqual(e2);
  });
});

describe('Q6 validation', () => {
  it('reports syntax errors with a line number', () => {
    expect(compileCheck('//@version=6\nstrategy("s")\nx = 1 +\ny = )\nplot(x)\n')).toMatchObject({ ok: false, line: 4, column: 4 });
    // An unclosed parenthesis is reported where the parser gave up (end of input), not where it opened.
    expect(compileCheck('//@version=6\nstrategy("s")\nx = ta.sma(close, 10\nplot(x)\n')).toMatchObject({ ok: false, line: 5, column: 1 });
  });

  it('flags unsupported request.* calls as runtime warnings and returns na (probe 07)', async () => {
    const { ctx } = await runScript(probeSource('07-unsupported'), candles.slice(0, 50));
    const methods = (ctx as unknown as { warnings: { method: string }[] }).warnings.map((w) => w.method);
    expect(methods.sort()).toEqual(['request.dividends', 'request.economic', 'request.financial', 'request.seed']);
    for (const p of ['eps', 'gdp', 'seed', 'dividends']) expect(plot(ctx, p).every((v) => Number.isNaN(v))).toBe(true);
    expect(plot(ctx, 'sma').some((v) => Number.isFinite(v))).toBe(true); // the rest of the script still runs
  });

  // Unknown functions surface only at run time as a JS TypeError, with no Pine line.
  it.fails('reports unknown functions at compile time with a line number', () => {
    const r = compileCheck('//@version=6\nstrategy("u")\na = 1\nx = ta.notafunction(close, 10)\nplot(x)\n');
    expect(r.ok).toBe(false);
    expect(r.line).toBe(4);
  });

  it('unknown functions compile, then fail at run time with a TypeError and no Pine line', async () => {
    const src = '//@version=6\nstrategy("u")\na = 1\nx = ta.notafunction(close, 10)\nplot(x)\n';
    expect(compileCheck(src)).toEqual({ ok: true });
    const err = await runScript(src, candles.slice(0, 5)).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err!.message).toBe('ta.notafunction is not a function');
    expect(err!.message).not.toMatch(/line|\d+:\d+/i);
  });

  // Undeclared identifiers are rejected at compile time, but the message carries no position.
  it.fails('reports undeclared identifiers with a line number', () => {
    const r = compileCheck('//@version=6\nstrategy("v")\nplot(foo)\n');
    expect(r.ok).toBe(false);
    expect(r.line).toBe(3);
  });

  it('rejects undeclared identifiers at compile time, without a position', () => {
    expect(compileCheck('//@version=6\nstrategy("v")\nplot(foo)\n')).toEqual({ ok: false, message: 'Undeclared identifier "foo"' });
  });

  it('does not type-check: a float + string script compiles and runs', async () => {
    const src = '//@version=6\nstrategy("t")\nx = close + "abc"\nplot(x, "x")\n';
    expect(compileCheck(src)).toEqual({ ok: true });
    const { ctx } = await runScript(src, candles.slice(0, 3));
    expect(plot(ctx, 'x').length).toBe(3);
  });

  it('runtime.error() throws a PineRuntimeError with the method and no line', async () => {
    const err = await runScript('//@version=6\nstrategy("r")\nruntime.error("boom")\n', candles.slice(0, 3)).then(
      () => null,
      (e: unknown) => e as Error & { method?: string },
    );
    expect(err?.name).toBe('PineRuntimeError');
    expect(err?.message).toBe('boom');
  });

  it('reads the declaration kind and its arguments (probes 06 and 01)', () => {
    const ind = declarationOf(probeSource('06-indicator'));
    expect(ind.kind).toBe('indicator');
    expect(ind.args).toMatchObject({ overlay: false, precision: 2 });
    const st = declarationOf(probeSource('01-ma-cross'));
    expect(st.kind).toBe('strategy');
    expect(st.args).toMatchObject({ initial_capital: 10000, default_qty_type: 'percent_of_equity', default_qty_value: 100, commission_value: 0.05, pyramiding: 0 });
    const ky = declarationOf(probeSource('08-kyberswing'));
    expect(ky.args).toMatchObject({ slippage: 2, margin_long: 20, margin_short: 20, process_orders_on_close: false, calc_on_order_fills: false });
  });

  // PineTS only knows 'indicator' | 'strategy'; a library() script reads as null.
  it.fails('recognises library() declarations', () => {
    expect(declarationOf('//@version=6\nlibrary("MyLib")\nexport f(float x) => x * 2\n').kind).toBe('library');
  });

  it('reads a library() script as declaration kind null', () => {
    expect(declarationOf('//@version=6\nlibrary("MyLib")\nexport f(float x) => x * 2\n').kind).toBeNull();
  });

  it('a Pine import with no resolver set fails without touching the network', async () => {
    const src = '//@version=6\nindicator("i")\nimport TradingView/ta/7 as tvta\nplot(close)\n';
    await expect(runScript(src, candles.slice(0, 3))).rejects.toThrow(/Unresolved Pine Script import: "TradingView\/ta\/7"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Q7 sandboxing', () => {
  it('loads the PineTS bundle and runs probe 01 inside an isolated-vm isolate with no host globals', async () => {
    const bars = candles.slice(0, 2000);
    const r = await runInIsolate(ungated('01-ma-cross'), bars);
    const outside = await runScript(ungated('01-ma-cross'), bars, { forward: true });
    const s = (outside.ctx as unknown as { strategy: { closedtrades: unknown[]; netprofit: number } }).strategy;
    log(`[Q7] isolate heap used ${(r.heapUsedBytes / 1e6).toFixed(1)} MB, total ${(r.heapTotalBytes / 1e6).toFixed(1)} MB`);
    expect(r.hostGlobals).toEqual({ require: 'undefined', process: 'undefined', fetch: 'undefined', setTimeout: 'undefined', Buffer: 'undefined', module: 'undefined' });
    expect(r.closedTrades).toBe(s.closedtrades.length);
    expect(r.netprofit).toBeCloseTo(s.netprofit, 6);
    expect(r.heapUsedBytes).toBeGreaterThan(0);
  });

  it('runs the hook inside the isolate with the broker in the host: same order calls as outside (probes 02 and 04)', async () => {
    const view = (bar: number): BrokerView => ({
      position_size: bar % 7 === 0 ? 0 : 0.25,
      position_avg_price: 12_345 + bar,
      equity: 20_000 + bar,
      netprofit: 0,
      openprofit: 0,
      opentrades: [],
    });
    const roundTrip = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;
    for (const [name, broker] of [
      ['02-exit-brackets', undefined],
      ['04-equity-sizing', view],
    ] as const) {
      const bars = candles.slice(0, 1200);
      const inside = await runHookedInIsolate(probeSource(name), bars, broker);
      const outside = await runScript(probeSource(name), bars, broker ? { broker } : {});
      expect(outside.calls.length).toBeGreaterThan(0);
      expect(inside.calls).toEqual(roundTrip(outside.calls));
    }
  });
});

describe('Q8 PineTS emulator results (evidence, pinned so drift is visible)', () => {
  const ref = JSON.parse(readFileSync('tests/fixtures/tv-reference.json', 'utf8')) as Record<string, unknown>;

  it('probe 01: emulator stats over Jan 1 2024 - Nov 18 2026 (TradingView numbers still pending)', async () => {
    expect(ref['ma-cross']).toBeNull();
    const { ctx } = await runScript(probeSource('01-ma-cross'), candles, { provider: true, forward: true });
    const st = emulatorStats(ctx, MA_CROSS_WINDOW);
    log('[Q8] probe 01 PineTS emulator:', JSON.stringify(st));
    expect(st).toEqual({ trades: 346, winRatePct: 17.05, profitFactor: 0.96, netProfitPct: -20.86 });
    // Same script without symbol info (qty step 1e-6 instead of 0.001): very different.
    const bare = await runScript(probeSource('01-ma-cross'), candles, { forward: true });
    expect(emulatorStats(bare.ctx, MA_CROSS_WINDOW)).toEqual({ trades: 716, winRatePct: 11.87, profitFactor: 1.01, netProfitPct: 10.21 });
  });

  it('KyberSwing: emulator stats next to the owner TradingView numbers', async () => {
    const inWindow = (c: OrderCall) => c.time >= KYBER_WINDOW.from && c.time < KYBER_WINDOW.to;
    const { ctx } = await runScript(probeSource('08-kyberswing'), candles, { provider: true, forward: inWindow });
    const st = emulatorStats(ctx, KYBER_WINDOW);
    log('[Q8] KyberSwing PineTS emulator:', JSON.stringify(st), 'TV:', JSON.stringify(ref['kyber-swing']));
    expect(st).toEqual({ trades: 59, winRatePct: 32.2, profitFactor: 1.64, netProfitPct: 20.58 });
    const ungatedRun = await runScript(probeSource('08-kyberswing'), candles, { provider: true, forward: true });
    expect(emulatorStats(ungatedRun.ctx, KYBER_WINDOW)).toEqual({ trades: 59, winRatePct: 32.2, profitFactor: 1.64, netProfitPct: 21.87 });
    const bare = await runScript(probeSource('08-kyberswing'), candles, { forward: inWindow });
    expect(emulatorStats(bare.ctx, KYBER_WINDOW)).toEqual({ trades: 87, winRatePct: 22.99, profitFactor: 1.28, netProfitPct: 12.66 });
  });
});
