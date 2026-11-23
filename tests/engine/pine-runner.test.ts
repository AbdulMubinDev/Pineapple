import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/core/types.js';
import { loadCandles } from '../../src/data/csv.js';
import type { BrokerView } from '../../src/engine/hook-core.js';
import { compileScript, runStrategy, toPineOrderCall, type PineOrderCall } from '../../src/engine/pine-runner.js';
import type { ScriptView } from '../../src/engine/strategy-layer.js';
import { recordEmulatorViews, runScript } from '../../spike/probe.js';

const probe = (name: string) => readFileSync(`spike/probes/${name}.pine`, 'utf8');
const KYBER = readFileSync('tests/fixtures/KyberSwing.pine', 'utf8');
const SYMINFO = { mintick: 0.1, qtyStep: 0.001 };

// No network: any fetch fails loudly, and none may be attempted.
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

const FLAT: ScriptView = { positionSize: 0, positionAvgPrice: NaN, equity: 10_000, openTrades: 0, netProfit: 0, openProfit: 0, opentrades: [] };

/** A spike broker view in the engine's ScriptView shape. */
const fromBrokerView = (v: BrokerView): ScriptView => ({
  positionSize: v.position_size,
  positionAvgPrice: v.position_avg_price,
  equity: v.equity,
  openTrades: v.opentrades.length,
  netProfit: v.netprofit,
  openProfit: v.openprofit,
  opentrades: v.opentrades.map((t) => ({
    size: t.size,
    entryPrice: t.entry_price,
    entryId: t.id,
    entryBarIndex: t.entry_bar_index,
    entryTime: t.entry_time,
    profit: t.profit ?? 0,
  })),
});

