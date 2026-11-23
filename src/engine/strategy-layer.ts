// Pine's order semantics on top of our broker, the way TradingView's broker emulator applies them
// (PineTS 0.13.1's emulator, which tracks TradingView closely, is the reference for the details).
//
// The script's strategy.* calls (captured by pine-runner) become broker OrderIntents here, and the
// script's read-backs (strategy.position_size, equity, opentrades, ...) come from scriptView(), which
// reads the broker. The broker holds one net position per symbol; this layer adds what Pine needs on
// top: entry ids, the open trades per entry, pyramiding, reversals and the exit orders.
//
// How the replay drives it, per bar (Task 6):
//   before: fills = broker.onBarOpen(...)   -> submit(layer.onFills(fills, bar, idx))
//           fills = broker.onBarRange(...)  -> submit(layer.onFills(fills, bar, idx))   (and onMark)
//           broker.markToMarket(close); return layer.scriptView()
//   after:  submit(layer.toIntents(calls, bar))
// Every fill the broker reports for this symbol must reach onFills: the layer's trades are built from
// them, and scriptView() throws if they no longer add up to the broker's position.
//
// Exit orders belong to the layer. A strategy.exit for an entry that has not filled yet waits here
// and goes to the broker (via onFills) as soon as the entry fills: right after onBarOpen for a market
// entry, so the stop already protects the fill bar, as on TradingView.
//
// Cancellations (strategy.cancel / cancel_all, replaced or withdrawn exits) are applied to the broker
// directly; everything to submit is returned.
import type { PaperBroker } from '../broker/broker.js';
import { leverageInForce } from '../broker/margin.js';
import type { Candle, Fill, OrderIntent, PairRules, SizingRule } from '../core/types.js';
import type { PineOrderCall, StrategyDeclaration } from './pine-runner.js';

export interface ScriptTrade {
  /** Signed: positive long, negative short. */
  size: number;
  entryPrice: number;
  entryId: string;
  entryBarIndex: number;
  entryTime: number;
  /** Unrealised P&L at the broker's last price, before fees. */
  profit: number;
}

/** What the script reads back (strategy.position_size, ...). */
export interface ScriptView {
  positionSize: number;
  positionAvgPrice: number;
  equity: number;
  openTrades: number;
  netProfit: number;
  openProfit: number;
  opentrades: ScriptTrade[];
}

export interface LayerOptions {
  /** The pair's rules: tick size (mintick), qty step and max leverage. */
  rules: PairRules;
  /** Bars opening before this time are warm-up: their order calls are discarded. */
  from?: number;
}

type Dir = 1 | -1;

/** A physical lot: what a close or exit for its entry id may still take. */
interface Lot {
  entryId: string;
  qty: number;
  dir: Dir;
  price: number;
}

/** An open trade as the script sees it (strategy.opentrades): exits pair with these by close_entries_rule. */
interface TradeRecord {
  entryId: string;
  qty: number;
  dir: Dir;
  price: number;
  barIndex: number;
  time: number;
}

interface OrderMeta {
  kind: 'entry' | 'order' | 'exit' | 'close' | 'close_all';
  entryId?: string;
  /** exit legs: the exit registration they belong to. */
  exitKey?: string;
}

interface ExitReg {
  key: string;
  exitId: string;
  /** '' = every open entry. */
  fromEntry: string;
  qty?: number;
  qtyPercent?: number;
  limit?: number;
  stop?: number;
  profitTicks?: number;
  lossTicks?: number;
  ocaName?: string;
  /** Leg order id -> the intent last handed out for it (JSON), to send only changes. */
  sent: Map<string, string>;
  /** It has had a trade to protect (so it dies when that trade is gone). */
  wasLive: boolean;
}

const EPS = 1e-9;

function decimalsOf(step: number): number {
  const s = String(step);
  if (s.includes('e-')) {
    const [m, e] = s.split('e-');
    return Number(e) + (m!.split('.')[1]?.length ?? 0);
  }
  return s.split('.')[1]?.length ?? 0;
}

