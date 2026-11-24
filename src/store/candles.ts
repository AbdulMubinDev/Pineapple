import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Candle, FundingEvent, Timeframe } from '../core/types.js';

interface CandleRow {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const toCandle = (r: CandleRow): Candle => ({
  openTime: r.open_time,
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
});

function inTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export class CandleRepo {
  private readonly stmts: Record<'upsert' | 'range' | 'latest' | 'count' | 'prune', StatementSync>;

  constructor(private readonly db: DatabaseSync) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT INTO candles (symbol, tf, open_time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol, tf, open_time) DO UPDATE SET
           open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`,
      ),
      range: db.prepare(
        `SELECT open_time, open, high, low, close, volume FROM candles
         WHERE symbol = ? AND tf = ? AND open_time >= ? AND open_time <= ? ORDER BY open_time`,
      ),
      latest: db.prepare(
        `SELECT open_time, open, high, low, close, volume FROM candles
         WHERE symbol = ? AND tf = ? ORDER BY open_time DESC LIMIT 1`,
      ),
      count: db.prepare('SELECT COUNT(*) AS n FROM candles WHERE symbol = ? AND tf = ?'),
      prune: db.prepare('DELETE FROM candles WHERE symbol = ? AND tf = ? AND open_time < ?'),
    };
  }

  upsert(symbol: string, tf: Timeframe, candles: Candle[]): void {
    inTransaction(this.db, () => {
      for (const c of candles) this.stmts.upsert.run(symbol, tf, c.openTime, c.open, c.high, c.low, c.close, c.volume);
    });
  }

  /** Candles with openTime in [fromMs, toMs], oldest first. */
  range(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Candle[] {
    return (this.stmts.range.all(symbol, tf, fromMs, toMs) as unknown as CandleRow[]).map(toCandle);
  }

  latest(symbol: string, tf: Timeframe): Candle | null {
    const r = this.stmts.latest.get(symbol, tf) as unknown as CandleRow | undefined;
    return r ? toCandle(r) : null;
  }

  count(symbol: string, tf: Timeframe): number {
    return (this.stmts.count.get(symbol, tf) as unknown as { n: number }).n;
  }

  /** Delete bars with openTime strictly before `ms`. */
  pruneBefore(symbol: string, tf: Timeframe, ms: number): void {
    this.stmts.prune.run(symbol, tf, ms);
  }
}

export class FundingRepo {
  private readonly upsertStmt: StatementSync;
  private readonly rangeStmt: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.upsertStmt = db.prepare(
      `INSERT INTO funding (symbol, time, rate, mark) VALUES (?, ?, ?, ?)
       ON CONFLICT (symbol, time) DO UPDATE SET rate = excluded.rate, mark = excluded.mark`,
    );
    this.rangeStmt = db.prepare('SELECT time, rate, mark FROM funding WHERE symbol = ? AND time >= ? AND time <= ? ORDER BY time');
  }

  upsert(symbol: string, events: FundingEvent[]): void {
    inTransaction(this.db, () => {
      for (const e of events) this.upsertStmt.run(symbol, e.time, e.rate, e.markPrice);
    });
  }

  /** Events with time in [fromMs, toMs], oldest first. */
  range(symbol: string, fromMs: number, toMs: number): FundingEvent[] {
    return (this.rangeStmt.all(symbol, fromMs, toMs) as unknown as { time: number; rate: number; mark: number }[]).map((r) => ({
      time: r.time,
      rate: r.rate,
      markPrice: r.mark,
    }));
  }
}
