import { describe, expect, it } from 'vitest';
import type { FundingEvent } from '../../src/core/types.js';
import type { MarkUpdate } from '../../src/exchange/client.js';
import { FakeExchange } from '../../src/exchange/fake.js';
import { FundingTracker } from '../../src/exchange/funding.js';
import { FundingRepo } from '../../src/store/candles.js';
import { openDb } from '../../src/store/db.js';
import { makeClock } from './clock.js';

const H8 = 8 * 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H8); // an 8h boundary
const MIN = 60_000;

const ev = (time: number, rate = 0.0001): FundingEvent => ({ time, rate, markPrice: 100 });
const mark = (symbol: string, nextFundingTime: number): MarkUpdate => ({ symbol, markPrice: 100, fundingRate: 0.0001, nextFundingTime, time: 0 });

function setup(start = T0 - H8 / 2) {
  const clock = makeClock(start);
  const client = new FakeExchange({ now: clock.now, sleep: clock.sleep });
  const repo = new FundingRepo(openDb(':memory:'));
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const tracker = new FundingTracker({ client, repo, now: clock.now, log: (event, data) => logs.push({ event, data }) });
  const fundingCalls = () => client.calls.filter((c) => c.url.includes('/fapi/v1/fundingRate'));
  return { clock, client, repo, tracker, logs, fundingCalls };
}