export class StrategyLayer {
  private readonly rules: PairRules;
  private readonly from?: number;
  private lots: Lot[] = [];
  private records: TradeRecord[] = [];
  private readonly meta = new Map<string, OrderMeta>();
  private readonly exits = new Map<string, ExitReg>();
  private seq = 0;

  constructor(
    private readonly decl: StrategyDeclaration,
    private readonly broker: PaperBroker,
    private readonly symbol: string,
    private readonly sizing: SizingRule,
    opts: LayerOptions,
  ) {
    this.rules = opts.rules;
    this.from = opts.from;
  }

  /** A flat view (warm-up, validation): no position, the given equity. */
  static flatView(equity: number): ScriptView {
    return { positionSize: 0, positionAvgPrice: NaN, equity, openTrades: 0, netProfit: 0, openProfit: 0, opentrades: [] };
  }

  // ------------------------------------------------------------------ public ----

  /** The order intents for one bar's calls, in call order. Cancellations are applied to the broker now. */
  toIntents(calls: PineOrderCall[], bar: Candle): OrderIntent[] {
    if (this.from !== undefined && bar.openTime < this.from) return [];
    this.dropOrphanedExits();
    const batch = new Map<string, OrderIntent>();
    for (const c of calls) {
      switch (c.kind) {
        case 'entry':
          this.entry(c, bar, batch);
          break;
        case 'order':
          this.order(c, bar, batch);
          break;
        case 'exit':
          this.exit(c, batch);
          break;
        case 'close':
          this.close(c, batch);
          break;
        case 'close_all':
          this.closeAll(batch);
          break;
        case 'cancel':
          this.cancel(c.id, batch);
          break;
        case 'cancel_all':
          this.cancelAll(batch);
          break;
      }
    }
    for (const reg of [...this.exits.values()]) this.syncExit(reg, batch);
    return [...batch.values()];
  }

  /**
   * Books broker fills for this symbol into the open trades. Returns the exit orders that are now due
   * (an entry filled, or a trade's size changed): submit them before the broker's next price event.
   */
  onFills(fills: Fill[], _bar: Candle, idx: number): OrderIntent[] {
    for (const f of fills) {
      if (f.symbol !== this.symbol) continue;
      if (f.orderId.startsWith('liquidation:')) {
        this.lots = [];
        this.records = [];
        continue;
      }
      const m = this.meta.get(f.orderId);
      this.book(f, m, idx);
      if (m?.kind === 'exit' && m.exitKey) {
        // A filled exit is used up (its OCA sibling is gone too); a re-issued strategy.exit places a new one.
        const reg = this.exits.get(m.exitKey);
        if (reg) this.dropExit(reg);
      }
      if (m && (m.kind === 'close' || m.kind === 'close_all')) this.meta.delete(f.orderId);
    }
    const out = new Map<string, OrderIntent>();
    for (const reg of [...this.exits.values()]) this.syncExit(reg, out);
    return [...out.values()];
  }

  scriptView(): ScriptView {
    const pos = this.broker.position(this.symbol);
    const qty = pos?.qty ?? 0;
    const net = this.netSize();
    if (Math.abs(net - qty) > EPS * Math.max(1, Math.abs(qty))) {
      throw new Error(`StrategyLayer(${this.symbol}) is out of sync with the broker (${net} vs ${qty}): every broker fill must reach onFills`);
    }
    const last = this.broker.lastPriceOf(this.symbol);
    let netProfit = 0;
    for (const t of this.broker.closedTrades()) if (t.symbol === this.symbol) netProfit += t.pnl - t.fees + t.funding;
    return {
      positionSize: qty,
      positionAvgPrice: pos ? pos.entryPrice : NaN,
      equity: this.broker.account().equity,
      openTrades: this.records.length,
      netProfit,
      openProfit: pos && last !== undefined ? pos.qty * (last - pos.entryPrice) : 0,
      opentrades: this.records.map((r) => ({
        size: r.dir * r.qty,
        entryPrice: r.price,
        entryId: r.entryId,
        entryBarIndex: r.barIndex,
        entryTime: r.time,
        profit: last !== undefined ? r.dir * r.qty * (last - r.price) : 0,
      })),
    };
  }

