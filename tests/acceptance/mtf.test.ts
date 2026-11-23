// Acceptance test 2: multi-timeframe values without repainting, through the production runner.
// Probe 05 (and KyberSwing's own regime tuple) run through runStrategy over the whole 4h fixture. Each
// script gets extra strategy.order() calls whose arguments carry the request.security values of that bar;
// the hooks capture them (orders are never filled here: the view stays flat) and we compare them per bar
// with daily candles built by hand from the 4h fixture as UTC days.
//   (a) the values (and the regime) each 4h bar sees come from the previous closed daily candle;
//   (b) no 4h bar ever sees its own day's unclosed daily close, and cutting the data mid-day never
//       changes what an earlier bar saw.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types.js';
import { loadCandles } from '../../src/data/csv.js';
import { runStrategy, type PineOrderCall } from '../../src/engine/pine-runner.js';
import { StrategyLayer } from '../../src/engine/strategy-layer.js';

const H4 = 14_400_000;
const DAY = 86_400_000;
const dayOf = (t: number) => Math.floor(t / DAY) * DAY;

const candles = loadCandles('tests/fixtures/BTCUSDT_4h.csv', '4h');

/** Daily candles by hand: the 4h bars grouped by UTC day; the close is the day's last 4h close. */
function dailyFromFourHour(bars: Candle[]): { openTime: number; close: number; bars: number }[] {
  const out: { openTime: number; close: number; bars: number }[] = [];
  for (const b of bars) {
    const d = dayOf(b.openTime);
    const last = out.at(-1);
    if (last && last.openTime === d) {
      last.close = b.close;
      last.bars++;
    } else out.push({ openTime: d, close: b.close, bars: 1 });
  }
  return out;
}

/** Pine's ta.ema: SMA of the first `n` values as the seed, then alpha = 2 / (n + 1). NaN before. */
function emaSeries(xs: number[], n: number): number[] {
  const alpha = 2 / (n + 1);
  const out: number[] = [];
  let e = NaN;
  for (let i = 0; i < xs.length; i++) {
    if (i === n - 1) e = xs.slice(0, n).reduce((s, x) => s + x, 0) / n;
    else if (i >= n) e = alpha * xs[i]! + (1 - alpha) * e;
    out.push(e);
  }
  return out;
}

/** Runs `source` through runStrategy with a flat view, returning per bar the captured order calls by id. */
async function probeRun(source: string, bars: Candle[]): Promise<Map<string, PineOrderCall>[]> {
  const seen: Map<string, PineOrderCall>[] = [];
  await runStrategy({
    source,
    symbol: 'BTCUSDT',
    tf: '4h',
    candles: bars,
    syminfo: { mintick: 0.1, qtyStep: 0.001 },
    hooks: {
      before: () => StrategyLayer.flatView(10_000),
      after: (_bar, idx, calls) => {
        seen[idx] = new Map(calls.filter((c) => c.kind === 'order' && c.id.startsWith('mtf_')).map((c) => [c.id, c]));
      },
    },
  });
  return seen;
}

/** A captured value; `na` arguments are omitted by the runner, so they read as NaN here. */
const val = (seen: Map<string, PineOrderCall>, id: string, field: 'qty' | 'limit' | 'stop') => seen.get(id)?.[field] ?? NaN;

// Probe 05 verbatim, plus the order calls that report its values, plus a regime from its tuple.
const PROBE05 =
  readFileSync('spike/probes/05-mtf-daily.pine', 'utf8') +
  `
regime = tClose > tEma ? 1 : tClose < tEma ? -1 : 0
strategy.order("mtf_prevOn", strategy.long, qty = dPrevOn)
strategy.order("mtf_default", strategy.long, qty = dDefault)
strategy.order("mtf_tuple", strategy.long, qty = tClose, limit = tEma, stop = regime)
`;

// KyberSwing verbatim, plus the order calls that report its own regime tuple and regime.
const KYBER =
  readFileSync('tests/fixtures/KyberSwing.pine', 'utf8') +
  `
strategy.order("mtf_htf", strategy.long, qty = htfClose, limit = htfFast, stop = htfSlow)
strategy.order("mtf_regime", strategy.long, qty = bullRegime ? 1 : bearRegime ? -1 : 0)
`;

const daily = dailyFromFourHour(candles);
const dIndex = new Map(daily.map((d, i) => [d.openTime, i]));
const closes = daily.map((d) => d.close);
const ema3 = emaSeries(closes, 3);
const ema50 = emaSeries(closes, 50);
const ema200 = emaSeries(closes, 200);

/** Index of the previous closed daily candle for a 4h bar (its own day minus one), or -1. */
const prevDay = (b: Candle) => (dIndex.get(dayOf(b.openTime)) ?? 0) - 1;
const isLastOfDay = (b: Candle) => b.openTime + H4 === dayOf(b.openTime) + DAY;

