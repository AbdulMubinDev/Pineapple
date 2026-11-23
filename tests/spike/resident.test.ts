// Task 2b: resident instances with bounded history (spike/resident.ts). Correctness bar: with
// trimming, order calls equal a full run over 3,000+ bars, for KyberSwing and probe 01.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types.js';
import { BTCUSDT_PERP_SYMINFO, aggregateDaily, fixtureCandles, probeSource, recordEmulatorViews, runScript, type BrokerView, type OrderCall } from '../../spike/probe.js';
import { FeedStore, ResidentInstance, SharedScript } from '../../spike/resident.js';

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

const FLAT: BrokerView = { position_size: 0, position_avg_price: NaN, equity: 10_000, netprofit: 0, openprofit: 0, opentrades: [] };
const ungated = (n: string) => probeSource(n).replace('time >= timestamp("UTC", 2024, 1, 1, 0, 0)', 'true');
// A broker view that changes every bar, so read-backs matter.
const moving = (bar: number): BrokerView => ({ ...FLAT, equity: 10_000 + 3 * bar, netprofit: bar });

async function resident(src: string, bars: Candle[], warm: number, opts: { keep?: number; htfKeep?: number; slack?: number; broker?: (bar: number) => BrokerView }, script = new SharedScript(src)) {
  const store = new FeedStore('240', 14_400_000, BTCUSDT_PERP_SYMINFO, bars.slice(0, warm));
  const inst = await ResidentInstance.create(script, store, { broker: opts.broker ?? (() => FLAT), keep: opts.keep, htfKeep: opts.htfKeep, slack: opts.slack });
  const calls: OrderCall[] = inst.drain();
  for (const c of bars.slice(warm)) {
    store.append(c);
    await inst.step();
    calls.push(...inst.drain());
    // The shared candle store is bounded too once the instance is warm.
    if (opts.keep) store.trim(opts.keep, opts.htfKeep ?? opts.keep);
  }
  return { inst, calls, store };
}

