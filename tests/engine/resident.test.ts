// The resident strategy engine (src/engine/resident.ts): one PineTS instance per (run, pair), warm-started
// once and stepped one closed bar at a time through the same BarHooks the replay uses.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import type { Candle, PairRules } from '../../src/core/types.js';
import { loadCandles } from '../../src/data/csv.js';
import { aggregateCandles } from '../../src/engine/memory-provider.js';
import { compileScript, type BarHooks, type PineOrderCall } from '../../src/engine/pine-runner.js';
import { barHooks, replay, splitOverfills, tvPropertiesOf } from '../../src/engine/replay.js';
import { ResidentInstance, ResidentStrategy, scriptBounds } from '../../src/engine/resident.js';
import { StrategyLayer } from '../../src/engine/strategy-layer.js';

const rules = JSON.parse(readFileSync('tests/fixtures/BTCUSDT-rules.json', 'utf8')) as PairRules;
const kyber = readFileSync('tests/fixtures/KyberSwing.pine', 'utf8');
const probe01 = readFileSync('spike/probes/01-ma-cross.pine', 'utf8');

const fetchSpy = vi.fn(() => {
  throw new Error('network access attempted in engine tests');
});
let candles: Candle[];
beforeAll(() => {
  vi.stubGlobal('fetch', fetchSpy);
  candles = loadCandles('tests/fixtures/BTCUSDT_4h.csv', '4h');
});
afterAll(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const flatHooks = (equity = 10_000): BarHooks => ({ before: () => StrategyLayer.flatView(equity), after: () => {} });

describe('resident stepping', () => {
  it('resident stepping equals replay: KyberSwing, 3,000-bar warm start, then every later bar stepped through barHooks', { timeout: 240_000 }, async () => {
    // The warm start begins at bar 500 (08:00 UTC: mid-day, so the first daily bar is a partial one).
    const START = 500;
    const WARM = 3_000;
    const window = candles.slice(START);
    const history = window.slice(0, WARM);
    const from = window[WARM]!.openTime;
    const to = window.at(-1)!.openTime;

    const compiled = await compileScript(kyber, '4h', 'BTCUSDT');
    if (!compiled.ok) throw new Error('KyberSwing does not compile');
    const tv = tvPropertiesOf(compiled.declaration);
    const declaration = { ...compiled.declaration, overridden: { initialCapital: tv.initialCapital, commission: tv.commissionPct, slippage: tv.slippageTicks } };
    const fees = { makerRate: tv.commissionPct / 100, takerRate: tv.commissionPct / 100, slippagePct: 0, slippageTicks: tv.slippageTicks };
    const sizing = { kind: 'script' as const };
    const broker = new PaperBroker({ startingBalance: tv.initialCapital, fees, mode: 'tradingview', rules: () => rules, sizing });
    const layer = new StrategyLayer(declaration, broker, 'BTCUSDT', sizing, { rules, from });
    const equity: { time: number; equity: number }[] = [];
    const hooks = barHooks({
      broker,
      layer,
      symbol: 'BTCUSDT',
      tf: '4h',
      mode: 'tradingview',
      from,
      funding: [],
      processOrdersOnClose: declaration.processOrdersOnClose === true,
      warmupEquity: tv.initialCapital,
      onBarDone: (bar) => equity.push({ time: bar.openTime, equity: broker.account().equity }),
    });

    const bounds = scriptBounds(kyber);
    if ('error' in bounds) throw new Error(bounds.error);
    const htf = Object.fromEntries(compiled.securityTimeframes.map((t) => [t, aggregateCandles(history, t)]));
    const inst = await ResidentStrategy.create({ source: kyber, symbol: 'BTCUSDT', tf: '4h', rules, history, htf, hooks, ...bounds });
    expect(equity).toHaveLength(0); // warm-up bars are not traded
    for (const bar of window.slice(WARM)) await inst.step(bar);
    inst.dispose();

    const r = await replay({ source: kyber, symbol: 'BTCUSDT', tf: '4h', candles: window, funding: [], from, to, mode: 'tradingview', rules, startingBalance: 10_000, sizing });
    const mine = splitOverfills(broker.closedTrades().filter((t) => t.symbol === 'BTCUSDT'), layer.attributions());
    if (process.env.RESIDENT_LOG) console.log(`[resident] trades ${mine.trades.length} vs replay ${r.trades.length}; equity ${equity.at(-1)!.equity} vs ${r.equityCurve.at(-1)!.equity}`);
    expect(r.trades.length).toBeGreaterThan(20); // not vacuous: real positions opened and closed
    expect(mine.trades).toEqual(r.trades);
    expect(mine.overfills).toEqual(r.overfills);
    expect(equity).toEqual(r.equityCurve);
    expect(broker.position('BTCUSDT')).toEqual(r.openPosition);
    expect(broker.account()).toEqual(r.account);
  });

  it('trimmed instance stays bounded: after 2,000 steps every history buffer is within keep + slack', { timeout: 120_000 }, async () => {
    const bounds = scriptBounds(kyber);
    if ('error' in bounds) throw new Error(bounds.error);
    const { keep, htfKeep } = bounds;
    const history = candles.slice(0, 500);
    const inst = await ResidentStrategy.create({
      source: kyber,
      symbol: 'BTCUSDT',
      tf: '4h',
      rules,
      history,
      htf: { D: aggregateCandles(history, 'D') },
      hooks: flatHooks(),
      keep,
      htfKeep,
    });
    for (const bar of candles.slice(500, 2_500)) await inst.step(bar);
    const h = inst.held();
    inst.dispose();
    // The default slack is keep (htfKeep in request.security contexts): a buffer is cut back once it holds 2 x keep.
    expect(h.bars).toBe(2_500);
    expect(h.chartBars).toBeLessThanOrEqual(2 * keep);
    expect(h.chartSlots).toBeLessThanOrEqual(2 * keep);
    expect(h.longestBuffer).toBeLessThanOrEqual(2 * keep + 1);
    expect(h.htfBars).toBeGreaterThan(0);
    expect(h.htfBars).toBeLessThanOrEqual(2 * htfKeep);
    expect(h.longestHtfBuffer).toBeLessThanOrEqual(2 * htfKeep + 1);
    expect(h.storeChart).toBeLessThanOrEqual(2 * keep);
    expect(h.storeHtf).toBeLessThanOrEqual(2 * htfKeep);
    expect(h.taSlots).toBeLessThanOrEqual(512);
  });

  it('a higher-timeframe bar is built from the stepped chart bars exactly as MemoryProvider aggregates them, and closes on its boundary', { timeout: 60_000 }, async () => {
    // lookahead_on with close[1]: the last completed day; without an offset: the day so far (every stepped bar is the last).
    const src = [
      '//@version=6',
      'strategy("htf")',
      'prevOn = request.security(syminfo.tickerid, "D", close[1], lookahead = barmerge.lookahead_on)',
      'dayHigh = request.security(syminfo.tickerid, "D", high, lookahead = barmerge.lookahead_on)',
      'if close > prevOn',
      '    strategy.entry("L", strategy.long)',
      'if close < prevOn',
      '    strategy.close("L")',
      'plot(prevOn, "prevOn")',
      'plot(dayHigh, "dayHigh")',
      '',
    ].join('\n');
    const all = candles.slice(0, 700);
    const history = all.slice(0, 200);
    const seen: { idx: number; calls: PineOrderCall[] }[] = [];
    const hooks: BarHooks = { before: () => StrategyLayer.flatView(10_000), after: (_b, idx, calls) => seen.push({ idx, calls }) };
    const inst = await ResidentStrategy.create({ source: src, symbol: 'BTCUSDT', tf: '4h', rules, history, htf: { D: aggregateCandles(history, 'D') }, hooks, keep: 100, htfKeep: 50 });
    const last = (name: string) => inst.lastPlot(name);
    for (let i = 200; i < all.length; i++) {
      await inst.step(all[i]!);
      const days = aggregateCandles(all.slice(0, i + 1), 'D');
      expect(last('dayHigh')).toBe(days.at(-1)!.high);
      expect(last('prevOn')).toBe(days.at(-2)!.close);
    }
    inst.dispose();
    // One before/after pair per bar, warm-up included, in order.
    expect(seen.map((s) => s.idx)).toEqual(all.map((_, i) => i));
    expect(seen.some((s) => s.calls.length > 0)).toBe(true);
  });

  it('a stepped bar must follow the last one', { timeout: 60_000 }, async () => {
    const history = candles.slice(0, 100);
    const inst = await ResidentStrategy.create({ source: probe01, symbol: 'BTCUSDT', tf: '4h', rules, history, htf: {}, hooks: flatHooks(), keep: 100, htfKeep: 50 });
    await expect(inst.step(candles[101]!)).rejects.toThrow(/does not follow/);
    inst.dispose();
    await expect(inst.step(candles[100]!)).rejects.toThrow(/disposed/);
  });

  it('instances are created one at a time: concurrent create() calls are serialised', { timeout: 120_000 }, async () => {
    const original = ResidentInstance.create.bind(ResidentInstance);
    let active = 0;
    let most = 0;
    const spy = vi.spyOn(ResidentInstance, 'create').mockImplementation(async (...a: Parameters<typeof ResidentInstance.create>) => {
      most = Math.max(most, ++active);
      try {
        return await original(...a);
      } finally {
        active--;
      }
    });
    try {
      const history = candles.slice(0, 300);
      const make = (source: string) => ResidentStrategy.create({ source, symbol: 'BTCUSDT', tf: '4h', rules, history, htf: { D: aggregateCandles(history, 'D') }, hooks: flatHooks(), keep: 100, htfKeep: 50 });
      // A failing create does not stall the queue.
      const results = await Promise.allSettled([make(kyber), make(probe01), make('//@version=6\nstrategy("bad")\nx = nope()\n'), make(kyber)]);
      // The bad script fails at its transpile, before an instance is created.
      expect(spy).toHaveBeenCalledTimes(3);
      expect(most).toBe(1);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
      // The two KyberSwing instances share one transpiled script and still step independently.
      const [a, b] = [results[0], results[3]].map((r) => (r as PromiseFulfilledResult<ResidentStrategy>).value);
      await a!.step(candles[300]!);
      await b!.step(candles[300]!);
      for (const r of results) if (r.status === 'fulfilled') r.value.dispose();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('scriptBounds', () => {
  const script = (...body: string[]) => ['//@version=6', 'strategy("s")', ...body, ''].join('\n');

  it('KyberSwing gets finite bounds', () => {
    const b = scriptBounds(kyber);
    expect(b).not.toHaveProperty('error');
    const { keep, htfKeep } = b as { keep: number; htfKeep: number };
    expect(Number.isFinite(keep) && Number.isFinite(htfKeep)).toBe(true);
    expect(keep).toBeGreaterThanOrEqual(100);
    expect(htfKeep).toBeGreaterThanOrEqual(50);
  });

  it('defaults to keep 100 / htfKeep 50, and is 3 x the longest literal offset above that', () => {
    expect(scriptBounds(script('plot(close)'))).toEqual({ keep: 100, htfKeep: 50 });
    expect(scriptBounds(script('x = close[50] - close [2]', 'plot(x)'))).toEqual({ keep: 150, htfKeep: 50 });
    expect(scriptBounds(script('d = request.security(syminfo.tickerid, "D", close[30])', 'plot(d)'))).toEqual({ keep: 100, htfKeep: 90 });
  });

  it('a request.security expression on a script variable or function takes the whole script\'s longest offset', () => {
    const b = scriptBounds(script('f() => close - close[40]', 'v = high[20]', 'd = request.security(syminfo.tickerid, "D", f())', 'plot(d + v)'));
    expect(b).toEqual({ keep: 120, htfKeep: 120 });
  });

  it('tuples, array types, strings and comments are not history references', () => {
    const b = scriptBounds(script('float[] xs = array.new<float>()', '[a, b] = request.security(syminfo.tickerid, "D", [close, open])', 's = "close[len]" // high[n]', 'plot(a + b)'));
    expect(b).toEqual({ keep: 100, htfKeep: 50 });
  });

  it('close[len] with an input len is rejected, naming its line', () => {
    expect(scriptBounds(script('len = input.int(5, "len")', 'plot(close[len])'))).toEqual({ error: 'history offset on line 4 cannot be bounded in v1' });
    expect(scriptBounds(script('plot(close[bar_index - 10])'))).toEqual({ error: 'history offset on line 3 cannot be bounded in v1' });
  });
});