describe('compileScript', () => {
  it('compileScript rejects indicator with exact message', async () => {
    const r = await compileScript(probe('06-indicator'));
    expect(r).toEqual({ ok: false, errors: [{ line: 3, message: 'v1 runs strategy() scripts only.' }] });
    const lib = await compileScript('//@version=6\nlibrary("MyLib")\nexport f(float x) => x * 2\n');
    expect(lib).toEqual({ ok: false, errors: [{ line: 2, message: 'v1 runs strategy() scripts only.' }] });
  });

  it('compileScript reports unsupported function with line number', async () => {
    const r = await compileScript(probe('07-unsupported'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([
      { line: 5, message: 'request.financial is not supported in v1' },
      { line: 7, message: 'request.economic is not supported in v1' },
      { line: 8, message: 'request.seed is not supported in v1' },
      { line: 9, message: 'request.dividends is not supported in v1' },
    ]);
    // An unknown function only fails at run time; the line is found by us.
    const u = await compileScript('//@version=6\nstrategy("u")\na = 1\nx = ta.notafunction(close, 10)\nplot(x)\n');
    expect(u).toEqual({ ok: false, errors: [{ line: 4, message: 'ta.notafunction is not a function' }] });
  });

  it('compileScript rejects unfed read-back', async () => {
    const src = '//@version=6\nstrategy("w")\n// strategy.grossprofit in a comment is fine\nplot(strategy.wintrades)\nplot(strategy.opentrades.size(0))\n';
    expect(await compileScript(src)).toEqual({ ok: false, errors: [{ line: 4, message: 'strategy.wintrades is not supported in v1' }] });
    const more = await compileScript('//@version=6\nstrategy("w")\nx = strategy.closedtrades.profit(0)\ny = strategy.opentrades.commission(0)\nplot(x + y)\n');
    expect(more).toEqual({
      ok: false,
      errors: [
        { line: 3, message: 'strategy.closedtrades.profit is not supported in v1' },
        { line: 4, message: 'strategy.opentrades.commission is not supported in v1' },
      ],
    });
  });

  it('compileScript rejects calc_on_order_fills', async () => {
    const r = await compileScript('//@version=6\nstrategy("c", overlay = true,\n     calc_on_order_fills = true)\nplot(close)\n');
    expect(r).toEqual({ ok: false, errors: [{ line: 3, message: 'calc_on_order_fills = true is not supported in v1' }] });
  });

  it('reports syntax errors and undeclared identifiers with a line', async () => {
    expect(await compileScript('//@version=6\nstrategy("s")\nx = 1 +\ny = )\nplot(x)\n')).toMatchObject({ ok: false, errors: [{ line: 4 }] });
    expect(await compileScript('//@version=6\nstrategy("v")\nplot(foo)\n')).toEqual({ ok: false, errors: [{ line: 3, message: 'Undeclared identifier "foo"' }] });
  });

  it('rejects trailing exits', async () => {
    const r = await compileScript('//@version=6\nstrategy("t")\nstrategy.entry("L", strategy.long)\nstrategy.exit("X", "L", trail_points = 100, trail_offset = 50)\n');
    expect(r).toEqual({ ok: false, errors: [{ line: 4, message: 'strategy.exit trailing stops (trail_points) are not supported in v1' }] });
  });

  it('reads the declaration of KyberSwing and probe 01', async () => {
    const k = await compileScript(KYBER);
    expect(k).toEqual({
      ok: true,
      declaration: {
        title: 'KyberSwing v1.1',
        pyramiding: 0,
        marginLong: 20,
        marginShort: 20,
        closeEntriesRule: 'FIFO',
        defaultQtyType: 'fixed',
        defaultQtyValue: 1,
        processOrdersOnClose: false,
        overridden: { initialCapital: 10_000, commission: 0.05, slippage: 2 },
      },
    });
    const p = await compileScript(probe('01-ma-cross'));
    expect(p).toMatchObject({ ok: true, declaration: { defaultQtyType: 'percent_of_equity', defaultQtyValue: 100, marginLong: 100, overridden: { initialCapital: 10_000, commission: 0.05, slippage: 0 } } });
    // Only what the declaration states is "overridden"; a default is not.
    const bare = await compileScript('//@version=6\nstrategy("b")\nplot(close)\n');
    expect(bare).toMatchObject({ ok: true, declaration: { title: 'b', overridden: {} } });
    if (bare.ok) expect(bare.declaration.overridden).toEqual({});
  });
});

describe('runStrategy', () => {
  it('calls before and after once per bar, in order, with the candles', async () => {
    const seen: string[] = [];
    const slice = candles.slice(0, 50);
    await runStrategy({
      source: probe('01-ma-cross'),
      symbol: 'BTCUSDT',
      tf: '4h',
      candles: slice,
      syminfo: SYMINFO,
      hooks: {
        before: (bar, idx) => {
          seen.push(`b${idx}:${bar.openTime}`);
          return FLAT;
        },
        after: (bar, idx) => {
          seen.push(`a${idx}:${bar.openTime}`);
        },
      },
    });
    expect(seen).toEqual(slice.flatMap((c, i) => [`b${i}:${c.openTime}`, `a${i}:${c.openTime}`]));
  });

  it('a read-back the view does not feed throws instead of reading the empty emulator', async () => {
    const src = '//@version=6\nstrategy("g")\nplot(strategy.grossprofit)\n';
    await expect(
      runStrategy({ source: src, symbol: 'BTCUSDT', tf: '4h', candles: candles.slice(0, 5), syminfo: SYMINFO, hooks: { before: () => FLAT, after: () => {} } }),
    ).rejects.toThrow('strategy.grossprofit is not supported in v1');
  });

  it('feeds strategy.equity from the view (equity-based sizing reads our broker)', async () => {
    const src = '//@version=6\nstrategy("e")\nif bar_index == 3\n    strategy.entry("L", strategy.long, qty = strategy.equity / close)\n';
    const calls: PineOrderCall[] = [];
    const slice = candles.slice(0, 5);
    await runStrategy({
      source: src,
      symbol: 'BTCUSDT',
      tf: '4h',
      candles: slice,
      syminfo: SYMINFO,
      hooks: { before: () => ({ ...FLAT, equity: 77_000 }), after: (_b, _i, c) => calls.push(...c) },
    });
    expect(calls).toEqual([{ kind: 'entry', id: 'L', direction: 'long', qty: 77_000 / slice[3]!.close }]);
  });

  it('runStrategy hooks match spike capture', async () => {
    // PineTS's own fills replayed as the view (a scripted broker with real positions).
    const views = await recordEmulatorViews(KYBER, candles);
    const spike = await runScript(KYBER, candles, { provider: true, broker: (bar) => views[bar]! });
    const ours: (PineOrderCall & { bar: number })[] = [];
    await runStrategy({
      source: KYBER,
      symbol: 'BTCUSDT',
      tf: '4h',
      candles,
      syminfo: SYMINFO,
      hooks: {
        before: (_bar, idx) => fromBrokerView(views[idx]!),
        after: (_bar, idx, calls) => {
          for (const c of calls) ours.push({ bar: idx, ...c });
        },
      },
    });
    expect(views.filter((v) => v.position_size !== 0).length).toBeGreaterThan(1_000);
    expect(spike.calls.length).toBeGreaterThan(10_000);
    expect(ours).toEqual(spike.calls.map((c) => ({ bar: c.bar, ...toPineOrderCall(c.method, c.args) })));
  }, 120_000);
});
