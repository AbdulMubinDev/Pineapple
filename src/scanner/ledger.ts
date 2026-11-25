// What a ScannerRun has not committed yet, and the commit itself: the run log entries, the broker's new closed trades
// (restated by the layers' overfill attributions), its new fill-time rejections, the layers' new anomalies, and the
// state, all in ONE RunRepo.commitPass.
import type { PaperBroker } from '../broker/broker.js';
import { splitOverfills } from '../engine/replay.js';
import type { StrategyLayer } from '../engine/strategy-layer.js';
import type { LayerState } from '../engine/layer-state.js';
import { DuplicatePassError, StalePassError, type RunLogEntry, type RunRepo, type RunTrade } from '../store/runs.js';

export interface CommitInput {
  broker: PaperBroker;
  /** Every layer of the run by symbol (delisted ones included until their trades are committed). */
  layers: Map<string, StrategyLayer>;
  close: number;
  processed: { symbol: string; openTime: number }[];
  /** Symbols whose layer changed (a symbol with new trades is added). */
  touched: Set<string>;
  fundingApplied: Record<string, number>;
  equityTime: number;
}

export class RunLedger {
  private logs: RunLogEntry[] = [];
  private closed = 0;
  private rejections = 0;
  private readonly anomalies = new Map<string, number>();
  /** The last close committed (state-only commits reuse it). */
  lastClose = 0;

  constructor(
    private readonly repo: RunRepo,
    private readonly runId: number,
    private readonly now: () => number,
  ) {}

  log(kind: string, symbol: string | undefined, detail: unknown): void {
    const e: RunLogEntry = { time: this.now(), kind, detail };
    if (symbol !== undefined) e.symbol = symbol;
    this.logs.push(e);
  }

  get pendingLogs(): number {
    return this.logs.length;
  }

  /** A layer joined: only anomalies after this count are new. */
  track(symbol: string, layer: StrategyLayer): void {
    this.anomalies.set(symbol, layer.anomalies().length);
  }

  /** After a reload: everything in the restored broker and layers is committed already. */
  reset(broker: PaperBroker, lastClose: number): void {
    this.closed = broker.closedTrades().length;
    this.rejections = broker.rejections().length;
    this.anomalies.clear();
    this.lastClose = lastClose;
  }

  /**
   * Everything new since the last commit, in one commitPass. False when the database rejected it as a duplicate or
   * stale pass (memory is ahead of it): nothing was written, a state_reloaded warning is queued, the caller reloads.
   */
  commit(c: CommitInput): boolean {
    const closed = c.broker.closedTrades();
    const fresh = closed.slice(this.closed);
    const trades: RunTrade[] = [];
    for (const symbol of new Set(fresh.map((t) => t.symbol))) {
      const mine = fresh.filter((t) => t.symbol === symbol);
      const layer = c.layers.get(symbol);
      if (!layer) {
        trades.push(...mine);
        continue;
      }
      const split = splitOverfills(mine, layer.attributions());
      trades.push(...split.trades, ...split.overfills.map((t) => ({ ...t, overfill: true })));
      c.touched.add(symbol);
    }
    const rejections = c.broker.rejections();
    const logs = [...this.logs];
    for (const r of rejections.slice(this.rejections)) {
      logs.push({ time: r.time, kind: 'rejection', symbol: r.symbol, detail: { stage: 'fill', orderId: r.orderId, reason: r.reason } });
    }
    const layers: Record<string, LayerState> = {};
    const anomalyCounts = new Map<string, number>();
    for (const symbol of c.touched) {
      const layer = c.layers.get(symbol);
      if (!layer) continue;
      layers[symbol] = layer.snapshot();
      const all = layer.anomalies();
      for (const a of all.slice(this.anomalies.get(symbol) ?? 0)) logs.push({ time: a.time, kind: 'anomaly', symbol, detail: { kind: a.kind, orderId: a.orderId } });
      anomalyCounts.set(symbol, all.length);
    }
    try {
      this.repo.commitPass(this.runId, {
        close: c.close,
        processed: c.processed,
        broker: c.broker.snapshot(),
        layers,
        trades,
        equity: { time: c.equityTime, equity: c.broker.account().equity },
        logs,
        fundingApplied: c.fundingApplied,
      });
    } catch (e) {
      if (e instanceof DuplicatePassError || e instanceof StalePassError) {
        this.logs = [{ time: this.now(), kind: 'state_reloaded', detail: { reason: e.name, message: e.message } }];
        return false;
      }
      throw e;
    }
    this.logs = [];
    this.closed = closed.length;
    this.rejections = rejections.length;
    for (const [s, n] of anomalyCounts) this.anomalies.set(s, n);
    this.lastClose = Math.max(this.lastClose, c.close);
    return true;
  }
}
