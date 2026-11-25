// One scanner process (RunManager) per database. The holder writes a heartbeat every LEASE_HEARTBEAT_MS; a lease whose
// heartbeat is older than LEASE_STALE_MS is free (its process died). Other processes (the CLI's list / status / pause /
// resume / stop) never take it: they write a run's status, and the holder applies it on its next heartbeat.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './db.js';

export const LEASE_HEARTBEAT_MS = 10_000;
export const LEASE_STALE_MS = 30_000;
export const LEASE_HELD_MESSAGE = 'another scanner process holds this database';

export class ManagerLease {
  readonly token = randomUUID();
  private held = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly pid: number = process.pid,
  ) {}

  get isHeld(): boolean {
    return this.held;
  }

  /** Takes the lease, or throws LEASE_HELD_MESSAGE while another holder's heartbeat is fresh. Idempotent. */
  acquire(): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare('SELECT token, heartbeat FROM manager_lease WHERE id = 1').get() as { token: string; heartbeat: number } | undefined;
      if (row && row.token !== this.token && this.now() - row.heartbeat < LEASE_STALE_MS) throw new Error(LEASE_HELD_MESSAGE);
      this.db
        .prepare('INSERT INTO manager_lease (id, token, pid, heartbeat) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET token = excluded.token, pid = excluded.pid, heartbeat = excluded.heartbeat')
        .run(this.token, this.pid, this.now());
    });
    this.held = true;
  }

  /** Refreshes the heartbeat. False (and no longer held) if another process took the lease meanwhile. */
  renew(): boolean {
    if (!this.held) return false;
    const r = this.db.prepare('UPDATE manager_lease SET heartbeat = ? WHERE id = 1 AND token = ?').run(this.now(), this.token);
    this.held = Number(r.changes) === 1;
    return this.held;
  }

  release(): void {
    if (!this.held) return;
    this.db.prepare('DELETE FROM manager_lease WHERE id = 1 AND token = ?').run(this.token);
    this.held = false;
  }
}
