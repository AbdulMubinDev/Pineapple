// Acceptance test 1: the engine matches TradingView's strategy tester.
// For every entry in tests/fixtures/tv-reference.json (numbers read off TradingView by the owner), replay
// its script in tradingview mode over the 4h fixture and compare the summary within fixed tolerances.
// The Properties come from each script's own strategy() declaration (KyberSwing: 10000 / 0.05 % / 2 ticks,
// margin 20), as TradingView uses them. Tolerances are the plan's; never widen them without the owner.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PairRules } from '../../src/core/types.js';
import { loadCandles } from '../../src/data/csv.js';
import { replay } from '../../src/engine/replay.js';

type Ref = { trades: number; winRatePct: number; profitFactor: number; netProfitPct: number };

const reference = JSON.parse(readFileSync('tests/fixtures/tv-reference.json', 'utf8')) as Record<string, Ref | null>;
const rules = JSON.parse(readFileSync('tests/fixtures/BTCUSDT-rules.json', 'utf8')) as PairRules;

/** The script each reference entry was measured with, and the window it was measured over. */
const SCRIPTS: Record<string, string> = {
  'ma-cross': 'spike/probes/01-ma-cross.pine',
  'kyber-swing': 'tests/fixtures/KyberSwing.pine',
};
// 2024-01-01 00:00 UTC to the end of 2026-11-18 (the fixture's last day). Earlier bars are warm-up.
const FROM = Date.UTC(2024, 0, 1);
const TO = Date.UTC(2026, 10, 19) - 1;

const TOLERANCE = { trades: 3, winRatePct: 3, profitFactor: 0.15, netProfitPct: 3 };

describe('acceptance 1: engine matches TradingView', () => {
  const candles = loadCandles('tests/fixtures/BTCUSDT_4h.csv', '4h');

  it('has a script for every reference entry, and KyberSwing is provided', () => {
    for (const name of Object.keys(reference)) expect(SCRIPTS[name], name).toBeDefined();
    // KyberSwing is required: the owner supplied its TradingView numbers.
    expect(reference['kyber-swing']).toEqual({ trades: 58, winRatePct: 32.8, profitFactor: 1.71, netProfitPct: 22.6 });
  });

  for (const [name, ref] of Object.entries(reference)) {
    it.skipIf(ref === null)(`${name} lands within tolerance of TradingView`, { timeout: 120_000 }, async () => {
      const r = await replay({
        source: readFileSync(SCRIPTS[name]!, 'utf8'),
        symbol: 'BTCUSDT',
        tf: '4h',
        candles,
        funding: [],
        from: FROM,
        to: TO,
        mode: 'tradingview',
        rules,
        startingBalance: 10_000,
        sizing: { kind: 'script' },
      });
      const s = r.summary;
      const got = { trades: s.tradeCount, winRatePct: s.winRatePct, profitFactor: s.profitFactor, netProfitPct: s.netProfitPct };
      const want = ref!;
      const line = `${name}: engine ${got.trades} / ${got.winRatePct.toFixed(2)} % / PF ${got.profitFactor.toFixed(3)} / ${got.netProfitPct.toFixed(2)} %` +
        ` vs TradingView ${want.trades} / ${want.winRatePct} % / PF ${want.profitFactor} / ${want.netProfitPct} %`;
      if (process.env.PARITY_LOG) console.log(line);

      // Nothing the TradingView figures would not contain.
      expect(r.overfills, line).toHaveLength(0);
      expect(r.anomalies, line).toHaveLength(0);
      expect(r.rejections, line).toHaveLength(0);

      expect(Math.abs(got.trades - want.trades), line).toBeLessThanOrEqual(TOLERANCE.trades);
      expect(Math.abs(got.winRatePct - want.winRatePct), line).toBeLessThanOrEqual(TOLERANCE.winRatePct);
      expect(Math.abs(got.profitFactor - want.profitFactor), line).toBeLessThanOrEqual(TOLERANCE.profitFactor);
      expect(Math.abs(got.netProfitPct - want.netProfitPct), line).toBeLessThanOrEqual(TOLERANCE.netProfitPct);

      if (name === 'kyber-swing') {
        // The Properties replayed are the declaration's own.
        expect(r.declaration.overridden).toEqual({ initialCapital: 10_000, commission: 0.05, slippage: 2 });
        expect(r.declaration.marginLong).toBe(20);
        expect(r.declaration.marginShort).toBe(20);
      }
    });
  }
});
