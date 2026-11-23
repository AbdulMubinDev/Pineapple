// Pure parts of the hook (no Node, no PineTS imports): shared by spike/probe.ts and
// spike/resident.ts, and bundled into the isolate for Q7 / Task 2b.
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