describe('resident instances with bounded history', () => {
  it('probe 01: trimmed to 200 bars, 3,000 stepped bars give the same order calls as a full run over 3,500', async () => {
    const bars = candles.slice(0, 3500);
    const full = await runScript(ungated('01-ma-cross'), bars, { provider: true, broker: moving });
    const r = await resident(ungated('01-ma-cross'), bars, 500, { keep: 200, broker: moving });
    expect(r.calls.filter((c) => c.bar >= 500).length).toBeGreaterThan(50);
    expect(r.calls).toEqual(full.calls);
  }, 60_000);

  it('KyberSwing: trimmed to 100 chart bars and 50 daily bars, 8,008 stepped bars give the same order calls as a full run over 8,508', async () => {
    const bars = candles;
    const full = await runScript(probeSource('08-kyberswing'), bars, { provider: true, broker: moving });
    const r = await resident(probeSource('08-kyberswing'), bars, 500, { keep: 100, htfKeep: 50, broker: moving });
    expect(r.calls.filter((c) => c.method === 'entry' && c.bar >= 500).length).toBeGreaterThan(30);
    expect(r.calls).toEqual(full.calls);
    // Buffers really are bounded: main and daily contexts hold at most 2 x keep bars.
    const K = 100;
    const ctx = r.inst.ctx as unknown as { data: Record<string, { data: unknown[] }>; let: Record<string, { data?: unknown[] }>; cache: Record<string, { context?: { data: Record<string, { data: unknown[] }> }; pineTS?: { data: unknown[] } }> };
    expect(ctx.data.close!.data.length).toBeLessThanOrEqual(2 * K);
    for (const v of Object.values(ctx.let)) if (v?.data) expect(v.data.length).toBeLessThanOrEqual(2 * K + 1);
    const sec = Object.values(ctx.cache).find((v) => v?.context)!;
    expect(sec.context!.data.openTime!.data.length).toBeLessThanOrEqual(100);
    expect((r.inst as unknown as { chart: { buf: unknown[] }[] }).chart[0]!.buf.length).toBeLessThanOrEqual(2 * K);
  }, 120_000);

  it('KyberSwing, tight bounds (60 chart bars + 20 slack, 10 daily bars): same order calls as the full run over 8,508 bars', async () => {
    // KyberSwing's longest chart lookback is ta.highest(close, 55)[1] = 56 bars; inside the daily
    // request only close[1] / ema[1]. EMA/ATR/DMI recursion lives in taState, not in these buffers.
    const full = await runScript(probeSource('08-kyberswing'), candles, { provider: true, broker: moving });
    const r = await resident(probeSource('08-kyberswing'), candles, 500, { keep: 60, htfKeep: 10, slack: 20, broker: moving });
    expect(r.calls).toEqual(full.calls);
  }, 120_000);

  it('the bound must cover the longest series lookback: close[50] works with keep 60, breaks with keep 30', async () => {
    // KyberSwing is not this test: its windows (ta.highest(close, 55)) live in taState, and its
    // series lookbacks are [1], so even keep 30 reproduces it. An explicit close[50] is not.
    const src = [
      '//@version=6',
      'strategy("lb")',
      'if close > close[50]',
      '    strategy.entry("L", strategy.long)',
      'if close < close[50]',
      '    strategy.close("L")',
      '',
    ].join('\n');
    const bars = candles.slice(0, 3500);
    const full = await runScript(src, bars, { provider: true, broker: moving });
    expect((await resident(src, bars, 500, { keep: 60, slack: 20, broker: moving })).calls).toEqual(full.calls);
    expect((await resident(src, bars, 500, { keep: 30, slack: 5, broker: moving })).calls).not.toEqual(full.calls);
  }, 60_000);

  it('ta window buffers, highest/lowest deques, alerts and the candle store stay bounded while stepping', async () => {
    const bars = candles.slice(0, 3000);
    const { inst, store } = await resident(probeSource('08-kyberswing'), bars, 500, { keep: 60, htfKeep: 10, slack: 20, broker: moving });
    expect(store.chart.length).toBeLessThanOrEqual(120);
    expect(store.daily.length).toBeLessThanOrEqual(20);
    const ctx = inst.ctx as unknown as { taState: Record<string, Record<string, unknown>>; alerts: unknown[]; marketData: { openTime: number }[] };
    let histories = 0;
    let deques = 0;
    for (const s of Object.values(ctx.taState)) {
      for (const x of Object.values(s)) {
        const o = x as { v?: unknown; idx?: unknown[]; head?: number; start?: number; end?: number };
        if (o?.v instanceof Float64Array) {
          histories++;
          expect(o.v.length).toBeLessThanOrEqual(512); // PineTS alone: up to 5,000+ entries per buffer
          expect(o.end! - o.start!).toBeLessThanOrEqual(2 * 56 + 2);
        } else if (Array.isArray(o?.idx)) {
          deques++;
          expect(o.idx!.length).toBeLessThanOrEqual(200);
        }
      }
    }
    expect(histories).toBeGreaterThan(5);
    expect(deques).toBeGreaterThan(5);
    expect(ctx.alerts.length).toBeLessThanOrEqual(8);
    // Absolute bar indexes still work on the sliding chart arrays; bar 0 stays readable.
    expect(ctx.marketData.length).toBe(3000);
    expect(ctx.marketData[0]!.openTime).toBe(bars[0]!.openTime);
    expect(ctx.marketData[2999]!.openTime).toBe(bars[2999]!.openTime);
    expect(ctx.marketData[1000]).toBeUndefined();
  }, 60_000);

  it('KyberSwing untrimmed resident (incremental daily via fixed updateTail) equals the full run too', async () => {
    const bars = candles.slice(0, 3500);
    const full = await runScript(probeSource('08-kyberswing'), bars, { provider: true, broker: moving });
    const r = await resident(probeSource('08-kyberswing'), bars, 500, { broker: moving });
    expect(r.calls).toEqual(full.calls);
  }, 60_000);

  it('daily values (lookahead_on close[1], default close, tuple) stay TradingView-correct with trimming (probe 05)', async () => {
    const bars = candles.slice(0, 2000);
    const { inst } = await resident(probeSource('05-mtf-daily'), bars, 100, { keep: 50 });
    // Plots are trimmed too, so compare the last bar; and run the whole range against the full run.
    const full = await runScript(probeSource('05-mtf-daily'), bars, { provider: true });
    const last = (ctx: unknown, name: string) => {
      const d = (ctx as { plots: Record<string, { data: { value: unknown }[] }> }).plots[name]!.data;
      return d[d.length - 1]!.value;
    };
    for (const p of ['prevOn', 'default', 'tupleClose', 'tupleEma']) expect(last(inst.ctx, p)).toBe(last(full.ctx, p));
    const day = (t: number) => Math.floor(t / 86_400_000) * 86_400_000;
    const prev = aggregateDaily(bars).find((d) => d.openTime === day(bars[bars.length - 1]!.openTime) - 86_400_000)!;
    expect(last(inst.ctx, 'prevOn')).toBe(prev.close);
  }, 60_000);

  it('per-bar daily values match the full run on every stepped bar with trimming (probe 05, keep 50)', async () => {
    const bars = candles.slice(0, 1200);
    const full = await runScript(probeSource('05-mtf-daily'), bars, { provider: true });
    const store = new FeedStore('240', 14_400_000, BTCUSDT_PERP_SYMINFO, bars.slice(0, 100));
    const inst = await ResidentInstance.create(new SharedScript(probeSource('05-mtf-daily')), store, { broker: () => FLAT, keep: 50 });
    const plotsOf = (ctx: unknown) => (ctx as { plots: Record<string, { data: { value: unknown }[] }> }).plots;
    for (let i = 100; i < bars.length; i++) {
      store.append(bars[i]!);
      await inst.step();
      for (const p of ['prevOn', 'default', 'tupleClose', 'tupleEma']) {
        const d = plotsOf(inst.ctx)[p]!.data;
        expect(d[d.length - 1]!.value).toBe(plotsOf(full.ctx)[p]!.data[i]!.value);
      }
    }
  }, 60_000);

  it('one SharedScript (one transpile) serves several instances, each equal to its own full run', async () => {
    const bars = candles.slice(0, 3200);
    const script = new SharedScript(probeSource('08-kyberswing'));
    const brokers = [moving, (bar: number) => ({ ...FLAT, equity: 50_000 - bar })];
    const fulls = await Promise.all(brokers.map((b) => runScript(probeSource('08-kyberswing'), bars, { provider: true, broker: b })));
    const store = new FeedStore('240', 14_400_000, BTCUSDT_PERP_SYMINFO, bars.slice(0, 200));
    const insts = [];
    for (const b of brokers) insts.push(await ResidentInstance.create(script, store, { broker: b, keep: 200 }));
    const calls: OrderCall[][] = insts.map((i) => i.drain());
    for (const c of bars.slice(200)) {
      store.append(c);
      for (let k = 0; k < insts.length; k++) {
        await insts[k]!.step();
        calls[k]!.push(...insts[k]!.drain());
      }
    }
    expect(calls[0]).toEqual(fulls[0]!.calls);
    expect(calls[1]).toEqual(fulls[1]!.calls);
    expect(calls[0]).not.toEqual(calls[1]); // different equity -> different qty
  }, 120_000);
});

