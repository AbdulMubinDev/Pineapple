import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaperBroker } from '../../src/broker/broker.js';
import type { Candle, OrderIntent, PairRules } from '../../src/core/types.js';
import { loadCandles } from '../../src/data/csv.js';
import type { BrokerView } from '../../src/engine/hook-core.js';
import { compileScript, runStrategy, toPineOrderCall, type PineOrderCall } from '../../src/engine/pine-runner.js';
import { StrategyLayer, type ScriptView } from '../../src/engine/strategy-layer.js';
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

  it('compileScript accepts process_orders_on_close (the replay fills at the close)', async () => {
    const r = await compileScript('//@version=6\nstrategy("c", process_orders_on_close = true)\nplot(close)\n');
    expect(r).toMatchObject({ ok: true, declaration: { processOrdersOnClose: true } });
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
      securityTimeframes: ['D'],
    });
    const p = await compileScript(probe('01-ma-cross'));
    expect(p).toMatchObject({ ok: true, declaration: { defaultQtyType: 'percent_of_equity', defaultQtyValue: 100, marginLong: 100, overridden: { initialCapital: 10_000, commission: 0.05, slippage: 0 } } });
    // Only what the declaration states is "overridden"; a default is not.
    const bare = await compileScript('//@version=6\nstrategy("b")\nplot(close)\n');
    expect(bare).toMatchObject({ ok: true, declaration: { title: 'b', overridden: {} } });
    if (bare.ok) expect(bare.declaration.overridden).toEqual({});
  });
});

describe("order semantics against PineTS's own emulator (TradingView reference)", () => {
  const rules: PairRules = { symbol: 'BTCUSDT', tickSize: 0.1, stepSize: 0.001, minNotional: 5, maxLeverage: 125, leverageEstimated: false, brackets: [] };

  /** Per bar: position size, open-trade count and the first open trade's entry id, as the script reads them. */
  async function throughLayer(source: string, bars: Candle[]) {
    const c = await compileScript(source);
    if (!c.ok) throw new Error(JSON.stringify(c.errors));
    const broker = new PaperBroker({ startingBalance: 1e7, fees: { makerRate: 0, takerRate: 0, slippagePct: 0 }, mode: 'tradingview', rules: () => rules, sizing: { kind: 'script' } });
    const layer = new StrategyLayer(c.declaration, broker, 'BTCUSDT', { kind: 'script' }, { rules });
    const submit = (xs: OrderIntent[], t: number) => xs.forEach((x) => broker.submit(x, t));
    const seen: { pos: number; n: number; id0: string }[] = [];
    await runStrategy({
      source,
      symbol: 'BTCUSDT',
      tf: '4h',
      candles: bars,
      syminfo: SYMINFO,
      hooks: {
        before(bar, idx) {
          if (idx > 0) {
            submit(layer.onFills(broker.onBarOpen('BTCUSDT', bar), bar, idx), bar.openTime);
            submit(layer.onFills(broker.onBarRange('BTCUSDT', bar), bar, idx), bar.openTime);
          }
          broker.markToMarket('BTCUSDT', bar.close);
          const v = layer.scriptView();
          seen.push({ pos: v.positionSize, n: v.openTrades, id0: v.opentrades[0]?.entryId ?? '' });
          return v;
        },
        after(bar, _idx, calls) {
          submit(layer.toIntents(calls, bar), bar.openTime);
        },
      },
    });
    return { seen, closed: broker.closedTrades().map((t) => t.qty) };
  }

  /** The same through PineTS's emulator (every order forwarded), read off the script's plots. */
  async function throughEmulator(source: string, bars: Candle[]) {
    const { ctx } = await runScript(source, bars, { provider: true, forward: true });
    const c = ctx as unknown as { plots: Record<string, { data: { value: unknown }[] }>; strategy: { closedtrades: { size: number }[] } };
    const col = (n: string) => (c.plots[n]?.data ?? []).map((d) => d.value);
    const pos = col('pos') as number[];
    const n = col('n') as number[];
    const id0 = col('id0') as number[];
    return {
      seen: pos.map((p, i) => ({ pos: p, n: n[i]!, id0: ['', 'A', 'B', 'C', 'L'][id0[i]!]! })),
      closed: c.strategy.closedtrades.map((t) => Math.abs(t.size)),
    };
  }

  const PLOTS = `plot(strategy.position_size, "pos")
plot(strategy.opentrades, "n")
plot(strategy.opentrades == 0 ? 0 : strategy.opentrades.entry_id(0) == "A" ? 1 : strategy.opentrades.entry_id(0) == "B" ? 2 : strategy.opentrades.entry_id(0) == "C" ? 3 : 4, "id0")
`;
  const cases: Record<string, string> = {
    'FIFO close("B") twice, then close("A")': `//@version=6
strategy("f", pyramiding = 2, close_entries_rule = "FIFO")
if bar_index == 1
    strategy.entry("A", strategy.long, qty = 1)
if bar_index == 2
    strategy.entry("B", strategy.long, qty = 1)
if bar_index == 4
    strategy.close("B")
if bar_index == 6
    strategy.close("B")
if bar_index == 8
    strategy.close("A")
`,
    'pyramiding 1, two entries on one bar': `//@version=6
strategy("p", pyramiding = 1)
if bar_index == 1
    strategy.entry("A", strategy.long, qty = 1)
    strategy.entry("B", strategy.long, qty = 1)
if bar_index == 5
    strategy.close_all()
`,
    'qty_percent 50 exit re-issued every bar': `//@version=6
strategy("h")
if bar_index == 1
    strategy.entry("L", strategy.long, qty = 1)
if bar_index > 1
    strategy.exit("tp", "L", qty_percent = 50, limit = close * 0.99)
if bar_index == 12
    strategy.exit("all", "L", limit = close * 0.99)
`,
  };

  for (const [name, body] of Object.entries(cases)) {
    it(name, async () => {
      const bars = candles.slice(0, 20);
      const ours = await throughLayer(body + PLOTS, bars);
      const ref = await throughEmulator(body + PLOTS, bars);
      expect(ours.seen).toEqual(ref.seen);
      expect(ours.closed).toEqual(ref.closed);
    });
  }
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
