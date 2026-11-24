import { describe, expect, it } from 'vitest';
import { budgetedGet, klineWeight, RestBudget } from '../../src/exchange/budget.js';
import { BinanceClient } from '../../src/exchange/binance.js';
import { FakeExchange } from '../../src/exchange/fake.js';
import { makeClock } from './clock.js';

const mkBudget = (limitPerMin = 1200) => {
  const clock = makeClock();
  return { clock, budget: new RestBudget({ limitPerMin, now: clock.now, sleep: clock.sleep }) };
};

describe('RestBudget', () => {
  it('budget never exceeds limit: 200 x weight 10 under 1200/min', async () => {
    const { clock, budget } = mkBudget();
    const charged: { t: number; w: number }[] = [];
    for (let i = 0; i < 200; i++) {
      await budget.acquire(10);
      charged.push({ t: clock.now(), w: 10 });
    }
    for (const { t } of charged) {
      const sum = charged.filter((c) => c.t > t - 60_000 && c.t <= t).reduce((s, c) => s + c.w, 0);
      expect(sum).toBeLessThanOrEqual(1200);
    }
    expect(clock.sleeps.length).toBeGreaterThan(0); // it really did have to wait
  });

  it('waits for server-reported usage (X-MBX-USED-WEIGHT-1M)', async () => {
    const { clock, budget } = mkBudget();
    budget.observe(1195);
    const t0 = clock.now();
    await budget.acquire(10);
    expect(clock.now() - t0).toBeGreaterThanOrEqual(60_000);
  });

  it('server floor counts our later charges: observe(1000) then 50 concurrent acquire(10)', async () => {
    const { clock, budget } = mkBudget();
    const t0 = clock.now();
    budget.observe(1000);
    const done: number[] = [];
    await Promise.all(Array.from({ length: 50 }, () => budget.acquire(10).then(() => done.push(clock.now()))));
    expect(done.filter((t) => t < t0 + 60_000).length).toBeLessThanOrEqual(20);
  });

  it('backoff pauses the next acquire for the full duration', async () => {
    const { clock, budget } = mkBudget();
    budget.backoff(5000);
    const t0 = clock.now();
    await budget.acquire(1);
    expect(clock.now() - t0).toBeGreaterThanOrEqual(5000);
  });

  it('418 pauses all REST for the full Retry-After and raises the banned flag', async () => {
    const clock = makeClock();
    const fake = new FakeExchange({ now: clock.now, sleep: clock.sleep });
    fake.setCandles('BTCUSDT', '1h', []);
    fake.script({ status: 418, retryAfter: 120 });
    expect(fake.budget.banned).toBe(false);
    const t0 = clock.now();
    await fake.klines('BTCUSDT', '1h', 0, 3_600_000 * 10);
    expect(fake.calls[0]?.status).toBe(418);
    expect(fake.calls[1]?.time).toBeGreaterThanOrEqual(t0 + 120_000);
    expect(fake.budget.banned).toBe(false); // ban elapsed on the fake clock
    fake.budget.ban(30_000);
    expect(fake.budget.banned).toBe(true);
    const t1 = clock.now();
    await fake.budget.acquire(1);
    expect(clock.now() - t1).toBeGreaterThanOrEqual(30_000);
  });

  it('rejects a single call heavier than the whole limit', async () => {
    const { budget } = mkBudget(100);
    await expect(budget.acquire(101)).rejects.toThrow(/exceeds/);
  });
});

describe('budgetedGet', () => {
  const res = (status: number, h: Record<string, string> = {}, body: unknown = []) => ({ status, headers: new Headers(h), body });

  it('429 without Retry-After defaults to 60 s, then succeeds', async () => {
    const { clock, budget } = mkBudget();
    const replies = [res(429), res(200, {}, { ok: 1 })];
    const t0 = clock.now();
    expect(await budgetedGet(budget, 1, () => Promise.resolve(replies.shift()!))).toEqual({ ok: 1 });
    expect(clock.now() - t0).toBeGreaterThanOrEqual(60_000);
  });

  it('reads the used-weight header, and gives up after repeated 429s', async () => {
    const { clock, budget } = mkBudget();
    await budgetedGet(budget, 1, () => Promise.resolve(res(200, { 'X-MBX-USED-WEIGHT-1M': '1199' })));
    const t0 = clock.now();
    await budget.acquire(5); // server says 1199 used, so this must wait out the window
    expect(clock.now() - t0).toBeGreaterThanOrEqual(59_000);
    await expect(budgetedGet(budget, 1, () => Promise.resolve(res(429, { 'Retry-After': '1' })))).rejects.toThrow(/gave up/);
  });

  it('throws on other non-2xx statuses and on non-JSON bodies', async () => {
    const { budget } = mkBudget();
    await expect(budgetedGet(budget, 1, () => Promise.resolve(res(500)))).rejects.toThrow('HTTP 500');
    await expect(budgetedGet(budget, 1, () => Promise.resolve(res(200, {}, null)))).rejects.toThrow(/not JSON/);
  });
});

describe('klineWeight', () => {
  it('maps limit to weight', () => {
    expect([1, 99, 100, 499, 500, 1000, 1001, 1500].map(klineWeight)).toEqual([1, 1, 2, 2, 5, 5, 10, 10]);
  });
});

describe('BinanceClient REST', () => {
  it('routes klines through the budget with the page weight and reads headers', async () => {
    const clock = makeClock();
    const budget = new RestBudget({ limitPerMin: 1200, now: clock.now, sleep: clock.sleep });
    const urls: string[] = [];
    const weights: number[] = [];
    const realAcquire = budget.acquire.bind(budget);
    budget.acquire = (w: number) => {
      weights.push(w);
      return realAcquire(w);
    };
    const client = new BinanceClient({
      budget,
      now: clock.now,
      get: (url) => {
        urls.push(url);
        return Promise.resolve({ status: 200, headers: new Headers({ 'x-mbx-used-weight-1m': '1190' }), body: [] });
      },
    });
    await client.klines('BTCUSDT', '1h', 0, 3_600_000 * 2000);
    await client.fundingHistory('BTCUSDT', 0, 1);
    expect(urls[0]).toContain('limit=1500');
    expect(urls[1]).toContain('/fapi/v1/fundingRate');
    // Server reported 1190 used after the funding call (weight 1 charged on top of the 10 for klines):
    // the server floor is 1190 + 0 later charges, so a weight-20 call must wait out the 60 s window.
    const t0 = clock.now();
    await budget.acquire(20);
    expect(clock.now() - t0).toBeGreaterThanOrEqual(59_000);
    expect(clock.now() - t0).toBeLessThanOrEqual(60_000);
    // 1500-bar kline page costs 10; funding costs 1 (the spy saw both before our own acquire(20)).
    expect(weights.slice(0, 2)).toEqual([10, 1]);
  });
});
