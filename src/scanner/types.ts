// Shapes shared by the scanner modules (run, pass helpers, manager, CLI).
import type { Candle, FundingEvent } from '../core/types.js';
import type { ResidentStrategy } from '../engine/resident.js';
import type { StrategyLayer } from '../engine/strategy-layer.js';
import type { PairInfo } from '../exchange/client.js';
import type { LiveFeedStatus } from '../exchange/live-feed.js';

/** A pair further behind than this many bars is warm-started again instead of stepped through the gap. */
export const MAX_CATCHUP_BARS = 200;

export const BAR_STATE_WARNING = 'uses barstate/bar_index: live stepping treats every bar as realtime; restart may change bar_index';

export interface PassReport {
  closeTime: number;
  /** Pairs stepped in this pass. */
  scanned: number;
  /** The stepped pairs, in stepping order (descending 24h quote volume). */
  stepped: string[];
  /** Pairs not stepped, by reason: processed, missing_bar, behind, error, insufficient_history, warmup_failed, loading. */
  skipped: Record<string, string[]>;
  durationMs: number;
  /** From the candle close to the pass's commit (the 10 s pass deadline is measured on it). */
  latencyMs: number;
  /** The commit was rejected (duplicate or stale pass): the run reloaded its saved state instead. */
  rejected: boolean;
  errors: { symbol: string; message: string }[];
}

/** A pass must be committed this long after its candle close at the latest (Global Constraints). */
export const PASS_DEADLINE_MS = 10_000;

export interface ScannerStatus {
  universe: number;
  scannedLastPass: number;
  skipped: Record<string, number>;
  lastPassAt: number;
  lastPassMs: number;
  feed: LiveFeedStatus | null;
  /** Operator warnings: rest_banned (a 418 ban is in force), paused. */
  warnings: string[];
}

/** One live pair of a run. */
export interface Pair {
  info: PairInfo;
  layer: StrategyLayer;
  inst: ResidentStrategy | null;
  /** barHooks' funding array (sorted); events are pushed before the bar that contains them is stepped (ruling B). */
  funding: FundingEvent[];
  /** The last bar stepped (or warmed on) and its index. */
  last: Candle;
  idx: number;
  /** The last bar of the newest warm-up history: a reload with nothing processed yet rolls back to it. */
  warmEnd: number;
  state: 'ok' | 'error';
  /** Funding applied (stepped through, or applied late) through this time. */
  fundingThrough: number;
  repairing: boolean;
}

export type PendingReason = 'insufficient_history' | 'warmup_failed' | 'loading';
