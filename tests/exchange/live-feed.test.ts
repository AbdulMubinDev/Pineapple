import { describe, expect, it } from 'vitest';
import { barOpenFor, tfToMs } from '../../src/core/timeframe.js';
import type { Candle } from '../../src/core/types.js';
import type { MarkUpdate } from '../../src/exchange/client.js';
import { FakeExchange } from '../../src/exchange/fake.js';
import { loadHistory } from '../../src/exchange/history.js';
import { LiveFeed, MissingBarsError, RepoBehindError } from '../../src/exchange/live-feed.js';
import { CandleRepo } from '../../src/store/candles.js';
import { NetworkError } from '../../src/net/http.js';
import { openDb } from '../../src/store/db.js';
import { flush, makeClock, makeTimers } from './clock.js';

const TF = '15m' as const;
const STEP = tfToMs(TF);
// One minute into a bar: B0 is the last close before the feed starts, B1 the next one.
const B0 = barOpenFor(1_700_000_000_000, TF);
const START = B0 + 60_000;
const B1 = B0 + STEP;
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const SEC = 1000;
/** Kline silence (60 s) plus one watchdog tick (5 s). */
const SILENCE_PLUS_TICK = 65_000;

/** Stream bars close at 1.5; REST bars close at 9, so tests can tell which source a bar came from. */
const streamBar = (openTime: number): Candle => ({ openTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
const restBar = (openTime: number): Candle => ({ openTime, open: 8, high: 10, low: 7, close: 9, volume: 4 });

/** `repoLast` overrides the last stored openTime per symbol (default: the bar that closed at B0). */
function setup(symbols = SYMS, repoLast: Record<string, number> = {}, lastCloseTime?: number) {
  const clock = makeClock(START);
  const timers = makeTimers(clock);
  const client = new FakeExchange({ now: clock.now, sleep: clock.sleep });
  const repo = new CandleRepo(openDb(':memory:'));
  for (const s of symbols) {
    // REST knows the whole day (fetchKlines only serves bars that have closed by `now`).
    client.setCandles(s, TF, Array.from({ length: 200 }, (_, i) => restBar(B0 - 100 * STEP + i * STEP)));
    // Repo is warm up to and including the bar that closed at B0 (openTime B0 - STEP).
    const last = repoLast[s] ?? B0 - STEP;
    repo.upsert(s, TF, Array.from({ length: 10 }, (_, i) => restBar(last - (9 - i) * STEP)));
  }
  const feed = new LiveFeed({
    client,
    repo,
    tf: TF,
    symbols,
    now: clock.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(lastCloseTime === undefined ? {} : { lastCloseTime }),
  });
  const closes: { closeTime: number; bars: Map<string, Candle>; missing: string[]; behind: string[]; at: number }[] = [];
  feed.onClose((closeTime, bars, info) => {
    closes.push({ closeTime, bars, missing: info.missing, behind: info.behind, at: clock.now() });
  });
  const errors: unknown[] = [];
  feed.onError((e) => errors.push(e));
  /** Advance to `t` (absolute). */
  const to = (t: number) => timers.advance(t - clock.now());
  const pushAll = (openTime: number, syms = symbols) => {
    for (const s of syms) client.pushKline(s, TF, streamBar(openTime));
  };
  return { clock, timers, client, repo, feed, closes, errors, to, pushAll };
}

/** What BinanceClient throws for a fetch-level failure (DNS, reset, timeout). */
const fetchFailed = () => new NetworkError('fapi.binance.com/fapi/v1/klines', new TypeError('fetch failed'));
const symbolOf = (url: string) => new URL(url).searchParams.get('symbol');
const limitOf = (url: string) => new URL(url).searchParams.get('limit');

const contiguous =(c: Candle[]): boolean => c.every((x, i) => i === 0 || x.openTime - c[i - 1]!.openTime === STEP);
const all = (repo: CandleRepo, s: string) => repo.range(s, TF, 0, Number.MAX_SAFE_INTEGER);

describe('LiveFeed', () => {
  it("emits one close with every symbol's bar", async () => {
    const { client, repo, feed, closes, to, pushAll } = setup();
    feed.start();
    await flush();
    expect(feed.status().connected).toBe(true);

    await to(B1 + 400);
    client.pushKline('BTCUSDT', TF, { ...streamBar(B0), close: 1.7 }, false); // still forming: ignored
    pushAll(B0);
    await flush();

    expect(closes).toHaveLength(1);
    expect(closes[0]!.closeTime).toBe(B1);
    expect([...closes[0]!.bars.keys()].sort()).toEqual([...SYMS].sort());
    for (const s of SYMS) {
      expect(closes[0]!.bars.get(s)).toEqual(streamBar(B0));
      expect(repo.latest(s, TF)).toEqual(streamBar(B0));
      expect(contiguous(all(repo, s))).toBe(true);
    }
    expect(client.calls).toHaveLength(0); // no REST needed

    // Binance repeats the final kline: it never fires again.
    pushAll(B0);
    await to(B1 + 10 * SEC);
    expect(closes).toHaveLength(1);
    feed.stop();
  });

  it('missing symbol is backfilled over REST within 3 s', async () => {
    const { clock, client, feed, closes, to, pushAll } = setup();
    feed.start();
    // B1 closes normally; B2 is the one under test (no post-open catch-up timer is pending by then).
    const B2 = B1 + STEP;
    for (let t = START + 30 * SEC; t < B2; t += 30 * SEC) {
      await to(t);
      client.pushKline('BTCUSDT', TF, streamBar(barOpenFor(t, TF)), false); // healthy forming-kline traffic
      if (t === B1) pushAll(B0); // B1's closed klines, on time
    }
    expect(closes.map((c) => c.closeTime)).toEqual([B1]);
    await to(B2 + 500);
    pushAll(B1, ['BTCUSDT', 'ETHUSDT']);
    const first = clock.now();
    await to(first + 2900);
    expect(closes).toHaveLength(1);
    expect(client.connections).toHaveLength(1); // a healthy feed never reconnected
    await to(first + 3000);
    expect(closes).toHaveLength(2);
    expect(closes[1]!.at).toBe(first + 3000);
    const bars = closes[1]!.bars;
    expect(bars.get('BTCUSDT')).toEqual(streamBar(B1));
    expect(bars.get('SOLUSDT')).toEqual(restBar(B1));
    expect(closes[1]!.missing).toEqual([]);
    expect(client.calls.map((c) => new URL(c.url).searchParams.get('symbol'))).toEqual(['SOLUSDT']);
    feed.stop();
  });

  it('stale socket reconnects and backfills the gap', async () => {
    const { client, repo, feed, closes, to, pushAll } = setup();
    const catchingUpAtClose: boolean[] = [];
    feed.onClose(() => {
      catchingUpAtClose.push(feed.status().catchingUp);
    });
    feed.start();
    await to(B1 + 500);
    pushAll(B0);
    await flush();
    expect(closes.map((c) => c.closeTime)).toEqual([B1]);
    const connectionsBefore = client.connections.length;

    // Silence: no message of any kind for two closes plus 30 s.
    const B2 = B1 + STEP;
    const B3 = B2 + STEP;
    let staleSeen = false;
    // Silence for two closes plus 30 s, plus one watchdog tick (5 s).
    for (let t = B1 + 10 * SEC; t <= B3 + 35 * SEC; t += 5 * SEC) {
      await to(t);
      staleSeen ||= feed.status().stale;
    }
    expect(staleSeen).toBe(true);
    expect(catchingUpAtClose).toEqual([false, true, true]); // the missed closes fired while catching up
    expect(client.connections.length).toBeGreaterThan(connectionsBefore); // reconnected
    // Every missed close fired once, in order, from REST.
    expect(closes.map((c) => c.closeTime)).toEqual([B1, B2, B3]);
    expect(closes[1]!.bars.get('ETHUSDT')).toEqual(restBar(B1));
    expect(closes[2]!.bars.get('ETHUSDT')).toEqual(restBar(B2));
    expect(feed.status().stale).toBe(true); // sockets still silent

    // Ticker traffic alone does not clear stale; a kline event on the new connection does.
    client.pushTickers([{ symbol: 'BTCUSDT', last: 100 }]);
    await flush();
    expect(feed.status().stale).toBe(true);
    client.pushKline('BTCUSDT', TF, streamBar(B3), false);
    await flush();
    expect(feed.status()).toMatchObject({ connected: true, stale: false, catchingUp: false, missing: [] });

    // A replayed final kline after the reconnect does not fire again.
    pushAll(B2);
    await to(B3 + 60 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B1, B2, B3]);
    for (const s of SYMS) expect(contiguous(all(repo, s))).toBe(true);
    feed.stop();
  });

  it('disconnect reconnects with backoff and emits closes missed while down', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    feed.start();
    await flush();
    client.dropStreams();
    expect(feed.status().connected).toBe(false);
    client.autoOpenStreams = false;
    await to(B1 + 2 * SEC);
    pushAll(B0); // nobody is listening
    client.autoOpenStreams = true;
    await to(B1 + 2 * 60 * SEC);
    expect(feed.status().connected).toBe(true);
    expect(closes.map((c) => c.closeTime)).toEqual([B1]);
    expect(closes[0]!.bars.get('BTCUSDT')).toEqual(restBar(B0));
    feed.stop();
  });

  it('reconnects proactively before Binance drops the connection at 24 h', async () => {
    const { client, feed, closes, to } = setup(['BTCUSDT']);
    feed.start();
    await flush();
    const first = client.connections.length;
    // Keep the socket chatty (tickers and a forming kline every 30 s, each close's kline on time) so only the age rule can trigger.
    const end = START + 23 * 3_600_000 + 60 * SEC;
    for (let t = START; t < end; t += 30 * SEC) {
      await to(t);
      client.pushTickers([{ symbol: 'BTCUSDT', last: 1 }]);
      client.pushKline('BTCUSDT', TF, streamBar(barOpenFor(t, TF)), false);
      if ((t - B0) % STEP === 0) client.pushKline('BTCUSDT', TF, streamBar(t - STEP));
      if (t < START + 23 * 3_600_000 - 60 * SEC) expect(client.connections.length).toBe(first);
    }
    expect(client.connections.length).toBe(first * 2);
    expect(client.connections.slice(0, first).every((c) => c.closed)).toBe(true);
    // Every close across the rotation fired once, in order, from the stream.
    const expected: number[] = [];
    for (let c = B1; c <= barOpenFor(end - 30 * SEC, TF); c += STEP) expected.push(c);
    expect(closes.map((c) => c.closeTime)).toEqual(expected);
    expect(closes.every((c) => c.bars.get('BTCUSDT')?.close === 1.5)).toBe(true);
    expect(feed.status().stale).toBe(false);
    feed.stop();
  });

  it('streams split at 200 per connection', async () => {
    const syms = Array.from({ length: 450 }, (_, i) => `S${i}USDT`);
    const clock = makeClock(START);
    const timers = makeTimers(clock);
    const client = new FakeExchange({ now: clock.now, sleep: clock.sleep });
    const feed = new LiveFeed({ client, repo: new CandleRepo(openDb(':memory:')), tf: TF, symbols: syms, now: clock.now, setTimer: timers.setTimer });
    feed.start();
    await flush();
    expect(client.connections).toHaveLength(3);
    expect(client.connections.map((c) => c.streams.length)).toEqual([200, 200, 52]);
    const streams = client.connections.flatMap((c) => c.streams);
    expect(streams).toContain('!ticker@arr');
    expect(streams).toContain('!markPrice@arr@1s');
    expect(streams).toContain('s0usdt@kline_15m');
    expect(new Set(streams).size).toBe(452);
    feed.stop();
    expect(client.connections.every((c) => c.closed)).toBe(true);
  });

  it('setSymbols reconnects with the new stream list and keeps the close sequence', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    feed.start();
    await flush();
    feed.setSymbols(['BTCUSDT', 'ETHUSDT']);
    await flush();
    const live = client.connections.filter((c) => !c.closed);
    expect(live).toHaveLength(1);
    expect(live[0]!.streams).not.toContain('solusdt@kline_15m');
    await to(B1 + 500);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await flush();
    expect(closes.map((c) => [...c.bars.keys()].sort())).toEqual([['BTCUSDT', 'ETHUSDT']]);
    feed.stop();
  });

  it('emits last prices and marks for its own symbols only', async () => {
    const { client, feed } = setup();
    const prices: [string, number, number][] = [];
    const marks: MarkUpdate[] = [];
    feed.onPrice((s, last, time) => prices.push([s, last, time]));
    feed.onMark((m) => marks.push(m));
    feed.start();
    await flush();
    client.pushTickers([
      { symbol: 'BTCUSDT', last: 101.5 },
      { symbol: 'DOGEUSDT', last: 0.1 }, // another timeframe's pair
    ]);
    client.pushRaw('!ticker@arr', [{ s: 'ETHUSDT', c: 'oops', E: 1 }]); // malformed: skipped
    const m: MarkUpdate = { symbol: 'ETHUSDT', markPrice: 2000.5, fundingRate: 0.0001, nextFundingTime: B0 + 8 * 3_600_000, time: START };
    client.pushMarks([m, { ...m, symbol: 'DOGEUSDT' }]);
    await flush();
    expect(prices).toEqual([['BTCUSDT', 101.5, START]]);
    expect(marks).toEqual([m]);
    feed.stop();
  });

  it('a closed kline with a gap behind it is written only after the gap is backfilled', async () => {
    // ETHUSDT's repo stops three bars short of the bar before the stream bar.
    const { client, repo, feed, closes, to, pushAll } = setup(SYMS, { ETHUSDT: B0 - 4 * STEP });
    feed.start();
    await to(B1 + 500);
    pushAll(B0);
    await flush();
    expect(closes).toHaveLength(1);
    const eth = all(repo, 'ETHUSDT');
    expect(eth.slice(-5).map((c) => c.openTime)).toEqual([B0 - 4 * STEP, B0 - 3 * STEP, B0 - 2 * STEP, B0 - STEP, B0]);
    expect(contiguous(eth)).toBe(true);
    expect(eth.at(-1)).toEqual(streamBar(B0)); // the stream bar itself, after its backfilled gap
    expect(client.calls.map((c) => new URL(c.url).searchParams.get('symbol'))).toEqual(['ETHUSDT']);
    feed.stop();
  });

  it('crash between stream write and backfill leaves a repo the next loadHistory makes contiguous', async () => {
    const { clock, client, repo, feed, closes, to, pushAll } = setup(SYMS, { ETHUSDT: B0 - 4 * STEP });
    // Kill during the backfill: the gap's REST call fails, then the process dies before any retry.
    client.script({ status: 500 });
    feed.start();
    await to(B1 + 500);
    pushAll(B0);
    await flush();
    feed.stop(); // process killed
    expect(closes).toHaveLength(0);
    // The stream bar was not written ahead of its missing gap (carry 3a).
    expect(repo.latest('ETHUSDT', TF)!.openTime).toBe(B0 - 4 * STEP);

    // Worst case anyway (an older build, or a write that raced the kill): the stream bar sits past a hole.
    repo.upsert('ETHUSDT', TF, [streamBar(B0)]);
    expect(contiguous(all(repo, 'ETHUSDT'))).toBe(false);

    // Restart: a fresh loadHistory on that repo leaves the window contiguous.
    const fresh = new FakeExchange({ now: clock.now, sleep: clock.sleep });
    fresh.setCandles('ETHUSDT', TF, Array.from({ length: 200 }, (_, i) => restBar(B0 - 100 * STEP + i * STEP)));
    const res = await loadHistory({ client: fresh, repo, symbol: 'ETHUSDT', tf: TF, bars: 10, now: clock.now() });
    const window = repo.range('ETHUSDT', TF, B0 - 9 * STEP, B0);
    expect(res.available).toBe(10);
    expect(window).toHaveLength(10);
    expect(contiguous(window)).toBe(true);
  });

  it('REST with no bar yet is retried and the close is emitted complete within the deadline', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    client.scriptKlines('SOLUSDT', 'empty', 'empty');
    feed.start();
    await to(B1 + 500);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 12 * SEC);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.missing).toEqual([]);
    expect(closes[0]!.bars.get('SOLUSDT')).toEqual(restBar(B0));
    expect(closes[0]!.at).toBeLessThanOrEqual(B1 + 10 * SEC);
    expect(client.calls.filter((c) => c.url.includes('SOLUSDT'))).toHaveLength(3);
    feed.stop();
  });

  it('a bar that never appears is emitted as missing, never dropped silently', async () => {
    const { client, feed, closes, errors, to, pushAll } = setup();
    client.setCandles('SOLUSDT', TF, []);
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 15 * SEC);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.missing).toEqual(['SOLUSDT']);
    expect([...closes[0]!.bars.keys()].sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(closes[0]!.at).toBeLessThanOrEqual(B1 + 10 * SEC);
    expect(errors.some((e) => e instanceof MissingBarsError && e.symbols.join() === 'SOLUSDT' && e.closeTime === B1)).toBe(true);
    expect(feed.status().missing).toEqual(['SOLUSDT']);
    // First fetch plus 2 retry rounds; the 3 s round would not fit its fetch allowance before the deadline.
    expect(client.calls.filter((c) => c.url.includes('SOLUSDT'))).toHaveLength(3);
    feed.stop();
  });

  it('tickers alive but klines dead: stale until klines return', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    feed.start();
    await to(B1 + 500);
    pushAll(B0);
    await flush();
    const B2 = B1 + STEP;
    let staleAt = 0;
    for (let t = B1 + 5 * SEC; t <= B2 + 40 * SEC; t += 5 * SEC) {
      await to(t);
      client.pushTickers([{ symbol: 'BTCUSDT', last: 1 }]);
      if (feed.status().stale && staleAt === 0) staleAt = t;
      if (staleAt > 0) expect(feed.status().stale).toBe(true);
    }
    expect(staleAt).toBeGreaterThan(0);
    expect(staleAt).toBeLessThanOrEqual(B1 + 500 + SILENCE_PLUS_TICK);
    expect(closes.map((c) => c.closeTime)).toEqual([B1, B2]); // B2 came over REST
    client.pushKline('ETHUSDT', TF, streamBar(B2), false);
    await flush();
    expect(feed.status().stale).toBe(false);
    feed.stop();
  });

  it('setSymbols just before a close: old sockets keep delivering until the new ones open, no duplicate', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    feed.start();
    await to(B1 - 500);
    client.autoOpenStreams = false;
    feed.setSymbols(['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']); // only the old connection is open
    await flush();
    expect(closes.map((c) => c.closeTime)).toEqual([B1]);
    expect(closes[0]!.at).toBeLessThanOrEqual(B1 + 3 * SEC);
    client.openPending();
    await flush();
    expect(client.connections.filter((c) => !c.closed)).toHaveLength(1);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']); // replay on the new socket
    await to(B1 + 60 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B1]);
    feed.stop();
  });

  it('setSymbols just before a close whose klines are lost in the switch: emitted by close + 3 s', async () => {
    const { feed, closes, to } = setup();
    feed.start();
    await to(B1 - 500);
    feed.setSymbols(['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 3 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B1]);
    expect(closes[0]!.missing).toEqual([]);
    await to(B1 + 60 * SEC);
    expect(closes).toHaveLength(1);
    feed.stop();
  });

  it('one symbol rejected with 400 is reported missing; the others close on time', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    client.failKlines('ETHUSDT', 400);
    feed.start();
    const B2 = B1 + STEP;
    const B3 = B2 + STEP;
    for (const c of [B1, B2, B3]) {
      await to(c + 300);
      pushAll(c - STEP, ['BTCUSDT', 'SOLUSDT']);
      await to(c + 4 * SEC);
    }
    expect(closes.map((c) => c.closeTime)).toEqual([B1, B2, B3]);
    for (const [i, c] of closes.entries()) {
      expect(c.missing).toEqual(['ETHUSDT']);
      expect(c.at).toBeLessThanOrEqual([B1, B2, B3][i]! + 3500);
      expect(c.bars.get('BTCUSDT')).toEqual(streamBar(c.closeTime - STEP));
    }
    feed.stop();
  });

  it('a repo 3 days behind costs a bounded number of requests and is left to loadHistory', async () => {
    const behind = B0 - 3 * 96 * STEP;
    const { client, repo, feed, closes, errors, to, pushAll } = setup(SYMS, { ETHUSDT: behind });
    feed.start();
    await to(B1 + 500);
    pushAll(B0);
    await flush();
    expect(closes).toHaveLength(1);
    expect(closes[0]!.bars.get('ETHUSDT')).toEqual(streamBar(B0));
    expect(client.calls).toHaveLength(0);
    expect(repo.latest('ETHUSDT', TF)!.openTime).toBe(behind); // nothing stored past the hole (3a)
    expect(errors.filter((e) => e instanceof RepoBehindError)).toHaveLength(1);
    expect(closes[0]!.behind).toEqual(['ETHUSDT']);
    expect(closes[0]!.missing).toEqual([]);
    expect(feed.status().behind).toEqual(['ETHUSDT']);
    feed.stop();
  });

  it('12 symbols that never appear still emit within the deadline, all reported missing', async () => {
    const syms = Array.from({ length: 15 }, (_, i) => `S${i}USDT`);
    const gone = syms.slice(3);
    const { client, feed, closes, to, pushAll } = setup(syms);
    for (const s of gone) client.setCandles(s, TF, []);
    feed.start();
    await to(B1 + 300);
    pushAll(B0, syms.slice(0, 3));
    await to(B1 + 20 * SEC);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.missing.sort()).toEqual([...gone].sort());
    expect(closes[0]!.at).toBeLessThanOrEqual(B1 + 300 + 10 * SEC);
    // One shared set of retry rounds, not one per symbol: at most 1 + 3 calls each.
    for (const s of gone) expect(client.calls.filter((c) => c.url.includes(`symbol=${s}&`)).length).toBeLessThanOrEqual(4);
    feed.stop();
  });

  it('retry rounds stop at the pass deadline even when REST is slow', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    client.setCandles('SOLUSDT', TF, []);
    client.script({ status: 429, retryAfter: 3 }); // the first fetch spends 3 s in back-off
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 20 * SEC);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.missing).toEqual(['SOLUSDT']);
    expect(closes[0]!.at).toBeLessThanOrEqual(B1 + 300 + 10 * SEC);
    feed.stop();
  });

  it('after a failed batch, a close that becomes complete still waits RETRY_MS', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    client.failKlines('SOLUSDT', 503);
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 3500); // the 3 s deadline batch failed at B1 + 3.3 s
    expect(feed.status().catchingUp).toBe(true);
    pushAll(B0, ['SOLUSDT']); // now complete from the stream alone
    await to(B1 + 5 * SEC);
    expect(closes).toHaveLength(0);
    await to(B1 + 15 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B1]);
    expect(closes[0]!.bars.get('SOLUSDT')).toEqual(streamBar(B0));
    feed.stop();
  });

  it('a permanent exchange hole 20 bars back costs one fetch and no retries', async () => {
    const hole = B0 - 20 * STEP;
    const { client, feed, closes, to, pushAll } = setup(SYMS, { ETHUSDT: hole - STEP });
    client.setCandles(
      'ETHUSDT',
      TF,
      Array.from({ length: 200 }, (_, i) => restBar(B0 - 100 * STEP + i * STEP)).filter((c) => c.openTime !== hole),
    );
    feed.start();
    await to(B1 + 500);
    pushAll(B0);
    await flush();
    expect(closes).toHaveLength(1);
    expect(closes[0]!.at).toBe(B1 + 500); // no retry wait
    expect(closes[0]!.missing).toEqual([]);
    expect(client.calls.filter((c) => c.url.includes('ETHUSDT'))).toHaveLength(1);
    feed.stop();
  });

  it('bars already stored for part of the batch are emitted, not reported missing', async () => {
    // The feed resumes 3 closes back; loadHistory already stored the first two of those bars.
    const { client, feed, closes, errors, to } = setup(SYMS, { BTCUSDT: B0 - 2 * STEP, ETHUSDT: B0 - 2 * STEP, SOLUSDT: B0 - 2 * STEP }, B0 - 3 * STEP);
    feed.start();
    await to(START + 5 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B0 - 2 * STEP, B0 - STEP, B0]);
    for (const c of closes) {
      expect(c.missing).toEqual([]);
      expect(c.bars.size).toBe(3);
    }
    expect(errors.some((e) => e instanceof MissingBarsError)).toBe(false);
    // Only the bar the repo did not have was fetched.
    for (const c of client.calls) expect(new URL(c.url).searchParams.get('startTime')).toBe(String(B0 - STEP));
    feed.stop();
  });

  it('a new generation opened at C + 1 s catches up C by C + 3 s', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    feed.start();
    const B2 = B1 + STEP;
    for (let t = START + 30 * SEC; t <= B2; t += 30 * SEC) {
      await to(t);
      client.pushKline('BTCUSDT', TF, streamBar(barOpenFor(t, TF)), false);
      if (t === B1) pushAll(B0);
    }
    expect(closes.map((c) => c.closeTime)).toEqual([B1]);
    await to(B2 + SEC);
    feed.setSymbols(['BTCUSDT', 'ETHUSDT']); // B2's closed klines were lost in the switch
    await to(B2 + 3 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B1, B2]);
    expect(closes[1]!.missing).toEqual([]);
    feed.stop();
  });

  it('a network-wide outage holds closes until REST is back, then emits them complete and in order', async () => {
    const warm = { BTCUSDT: B0 - 2 * STEP, ETHUSDT: B0 - 2 * STEP, SOLUSDT: B0 - 2 * STEP };
    const { clock, client, feed, closes, to } = setup(SYMS, warm, B0 - STEP); // resumes one close behind
    const outageEnd = START + 30 * SEC;
    const real = client.klines.bind(client);
    client.klines = (...a) => (clock.now() < outageEnd ? Promise.reject(fetchFailed()) : real(...a));
    feed.start();
    await to(outageEnd - 1);
    expect(closes).toHaveLength(0); // never emitted without bars, however many batches failed
    expect(feed.status().catchingUp).toBe(true);
    await to(outageEnd + 10 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B0]);
    // B1's klines never arrive either: caught up over REST once overdue.
    await to(B1 + 40 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B0, B1]);
    for (const c of closes) {
      expect(c.missing).toEqual([]);
      expect(c.bars.size).toBe(3);
    }
    feed.stop();
  });

  it('a fetch-level error on one symbol never marks it missing, even while others fetch fine', async () => {
    const { clock, client, feed, closes, to, pushAll } = setup();
    const outageEnd = B1 + 60 * SEC;
    const real = client.klines.bind(client);
    client.klines = (s, ...rest) =>
      s === 'SOLUSDT' && clock.now() < outageEnd ? Promise.reject(fetchFailed()) : real(s, ...rest);
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT']); // ETHUSDT over REST succeeds every batch
    await to(outageEnd - 1);
    expect(closes).toHaveLength(0);
    await to(outageEnd + 10 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B1, []]]);
    expect(closes[0]!.bars.get('SOLUSDT')).toEqual(restBar(B0));
    feed.stop();
  });

  it('the same odd error on every symbol at once is not blamed on any one of them', async () => {
    const warm = { BTCUSDT: B0 - 2 * STEP, ETHUSDT: B0 - 2 * STEP, SOLUSDT: B0 - 2 * STEP };
    const { clock, client, feed, closes, to } = setup(SYMS, warm, B0 - STEP); // B0's bars must come over REST
    for (const s of SYMS) client.failKlines(s, 'nonjson');
    feed.start();
    await to(START + 30 * SEC);
    expect(closes).toHaveLength(0);
    for (const s of SYMS) client.failKlines(s, null);
    await to(clock.now() + 10 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B0, []]]);
    feed.stop();
  });

  it('a slow fetch in the last retry round is cut at the deadline', async () => {
    const { timers, client, feed, closes, to, pushAll } = setup();
    client.setCandles('SOLUSDT', TF, []);
    const real = client.klines.bind(client);
    let solCalls = 0;
    client.klines = async (s, ...rest) => {
      if (s === 'SOLUSDT' && ++solCalls === 3) await new Promise((r) => timers.setTimer(r, 5 * SEC));
      return real(s, ...rest);
    };
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 20 * SEC);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.missing).toEqual(['SOLUSDT']);
    expect(closes[0]!.at).toBeLessThanOrEqual(B1 + 300 + 10 * SEC);
    expect(solCalls).toBe(3);
    feed.stop();
  });

  it('lost klines plus a slow REST call still emit by about C + 10 s', async () => {
    const { timers, client, feed, closes, to, pushAll } = setup();
    feed.start();
    const B2 = B1 + STEP;
    for (let t = START + 30 * SEC; t <= B2; t += 30 * SEC) {
      await to(t);
      client.pushKline('BTCUSDT', TF, streamBar(barOpenFor(t, TF)), false);
      if (t === B1) pushAll(B0);
    }
    client.setCandles('SOLUSDT', TF, []);
    const real = client.klines.bind(client);
    let solCalls = 0;
    client.klines = async (s, ...rest) => {
      if (s === 'SOLUSDT' && ++solCalls === 1) await new Promise((r) => timers.setTimer(r, 5 * SEC));
      return real(s, ...rest);
    };
    await to(B2 + SEC);
    feed.setSymbols([...SYMS]); // new generation; B2's closed klines are lost in the switch
    await to(B2 + 20 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B1, B2]);
    expect(closes[1]!.missing).toEqual(['SOLUSDT']);
    expect(closes[1]!.at).toBeLessThanOrEqual(B2 + 10 * SEC);
    feed.stop();
  });

  it('a malformed reply for the only symbol on REST, while the others stream, marks it missing after 3 batches', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    client.failKlines('SOLUSDT', 'nonjson');
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']); // only SOLUSDT needs REST: no other REST fetch can vouch for REST
    await to(B1 + 40 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B1, ['SOLUSDT']]]);
    // Held only for 3 batches: first at B1 + 3.3 s, then two watchdog retries (RETRY_MS, 5 s ticks).
    expect(closes[0]!.at).toBeLessThanOrEqual(B1 + 300 + 3 * SEC + 2 * 2 * 5 * SEC);
    expect(closes[0]!.bars.get('BTCUSDT')).toEqual(streamBar(B0));
    expect(closes[0]!.bars.get('ETHUSDT')).toEqual(streamBar(B0));
    // One weight-1 control probe per batch, for a symbol that streamed.
    const probes = client.calls.filter((c) => symbolOf(c.url) !== 'SOLUSDT');
    expect(probes).toHaveLength(3);
    for (const c of probes) {
      expect(symbolOf(c.url)).toBe('BTCUSDT');
      expect(limitOf(c.url)).toBe('1');
      expect(c.weight).toBe(1);
    }
    const B2 = B1 + STEP;
    await to(B2 + 300);
    pushAll(B1, ['BTCUSDT', 'ETHUSDT']);
    await to(B2 + 3500);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([
      [B1, ['SOLUSDT']],
      [B2, ['SOLUSDT']],
    ]);
    feed.stop();
  });

  it('a malformed reply for one symbol while others fetch fine over REST marks it missing after 3 batches', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    client.failKlines('SOLUSDT', 'nonjson');
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT']); // ETHUSDT comes over REST and succeeds: that is the evidence, no probe needed
    await to(B1 + 40 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B1, ['SOLUSDT']]]);
    expect(closes[0]!.bars.get('ETHUSDT')).toEqual(restBar(B0));
    expect(client.calls.filter((c) => limitOf(c.url) === '1' && symbolOf(c.url) === 'BTCUSDT')).toHaveLength(0);
    feed.stop();
  });

  it('a 200 with a malformed row ([null]) is that symbol\'s own error, not a network failure', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    client.failKlines('SOLUSDT', { body: [null] });
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 40 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B1, ['SOLUSDT']]]);
    feed.stop();
  });

  it('REST-wide malformed replies (the probe fails too) never emit a close without bars', async () => {
    const { client, feed, closes, errors, to, pushAll } = setup();
    for (const s of SYMS) client.failKlines(s, 'nonjson'); // e.g. a proxy answering every request with a 200 HTML page
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 60 * SEC);
    expect(closes).toHaveLength(0);
    expect(errors.some((e) => e instanceof MissingBarsError)).toBe(false);
    expect(feed.status().catchingUp).toBe(true);
    // At most one probe per batch: every batch made one SOLUSDT fetch (it fails, so no retry rounds).
    const solCalls = client.calls.filter((c) => symbolOf(c.url) === 'SOLUSDT').length;
    const probes = client.calls.filter((c) => symbolOf(c.url) !== 'SOLUSDT').length;
    expect(solCalls).toBeGreaterThanOrEqual(5);
    expect(probes).toBe(solCalls);
    for (const s of SYMS) client.failKlines(s, null);
    await to(B1 + 75 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B1, []]]);
    expect(closes[0]!.bars.get('SOLUSDT')).toEqual(restBar(B0));
    expect(closes[0]!.bars.get('BTCUSDT')).toEqual(streamBar(B0));
    feed.stop();
  });

  it("a symbol's own earlier success in the batch is not evidence that REST is healthy", async () => {
    const { client, feed, closes, to, pushAll } = setup();
    // Batch 1 (B1 + 3.3 s): SOLUSDT's first fetch answers (no bar yet), its 1 s retry is malformed, and the probe is
    // malformed too, so batch 1 must not count toward SOLUSDT's streak.
    client.scriptKlines('SOLUSDT', 'empty', 'nonjson');
    client.failKlines('BTCUSDT', 'nonjson');
    client.failKlines('ETHUSDT', 'nonjson');
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    await to(B1 + 6 * SEC);
    expect(client.calls.filter((c) => symbolOf(c.url) === 'BTCUSDT')).toHaveLength(1); // the probe was sent
    // From here REST is healthy and SOLUSDT alone is malformed: batches 2 (B1 + 10 s), 3 (+15 s), 4 (+20 s).
    client.failKlines('BTCUSDT', null);
    client.failKlines('ETHUSDT', null);
    client.failKlines('SOLUSDT', 'nonjson');
    await to(B1 + 17 * SEC);
    expect(closes).toHaveLength(0); // streak 2 after batch 3: batch 1 did not count
    await to(B1 + 22 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B1, ['SOLUSDT']]]);
    expect(closes[0]!.at).toBe(B1 + 20 * SEC);
    feed.stop();
  });

  it('one probe per batch serves every malformed symbol, and it goes to a symbol that streamed', async () => {
    const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'];
    // BTCUSDT already has B1's bar stored (first in the list, but it did not stream); ETHUSDT streams.
    const { client, feed, closes, to, pushAll } = setup(syms, { BTCUSDT: B0 });
    client.failKlines('SOLUSDT', 'nonjson');
    client.failKlines('XRPUSDT', 'nonjson');
    feed.start();
    await to(B1 + 300);
    pushAll(B0, ['ETHUSDT']);
    await to(B1 + 40 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B1, ['SOLUSDT', 'XRPUSDT']]]);
    const probes = client.calls.filter((c) => symbolOf(c.url) !== 'SOLUSDT' && symbolOf(c.url) !== 'XRPUSDT');
    expect(probes.map((c) => symbolOf(c.url))).toEqual(['ETHUSDT', 'ETHUSDT', 'ETHUSDT']);
    feed.stop();
  });

  it('with no symbol streamed, the probe uses another symbol of the feed', async () => {
    // B0 must come over REST; BTCUSDT and ETHUSDT already have it stored, so only SOLUSDT fetches.
    const { client, feed, closes, to } = setup(SYMS, { SOLUSDT: B0 - 2 * STEP }, B0 - STEP);
    client.failKlines('SOLUSDT', 'nonjson');
    feed.start();
    await to(START + 30 * SEC);
    expect(closes.map((c) => [c.closeTime, c.missing])).toEqual([[B0, ['SOLUSDT']]]);
    const probes = client.calls.filter((c) => symbolOf(c.url) !== 'SOLUSDT');
    expect(probes.length).toBe(3);
    expect(probes.every((c) => limitOf(c.url) === '1')).toBe(true);
    feed.stop();
  });

  it('one connection of three drops: only it reconnects, and its symbols are recovered with no loss', async () => {
    const syms = Array.from({ length: 450 }, (_, i) => `S${i}USDT`);
    const { client, feed, closes, to, pushAll } = setup(syms);
    feed.start();
    await flush();
    const [c0, c1, c2] = client.connections;
    // Healthy streams send forming klines all the time; keep that up so only the drop matters.
    for (let t = START + 30 * SEC; t < B1 - 2 * SEC; t += 30 * SEC) {
      await to(t);
      for (const s of syms) client.pushKline(s, TF, streamBar(B0), false);
    }
    client.autoOpenStreams = false;
    client.dropConnection(2);
    await to(B1 + 500);
    pushAll(B0); // conn 2's symbols are not delivered
    await to(B1 + 5 * SEC);
    expect(c0!.closed || c1!.closed).toBe(false);
    expect(c2!.closed).toBe(true);
    expect(closes).toHaveLength(1);
    expect(closes[0]!.missing).toEqual([]);
    const lost = c2!.streams.map((s) => s.split('@')[0]!.toUpperCase());
    const fetched = new Set(client.calls.map((c) => new URL(c.url).searchParams.get('symbol')));
    expect([...fetched].sort()).toEqual([...lost].sort());
    for (const s of lost) expect(closes[0]!.bars.get(s)).toEqual(restBar(B0));
    client.autoOpenStreams = true;
    client.openPending();
    await to(B1 + 2 * 60 * SEC);
    expect(feed.status().connected).toBe(true);
    expect(client.connections.filter((c) => !c.closed)).toHaveLength(3);
    feed.stop();
  });

  it('a failed batch is retried, and later closes wait and fire in order', async () => {
    const { client, feed, closes, to, pushAll } = setup();
    client.failKlines('SOLUSDT', 503);
    feed.start();
    await to(B1 + 500);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    const B2 = B1 + STEP;
    await to(B2 + 500);
    pushAll(B1);
    await to(B2 + 2 * SEC);
    expect(closes).toHaveLength(0);
    expect(feed.status().catchingUp).toBe(true);
    client.failKlines('SOLUSDT', null);
    await to(B2 + 10 * SEC);
    expect(closes.map((c) => c.closeTime)).toEqual([B1, B2]);
    expect(closes[0]!.bars.get('SOLUSDT')).toEqual(restBar(B0));
    expect(closes[1]!.bars.get('SOLUSDT')).toEqual(streamBar(B1));
    expect(closes.every((c) => c.missing.length === 0)).toBe(true);
    expect(feed.status().catchingUp).toBe(false);
    feed.stop();
  });

  it('stop cancels its timers', async () => {
    const { timers, feed, to, pushAll } = setup();
    feed.start();
    await to(B1 + 500);
    pushAll(B0, ['BTCUSDT']);
    expect(timers.pending()).toBeGreaterThan(0);
    feed.stop();
    expect(timers.pending()).toBe(0);
  });
  it('prices: false subscribes kline streams only (a shared price stream serves several feeds)', async () => {
    const clock = makeClock(START);
    const timers = makeTimers(clock);
    const client = new FakeExchange({ now: clock.now, sleep: clock.sleep });
    const repo = new CandleRepo(openDb(':memory:'));
    const feed = new LiveFeed({ client, repo, tf: TF, symbols: SYMS, now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, prices: false });
    const prices: string[] = [];
    feed.onPrice((s) => prices.push(s));
    feed.start();
    await flush();
    const streams = client.connections.flatMap((c) => c.streams);
    expect(streams).toEqual(SYMS.map((s) => `${s.toLowerCase()}@kline_${TF}`));
    client.pushTickers([{ symbol: 'BTCUSDT', last: 1 }]);
    expect(prices).toEqual([]);
    expect(feed.status().connected).toBe(true);
    feed.stop();
  });
});
