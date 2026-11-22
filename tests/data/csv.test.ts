import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Candle, FundingEvent } from '../../src/core/types.js';
import { DataGapError, loadCandles, loadFunding, writeCandles, writeFunding } from '../../src/data/csv.js';

const dir = mkdtempSync(join(tmpdir(), 'pineapple-csv-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const H4 = 14_400_000;
const t0 = Date.UTC(2024, 0, 1);

function mk(i: number): Candle {
  return {
    openTime: t0 + i * H4,
    open: 42000.5 + i,
    high: 42100.25 + i,
    low: 41900.125 + i,
    close: 42050.75 + i,
    volume: 1234.56789012 + i,
  };
}

describe('csv', () => {
  it('round-trips candles exactly', () => {
    const candles = [0, 1, 2, 3].map(mk);
    const p = join(dir, 'c.csv');
    writeCandles(p, candles);
    expect(loadCandles(p, '4h')).toEqual(candles);
  });

  it('writes quantities with 8 decimals', () => {
    const p = join(dir, 'dp.csv');
    writeCandles(p, [{ openTime: t0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }]);
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    expect(lines[1]).toBe(`${t0},1.00000000,2.00000000,0.50000000,1.50000000,3.00000000`);
  });

  it('loadCandles throws on gap', () => {
    const p = join(dir, 'gap.csv');
    writeCandles(p, [mk(0), mk(1), mk(3)]); // missing 08:00
    try {
      loadCandles(p, '4h');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DataGapError);
      expect((e as DataGapError).firstMissing).toBe(Date.UTC(2024, 0, 1, 8));
    }
  });

  it('committed BTCUSDT fixtures load gap-free and cover the same window', () => {
    const candles = loadCandles('tests/fixtures/BTCUSDT_4h.csv', '4h');
    const funding = loadFunding('tests/fixtures/BTCUSDT_funding.csv');
    expect(candles[0]?.openTime).toBe(Date.UTC(2023, 0, 1));
    expect(funding[0]?.time).toBeGreaterThanOrEqual(Date.UTC(2023, 0, 1));
    expect(funding[0]?.time).toBeLessThan(Date.UTC(2023, 0, 1, 0, 1));
    const lastCandle = candles[candles.length - 1]!;
    const lastFunding = funding[funding.length - 1]!;
    expect(lastCandle.openTime).toBe(Date.UTC(2026, 10, 18, 20));
    expect(lastFunding.time).toBeGreaterThan(Date.UTC(2026, 10, 18));
    expect(lastFunding.time).toBeLessThan(Date.UTC(2026, 10, 19));
  });

  it('round-trips funding exactly', () => {
    const ev: FundingEvent[] = [
      { time: t0, rate: 0.0001, markPrice: 42000.5 },
      { time: t0 + 8 * 3_600_000, rate: -0.00012345, markPrice: 42100.125 },
    ];
    const p = join(dir, 'f.csv');
    writeFunding(p, ev);
    expect(loadFunding(p)).toEqual(ev);
  });
});
