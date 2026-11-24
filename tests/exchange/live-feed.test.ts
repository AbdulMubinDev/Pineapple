import { describe, expect, it } from 'vitest';
import { barOpenFor, tfToMs } from '../../src/core/timeframe.js';
import type { Candle } from '../../src/core/types.js';
import type { MarkUpdate } from '../../src/exchange/client.js';
import { FakeExchange } from '../../src/exchange/fake.js';
import { loadHistory } from '../../src/exchange/history.js';
import { LiveFeed } from '../../src/exchange/live-feed.js';
import { CandleRepo } from '../../src/store/candles.js';
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

/** Stream bars close at 1.5; REST bars close at 9, so tests can tell which source a bar came from. */
const streamBar = (openTime: number): Candle => ({ openTime, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });
const restBar = (openTime: number): Candle => ({ openTime, open: 8, high: 10, low: 7, close: 9, volume: 4 });

/** `repoLast` overrides the last stored openTime per symbol (default: the bar that closed at B0). */
function setup(symbols = SYMS, repoLast: Record<string, number> = {}) {
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
  const feed = new LiveFeed({ client, repo, tf: TF, symbols, now: clock.now, setTimer: timers.setTimer });
  const closes: { closeTime: number; bars: Map<string, Candle> }[] = [];
  feed.onClose((closeTime, bars) => {
    closes.push({ closeTime, bars });
  });
  /** Advance to `t` (absolute). */
  const to = (t: number) => timers.advance(t - clock.now());
  const pushAll = (openTime: number, syms = symbols) => {
    for (const s of syms) client.pushKline(s, TF, streamBar(openTime));
  };
  return { clock, timers, client, repo, feed, closes, to, pushAll };
}

const contiguous = (c: Candle[]): boolean => c.every((x, i) => i === 0 || x.openTime - c[i - 1]!.openTime === STEP);
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
    await to(B1 + 500);
    pushAll(B0, ['BTCUSDT', 'ETHUSDT']);
    const first = clock.now();
    await to(first + 2900);
    expect(closes).toHaveLength(0);
    await to(first + 3000);
    expect(closes).toHaveLength(1);
    const bars = closes[0]!.bars;
    expect(bars.get('BTCUSDT')).toEqual(streamBar(B0));
    expect(bars.get('SOLUSDT')).toEqual(restBar(B0));
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

    // Messages flow again on the new connection: caught up, not stale.
    client.pushTickers([{ symbol: 'BTCUSDT', last: 100 }]);
    await flush();
    expect(feed.status()).toMatchObject({ connected: true, stale: false, catchingUp: false });

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
    const { client, feed, to } = setup(['BTCUSDT']);
    feed.start();
    await flush();
    const first = client.connections.length;
    // Keep the socket chatty (tickers every 30 s, each close's kline on time) so only the age rule can trigger.
    for (let t = START; t < START + 23 * 3_600_000 + 60 * SEC; t += 30 * SEC) {
      await to(t);
      client.pushTickers([{ symbol: 'BTCUSDT', last: 1 }]);
      if ((t - B0) % STEP === 0) client.pushKline('BTCUSDT', TF, streamBar(t - STEP));
      if (t < START + 23 * 3_600_000 - 60 * SEC) expect(client.connections.length).toBe(first);
    }
    expect(client.connections.length).toBe(first * 2);
    expect(client.connections.slice(0, first).every((c) => c.closed)).toBe(true);
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
});
