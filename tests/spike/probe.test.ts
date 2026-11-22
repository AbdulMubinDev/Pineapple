// Task 2 spike: one block per capability question in docs/spike/pinets-findings.md.
// `it.fails` marks a capability PineTS 0.13.1 does NOT have (the body asserts the capability and is
// expected to fail); the comment next to it says why. Never delete one: if PineTS gains the
// capability, the `it.fails` starts failing and tells us.
import { readFileSync } from 'node:fs';
import { serialize } from 'node:v8';
import { beforeAll, describe, expect, it } from 'vitest';
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
import { runInIsolate } from '../../spike/isolate.js';

const H4 = 14_400_000;
const DAY = 86_400_000;

let candles: Candle[];
beforeAll(() => {
  candles = fixtureCandles();
});

const plot = (ctx: { plots: Record<string, { data: { value: unknown }[] }> }, name: string): unknown[] =>
  (ctx.plots[name]?.data ?? []).map((p) => p.value);

const ofMethod = (calls: OrderCall[], m: OrderCall['method']) => calls.filter((c) => c.method === m);

describe('Q1 order calls', () => {
  it('exposes order calls per bar (probe 01: entry with id, direction, qty)', async () => {
    const { calls } = await runScript(probeSource('01-ma-cross'), candles);
    const entries = ofMethod(calls, 'entry');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.args).toMatchObject({ id: expect.any(String), direction: expect.stringMatching(/^(long|short)$/) });
    expect('qty' in entries[0]!.args).toBe(true); // undefined = strategy default qty
    expect(entries[0]!.bar).toBeGreaterThanOrEqual(0);
    expect(entries[0]!.time).toBe(candles[entries[0]!.bar]!.openTime);
  });

  it('captures every primitive with its arguments (probe 02) and the emulator sees none of them', async () => {
    const { calls, ctx } = await runScript(probeSource('02-exit-brackets'), candles);
    expect(ofMethod(calls, 'entry')[0]!.args).toMatchObject({ id: 'L', direction: 'long', qty: 0.1, comment: 'go long' });
    const exit = ofMethod(calls, 'exit')[0]!;
    expect(exit.args).toMatchObject({ id: 'L-x', from_entry: 'L' });
    const bar = candles[exit.bar]!;
    expect(exit.args.stop).toBeCloseTo(bar.close * 0.97, 6);
    expect(exit.args.limit).toBeCloseTo(bar.close * 1.05, 6);
    expect(ofMethod(calls, 'close')[0]!.args).toMatchObject({ id: 'L', comment: 'cross down' });
    const order = ofMethod(calls, 'order')[0]!;
    expect(order.args).toMatchObject({ id: 'Dip', direction: 'long', qty: 0.05 });
    expect(order.args.limit).toBeCloseTo(candles[order.bar]!.close * 0.9, 6);
    expect(ofMethod(calls, 'cancel')[0]!.args).toMatchObject({ id: 'Dip' });
    expect(ofMethod(calls, 'cancel_all').length).toBeGreaterThan(0);
    expect(ofMethod(calls, 'close_all')[0]!.args).toMatchObject({ comment: 'flatten' });
    // Not forwarded: PineTS's broker emulator never received an order.
    const s = (ctx as unknown as { strategy: { closedtrades: unknown[]; opentrades: unknown[]; pending_orders: unknown[] } }).strategy;
    expect(s.closedtrades.length + s.opentrades.length + s.pending_orders.length).toBe(0);
  });

  it('captures KyberSwing equity-sized entries and stop-only exits (probe 08)', async () => {
    const { calls } = await runScript(probeSource('08-kyberswing'), candles, { provider: true, broker: () => FLAT_10K });
    const entry = ofMethod(calls, 'entry')[0]!;
    expect(entry.args).toMatchObject({ id: expect.stringMatching(/^(Long|Short)$/) });
    expect(entry.args.qty as number).toBeGreaterThan(0);
    // qty is capped at equity * maxLev / close, and the fed equity is 10,000.
    expect(entry.args.qty as number).toBeLessThanOrEqual((10_000 * 3) / candles[entry.bar]!.close + 1e-9);
    const exits = ofMethod(calls, 'exit');
    expect(exits.some((c) => c.args.id === 'L-X' && c.args.from_entry === 'Long' && 'stop' in c.args && c.args.limit === undefined)).toBe(true);
  });
});