  // ------------------------------------------------------------------ order calls ----

  private entry(c: PineOrderCall, bar: Candle, batch: Map<string, OrderIntent>): void {
    const dir = this.direction(c);
    const id = this.entryOrderId(c.id);
    // An entry with the id of an unfilled entry / order modifies it (also on the bar it was placed).
    batch.delete(id);
    const cur = this.projected(batch);
    const adding = cur !== 0 && Math.sign(cur) === dir;
    // Pyramiding caps adds to a same-direction position by its open entries (not opening, not reversing).
    if (adding && this.lots.filter((l) => l.dir === dir).length >= this.decl.pyramiding) return;
    const { type, limitPrice, stopPrice } = this.levels(c, dir);
    const base = this.baseQty(c.qty, dir, type, limitPrice, stopPrice, bar.close);
    const reversal = cur !== 0 && Math.sign(cur) !== dir;
    if (!(base > 0) && !reversal) return;
    const qty = reversal ? this.roundQty(Math.abs(cur) + base) : base;
    this.meta.set(id, { kind: 'entry', entryId: c.id });
    batch.set(id, this.intent(c, id, dir, type, qty, limitPrice, stopPrice));
  }

  private order(c: PineOrderCall, bar: Candle, batch: Map<string, OrderIntent>): void {
    const dir = this.direction(c);
    const id = this.entryOrderId(c.id);
    batch.delete(id);
    const { type, limitPrice, stopPrice } = this.levels(c, dir);
    const qty = this.baseQty(c.qty, dir, type, limitPrice, stopPrice, bar.close);
    if (!(qty > 0)) return;
    this.meta.set(id, { kind: 'order', entryId: c.id });
    batch.set(id, this.intent(c, id, dir, type, qty, limitPrice, stopPrice));
  }

  private exit(c: PineOrderCall, batch: Map<string, OrderIntent>): void {
    const fromEntry = c.fromEntry ?? '';
    // An exit for an entry that is neither open nor pending places nothing (and replaces nothing).
    if (fromEntry && !this.lotsOf(fromEntry).length && !this.entryPending(fromEntry, batch)) return;
    const key = `${c.id}\u0000${fromEntry}`;
    const old = this.exits.get(key);
    if ([c.limit, c.stop, c.profitTicks, c.lossTicks].every((v) => v === undefined)) {
      // Every price leg na: no order, and the exit it would replace is withdrawn.
      if (old) this.dropExit(old, batch);
      return;
    }
    this.exits.set(key, {
      key,
      exitId: c.id,
      fromEntry,
      qty: c.qty,
      qtyPercent: c.qtyPercent,
      limit: c.limit,
      stop: c.stop,
      profitTicks: c.profitTicks,
      lossTicks: c.lossTicks,
      ocaName: c.ocaName,
      sent: old?.sent ?? new Map(),
      wasLive: old?.wasLive ?? false,
    });
  }

  private close(c: PineOrderCall, batch: Map<string, OrderIntent>): void {
    const lots = this.lotsOf(c.id);
    if (lots.length === 0) return; // no open trade for that entry: a no-op, as on TradingView
    const total = lots.reduce((s, l) => s + l.qty, 0);
    const qty = this.partialQty(total, c.qty, c.qtyPercent);
    if (!(qty > 0)) return;
    // A full close supersedes the entry's conditional exits.
    if (qty >= total - EPS) for (const reg of [...this.exits.values()]) if (reg.fromEntry === c.id) this.dropExit(reg, batch);
    const dir = lots[0]!.dir;
    const id = `${this.symbol}|C|${c.id}|${this.seq++}`;
    this.meta.set(id, { kind: 'close', entryId: c.id });
    batch.set(id, this.closeIntent(id, dir, qty, c.id));
  }

