// The per-run database: runs and their settings history, the saved broker and strategy-layer state,
// exactly-once processed candle keys, funding applied-through times, trades, equity and the run log.
// A scanner pass commits everything it changed in ONE transaction (commitPass), so a crash leaves either the
// whole pass or none of it.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { plainCopy } from '../core/plain-json.js';
import type { BrokerState, ClosedTrade, FeeConfig, SizingRule, Timeframe } from '../core/types.js';
import type { LayerState } from '../engine/layer-state.js';
import { inTransaction } from './db.js';

export type RunStatus = 'running' | 'paused' | 'stopped';
const STATUSES: readonly RunStatus[] = ['running', 'paused', 'stopped'];

/** What a run was started with. Plain JSON (no Infinity: pair rules are never part of it). */
export interface RunSetup {
  script: string;
  exchange: string;
  tf: Timeframe;
  startingBalance: number;
  sizing: SizingRule;
  /** Commission rates and slippage (slippagePct, or slippageTicks). */
  fees: FeeConfig;
}

export interface RunRecord {
  id: number;
  name: string;
  status: RunStatus;
  createdAt: number;
  setup: RunSetup;
}

export interface SettingChange {
  time: number;
  field: string;
  old: unknown;
  new: unknown;
}

/** Rejections, anomalies, delistings, skips and warnings. */
export interface RunLogEntry {
  time: number;
  kind: string;
  symbol?: string;
  detail?: unknown;
}

/** A closed trade as stored: `overfill` marks a pyramiding-overfill round trip (see StrategyLayer). */
export type RunTrade = ClosedTrade & { overfill?: boolean };

export interface PassCommit {
  /** The close time of the pass. */
  close: number;
  /** The closed klines this pass stepped. */
  processed: { symbol: string; openTime: number }[];
  broker: BrokerState;
  /** The layers this pass touched, by symbol (merged into the saved ones). */
  layers: Record<string, LayerState>;
  trades: RunTrade[];
  equity: { time: number; equity: number };
  logs: RunLogEntry[];
  /** Per symbol: funding applied through this time (FundingTracker.due's appliedThrough; ruling G). */
  fundingApplied: Record<string, number>;
}

export interface RunState {
  lastClose: number;
  broker: BrokerState;
  layers: Record<string, LayerState>;
  updatedAt: number;
}

interface TradeRow {
  symbol: string;
  side: ClosedTrade['side'];
  entry_time: number;
  entry_price: number;
  exit_time: number;
  exit_price: number;
  qty: number;
  pnl: number;
  fees: number;
  funding: number;
  exit_reason: ClosedTrade['exitReason'];
  exit_order_id: string | null;
  overfill: number;
}

/** A pass re-ran klines already committed for the run: nothing of it was written. */
export class DuplicatePassError extends Error {
  constructor(
    readonly runId: number,
    readonly keys: { symbol: string; openTime: number }[],
  ) {
    super(`run ${runId}: pass rejected, already processed: ${keys.map((k) => `${k.symbol}@${k.openTime}`).join(', ')}`);
    this.name = 'DuplicatePassError';
  }
}

/** A pass closes before the run's saved last close (out of order): nothing of it was written. */
export class StalePassError extends Error {
  constructor(
    readonly runId: number,
    readonly close: number,
    readonly lastClose: number,
  ) {
    super(`run ${runId}: pass for close ${close} is before the last committed close ${lastClose}`);
    this.name = 'StalePassError';
  }
}

const json = (x: unknown, what: string): string => JSON.stringify(plainCopy(x, what));

const finite = (n: number, what: string): number => {
  if (!Number.isFinite(n)) throw new Error(`${what} is ${n}, which JSON cannot hold`);
  return n;
};