const FLAT_10K: BrokerView = { position_size: 0, position_avg_price: NaN, equity: 10_000, netprofit: 0, openprofit: 0, opentrades: [] };

describe('Q2 broker state', () => {
  it('feeds position_size / position_avg_price / equity / opentrades / netprofit from our broker (probe 04)', async () => {
    const view = (bar: number): BrokerView => ({
      position_size: bar % 7 === 0 ? 0 : 0.25,
      position_avg_price: 12_345 + bar,
      equity: 20_000 + bar,
      netprofit: 1_000 + bar,
      openprofit: 0,
      opentrades: bar % 7 === 0 ? [] : [{ id: 'L', size: 0.25, entry_price: 12_345 + bar, entry_bar_index: bar - 1, entry_time: 0 }],
    });
    const slice = candles.slice(0, 300);
    const { ctx, calls } = await runScript(probeSource('04-equity-sizing'), slice, { broker: view });
    const pos = plot(ctx, 'pos');
    const n = pos.length;
    expect(n).toBe(300);
    for (let i = 0; i < n; i++) {
      const v = view(i);
      expect(pos[i]).toBe(v.position_size);
      expect(plot(ctx, 'avg')[i]).toBe(v.position_avg_price);
      expect(plot(ctx, 'equity')[i]).toBe(v.equity);
      expect(plot(ctx, 'netprofit')[i]).toBe(v.netprofit);
      expect(plot(ctx, 'opentrades')[i]).toBe(v.opentrades.length);
      if (i > 0) expect(plot(ctx, 'posPrev')[i]).toBe(view(i - 1).position_size); // strategy.position_size[1]
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

  it('a script reading strategy.opentrades sees our open-trade count (probe 03)', async () => {
    const slice = candles.slice(0, 200);
    const { ctx, calls } = await runScript(probeSource('03-pyramiding'), slice, {
      broker: (bar) => ({ ...FLAT_10K, position_size: 0.03, opentrades: bar < 100 ? [] : [1, 2, 3].map((k) => ({ id: 'L', size: 0.01, entry_price: 1, entry_bar_index: k, entry_time: 0 })) }),
    });
    expect(plot(ctx, 'opentrades').slice(100).every((v) => v === 3)).toBe(true);
    expect(ofMethod(calls, 'entry').every((c) => c.bar < 100)).toBe(true); // "opentrades < 3" gate used our count
  });
});

describe('Q3 bar-by-bar running', () => {
  it('runs one bar at a time with state kept, matching a full run (probe 01, 1,000 bars)', async () => {
    const bars = candles.slice(2000, 3000);
    const src = probeSource('01-ma-cross').replace('time >= timestamp("UTC", 2024, 1, 1, 0, 0)', 'true');
    const full = await runScript(src, bars);
    const stepper = await createStepper(src);
    const t0 = performance.now();
    for (const c of bars) await stepper.push(c);
    const usPerBar = ((performance.now() - t0) * 1000) / bars.length;
    console.log(`[Q3] stepped probe 01: ${usPerBar.toFixed(1)} us/bar over ${bars.length} bars`);
    expect(stepper.calls).toEqual(full.calls);
    expect(stepper.calls.length).toBeGreaterThan(0);
    expect(usPerBar).toBeLessThan(5_000);
  });

  it('steps KyberSwing (daily request.security) bar by bar with the same order calls as a full run', async () => {
    const bars = candles.slice(0, 3000);
    const broker = () => FLAT_10K;
    const full = await runScript(probeSource('08-kyberswing'), bars, { provider: true, broker });
    const stepper = await createStepper(probeSource('08-kyberswing'), { provider: true, broker, htfRefresh: 'day-boundary' });
    const t0 = performance.now();
    for (const c of bars) await stepper.push(c);
    console.log(`[Q3] stepped KyberSwing: ${(((performance.now() - t0) * 1000) / bars.length).toFixed(1)} us/bar over ${bars.length} bars`);
    expect(ofMethod(stepper.calls, 'entry').length).toBeGreaterThan(0);
    expect(stepper.calls).toEqual(full.calls);
  }, 120_000);
});

describe('Q4 saving state', () => {
  // Context holds closures (namespace methods bound to the context), class instances and the
  // transpiled function: neither structuredClone nor v8.serialize can copy it.
  it.fails('serialises per-bar state with structuredClone', async () => {
    const { ctx } = await runScript(probeSource('01-ma-cross'), candles.slice(0, 200));
    expect(() => structuredClone(ctx)).not.toThrow();
  });
  it.fails('serialises per-bar state with v8.serialize', async () => {
    const { ctx } = await runScript(probeSource('01-ma-cross'), candles.slice(0, 200));
    expect(() => serialize(ctx)).not.toThrow();
  });
  it('rebuilds state by replaying 1,000 bars deterministically', async () => {
    const bars = candles.slice(0, 1000);
    const a = await runScript(probeSource('01-ma-cross').replace('time >= timestamp("UTC", 2024, 1, 1, 0, 0)', 'true'), bars);
    const t0 = performance.now();
    const b = await runScript(probeSource('01-ma-cross').replace('time >= timestamp("UTC", 2024, 1, 1, 0, 0)', 'true'), bars);
    const ms = performance.now() - t0;
    console.log(`[Q4] 1,000-bar replay rebuild: ${ms.toFixed(1)} ms`);
    expect(b.calls).toEqual(a.calls);
    expect(ms).toBeLessThan(5_000);
  });
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
    let checked = 0;
    for (let i = 12; i < bars.length; i++) {
      const e = expected(closes, bars[i]!.openTime);
      expect(prevOn[i]).toBe(e.prevOn);
      expect(def[i]).toBe(e.default);
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

  it('gives TradingView non-repainting and default-lookahead values when a provider serves daily candles', async () => {
    const bars = candles.slice(0, 1500);
    const { ctx } = await runScript(probeSource('05-mtf-daily'), bars, { provider: true });
    check(ctx, bars);
  });

  // PineTS's own tail refresh (dataVersion bump -> updateTail) keeps returning stale daily values:
  // its rollback truncates Series state but not the plain `params` arrays the values are read from.
  it.fails('gives TradingView daily values bar by bar via PineTS updateTail', async () => {
    const bars = candles.slice(0, 300);
    const stepper = await createStepper(probeSource('05-mtf-daily'), { provider: true, htfRefresh: 'updateTail' });
    for (const c of bars) await stepper.push(c);
    check(stepper.context()!, bars, 250);
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

  it('serves KyberSwing its tuple request [close[1], ema[1], ema[1]] (no NaN after warm-up)', async () => {
    const bars = candles;
    const { ctx } = await runScript(probeSource('08-kyberswing'), bars, { provider: true, broker: () => FLAT_10K });
    expect(ctx.plots['Breakout high']).toBeDefined();
    const { calls } = await runScript(probeSource('08-kyberswing'), bars, { provider: true, broker: () => FLAT_10K });
    expect(ofMethod(calls, 'entry').length).toBeGreaterThan(0); // regime filter needs the daily EMAs
  });
});

describe('Q6 validation', () => {
  it('reports syntax errors with a line number', () => {
    const r = compileCheck('//@version=6\nstrategy("s")\nx = ta.sma(close, 10\nplot(x)\n');
    expect(r.ok).toBe(false);
    expect(r.line).toBeGreaterThan(0);
  });

  it('flags unsupported request.* calls as runtime warnings (probe 07)', async () => {
    const { ctx } = await runScript(probeSource('07-unsupported'), candles.slice(0, 50));
    const methods = (ctx as unknown as { warnings: { method: string }[] }).warnings.map((w) => w.method);
    expect(methods).toEqual(expect.arrayContaining(['request.financial', 'request.economic']));
  });

  // Unknown functions surface only at run time as a JS TypeError, with no Pine line.
  it.fails('reports unknown functions at compile time with a line number', () => {
    const r = compileCheck('//@version=6\nstrategy("u")\na = 1\nx = ta.notafunction(close, 10)\nplot(x)\n');
    expect(r.ok).toBe(false);
    expect(r.line).toBe(4);
  });

  // Undeclared identifiers are rejected at compile time, but the message carries no position.
  it.fails('reports undeclared identifiers with a line number', () => {
    const r = compileCheck('//@version=6\nstrategy("v")\nplot(foo)\n');
    expect(r.ok).toBe(false);
    expect(r.line).toBe(3);
  });

  it('reads the declaration kind and its arguments (probes 06 and 01)', () => {
    const ind = declarationOf(probeSource('06-indicator'));
    expect(ind.kind).toBe('indicator');
    expect(ind.args).toMatchObject({ overlay: false, precision: 2 });
    const st = declarationOf(probeSource('01-ma-cross'));
    expect(st.kind).toBe('strategy');
    expect(st.args).toMatchObject({ initial_capital: 10000, default_qty_type: 'percent_of_equity', default_qty_value: 100, commission_value: 0.05, pyramiding: 0 });
  });

  // PineTS only knows 'indicator' | 'strategy'; a library() script reads as null.
  it.fails('recognises library() declarations', () => {
    expect(declarationOf('//@version=6\nlibrary("MyLib")\nexport f(float x) => x * 2\n').kind).toBe('library');
  });
});

describe('Q7 sandboxing', () => {
  it('loads the PineTS bundle and runs probe 01 inside an isolated-vm isolate', async () => {
    const bars = candles.slice(0, 2000);
    const r = await runInIsolate(probeSource('01-ma-cross').replace('time >= timestamp("UTC", 2024, 1, 1, 0, 0)', 'true'), bars);
    const outside = await runScript(probeSource('01-ma-cross').replace('time >= timestamp("UTC", 2024, 1, 1, 0, 0)', 'true'), bars, { forward: true });
    const s = (outside.ctx as unknown as { strategy: { closedtrades: unknown[]; netprofit: number } }).strategy;
    console.log(`[Q7] isolate heap used ${(r.heapUsedBytes / 1e6).toFixed(1)} MB, total ${(r.heapTotalBytes / 1e6).toFixed(1)} MB`);
    expect(r.closedTrades).toBe(s.closedtrades.length);
    expect(r.netprofit).toBeCloseTo(s.netprofit, 6);
    expect(r.heapUsedBytes).toBeGreaterThan(0);
  });
});

describe('Q8 PineTS emulator results', () => {
  const ref = JSON.parse(readFileSync('tests/fixtures/tv-reference.json', 'utf8')) as Record<string, unknown>;

  it('records the emulator stats for probe 01 (TradingView numbers pending)', async () => {
    const { ctx } = await runScript(probeSource('01-ma-cross'), candles, { provider: true, forward: true });
    const st = emulatorStats(ctx, MA_CROSS_WINDOW);
    console.log('[Q8] probe 01 PineTS emulator:', JSON.stringify(st), 'TV:', JSON.stringify(ref['ma-cross']));
    expect(st.trades).toBeGreaterThan(0);
    expect(Number.isFinite(st.profitFactor)).toBe(true);
  });

  it('records the emulator stats for KyberSwing next to the owner TradingView numbers (evidence only)', async () => {
    const { ctx } = await runScript(probeSource('08-kyberswing'), candles, {
      provider: true,
      forward: (c) => c.time >= KYBER_WINDOW.from && c.time < KYBER_WINDOW.to,
    });
    const st = emulatorStats(ctx, KYBER_WINDOW);
    console.log('[Q8] KyberSwing PineTS emulator:', JSON.stringify(st), 'TV:', JSON.stringify(ref['kyber-swing']));
    expect(ref['kyber-swing']).toEqual({ trades: 58, winRatePct: 32.8, profitFactor: 1.71, netProfitPct: 22.6 });
    expect(st.trades).toBeGreaterThan(0);
  });
});
