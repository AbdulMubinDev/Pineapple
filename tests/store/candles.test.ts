import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candle, FundingEvent } from '../../src/core/types.js';
import { CandleRepo, FundingRepo } from '../../src/store/candles.js';
import { openDb } from '../../src/store/db.js';

const H = 3_600_000;
const bar = (i: number, close = 100 + i): Candle => ({ openTime: i * H, open: close - 1, high: close + 2, low: close - 2, close, volume: 10 + i });

describe('openDb', () => {
  it('sets foreign_keys, a schema version and works in memory', () => {
    const db = openDb(':memory:');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBeGreaterThan(0);
    db.close();
  });

  it('uses WAL on a file and re-opening keeps data and version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pineapple-db-'));
    try {
      const path = join(dir, 'p.db');
      const db = openDb(path);
      expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
      new CandleRepo(db).upsert('BTCUSDT', '1h', [bar(1)]);
      db.close();
      const again = openDb(path);
      expect(new CandleRepo(again).count('BTCUSDT', '1h')).toBe(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CandleRepo', () => {
  it('candles round-trip and upsert is idempotent', () => {
    const repo = new CandleRepo(openDb(':memory:'));
    const bars = [1, 2, 3].map((i) => bar(i));
    repo.upsert('BTCUSDT', '1h', bars);
    repo.upsert('BTCUSDT', '1h', bars);
    expect(repo.count('BTCUSDT', '1h')).toBe(3);
    expect(repo.range('BTCUSDT', '1h', 0, 10 * H)).toEqual(bars);
    repo.upsert('BTCUSDT', '1h', [bar(2, 555)]);
    expect(repo.count('BTCUSDT', '1h')).toBe(3);
    expect(repo.range('BTCUSDT', '1h', 2 * H, 2 * H)[0]?.close).toBe(555);
  });

  it('range is inclusive, ordered and scoped by symbol and timeframe', () => {
    const repo = new CandleRepo(openDb(':memory:'));
    repo.upsert('BTCUSDT', '1h', [bar(5), bar(3), bar(4)]);
    repo.upsert('ETHUSDT', '1h', [bar(4, 1)]);
    repo.upsert('BTCUSDT', '4h', [bar(4, 2)]);
    expect(repo.range('BTCUSDT', '1h', 3 * H, 4 * H).map((c) => c.openTime)).toEqual([3 * H, 4 * H]);
    expect(repo.count('BTCUSDT', '1h')).toBe(3);
  });

  it('latest returns the newest bar or null', () => {
    const repo = new CandleRepo(openDb(':memory:'));
    expect(repo.latest('BTCUSDT', '1h')).toBeNull();
    repo.upsert('BTCUSDT', '1h', [bar(1), bar(7), bar(3)]);
    expect(repo.latest('BTCUSDT', '1h')).toEqual(bar(7));
  });

  it('pruneBefore deletes strictly older bars of that series only', () => {
    const repo = new CandleRepo(openDb(':memory:'));
    repo.upsert('BTCUSDT', '1h', [1, 2, 3, 4].map((i) => bar(i)));
    repo.upsert('ETHUSDT', '1h', [bar(1)]);
    repo.pruneBefore('BTCUSDT', '1h', 3 * H);
    expect(repo.range('BTCUSDT', '1h', 0, 10 * H).map((c) => c.openTime)).toEqual([3 * H, 4 * H]);
    expect(repo.count('ETHUSDT', '1h')).toBe(1);
  });
});

describe('FundingRepo', () => {
  it('round-trips, is idempotent and ranges inclusively', () => {
    const repo = new FundingRepo(openDb(':memory:'));
    const ev: FundingEvent[] = [1, 2, 3].map((i) => ({ time: i * 8 * H, rate: 0.0001 * i, markPrice: 100 + i }));
    repo.upsert('BTCUSDT', ev);
    repo.upsert('BTCUSDT', ev);
    repo.upsert('ETHUSDT', [{ time: 8 * H, rate: 1, markPrice: 1 }]);
    expect(repo.range('BTCUSDT', 0, 100 * H)).toEqual(ev);
    expect(repo.range('BTCUSDT', 16 * H, 24 * H)).toEqual(ev.slice(1));
  });
});