  private closeAll(batch: Map<string, OrderIntent>): void {
    const net = this.netSize();
    if (net === 0) return;
    const id = `${this.symbol}|CA|${this.seq++}`;
    this.meta.set(id, { kind: 'close_all' });
    batch.set(id, this.closeIntent(id, net > 0 ? 1 : -1, Math.abs(net)));
  }

  /** strategy.cancel(id): unfilled entries / orders with that id, and exits with that id. */
  private cancel(pineId: string, batch: Map<string, OrderIntent>): void {
    const id = this.entryOrderId(pineId);
    batch.delete(id);
    this.broker.cancel(id);
    for (const reg of [...this.exits.values()]) if (reg.exitId === pineId) this.dropExit(reg, batch);
  }

  private cancelAll(batch: Map<string, OrderIntent>): void {
    batch.clear();
    for (const o of this.broker.openOrders(this.symbol)) if (this.meta.has(o.id)) this.broker.cancel(o.id);
    for (const reg of [...this.exits.values()]) this.dropExit(reg);
  }

  // ------------------------------------------------------------------ exits ----

  /** Brings the broker's legs of one exit up to date with its trades (sends changes only). */
  private syncExit(reg: ExitReg, batch: Map<string, OrderIntent>): void {
    const lots = reg.fromEntry ? this.lotsOf(reg.fromEntry) : this.lots;
    if (lots.length === 0) {
      // Waiting for its entry, or its trade is gone (then it goes too).
      if (reg.wasLive) this.dropExit(reg, batch);
      return;
    }
    reg.wasLive = true;
    const dir = lots[0]!.dir;
    const total = lots.reduce((s, l) => s + l.qty, 0);
    const entryPrice = lots.reduce((s, l) => s + l.qty * l.price, 0) / total;
    const qty = this.partialQty(total, reg.qty, reg.qtyPercent);
    const mintick = this.rules.tickSize;
    // Fractional tick counts round to the next whole tick away from the entry.
    const tickLevel = (ticks: number, away: 1 | -1) => this.onGrid(entryPrice / mintick + away * dir * Math.ceil(ticks - 1e-9));
    // Of a price leg and a ticks leg, the level nearer the entry wins (Pine v6).
    const nearer = (a: number | undefined, b: number | undefined, pick: (x: number, y: number) => number) =>
      a === undefined ? b : b === undefined ? a : pick(a, b);
    const tp = nearer(reg.limit, reg.profitTicks !== undefined ? tickLevel(reg.profitTicks, 1) : undefined, dir > 0 ? Math.min : Math.max);
    const sl = nearer(reg.stop, reg.lossTicks !== undefined ? tickLevel(reg.lossTicks, -1) : undefined, dir > 0 ? Math.max : Math.min);
    const base = `${this.symbol}|X|${reg.exitId}|${reg.fromEntry}`;
    const oca = reg.ocaName ? { ocaGroup: `${this.symbol}|O|${reg.ocaName}`, ocaType: 'reduce' as const } : { ocaGroup: base, ocaType: 'cancel' as const };
    const legs: [string, OrderIntent | null][] = [
      [`${base}|limit`, tp === undefined || !(qty > 0) ? null : this.exitLeg(`${base}|limit`, 'limit', this.roundLevel(tp, -dir as Dir, 'limit'), dir, qty, reg, oca)],
      [`${base}|stop`, sl === undefined || !(qty > 0) ? null : this.exitLeg(`${base}|stop`, 'stop', this.roundLevel(sl, -dir as Dir, 'stop'), dir, qty, reg, oca)],
    ];
    for (const [id, intent] of legs) {
      if (intent) {
        const json = JSON.stringify(intent);
        if (reg.sent.get(id) !== json) {
          reg.sent.set(id, json);
          this.meta.set(id, { kind: 'exit', entryId: reg.fromEntry || undefined, exitKey: reg.key });
          batch.set(id, intent);
        }
      } else if (reg.sent.has(id)) {
        reg.sent.delete(id);
        batch.delete(id);
        this.broker.cancel(id);
        this.meta.delete(id);
      }
    }
  }