export class RunRepo {
  private readonly s: Record<string, StatementSync>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    const p = (sql: string) => db.prepare(sql);
    this.s = {
      createRun: p("INSERT INTO runs (name, status, created_at, setup_json) VALUES (?, 'running', ?, ?)"),
      getRun: p('SELECT id, name, status, created_at, setup_json FROM runs WHERE id = ?'),
      listRuns: p('SELECT id, name, status, created_at, setup_json FROM runs ORDER BY id'),
      setStatus: p('UPDATE runs SET status = ? WHERE id = ?'),
      setSetup: p('UPDATE runs SET setup_json = ? WHERE id = ?'),
      addSetting: p('INSERT INTO settings_history (run_id, time, field, old_json, new_json) VALUES (?, ?, ?, ?, ?)'),
      settings: p('SELECT time, field, old_json, new_json FROM settings_history WHERE run_id = ? ORDER BY id'),
      getState: p('SELECT last_close, broker_json, layers_json, updated_at FROM run_state WHERE run_id = ?'),
      putState: p(
        `INSERT INTO run_state (run_id, last_close, broker_json, layers_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET last_close = MAX(last_close, excluded.last_close), broker_json = excluded.broker_json,
           layers_json = excluded.layers_json, updated_at = excluded.updated_at`,
      ),
      processed: p('INSERT OR IGNORE INTO processed_candles (run_id, symbol, open_time) VALUES (?, ?, ?)'),
      isProcessed: p('SELECT 1 AS hit FROM processed_candles WHERE run_id = ? AND symbol = ? AND open_time = ?'),
      lastProcessed: p('SELECT MAX(open_time) AS t FROM processed_candles WHERE run_id = ? AND symbol = ?'),
      activeRuns: p("SELECT COUNT(*) AS n FROM runs WHERE status IN ('running', 'paused')"),
      addTrade: p(
        `INSERT INTO trades (run_id, symbol, side, entry_time, entry_price, exit_time, exit_price, qty, pnl, fees, funding, exit_reason, exit_order_id, overfill)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      trades: p(
        `SELECT symbol, side, entry_time, entry_price, exit_time, exit_price, qty, pnl, fees, funding, exit_reason, exit_order_id, overfill
         FROM trades WHERE run_id = ? ORDER BY id`,
      ),
      putEquity: p('INSERT INTO equity (run_id, time, equity) VALUES (?, ?, ?) ON CONFLICT (run_id, time) DO UPDATE SET equity = excluded.equity'),
      equity: p('SELECT time, equity FROM equity WHERE run_id = ? ORDER BY time'),
      addLog: p('INSERT INTO run_log (run_id, time, kind, symbol, detail_json) VALUES (?, ?, ?, ?, ?)'),
      logs: p('SELECT time, kind, symbol, detail_json FROM run_log WHERE run_id = ? ORDER BY id'),
      logsOfKind: p('SELECT time, kind, symbol, detail_json FROM run_log WHERE run_id = ? AND kind = ? ORDER BY id'),
      putFunding: p(
        `INSERT INTO funding_applied (run_id, symbol, through_time) VALUES (?, ?, ?)
         ON CONFLICT (run_id, symbol) DO UPDATE SET through_time = MAX(through_time, excluded.through_time)`,
      ),
      funding: p('SELECT through_time FROM funding_applied WHERE run_id = ? AND symbol = ?'),
    };
  }

  // ------------------------------------------------------------ runs ----

  createRun(o: { name: string; setup: RunSetup }): number {
    const r = this.s.createRun!.run(o.name, this.now(), json(o.setup, 'run setup'));
    return Number(r.lastInsertRowid);
  }

  getRun(id: number): RunRecord | null {
    const r = this.s.getRun!.get(id) as { id: number; name: string; status: RunStatus; created_at: number; setup_json: string } | undefined;
    return r ? { id: r.id, name: r.name, status: r.status, createdAt: r.created_at, setup: JSON.parse(r.setup_json) as RunSetup } : null;
  }

  listRuns(): RunRecord[] {
    return (this.s.listRuns!.all() as { id: number }[]).map((r) => this.getRun(r.id)!);
  }

  setStatus(id: number, status: RunStatus): void {
    if (!STATUSES.includes(status)) throw new Error(`unknown run status ${String(status)}`);
    if (Number(this.s.setStatus!.run(status, id).changes) === 0) throw new Error(`no run ${id}`);
  }

  /** Changes one setup field (an owner edit) and records the old and new values, in one transaction. */
  recordSetting<K extends keyof RunSetup>(runId: number, field: K, value: RunSetup[K]): void {
    const newJson = json(value, `setting ${field}`);
    inTransaction(this.db, () => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`no run ${runId}`);
      const old = run.setup[field];
      this.s.setSetup!.run(json({ ...run.setup, [field]: value }, 'run setup'), runId);
      this.s.addSetting!.run(runId, this.now(), field, JSON.stringify(old ?? null), newJson);
    });
  }

  settingsHistory(runId: number): SettingChange[] {
    return (this.s.settings!.all(runId) as { time: number; field: string; old_json: string; new_json: string }[]).map((r) => ({
      time: r.time,
      field: r.field,
      old: JSON.parse(r.old_json) as unknown,
      new: JSON.parse(r.new_json) as unknown,
    }));
  }

  // ---------------------------------------------------------- passes ----

  /**
   * Stores one scanner pass in ONE transaction, all or nothing: its processed kline keys, broker and layer
   * state, trades, equity point, logs and funding applied-through times. It throws, writing nothing, when
   *  - a kline key of the pass is already processed (DuplicatePassError, listing the keys);
   *  - the pass's close is before the saved last close (StalePassError);
   *  - the state cannot be held as JSON (NaN, Infinity), or any write fails.
   * After a rejected commit the caller's in-memory broker and layers are ahead of the database: it must
   * reload them from loadState() (and rebuild its instances) before stepping again.
   */
  commitPass(runId: number, p: PassCommit): void {
    const brokerJson = json(p.broker, 'broker state');
    const layers = plainCopy(p.layers, 'layer state');
    const logs = p.logs.map((l) => ({ ...l, detailJson: l.detail === undefined ? null : json(l.detail, `log ${l.kind}`) }));
    finite(p.equity.equity, 'equity');
    finite(p.close, 'close');
    for (const t of p.trades) for (const k of ['entryTime', 'entryPrice', 'exitTime', 'exitPrice', 'qty', 'pnl', 'fees', 'funding'] as const) finite(t[k], `trade ${k}`);
    for (const [s, t] of Object.entries(p.fundingApplied)) finite(t, `funding applied for ${s}`);

    inTransaction(this.db, () => {
      const prev = this.loadState(runId);
      if (prev && p.close < prev.lastClose) throw new StalePassError(runId, p.close, prev.lastClose);
      const duplicates: { symbol: string; openTime: number }[] = [];
      for (const k of p.processed) {
        if (Number(this.s.processed!.run(runId, k.symbol, k.openTime).changes) === 0) duplicates.push(k);
      }
      // Rolls the whole pass back (the keys inserted above included): the broker state is global, so no part
      // of a pass that re-ran a kline can be kept.
      if (duplicates.length > 0) throw new DuplicatePassError(runId, duplicates);
      const merged: Record<string, LayerState> = { ...(prev?.layers ?? {}), ...layers };
      this.s.putState!.run(runId, p.close, brokerJson, JSON.stringify(merged), this.now());
      for (const t of p.trades) {
        this.s.addTrade!.run(
          runId, t.symbol, t.side, t.entryTime, t.entryPrice, t.exitTime, t.exitPrice, t.qty, t.pnl, t.fees, t.funding,
          t.exitReason, t.exitOrderId ?? null, t.overfill ? 1 : 0,
        );
      }
      this.s.putEquity!.run(runId, p.equity.time, p.equity.equity);
      for (const l of logs) this.s.addLog!.run(runId, l.time, l.kind, l.symbol ?? null, l.detailJson);
      for (const [s, t] of Object.entries(p.fundingApplied)) this.s.putFunding!.run(runId, s, t);
    });
  }

  isProcessed(runId: number, symbol: string, openTime: number): boolean {
    return this.s.isProcessed!.get(runId, symbol, openTime) !== undefined;
  }

  /** The newest processed kline openTime of (run, symbol), or null when none is. */
  lastProcessed(runId: number, symbol: string): number | null {
    const r = this.s.lastProcessed!.get(runId, symbol) as { t: number | null } | undefined;
    return r?.t ?? null;
  }

  /** Runs whose status is running or paused (each holds a RUN_LIMIT slot). */
  activeRuns(): number {
    return (this.s.activeRuns!.get() as { n: number }).n;
  }

  /** Funding applied through this time for (run, symbol); 0 when none has been. */
  appliedThrough(runId: number, symbol: string): number {
    const r = this.s.funding!.get(runId, symbol) as { through_time: number } | undefined;
    return r?.through_time ?? 0;
  }

  loadState(runId: number): RunState | null {
    const r = this.s.getState!.get(runId) as { last_close: number; broker_json: string; layers_json: string; updated_at: number } | undefined;
    if (!r) return null;
    return {
      lastClose: r.last_close,
      broker: JSON.parse(r.broker_json) as BrokerState,
      layers: JSON.parse(r.layers_json) as Record<string, LayerState>,
      updatedAt: r.updated_at,
    };
  }

  trades(runId: number): (ClosedTrade & { overfill: boolean })[] {
    return (this.s.trades!.all(runId) as unknown as TradeRow[]).map((r) => {
      const t: ClosedTrade & { overfill: boolean } = {
        symbol: r.symbol,
        side: r.side,
        entryTime: r.entry_time,
        entryPrice: r.entry_price,
        exitTime: r.exit_time,
        exitPrice: r.exit_price,
        qty: r.qty,
        pnl: r.pnl,
        fees: r.fees,
        funding: r.funding,
        exitReason: r.exit_reason,
        overfill: r.overfill === 1,
      };
      if (r.exit_order_id !== null) t.exitOrderId = r.exit_order_id;
      return t;
    });
  }

  equityCurve(runId: number): { time: number; equity: number }[] {
    return (this.s.equity!.all(runId) as { time: number; equity: number }[]).map((r) => ({ time: r.time, equity: r.equity }));
  }

  logs(runId: number, kind?: string): RunLogEntry[] {
    const rows = (kind === undefined ? this.s.logs!.all(runId) : this.s.logsOfKind!.all(runId, kind)) as {
      time: number;
      kind: string;
      symbol: string | null;
      detail_json: string | null;
    }[];
    return rows.map((r) => {
      const e: RunLogEntry = { time: r.time, kind: r.kind };
      if (r.symbol !== null) e.symbol = r.symbol;
      if (r.detail_json !== null) e.detail = JSON.parse(r.detail_json) as unknown;
      return e;
    });
  }
}
