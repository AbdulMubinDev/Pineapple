// request.security validation: other symbols, the chart timeframe, and the lookahead_on warning.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Candle, PairRules } from '../../src/core/types.js';
import { compileScript } from '../../src/engine/pine-runner.js';
import { replay } from '../../src/engine/replay.js';

const KYBER = readFileSync('tests/fixtures/KyberSwing.pine', 'utf8');
const rules = JSON.parse(readFileSync('tests/fixtures/BTCUSDT-rules.json', 'utf8')) as PairRules;
const M15 = 900_000;

const script = (call: string) => `//@version=6\nstrategy("s")\nx = ${call}\nplot(x)\n`;

/** Deterministic 15m candles (no fixtures, no network). */
function candles15m(n: number, start = Date.UTC(2024, 0, 1)): Candle[] {
  const out: Candle[] = [];
  let close = 40_000;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = open * (1 + 0.003 * Math.sin(i / 7));
    out.push({
      openTime: start + i * M15,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 10,
    });
  }
  return out;
}

describe('request.security on another symbol', () => {
  const MSG = 'request.security on another symbol is not supported in v1';

  it('is a compile error on the line of the call', async () => {
    const src = '//@version=6\nstrategy("s")\n\nx = request.security("BINANCE:ETHUSDT.P", "D", close)\nplot(x)\n';
    expect(await compileScript(src)).toEqual({ ok: false, errors: [{ line: 4, message: MSG }] });
    const bare = await compileScript(script('request.security("ETHUSDT", "D", close)'));
    expect(bare).toEqual({ ok: false, errors: [{ line: 3, message: MSG }] });
  });

  it.each(['syminfo.tickerid', '"BTCUSDT"', '"BINANCE:BTCUSDT"', '"BINANCE:BTCUSDT.P"'])('accepts the chart symbol as %s', async (id) => {
    expect(await compileScript(script(`request.security(${id}, "D", close)`))).toMatchObject({ ok: true });
  });
});

describe('compileScript on the chart timeframe', () => {
  it('accepts a 60 request on a 15m chart, and rejects it on a 4h chart with its line', async () => {
    const src = script('request.security(syminfo.tickerid, "60", close)');
    expect(await compileScript(src, '15m')).toMatchObject({ ok: true });
    expect(await compileScript(src)).toEqual({
      ok: false,
      errors: [{ line: 3, message: 'MemoryProvider cannot build 60 candles from 4h candles' }],
    });
  });

  it('still rejects a request the chart cannot build, with its line', async () => {
    const r = await compileScript(script('request.security(syminfo.tickerid, "5", close)'), '15m');
    expect(r).toEqual({ ok: false, errors: [{ line: 3, message: 'MemoryProvider cannot build 5 candles from 15m candles' }] });
  });

  it('replays a 15m chart with a 60 request', async () => {
    const src =
      '//@version=6\nstrategy("h", overlay = true)\nh = request.security(syminfo.tickerid, "60", close[1], lookahead = barmerge.lookahead_on)\n' +
      'if close > h\n    strategy.entry("L", strategy.long, qty = 0.1)\nif close < h\n    strategy.close("L")\n';
    const bars = candles15m(400);
    const r = await replay({
      source: src,
      symbol: 'BTCUSDT',
      tf: '15m',
      candles: bars,
      funding: [],
      from: bars[100]!.openTime,
      to: bars.at(-1)!.openTime,
      mode: 'tradingview',
      tv: { initialCapital: 10_000, commissionPct: 0.05, slippageTicks: 0 },
      rules,
      startingBalance: 10_000,
      sizing: { kind: 'script' },
    });
    expect(r.trades.length).toBeGreaterThan(0);
  });
});

describe('lookahead_on warning', () => {
  const MSG = 'request.security with lookahead_on and no [1] offset uses unclosed higher-timeframe data';

  it('KyberSwing (close[1] with lookahead_on) gets no warning', async () => {
    const r = await compileScript(KYBER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings ?? []).toEqual([]);
  });

  it('warns on a bare close with lookahead_on, at the call line', async () => {
    const src = '//@version=6\nstrategy("w")\n\nx = request.security(syminfo.tickerid, "D",\n     close, lookahead = barmerge.lookahead_on)\nplot(x)\n';
    const r = await compileScript(src);
    expect(r).toMatchObject({ ok: true, warnings: [{ line: 4, message: MSG }] });
  });

  it('does not warn without lookahead_on', async () => {
    const r = await compileScript(script('request.security(syminfo.tickerid, "D", close)'));
    expect(r.ok && (r.warnings ?? [])).toEqual([]);
  });
});