describe('acceptance 2: multi-timeframe without repainting', () => {
  it('the hand-built daily candles are whole UTC days of six 4h bars', () => {
    expect(daily.every((d) => d.bars === 6)).toBe(true);
    expect(daily.length * 6).toBe(candles.length);
  });

  it('probe 05: every 4h bar sees the previous closed daily candle (a), never its own unclosed day (b)', { timeout: 180_000 }, async () => {
    const seen = await probeRun(PROBE05, candles);
    expect(seen).toHaveLength(candles.length);
    let compared = 0;
    let regimeCompared = 0;
    for (let i = 0; i < candles.length; i++) {
      const b = candles[i]!;
      const p = prevDay(b);
      if (p < 0) continue; // the first day has no previous daily candle
      const s = seen[i]!;
      const today = daily[p + 1]!;
      const prevOn = val(s, 'mtf_prevOn', 'qty');
      const tClose = val(s, 'mtf_tuple', 'qty');
      const tEma = val(s, 'mtf_tuple', 'limit');
      const def = val(s, 'mtf_default', 'qty');

      // (a) previous closed day, both the plain and the tuple form.
      expect(prevOn, `bar ${i} prevOn`).toBe(closes[p]);
      expect(tClose, `bar ${i} tupleClose`).toBe(closes[p]);
      // Default lookahead (off): the day's close appears only on the bar that closes the day.
      expect(def, `bar ${i} default`).toBe(isLastOfDay(b) ? today.close : closes[p]);
      if (p >= 2) {
        expect(tEma, `bar ${i} tupleEma`).toBeCloseTo(ema3[p]!, 6);
        const hand = closes[p]! > ema3[p]! ? 1 : closes[p]! < ema3[p]! ? -1 : 0;
        expect(val(s, 'mtf_tuple', 'stop'), `bar ${i} regime`).toBe(hand);
        regimeCompared++;
      }
      // (b) a bar before the day's last never sees that day's close, final or developing,
      // unless it happens to equal the previous day's close.
      if (!isLastOfDay(b)) {
        for (const v of [prevOn, tClose, def]) {
          if (today.close !== closes[p]) expect(v, `bar ${i} saw today's final close`).not.toBe(today.close);
          if (b.close !== closes[p]) expect(v, `bar ${i} saw today's developing close`).not.toBe(b.close);
        }
      }
      compared++;
    }
    expect(compared).toBe(candles.length - 6);
    expect(regimeCompared).toBe(candles.length - 18);
  });

  it('KyberSwing: its own regime tuple and regime come from the previous closed daily candle on every 4h bar', { timeout: 180_000 }, async () => {
    const seen = await probeRun(KYBER, candles);
    let compared = 0;
    let bull = 0;
    let bear = 0;
    for (let i = 0; i < candles.length; i++) {
      const b = candles[i]!;
      const p = prevDay(b);
      if (p < 0) continue;
      const s = seen[i]!;
      const htfClose = val(s, 'mtf_htf', 'qty');
      expect(htfClose, `bar ${i} htfClose`).toBe(closes[p]);
      if (!isLastOfDay(b) && daily[p + 1]!.close !== closes[p]) expect(htfClose).not.toBe(daily[p + 1]!.close);
      if (p < 199) continue; // the 200-day EMA is na before its 200th daily close
      const htfFast = val(s, 'mtf_htf', 'limit');
      const htfSlow = val(s, 'mtf_htf', 'stop');
      expect(htfFast, `bar ${i} htfFast`).toBeCloseTo(ema50[p]!, 6);
      expect(htfSlow, `bar ${i} htfSlow`).toBeCloseTo(ema200[p]!, 6);
      const c = closes[p]!;
      const handBull = c > ema200[p]! && ema50[p]! > ema200[p]!;
      const handBear = c < ema200[p]! && ema50[p]! < ema200[p]!;
      const hand = handBull ? 1 : handBear ? -1 : 0;
      expect(val(s, 'mtf_regime', 'qty'), `bar ${i} regime`).toBe(hand);
      if (hand === 1) bull++;
      if (hand === -1) bear++;
      compared++;
    }
    // Bars from the 201st day on (the 200-day EMA's first value is on day 200, seen on day 201).
    expect(compared).toBe(candles.length - 200 * 6);
    // Both regimes occur, so the comparison is not vacuous.
    expect(bull).toBeGreaterThan(100);
    expect(bear).toBeGreaterThan(100);
  });

  it('cutting the data mid-day never changes what an earlier bar saw (no repainting)', { timeout: 180_000 }, async () => {
    // A 1500-bar slice, cut after the 00:00, 08:00 and 16:00 bars of three different days.
    const slice = candles.slice(0, 1500);
    const full = await probeRun(PROBE05, slice);
    const cuts = [600 + 0, 900 + 2, 1200 + 4]; // slice[i] for i % 6 === 0 is a day's 00:00 bar
    for (const cut of cuts) {
      expect(isLastOfDay(slice[cut]!)).toBe(false);
      const part = await probeRun(PROBE05, slice.slice(0, cut + 1));
      expect(part).toHaveLength(cut + 1);
      for (let i = 0; i <= cut; i++) {
        for (const [id, call] of full[i]!) expect(part[i]!.get(id), `cut ${cut} bar ${i} ${id}`).toEqual(call);
      }
    }
  });
});