  private exitLeg(
    id: string,
    type: 'limit' | 'stop',
    price: number,
    dir: Dir,
    qty: number,
    reg: ExitReg,
    oca: { ocaGroup: string; ocaType: 'cancel' | 'reduce' },
  ): OrderIntent {
    return {
      id,
      symbol: this.symbol,
      side: dir > 0 ? 'sell' : 'buy',
      type,
      qty,
      ...(type === 'limit' ? { limitPrice: price } : { stopPrice: price }),
      reduceOnly: true,
      ...oca,
      tag: 'exit',
      ...(reg.fromEntry ? { entryId: reg.fromEntry } : {}),
      leverage: this.leverage(dir),
    };
  }

  /** Withdraws an exit: its legs leave the broker (and the batch) and the registration is forgotten. */
  private dropExit(reg: ExitReg, batch?: Map<string, OrderIntent>): void {
    for (const leg of ['limit', 'stop']) {
      const id = `${this.symbol}|X|${reg.exitId}|${reg.fromEntry}|${leg}`;
      batch?.delete(id);
      if (reg.sent.has(id)) this.broker.cancel(id);
      this.meta.delete(id);
    }
    this.exits.delete(reg.key);
  }

  /**
   * Start of a bar's calls. Exits still waiting for an entry that is no longer pending (cancelled,
   * rejected) go with it, and market closes from earlier bars (filled or dropped by now) are forgotten.
   */
  private dropOrphanedExits(): void {
    const resting = new Set(this.broker.openOrders(this.symbol).map((o) => o.id));
    for (const [id, m] of this.meta) if ((m.kind === 'close' || m.kind === 'close_all') && !resting.has(id)) this.meta.delete(id);
    for (const reg of [...this.exits.values()]) {
      if (reg.wasLive) continue;
      const waiting = reg.fromEntry
        ? this.lotsOf(reg.fromEntry).length > 0 || this.entryPending(reg.fromEntry)
        : this.lots.length > 0 || this.broker.openOrders(this.symbol).some((o) => this.isEntryOrder(o.id));
      if (!waiting) this.exits.delete(reg.key);
    }
  }

  // ------------------------------------------------------------------ booking fills ----

  private book(f: Fill, m: OrderMeta | undefined, idx: number): void {
    const dir: Dir = f.side === 'buy' ? 1 : -1;
    let qty = f.qty;
    const net = this.netSize();
    if (net !== 0 && Math.sign(net) !== dir) {
      const closing = Math.min(qty, Math.abs(net));
      const named = m && (m.kind === 'exit' || m.kind === 'close') ? m.entryId : undefined;
      this.closeLots(closing, named);
      this.closeRecords(closing, named);
      qty -= closing;
    }
    if (qty > EPS) {
      const entryId = m?.entryId ?? f.orderId;
      this.lots.push({ entryId, qty, dir, price: f.price });
      this.records.push({ entryId, qty, dir, price: f.price, barIndex: idx, time: f.time });
    }
  }

  /** Physical lots: a close / exit for an entry takes that entry's lots first, oldest first. */
  private closeLots(qty: number, entryId?: string): void {
    const order = entryId ? [...this.lots.filter((l) => l.entryId === entryId), ...this.lots.filter((l) => l.entryId !== entryId)] : this.lots;
    let need = qty;
    for (const l of order) {
      if (need <= EPS) break;
      const take = Math.min(l.qty, need);
      l.qty -= take;
      need -= take;
    }
    this.lots = this.lots.filter((l) => l.qty > EPS);
  }

