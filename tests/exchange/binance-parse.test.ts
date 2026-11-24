import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fundingHoursFor, parseFundingInfo, parseTickers } from '../../src/exchange/binance.js';

const load = (f: string): unknown => JSON.parse(readFileSync(`tests/fixtures/${f}`, 'utf8'));

describe('parseTickers', () => {
  it('parses the recorded ticker/24hr entries', () => {
    const { tickers, skipped } = parseTickers(load('ticker24h.json'));
    expect(skipped).toBe(0);
    expect(tickers).toHaveLength(10);
    const btc = tickers.find((t) => t.symbol === 'BTCUSDT')!;
    expect(btc.quoteVolume).toBeGreaterThan(0);
    expect(btc.lastPrice).toBeGreaterThan(0);
    expect(Object.keys(btc).sort()).toEqual(['lastPrice', 'quoteVolume', 'symbol']);
  });

  it('skips and counts entries with non-finite or missing numbers', () => {
    const { tickers, skipped } = parseTickers([
      { symbol: 'AUSDT', quoteVolume: '10', lastPrice: '2' },
      { symbol: 'BUSDT', quoteVolume: 'NaN', lastPrice: '2' },
      { symbol: 'CUSDT', quoteVolume: '10' },
      { symbol: 'DUSDT', quoteVolume: '', lastPrice: '2' },
      null,
    ]);
    expect(tickers.map((t) => t.symbol)).toEqual(['AUSDT']);
    expect(skipped).toBe(4);
  });

  it('throws on a non-array response', () => {
    expect(() => parseTickers({ code: -1003, msg: 'Too many requests' })).toThrow(/array/);
  });
});

describe('parseFundingInfo', () => {
  it('parses the recorded fundingInfo entries, including non-8h intervals', () => {
    const { intervals, skipped } = parseFundingInfo(load('fundingInfo.json'));
    expect(skipped).toBe(0);
    expect(intervals.size).toBe(10);
    expect(intervals.get('BTCUSDT')).toBe(8);
    expect([...intervals.values()].some((h) => h !== 8)).toBe(true);
  });

  it('never coerces a bad interval to 8: it skips and counts it', () => {
    const { intervals, skipped } = parseFundingInfo([
      { symbol: 'AUSDT', fundingIntervalHours: 4 },
      { symbol: 'BUSDT', fundingIntervalHours: 0 },
      { symbol: 'CUSDT', fundingIntervalHours: '4' },
      { symbol: 'DUSDT' },
      { fundingIntervalHours: 4 },
    ]);
    expect([...intervals]).toEqual([['AUSDT', 4]]);
    expect(skipped).toBe(4);
  });

  it('throws on a non-array response', () => {
    expect(() => parseFundingInfo({})).toThrow(/array/);
  });
});

describe('fundingHoursFor', () => {
  it('defaults to 8 only for symbols absent from the map', () => {
    const m = new Map([['AUSDT', 4]]);
    expect(fundingHoursFor(m, 'AUSDT')).toBe(4);
    expect(fundingHoursFor(m, 'ZUSDT')).toBe(8);
  });
});