describe('FundingTracker', () => {
  it('fetches each funding event once', async () => {
    const { clock, client, repo, tracker, fundingCalls } = setup();
    client.setFunding('BTCUSDT', [ev(T0, 0.0003)]);
    tracker.onMark(mark('BTCUSDT', T0));
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([]);
    expect(fundingCalls()).toHaveLength(0);
    clock.set(T0 + 5_000);
    const got = await tracker.due(['BTCUSDT'], clock.now());
    expect(got).toEqual([{ symbol: 'BTCUSDT', event: ev(T0, 0.0003) }]);
    expect(repo.range('BTCUSDT', T0, T0)).toHaveLength(1);
    expect(fundingCalls()).toHaveLength(1);
    expect(fundingCalls()[0]?.url).toContain(`startTime=${T0 - 1000}&endTime=${T0 + 60_000}`);
    // The mark stream moves on to the next funding; the old event is never returned or fetched again.
    tracker.onMark(mark('BTCUSDT', T0 + H8));
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([]);
    tracker.onMark(mark('BTCUSDT', T0));
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([]);
    expect(fundingCalls()).toHaveLength(1);
  });

  it('retries an unpublished event, then logs funding_missing after 10 min', async () => {
    const { clock, client, tracker, logs, fundingCalls } = setup();
    tracker.onMark(mark('BTCUSDT', T0));
    clock.set(T0 + 1_000);
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([]);
    clock.set(T0 + 5 * MIN);
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([]);
    expect(fundingCalls()).toHaveLength(2);
    expect(logs).toEqual([]);
    // It is published late, within the window: picked up on the next call.
    client.setFunding('BTCUSDT', [ev(T0)]);
    clock.set(T0 + 6 * MIN);
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([{ symbol: 'BTCUSDT', event: ev(T0) }]);

    // Another symbol never publishes.
    tracker.onMark(mark('ETHUSDT', T0));
    clock.set(T0 + 7 * MIN);
    await tracker.due(['ETHUSDT'], clock.now());
    clock.set(T0 + 10 * MIN + 1);
    expect(await tracker.due(['ETHUSDT'], clock.now())).toEqual([]);
    expect(logs).toEqual([{ event: 'funding_missing', data: { symbol: 'ETHUSDT', time: T0 } }]);
    const n = fundingCalls().length;
    clock.set(T0 + 12 * MIN);
    await tracker.due(['ETHUSDT'], clock.now());
    expect(fundingCalls()).toHaveLength(n);
    expect(logs).toHaveLength(1);
  });

  it('only asks for given symbols', async () => {
    const { clock, client, tracker, fundingCalls } = setup();
    for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      client.setFunding(s, [ev(T0)]);
      tracker.onMark(mark(s, T0));
    }
    clock.set(T0 + 1_000);
    const got = await tracker.due(['ETHUSDT'], clock.now());
    expect(got.map((g) => g.symbol)).toEqual(['ETHUSDT']);
    expect(fundingCalls().every((c) => c.url.includes('symbol=ETHUSDT'))).toBe(true);
    expect(fundingCalls()).toHaveLength(1);
  });

  it('keeps passed funding times, so a late onMark cannot skip an event', async () => {
    const { clock, client, tracker } = setup();
    client.setFunding('BTCUSDT', [ev(T0)]);
    tracker.onMark(mark('BTCUSDT', T0));
    // The funding passes, and the mark stream moves on before anyone asked for it.
    clock.set(T0 + 2 * MIN);
    tracker.onMark(mark('BTCUSDT', T0 + H8));
    const got = await tracker.due(['BTCUSDT'], clock.now());
    expect(got.map((g) => g.event.time)).toEqual([T0]);
  });

  it('does not return an event already stored (restart)', async () => {
    const { clock, client, repo, tracker, fundingCalls } = setup();
    repo.upsert('BTCUSDT', [ev(T0)]);
    client.setFunding('BTCUSDT', [ev(T0)]);
    tracker.onMark(mark('BTCUSDT', T0));
    clock.set(T0 + 1_000);
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([]);
    expect(fundingCalls()).toHaveLength(0);
  });

  it('passes a markPrice of 0 through unchanged', async () => {
    const { clock, client, tracker } = setup();
    client.setFunding('BTCUSDT', [{ time: T0, rate: 0.0001, markPrice: 0 }]);
    tracker.onMark(mark('BTCUSDT', T0));
    clock.set(T0 + 1_000);
    expect((await tracker.due(['BTCUSDT'], clock.now()))[0]?.event.markPrice).toBe(0);
  });

  it('returns nothing for a symbol with no known funding time', async () => {
    const { clock, tracker, fundingCalls } = setup();
    clock.set(T0 + 1_000);
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([]);
    expect(fundingCalls()).toHaveLength(0);
  });

  it('primeFromInterval derives the next funding times from the last stored event', async () => {
    const { clock, client, tracker } = setup(T0 + 1_000);
    client.setFunding('BTCUSDT', [ev(T0), ev(T0 + H8 / 2)]);
    tracker.primeFromInterval('BTCUSDT', T0 - H8 / 2, 4);
    // T0 is past and is fetched; T0 + 4h is still in the future and is tracked too.
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([{ symbol: 'BTCUSDT', event: ev(T0) }]);
    clock.set(T0 + H8 / 2 + 1_000);
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([{ symbol: 'BTCUSDT', event: ev(T0 + H8 / 2) }]);
  });

  it('caps fundingHistory at 400 calls per rolling 5 minutes and defers the rest', async () => {
    const { clock, client, tracker, fundingCalls } = setup();
    const syms = Array.from({ length: 450 }, (_, i) => `S${i}USDT`);
    for (const s of syms) {
      client.setFunding(s, [ev(T0)]);
      tracker.onMark(mark(s, T0));
    }
    clock.set(T0 + 1_000);
    const first = await tracker.due(syms, clock.now());
    expect(first).toHaveLength(400);
    expect(fundingCalls()).toHaveLength(400);
    // Still inside the 5 minute window: nothing more goes out, and nothing throws.
    expect(await tracker.due(syms, clock.now())).toEqual([]);
    expect(fundingCalls()).toHaveLength(400);
    // The window rolls; the deferred 50 are fetched.
    clock.set(T0 + 1_000 + 5 * MIN + 1);
    const rest = await tracker.due(syms, clock.now());
    expect(rest.map((r) => r.symbol)).toEqual(syms.slice(400));
    expect(fundingCalls()).toHaveLength(450);
  });

  it('keeps a pending event after a failed fetch and retries it', async () => {
    const { clock, client, tracker, logs } = setup();
    client.setFunding('BTCUSDT', [ev(T0)]);
    tracker.onMark(mark('BTCUSDT', T0));
    clock.set(T0 + 1_000);
    client.script({ status: 500 });
    expect(await tracker.due(['BTCUSDT'], clock.now())).toEqual([]);
    expect(logs.map((l) => l.event)).toEqual(['funding_fetch_failed']);
    expect(await tracker.due(['BTCUSDT'], clock.now())).toHaveLength(1);
  });

  it('range delegates to the repo', async () => {
    const { clock, client, tracker } = setup();
    client.setFunding('BTCUSDT', [ev(T0)]);
    tracker.onMark(mark('BTCUSDT', T0));
    clock.set(T0 + 1_000);
    await tracker.due(['BTCUSDT'], clock.now());
    expect(tracker.range('BTCUSDT', T0 - 1, T0 + 1)).toEqual([ev(T0)]);
  });
});
