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
];

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