  /** The script's open trades: FIFO pairs any exit with the oldest trades; ANY with the named entry's. */
  private closeRecords(qty: number, entryId?: string): void {
    const named = this.decl.closeEntriesRule === 'ANY' && entryId !== undefined;
    const order = named
      ? [...this.records.filter((r) => r.entryId === entryId), ...this.records.filter((r) => r.entryId !== entryId)]
      : this.records;
    let need = qty;
    for (const r of order) {
      if (need <= EPS) break;
      const take = Math.min(r.qty, need);
      r.qty -= take;
      need -= take;
    }
    this.records = this.records.filter((r) => r.qty > EPS);
  }

  // ------------------------------------------------------------------ helpers ----

  private direction(c: PineOrderCall): Dir {
    if (c.direction === 'long') return 1;
    if (c.direction === 'short') return -1;
    throw new Error(`strategy.${c.kind}("${c.id}") needs a direction`);
  }

  private entryOrderId(pineId: string): string {
    return `${this.symbol}|E|${pineId}`;
  }

  private isEntryOrder(id: string): boolean {
    const k = this.meta.get(id)?.kind;
    return k === 'entry' || k === 'order';
  }

  private entryPending(pineId: string, batch?: Map<string, OrderIntent>): boolean {
    const id = this.entryOrderId(pineId);
    return (batch?.has(id) ?? false) || this.broker.openOrders(this.symbol).some((o) => o.id === id);
  }

  private lotsOf(entryId: string): Lot[] {
    return this.lots.filter((l) => l.entryId === entryId);
  }

  private netSize(): number {
    return this.lots.reduce((s, l) => s + l.dir * l.qty, 0);
  }

  /** The position once this bar's queued market orders have filled (they fill before a later one). */
  private projected(batch: Map<string, OrderIntent>): number {
    let cur = this.netSize();
    for (const o of batch.values()) {
      if (o.type !== 'market') continue;
      const s = o.side === 'buy' ? 1 : -1;
      if (o.tag === 'entry' && !o.reduceOnly) cur += s * o.qty;
      else if (cur !== 0 && Math.sign(cur) !== s) cur += s * Math.min(o.qty, Math.abs(cur));
    }
    return Math.abs(cur) < EPS ? 0 : cur;
  }

  private leverage(dir: Dir): number {
    const margin = dir > 0 ? this.decl.marginLong : this.decl.marginShort;
    // margin 0 means "no margin checking" in Pine: the pair's own maximum.
    if (margin === 0) return this.rules.maxLeverage;
    return leverageInForce(margin, this.rules.maxLeverage);
  }

  private levels(c: PineOrderCall, dir: Dir) {
    const limitPrice = c.limit !== undefined ? this.roundLevel(c.limit, dir, 'limit') : undefined;
    const stopPrice = c.stop !== undefined ? this.roundLevel(c.stop, dir, 'stop') : undefined;
    const type: OrderIntent['type'] =
      limitPrice !== undefined && stopPrice !== undefined ? 'stop_limit' : limitPrice !== undefined ? 'limit' : stopPrice !== undefined ? 'stop' : 'market';
    return { type, limitPrice, stopPrice };
  }

  private intent(c: PineOrderCall, id: string, dir: Dir, type: OrderIntent['type'], qty: number, limitPrice?: number, stopPrice?: number): OrderIntent {
    const oca = c.ocaName && c.ocaType && c.ocaType !== 'none' ? { ocaGroup: `${this.symbol}|O|${c.ocaName}`, ocaType: c.ocaType } : {};
    return {
      id,
      symbol: this.symbol,
      side: dir > 0 ? 'buy' : 'sell',
      type,
      qty,
      ...(limitPrice !== undefined ? { limitPrice } : {}),
      ...(stopPrice !== undefined ? { stopPrice } : {}),
      reduceOnly: false,
      ...oca,
      tag: 'entry',
      entryId: c.id,
      leverage: this.leverage(dir),
    };
  }

