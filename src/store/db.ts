import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Applied in order; `PRAGMA user_version` is the number applied so far. Append only, never edit. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE candles (
     symbol TEXT NOT NULL, tf TEXT NOT NULL, open_time INTEGER NOT NULL,
     open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
     PRIMARY KEY (symbol, tf, open_time)
   ) WITHOUT ROWID;
   CREATE TABLE funding (
     symbol TEXT NOT NULL, time INTEGER NOT NULL, rate REAL NOT NULL, mark REAL NOT NULL,
     PRIMARY KEY (symbol, time)
   ) WITHOUT ROWID;`,
  // 2: live runs (src/store/runs.ts). Every pass of a run commits in one transaction.
  `CREATE TABLE runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'stopped')),
     created_at INTEGER NOT NULL,
     setup_json TEXT NOT NULL
   );
   CREATE TABLE settings_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     time INTEGER NOT NULL, field TEXT NOT NULL, old_json TEXT NOT NULL, new_json TEXT NOT NULL
   );
   CREATE INDEX settings_history_run ON settings_history (run_id, id);
   CREATE TABLE run_state (
     run_id INTEGER PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
     last_close INTEGER NOT NULL, broker_json TEXT NOT NULL, layers_json TEXT NOT NULL, updated_at INTEGER NOT NULL
   );
   CREATE TABLE processed_candles (
     run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     symbol TEXT NOT NULL, open_time INTEGER NOT NULL,
     PRIMARY KEY (run_id, symbol, open_time)
   ) WITHOUT ROWID;
   CREATE TABLE trades (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     symbol TEXT NOT NULL,
     side TEXT NOT NULL CHECK (side IN ('long', 'short')),
     entry_time INTEGER NOT NULL, entry_price REAL NOT NULL, exit_time INTEGER NOT NULL, exit_price REAL NOT NULL,
     qty REAL NOT NULL, pnl REAL NOT NULL, fees REAL NOT NULL, funding REAL NOT NULL,
     exit_reason TEXT NOT NULL CHECK (exit_reason IN ('signal', 'stop', 'target', 'liquidation', 'delisting')),
     exit_order_id TEXT,
     overfill INTEGER NOT NULL CHECK (overfill IN (0, 1))
   );
   CREATE INDEX trades_run ON trades (run_id, id);
   CREATE TABLE equity (
     run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     time INTEGER NOT NULL, equity REAL NOT NULL,
     PRIMARY KEY (run_id, time)
   ) WITHOUT ROWID;
   CREATE TABLE run_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     time INTEGER NOT NULL, kind TEXT NOT NULL, symbol TEXT, detail_json TEXT
   );
   CREATE INDEX run_log_run ON run_log (run_id, kind, id);
   CREATE TABLE funding_applied (
     run_id INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
     symbol TEXT NOT NULL, through_time INTEGER NOT NULL,
     PRIMARY KEY (run_id, symbol)
   ) WITHOUT ROWID;`,
  // 3: the whole run log of a run, in order (logs(runId) without a kind).
  `CREATE INDEX run_log_run_id ON run_log (run_id, id);`,
];

/**
 * Runs `fn` in a transaction. SAVEPOINT nests safely inside a caller's transaction (and starts one when
 * there is none): everything `fn` wrote is rolled back if it throws.
 */
export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('SAVEPOINT pineapple_repo');
  try {
    const r = fn();
    db.exec('RELEASE pineapple_repo');
    return r;
  } catch (e) {
    db.exec('ROLLBACK TO pineapple_repo');
    db.exec('RELEASE pineapple_repo');
    throw e;
  }
}

/** Open (creating if needed) the database. Production path is data/pineapple.db; ':memory:' works for tests. */
export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > MIGRATIONS.length) {
    db.close();
    throw new Error(`database schema version ${current} is newer than this build (${MIGRATIONS.length})`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      db.close();
      throw e;
    }
  }
  return db;
}