// A scripted broker: per bar, the read-backs PineTS's own emulator gave this script in a full run
// with every order forwarded. Replayed into a hooked run, the script holds real positions.
describe('resident instances with a scripted broker (real positions)', () => {
  let kyberViews: BrokerView[];
  beforeAll(async () => {
    kyberViews = await recordEmulatorViews(probeSource('08-kyberswing'), candles);
  }, 60_000);

  const inPositionStats = (calls: OrderCall[], views: BrokerView[]) => {
    const barsInPosition = views.filter((v) => v.position_size !== 0).length;
    let opens = 0;
    let closes = 0;
    for (let i = 1; i < views.length; i++) {
      if (views[i - 1]!.position_size === 0 && views[i]!.position_size !== 0) opens++;
      if (views[i - 1]!.position_size !== 0 && views[i]!.position_size === 0) closes++;
    }
    // Stop ratchet: the exit's stop changes from bar to bar while a position is held.
    let ratchets = 0;
    let prev: number | undefined;
    for (const c of calls) {
      const pos = views[c.bar]!.position_size;
      if (c.method !== 'exit' || pos === 0) continue;
      if ((c.args.id === 'L-X' && pos > 0) || (c.args.id === 'S-X' && pos < 0)) {
        const stop = c.args.stop as number;
        if (prev !== undefined && Number.isFinite(stop) && stop !== prev) ratchets++;
        prev = stop;
      }
    }
    return { barsInPosition, opens, closes, ratchets };
  };

  it('KyberSwing, tight bounds (60 + 20 slack, daily 10): same order calls as the full run over 8,508 bars while holding real positions', async () => {
    const broker = (bar: number) => kyberViews[bar]!;
    const full = await runScript(probeSource('08-kyberswing'), candles, { provider: true, broker });
    const r = await resident(probeSource('08-kyberswing'), candles, 500, { keep: 60, htfKeep: 10, slack: 20, broker });
    const st = inPositionStats(full.calls, kyberViews);
    if (process.env.SPIKE_LOG) console.log('[2b] scripted KyberSwing:', JSON.stringify({ ...st, calls: full.calls.length }));
    expect(st.opens).toBeGreaterThan(50); // positions opened ...
    expect(st.closes).toBeGreaterThan(50); // ... and closed by the exits
    expect(st.barsInPosition).toBeGreaterThan(1000);
    expect(st.ratchets).toBeGreaterThan(100); // the in-position trailing-stop branch ran
    expect(r.calls.length).toBe(full.calls.length);
    expect(r.calls).toEqual(full.calls);
  }, 180_000);

  it('KyberSwing matches even at keep 30 (+5 slack, daily 10): its windows live in taState, its series lookbacks are [1]', async () => {
    const broker = (bar: number) => kyberViews[bar]!;
    const bars = candles.slice(0, 4000);
    const full = await runScript(probeSource('08-kyberswing'), bars, { provider: true, broker });
    const r = await resident(probeSource('08-kyberswing'), bars, 500, { keep: 30, htfKeep: 10, slack: 5, broker });
    expect(r.calls).toEqual(full.calls);
  }, 120_000);

  it('probe 01 with its own emulator fills replayed, trimmed to 200 bars: same calls over 3,500 bars', async () => {
    const bars = candles.slice(0, 3500);
    const views = await recordEmulatorViews(ungated('01-ma-cross'), bars);
    expect(views.filter((v) => v.position_size !== 0).length).toBeGreaterThan(1000);
    const broker = (bar: number) => views[bar]!;
    const full = await runScript(ungated('01-ma-cross'), bars, { provider: true, broker });
    const r = await resident(ungated('01-ma-cross'), bars, 500, { keep: 200, broker });
    expect(r.calls).toEqual(full.calls);
  }, 120_000);

  it('user-function scope (lctx) buffers and plot data are trimmed too, with identical calls', async () => {
    const src = [
      '//@version=6',
      'strategy("fn")',
      'f(float src, int n) =>',
      '    d = src - src[n]',
      '    d[1]',
      'v = f(close, 10)',
      'if v > 0',
      '    strategy.entry("L", strategy.long)',
      'if v < 0',
      '    strategy.close("L")',
      'plot(v, "v")',
      '',
    ].join('\n');
    const bars = candles.slice(0, 3000);
    const full = await runScript(src, bars, { provider: true, broker: moving });
    const r = await resident(src, bars, 300, { keep: 20, slack: 10, broker: moving });
    expect(r.calls.length).toBeGreaterThan(100);
    expect(r.calls).toEqual(full.calls);
    type Scope = Record<string, { data?: unknown[] } | unknown[]>;
    const ctx = r.inst.ctx as unknown as { lctx: Map<string, Record<string, Scope | undefined>>; plots: Record<string, { data: unknown[] }> };
    let lctxBuffers = 0;
    ctx.lctx.forEach((c) => {
      for (const scope of ['var', 'let', 'const', 'params']) {
        for (const item of Object.values(c[scope] ?? {})) {
          const arr = Array.isArray(item) ? item : item.data;
          if (!arr) continue;
          lctxBuffers++;
          expect(arr.length).toBeLessThanOrEqual(31);
        }
      }
    });
    expect(lctxBuffers).toBeGreaterThan(0);
    for (const p of Object.values(ctx.plots)) if (Array.isArray(p.data)) expect(p.data.length).toBeLessThanOrEqual(8);
  }, 60_000);

  it('stepping makes every bar the last, realtime bar: islast/isrealtime true, ishistory false, isconfirmed true', async () => {
    const src = [
      '//@version=6',
      'strategy("bs")',
      'plot(barstate.islast ? 1 : 0, "islast")',
      'plot(barstate.isrealtime ? 1 : 0, "rt")',
      'plot(barstate.ishistory ? 1 : 0, "hist")',
      'plot(barstate.isconfirmed ? 1 : 0, "conf")',
      '',
    ].join('\n');
    const bars = candles.slice(0, 300);
    const full = await runScript(src, bars, { provider: true, broker: moving });
    const col = (ctx: unknown, n: string) => (ctx as { plots: Record<string, { data: { value: unknown }[] }> }).plots[n]!.data.map((d) => d.value);
    expect(col(full.ctx, 'islast').slice(0, -1).every((v) => v === 0)).toBe(true); // full run: only the last bar
    const store = new FeedStore('240', 14_400_000, BTCUSDT_PERP_SYMINFO, bars.slice(0, 100));
    const inst = await ResidentInstance.create(new SharedScript(src), store, { broker: moving, keep: 50 });
    for (const c of bars.slice(100)) {
      store.append(c);
      await inst.step();
      const last = (n: string) => col(inst.ctx, n).at(-1);
      expect([last('islast'), last('rt'), last('hist'), last('conf')]).toEqual([1, 1, 0, 1]);
    }
  }, 60_000);
});