  private closeIntent(id: string, posDir: Dir, qty: number, entryId?: string): OrderIntent {
    return {
      id,
      symbol: this.symbol,
      side: posDir > 0 ? 'sell' : 'buy',
      type: 'market',
      qty,
      reduceOnly: true,
      tag: 'exit',
      ...(entryId !== undefined ? { entryId } : {}),
      leverage: this.leverage(posDir),
    };
  }

  /**
   * Order quantity before any reversal part. A fixed sizing rule replaces the script's sizing; else
   * the call's qty, else the declaration's default_qty_*. Cash and percent-of-equity are sized at the
   * expected fill (slippage included for market and stop orders), percent-of-equity so the position
   * and its entry commission fit the amount (TradingView). Floored to the pair's qty step.
   */
  private baseQty(qtyArg: number | undefined, dir: Dir, type: OrderIntent['type'], limit: number | undefined, stop: number | undefined, close: number): number {
    let price = close;
    // A stop / limit not yet marketable at the close is sized at its own level.
    if (stop !== undefined) price = (dir > 0 ? close >= stop : close <= stop) ? close : stop;
    else if (limit !== undefined) price = (dir > 0 ? close <= limit : close >= limit) ? close : limit;
    if (this.sizing.kind === 'fixed') return this.roundQty(this.sizing.notionalUsd / price);
    if (qtyArg !== undefined) return this.roundQty(Math.abs(qtyArg));
    const value = this.decl.defaultQtyValue;
    if (type === 'market' || type === 'stop') price += dir * (this.decl.overridden.slippage ?? 0) * this.rules.tickSize;
    switch (this.decl.defaultQtyType) {
      case 'fixed':
        return this.roundQty(value);
      case 'cash':
        return this.roundQty(value / price);
      case 'percent_of_equity': {
        const margin = dir > 0 ? this.decl.marginLong : this.decl.marginShort;
        const pct = margin === 0 ? Math.min(value, 100) : value;
        const amount = (this.broker.account().equity * pct) / 100;
        return this.roundQty(amount / (price * (1 + (this.decl.overridden.commission ?? 0) / 100)));
      }
    }
  }

  /** qty / qty_percent of `total` (floored; at least one step for a percentage, never more than total). */
  private partialQty(total: number, qty?: number, qtyPercent?: number): number {
    if (qty !== undefined && qty > 0) return Math.min(this.roundQty(qty), total);
    if (qtyPercent !== undefined && qtyPercent > 0 && qtyPercent < 100) {
      return Math.min(total, Math.max(this.rules.stepSize, this.roundQty((total * qtyPercent) / 100)));
    }
    return total;
  }

  /** Floors a quantity to the qty step (the 1e-10 slack absorbs binary noise: 0.15 / 0.00001). */
  private roundQty(qty: number): number {
    const step = this.rules.stepSize;
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    const steps = Math.floor((qty / step) * (1 + 1e-10));
    return Number((steps * step).toFixed(Math.min(10, decimalsOf(step))));
  }

  /** A price `ticks` ticks from 0 on the tick grid, without float noise. */
  private onGrid(ticks: number): number {
    const step = this.rules.tickSize;
    return Number((Math.round(ticks) * step).toFixed(Math.min(10, decimalsOf(step))));
  }

  /** An order level on the tick grid, rounded by side: buy limit down, buy stop up, sell limit up, sell stop down. */
  private roundLevel(price: number, side: Dir, kind: 'limit' | 'stop'): number {
    const step = this.rules.tickSize;
    if (!(step > 0) || !Number.isFinite(price)) return price;
    const ticks = price / step;
    const up = (kind === 'stop') === (side === 1);
    return this.onGrid(up ? Math.ceil(ticks - 1e-4) : Math.floor(ticks + 1e-4));
  }
}
