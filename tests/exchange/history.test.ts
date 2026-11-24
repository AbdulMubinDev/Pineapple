import { describe, expect, it } from 'vitest';
import { barOpenFor, tfToMs } from '../../src/core/timeframe.js';
import type { Candle, Timeframe } from '../../src/core/types.js';
import { FakeExchange } from '../../src/exchange/fake.js';
import { loadHistory } from '../../src/exchange/history.js';
import { CandleRepo } from '../../src/store/candles.js';
import { openDb } from '../../src/store/db.js';
import { makeClock } from './clock.js';

const SYM = 'BTCUSDT';
const H = tfToMs('1h');
// Mid-bar, so the bar containing `now` is still forming.
const START = barOpenFor(1_700_000_000_000, '1h') + 30 * 60_000;
const LAST_CLOSED = barOpenFor(START, '1h') - H;

const mk = (openTime: number): Candle => ({ openTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
/** `n` bars ending at `lastOpen`, plus (optionally) the forming bar after it. */
const series = (n: number, lastOpen = LAST_CLOSED, forming = true): Candle[] => {
  const out = Array.from({ length: n }, (_, i) => mk(lastOpen - (n - 1 - i) * H));
  if (forming) out.push(mk(lastOpen + H));
  return out;
};

function setup(tf: Timeframe = '1h') {
  const clock = makeClock(START);
  const client = new FakeExchange({ now: clock.now, sleep: clock.sleep });
  const repo = new CandleRepo(openDb(':memory:'));
  const load = (bars: number, role?: 'chart' | 'htf') =>
    loadHistory({ client, repo, symbol: SYM, tf, bars, now: clock.now(), ...(role ? { role } : {}) });
  return { clock, client, repo, load };
}

const contiguous = (c: Candle[]): boolean => c.every((x, i) => i === 0 || x.openTime - c[i - 1]!.openTime === H);

describe('loadHistory', () => {
  it('429 backs off and resumes with no duplicates and no gaps', async () => {
    const { clock, client, repo, load } = setup();
    client.setCandles(SYM, '1h', series(5000));
    client.script({ status: 429, retryAfter: 5 });
    const t0 = clock.now();
    const res = await load(3000);
    expect(res).toEqual({ loaded: 3000, available: 3000 });
    expect(clock.now() - t0).toBeGreaterThanOrEqual(5000);
    expect(client.calls[0]?.status).toBe(429);
    const all = repo.range(SYM, '1h', 0, Number.MAX_SAFE_INTEGER);
    expect(all).toHaveLength(3000);
    expect(contiguous(all)).toBe(true);
    expect(all[2999]?.openTime).toBe(LAST_CLOSED);
  });

  it('fetches only the missing tail: one request for 100 missing bars', async () => {
    const { client, repo, load } = setup();
    client.setCandles(SYM, '1h', series(5000));
    repo.upsert(SYM, '1h', series(2900, LAST_CLOSED - 100 * H, false));
    const res = await load(3000);
    expect(client.calls).toHaveLength(1);
    expect(res).toEqual({ loaded: 100, available: 3000 });
    expect(contiguous(repo.range(SYM, '1h', 0, Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it('makes no request when the repo is already current', async () => {
    const { client, repo, load } = setup();
    client.setCandles(SYM, '1h', series(5000));
    repo.upsert(SYM, '1h', series(3000, LAST_CLOSED, false));
    expect(await load(3000)).toEqual({ loaded: 0, available: 3000 });
    expect(client.calls).toHaveLength(0);
  });

  it('young pair reports available < bars', async () => {
    const { client, load } = setup();
    client.setCandles(SYM, '1h', series(800));
    expect(await load(3000)).toEqual({ loaded: 800, available: 800 });
  });

  it('keeps only candles closed by now', async () => {
    const { client, repo, load } = setup();
    client.setCandles(SYM, '1h', series(50)); // includes the forming bar
    await load(50);
    expect(repo.latest(SYM, '1h')?.openTime).toBe(LAST_CLOSED);
  });

  it('discards a stale repo that cannot join the wanted window', async () => {
    const { client, repo, load } = setup();
    client.setCandles(SYM, '1h', series(5000));
    repo.upsert(SYM, '1h', series(10, LAST_CLOSED - 4000 * H, false));
    const res = await load(100);
    expect(res).toEqual({ loaded: 100, available: 100 });
    expect(contiguous(repo.range(SYM, '1h', 0, Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it('backfills the head: 100 stored, 3000 wanted reports available 3000', async () => {
    const { client, repo, load } = setup();
    client.setCandles(SYM, '1h', series(5000));
    repo.upsert(SYM, '1h', series(100, LAST_CLOSED, false));
    expect(await load(3000)).toEqual({ loaded: 2900, available: 3000 });
    expect(contiguous(repo.range(SYM, '1h', 0, Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it('does not chase the head past onboardDate, and a young pair does not refetch forever', async () => {
    const { client, repo, clock, load } = setup();
    client.setCandles(SYM, '1h', series(800));
    const onboardDate = LAST_CLOSED - 799 * H;
    const run = () =>
      loadHistory({ client, repo, symbol: SYM, tf: '1h', bars: 3000, now: clock.now(), onboardDate });
    expect(await run()).toEqual({ loaded: 800, available: 800 });
    const calls = client.calls.length;
    expect(await run()).toEqual({ loaded: 0, available: 800 });
    expect(client.calls.length).toBe(calls); // already current, head limited by the listing date, no holes
    void load;
  });

  it('fills a 10-bar interior hole with one load', async () => {
    const { client, repo, load } = setup();
    const all = series(500, LAST_CLOSED, false);
    client.setCandles(SYM, '1h', all);
    repo.upsert(SYM, '1h', all.filter((_, i) => i < 200 || i >= 210));
    expect(await load(500)).toEqual({ loaded: 10, available: 500 });
    expect(contiguous(repo.range(SYM, '1h', 0, Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it('a genuine exchange gap is refetched once per load, not looped', async () => {
    const { client, load } = setup();
    const all = series(300, LAST_CLOSED, false).filter((_, i) => i < 100 || i >= 105);
    client.setCandles(SYM, '1h', all);
    const res = await load(300);
    expect(res.available).toBe(295);
    const first = client.calls.length;
    await load(300);
    expect(client.calls.length - first).toBeLessThanOrEqual(2); // at most the one bounded window refetch
  });

  it('retention: chart keeps bars + 500, higher timeframe keeps 1050', async () => {
    const chart = setup();
    chart.client.setCandles(SYM, '1h', series(5000));
    chart.repo.upsert(SYM, '1h', series(4000, LAST_CLOSED - 200 * H, false)); // 4000 stored, tail 200 missing
    await chart.load(3000);
    expect(chart.repo.count(SYM, '1h')).toBe(3500);
    expect(chart.repo.latest(SYM, '1h')?.openTime).toBe(LAST_CLOSED);

    const htf = setup();
    htf.client.setCandles(SYM, '1h', series(5000));
    htf.repo.upsert(SYM, '1h', series(2000, LAST_CLOSED - 10 * H, false));
    await htf.load(1000, 'htf');
    expect(htf.repo.count(SYM, '1h')).toBe(1050);
  });
});
