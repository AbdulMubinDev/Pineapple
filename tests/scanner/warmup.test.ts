// Warm-up helpers (src/scanner/warmup.ts) and the shared price stream (src/scanner/price-feed.ts).
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/core/types.js';
import { aggregateCandles } from '../../src/engine/memory-provider.js';
import { HttpStatusError } from '../../src/exchange/budget.js';
import { FakeExchange } from '../../src/exchange/fake.js';
import { NetworkError } from '../../src/net/http.js';
import { PriceFeed } from '../../src/scanner/price-feed.js';
import { buildHtf, contiguousTail, forEachPooled, nativeTimeframe, withRetry } from '../../src/scanner/warmup.js';
import { flush, makeClock, makeTimers } from '../exchange/clock.js';

const H = 3_600_000;
const DAY = 24 * H;
const bar = (openTime: number, close = 1): Candle => ({ openTime, open: 1, high: close + 1, low: 0.5, close, volume: 1 });

describe('warm-up helpers', () => {
  it('withRetry backs off 2 s, 4 s, ... up to 60 s on transient failures only', async () => {
    const clock = makeClock();
    let n = 0;
    const out = await withRetry(async () => {
      if (++n < 7) throw new NetworkError('fapi.binance.com', new TypeError('fetch failed'));
      return 'ok';
    }, clock.sleep);
    expect(out).toBe('ok');
    expect(clock.sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
    await expect(withRetry(() => Promise.reject(new HttpStatusError(400, 'HTTP 400')), clock.sleep)).rejects.toThrow('HTTP 400');
    expect(clock.sleeps).toHaveLength(6); // a 400 is not retried
    let m = 0;
    await expect(withRetry(() => (m++, Promise.reject(new HttpStatusError(503, 'HTTP 503'))), clock.sleep, { attempts: 3 })).rejects.toThrow('503');
    expect(m).toBe(3);
  });

  it('forEachPooled keeps at most `limit` in flight and survives a failing item', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachPooled([1, 2, 3, 4, 5, 6, 7], 3, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight--;
      if (i === 2) throw new Error('bad');
      seen.push(i);
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 3, 4, 5, 6, 7]);
  });

  it('contiguousTail keeps the newest run without a gap', () => {
    const c = [bar(0), bar(H), bar(3 * H), bar(4 * H), bar(5 * H)];
    expect(contiguousTail(c, '1h').map((x) => x.openTime)).toEqual([3 * H, 4 * H, 5 * H]);
    expect(contiguousTail([], '1h')).toEqual([]);
  });

  it('nativeTimeframe maps request.security timeframes Binance serves', () => {
    expect(nativeTimeframe('D')).toBe('1d');
    expect(nativeTimeframe('240')).toBe('4h');
    expect(nativeTimeframe('W')).toBeNull();
    expect(nativeTimeframe('3D')).toBeNull();
  });

  it('buildHtf: native buckets before the last bar, the developing bucket from closed chart bars', () => {
    // 15m history covering day 9 from 18:00 to day 10 06:45; native days 0..9 (day 10 is still open).
    const history = Array.from({ length: 52 }, (_, i) => bar(9 * DAY + 18 * H + i * 900_000, 100 + i));
    const native = Array.from({ length: 10 }, (_, d) => bar(d * DAY, 50 + d));
    const out = buildHtf(history, 'D', native);
    expect(out.map((c) => c.openTime)).toEqual(Array.from({ length: 11 }, (_, d) => d * DAY));
    expect(out.slice(0, 10)).toEqual(native); // day 9 is native (complete), not the partial aggregate
    expect(out[10]).toEqual(aggregateCandles(history, 'D').at(-1)); // day 10 from the closed 15m bars only
    // No native series: aggregated from the history alone.
    expect(buildHtf(history, 'W', [])).toEqual(aggregateCandles(history, 'W'));
  });
});

describe('PriceFeed', () => {
  it('one ticker + mark connection; prices, volumes and marks reach the listeners; a drop reconnects with backoff', async () => {
    const clock = makeClock();
    const timers = makeTimers(clock);
    const client = new FakeExchange({ now: clock.now, sleep: clock.sleep });
    const feed = new PriceFeed({ client, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const prices: [string, number][] = [];
    const volumes: [string, number][] = [];
    const marks: string[] = [];
    feed.onPrice((s, last) => prices.push([s, last]));
    feed.onVolume((s, q) => volumes.push([s, q]));
    feed.onMark((m) => marks.push(m.symbol));
    feed.start();
    await flush();
    expect(client.connections.map((c) => c.streams)).toEqual([['!ticker@arr', '!markPrice@arr@1s']]);
    expect(feed.status().connected).toBe(true);
    client.pushRaw('!ticker@arr', [{ s: 'AUSDT', c: '1.5', E: clock.now(), q: '1234' }]);
    client.pushMarks([{ symbol: 'AUSDT', markPrice: 1.4, fundingRate: 0.0001, nextFundingTime: clock.now() + H, time: clock.now() }]);
    expect(prices).toEqual([['AUSDT', 1.5]]);
    expect(volumes).toEqual([['AUSDT', 1234]]);
    expect(marks).toEqual(['AUSDT']);

    client.dropStreams();
    expect(feed.status().connected).toBe(false);
    await timers.advance(1_000);
    expect(client.connections.filter((c) => !c.closed)).toHaveLength(1);
    expect(feed.status()).toMatchObject({ connected: true, reconnects: 1 });

    // Silent for 60 s while open: reconnect.
    await timers.advance(65_000);
    expect(feed.status().reconnects).toBe(2);
    feed.stop();
    expect(timers.pending()).toBe(0);
  });
});
