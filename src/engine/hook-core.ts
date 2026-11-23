// The PineTS hook core: the order recorder, the Pine v6 argument normaliser and the read-back
// getters fed from our broker. Pure (no Node, no PineTS imports), so the same source runs in Node
// (src/engine/pine-runner.ts, spike/probe.ts, spike/resident.ts) and, bundled with esbuild, inside an
// isolated-vm isolate (spike/isolate.ts, spike/resident-bundle.ts).
//
// Design and evidence: docs/spike/pinets-findings.md, "Recommended hook design for Task 5".
export type OrderMethod = 'entry' | 'exit' | 'close' | 'close_all' | 'order' | 'cancel' | 'cancel_all';

export interface OrderCall {
  bar: number;
  time: number;
  method: OrderMethod;
  args: Record<string, unknown>;
}

export interface BrokerTrade {
  id: string;
  size: number;
  entry_price: number;
  entry_bar_index: number;
  entry_time: number;
  /** Unrealised P&L of the trade, as our broker marks it. */
  profit?: number;
}

/** What the script reads back. Our broker owns these numbers. */
export interface BrokerView {
  position_size: number;
  position_avg_price: number;
  equity: number;
  netprofit: number;
  openprofit: number;
  opentrades: BrokerTrade[];
}

// Pine v6 signatures, in positional order (same lists PineTS uses internally).
export const SIGNATURES: Record<OrderMethod, string[]> = {
  entry: ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert'],
  order: ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert'],
  exit: [
    'id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points',
    'trail_offset', 'oca_name', 'comment', 'comment_profit', 'comment_loss', 'comment_trailing', 'alert_message',
    'alert_profit', 'alert_loss', 'alert_trailing', 'disable_alert',
  ],
  close: ['id', 'comment', 'qty', 'qty_percent', 'alert_message', 'immediately', 'disable_alert'],
  close_all: ['comment', 'alert_message', 'immediately', 'disable_alert'],
  cancel: ['id'],
  cancel_all: [],
};

/** The read-backs the view feeds. */
export const FED_GETTERS = ['position_size', 'position_avg_price', 'equity', 'netprofit', 'openprofit', 'opentrades'] as const;
/** `strategy.opentrades.*` members the view feeds. */
export const FED_OPENTRADE_FIELDS = ['size', 'entry_price', 'entry_id', 'entry_bar_index', 'entry_time', 'profit'] as const;
/** Constants and constant namespaces (strategy.long, strategy.oca.cancel, ...): safe to leave to PineTS. */
export const STRATEGY_CONSTANTS = ['long', 'short', 'fixed', 'cash', 'percent_of_equity', 'direction', 'oca', 'commission'] as const;
/** PineTS internals on the namespace: `any` is the strategy() declaration, `param` unwraps arguments. */
const STRATEGY_INTERNALS = ['any', 'param'];

export const unsupportedMessage = (name: string): string => `strategy.${name} is not supported in v1`;

/** A Series (duck-typed: PineTS does not export the class) or a scalar helper -> its current value. */
function current(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  const o = v as { get?: (i: number) => unknown; data?: unknown; __value?: unknown };
  if (typeof o.get === 'function' && Array.isArray(o.data)) return o.get(0);
  if ('__value' in o) return o.__value;
  return v;
}

function isNamedArgsBag(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && !('__value' in v);
}

export function normaliseOrderArgs(method: OrderMethod, raw: unknown[]): Record<string, unknown> {
  const sig = SIGNATURES[method];
  const args: Record<string, unknown> = Object.fromEntries(sig.map((k) => [k, undefined]));
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (isNamedArgsBag(a)) {
      for (const [k, v] of Object.entries(a)) args[k] = current(v);
      break;
    }
    const name = sig[i];
    if (name !== undefined && a !== undefined) args[name] = current(a);
  }
  return args;
}

export function scalarList(list: BrokerTrade[]) {
  const n = list.length;
  const at = (i: unknown) => list[Number.isNaN(Number(i)) ? 0 : Number(i)];
  return {
    __value: n,
    valueOf: () => n,
    toString: () => String(n),
    [Symbol.toPrimitive]: () => n,
    size: (i: unknown) => at(i)?.size ?? 0,
    entry_price: (i: unknown) => at(i)?.entry_price ?? NaN,
    entry_id: (i: unknown) => at(i)?.id ?? '',
    entry_bar_index: (i: unknown) => at(i)?.entry_bar_index ?? NaN,
    entry_time: (i: unknown) => at(i)?.entry_time ?? NaN,
    profit: (i: unknown) => at(i)?.profit ?? 0,
  };
}

export interface StrategyHooks {
  /**
   * Called for every order primitive the script calls, with the raw arguments and PineTS's own
   * implementation. Its return value is what the script sees (the primitives return void).
   */
  onCall: (method: OrderMethod, raw: unknown[], original: (...a: unknown[]) => unknown) => unknown;
  /** Feed the read-back getters from this view (read each time the script reads one). */
  view?: () => BrokerView;
  /**
   * Replace every other `strategy.*` member (closedtrades, wintrades, grossprofit, ...) with a
   * function that throws "strategy.<name> is not supported in v1", so a read-back the view does not
   * feed can never silently return PineTS's empty emulator. Only meaningful together with `view`.
   */
  guardUnfed?: boolean;
}

/** Patches a run context's `$.pine.strategy` namespace. Call once per run context. */
export function installStrategyHooks(ns: Record<string, unknown>, h: StrategyHooks): void {
  for (const method of Object.keys(SIGNATURES) as OrderMethod[]) {
    const orig = ns[method] as (...a: unknown[]) => unknown;
    ns[method] = (...raw: unknown[]) => h.onCall(method, raw, orig);
  }
  const view = h.view;
  if (view) {
    ns.position_size = () => view().position_size;
    ns.position_avg_price = () => view().position_avg_price;
    ns.equity = () => view().equity;
    ns.netprofit = () => view().netprofit;
    ns.openprofit = () => view().openprofit;
    ns.opentrades = () => scalarList(view().opentrades);
  }
  if (h.guardUnfed) {
    const keep = new Set<string>([...Object.keys(SIGNATURES), ...FED_GETTERS, ...STRATEGY_CONSTANTS, ...STRATEGY_INTERNALS]);
    for (const name of Object.keys(ns)) {
      if (keep.has(name) || typeof ns[name] !== 'function') continue;
      ns[name] = () => {
        throw new Error(unsupportedMessage(name));
      };
    }
  }
}
