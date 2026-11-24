// Pine's order semantics on top of our broker, the way TradingView's broker emulator applies them
// (PineTS 0.13.1's emulator, which tracks TradingView closely, is the reference for the details).
//
// The script's strategy.* calls (captured by pine-runner) become broker OrderIntents here, and the
// script's read-backs (strategy.position_size, equity, opentrades, ...) come from scriptView(), which
// reads the broker. The broker holds one net position per symbol; this layer adds what Pine needs on
// top: entry ids, the open trades per entry, pyramiding, reversals and the exit orders.
//
// How the replay drives it, per bar (src/engine/replay.ts, barHooks):
//   before: fills = broker.onBarOpen(...)   -> submit(layer.onFills(fills, bar, idx))
//           funding events in the bar
//           fills = broker.onBarRange(...)  -> submit(layer.onFills(fills, bar, idx))   (liquidations included)
//           broker.markToMarket(close); return layer.scriptView()
//   after:  submit(layer.toIntents(calls, bar))
//           process_orders_on_close: fills = broker.fillMarketAt(close) -> submit(layer.onFills(...))
// Every fill the broker reports for this symbol must reach onFills: the layer's trades are built from
// them, and scriptView() throws if they no longer add up to the broker's position.
//
// Exit orders belong to the layer. A strategy.exit for an entry that has not filled yet waits here
// and goes to the broker (via onFills) as soon as the entry fills: right after onBarOpen for a market
// entry, so the stop already protects the fill bar, as on TradingView.
//
// Cancellations (strategy.cancel / cancel_all, replaced or withdrawn exits) are applied to the broker
// directly; everything to submit is returned.
//
// An exit leg the broker did not take (rejected at submit) is sent again on the next settle, at most
// MAX_RESENDS_PER_BAR times per bar and MAX_RESENDS times in all; after that it is abandoned (one
// exit_leg_abandoned anomaly) and never sent again for that exit.
//
// A delisting (broker.forceClose) closes the whole position: its fill clears the open trades, the held
// exits and the parked entries, and nothing is sent for them.
//
// Live runs save the layer with the broker (snapshot / restore, src/engine/layer-state.ts). Sizing is the
// broker's current rule (PaperBroker.setSizing), so an owner edit reaches both.
import type { PaperBroker } from '../broker/broker.js';
import { leverageInForce } from '../broker/margin.js';
import type { Candle, FeeConfig, Fill, OrderIntent, PairRules, SizingRule } from '../core/types.js';
import { decodeLayer, encodeLayer, type Dir, type ExitReg, type LayerState, type Lot, type OrderMeta, type TradeRecord } from './layer-state.js';
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

interface OverfillPiece {
  qty: number;
  price: number;
  time: number;
}

/** Something the layer had to correct after the broker acted; the replay should log these. */
export interface LayerAnomaly {
  kind: 'pyramiding_overfill' | 'exit_leg_resent' | 'exit_leg_abandoned' | 'overfill_absorbed';
  orderId: string;
  time: number;
}

export interface AttributionPart {
  kind: 'script' | 'overfill';
  qty: number;
  entryPrice: number;
  /** Overfill parts: when that lot filled (the broker trade's entry time is the position's). */
  entryTime?: number;
  /** Gross P&L of this part at its own entry price and the fill price (before the broker's liquidation remainder). */
  pnl: number;
}

/** One closing fill (the broker closed trade with this exitOrderId and exitTime), restated in parts. */
export interface TradeAttribution {
  orderId: string;
  time: number;
  parts: AttributionPart[];
}

const OVERFILL = '\u0000overfill';

const EPS = 1e-9;
/** Re-sends of one rejected exit leg: per bar, and in all (then it is abandoned). */
export const MAX_RESENDS_PER_BAR = 3;
export const MAX_RESENDS = 10;

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
  private meta = new Map<string, OrderMeta>();
  private exits = new Map<string, ExitReg>();
  /** strategy.entry adds taken off the broker while the pyramiding cap is full (they go back once there is room). */
  private parked = new Map<string, OrderIntent>();
  private anomalyLog: LayerAnomaly[] = [];
  private attributionLog: TradeAttribution[] = [];
  /** The broker's averaged entry over the script's own fills (overfill lots left out). */
  private scriptAvg = 0;
  /** An overfill lot has been part of the current broker position. */
  private tainted = false;
  private seq = 0;
  /** The broker's fees when this layer was first built (see baseQty). */
  private baseFees: FeeConfig;
  private delisted = false;

  constructor(
    private readonly decl: StrategyDeclaration,
    private readonly broker: PaperBroker,
    private readonly symbol: string,
    sizing: SizingRule,
    opts: LayerOptions,
  ) {
    // The layer sizes with the broker's rule as it is at each order (setSizing reaches both): a different
    // rule here would be silently ignored, so it is a wiring error.
    const current = broker.sizingRule();
    const same = sizing.kind === current.kind && (sizing.kind !== 'fixed' || (current.kind === 'fixed' && sizing.notionalUsd === current.notionalUsd));
    if (!same) throw new Error(`StrategyLayer(${symbol}): sizing ${JSON.stringify(sizing)} is not the broker's ${JSON.stringify(current)}`);
    this.rules = opts.rules;
    this.from = opts.from;
    this.baseFees = broker.feeConfig();
  }

  /** Plain JSON, saved with the broker's snapshot: restore() continues exactly where this left off. */
  snapshot(): LayerState {
    return encodeLayer(this.symbol, {
      lots: this.lots,
      records: this.records,
      meta: this.meta,
      exits: this.exits,
      parked: this.parked,
      scriptAvg: this.scriptAvg,
      tainted: this.tainted,
      seq: this.seq,
      anomalies: this.anomalyLog,
      attributions: this.attributionLog,
      baseFees: this.baseFees,
      delisted: this.delisted,
    });
  }

  /**
   * The layer `s` was taken from, on the restored broker. The other arguments are the constructor's, as at
   * construction; `sizing` defaults to the broker's current rule.
   */
  static restore(
    s: LayerState,
    decl: StrategyDeclaration,
    broker: PaperBroker,
    symbol: string,
    sizing: SizingRule | undefined,
    opts: LayerOptions,
  ): StrategyLayer {
    const layer = new StrategyLayer(decl, broker, symbol, sizing ?? broker.sizingRule(), opts);
    const d = decodeLayer(symbol, s);
    layer.lots = d.lots;
    layer.records = d.records;
    layer.meta = d.meta;
    layer.exits = d.exits;
    layer.parked = d.parked;
    layer.scriptAvg = d.scriptAvg;
    layer.tainted = d.tainted;
    layer.seq = d.seq;
    layer.anomalyLog = d.anomalies;
    layer.attributionLog = d.attributions;
    layer.baseFees = d.baseFees;
    layer.delisted = d.delisted;
    return layer;
  }

  /**
   * The pair left the exchange. Drops everything still held for it (exits waiting for an entry, parked
   * entries, order bookkeeping) and refuses any later order. With a position, call broker.forceClose and
   * pass its fill to onFills instead (that ends here too).
   */
  onDelisted(): void {
    if (Math.abs(this.netSize()) > EPS) throw new Error(`StrategyLayer(${this.symbol}).onDelisted with an open position: forceClose it and pass the fill to onFills`);
    for (const reg of [...this.exits.values()]) this.dropExit(reg);
    for (const id of this.meta.keys()) this.broker.cancel(id);
    this.parked.clear();
    this.meta.clear();
    this.lots = [];
    this.records = [];
    this.delisted = true;
  }

  /** Corrections the layer made after the broker acted (pyramiding overfills, re-sent exit legs). */
  anomalies(): LayerAnomaly[] {
    return this.anomalyLog.map((a) => ({ ...a }));
  }

  /** How closing fills split between script trades and overfill lots (see attribute()); empty without overfills. */
  attributions(): TradeAttribution[] {
    return this.attributionLog.map((a) => ({ ...a, parts: a.parts.map((p) => ({ ...p })) }));
  }

  /** A flat view (warm-up, validation): no position, the given equity. */
  static flatView(equity: number): ScriptView {
    return { positionSize: 0, positionAvgPrice: NaN, equity, openTrades: 0, netProfit: 0, openProfit: 0, opentrades: [] };
  }

  // ------------------------------------------------------------------ public ----

  /** The order intents for one bar's calls, in call order. Cancellations are applied to the broker now. */
  toIntents(calls: PineOrderCall[], bar: Candle): OrderIntent[] {
    if (this.delisted || (this.from !== undefined && bar.openTime < this.from)) return [];
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
    this.settle(batch, bar.openTime);
    return [...batch.values()];
  }

  /**
   * Books broker fills for this symbol into the open trades. Returns the exit orders that are now due
   * (an entry filled, or a trade's size changed): submit them before the broker's next price event.
   */
  onFills(fills: Fill[], bar: Candle, idx: number): OrderIntent[] {
    const out = new Map<string, OrderIntent>();
    for (const f of fills) {
      if (f.symbol !== this.symbol) continue;
      if (f.orderId.startsWith('liquidation:')) {
        this.attributeFullClose(f);
        continue;
      }
      if (f.orderId.startsWith('delisting:')) {
        // The pair is leaving: the whole position closed, and nothing of the script's may follow it.
        this.attributeFullClose(f);
        this.onDelisted();
        continue;
      }
      const m = this.meta.get(f.orderId);
      const reg = m?.kind === 'exit' && m.exitKey ? this.exits.get(m.exitKey) : undefined;
      // An exit id fills once per trade: re-issuing it while the trade is open does nothing (TradingView:
      // a qty_percent = 50 exit called every bar closes half the trade, not half of the rest each bar).
      if (reg) for (const l of this.eligibleLots(reg.exitId, reg.fromEntry)) l.exitsFilled.add(reg.exitId);
      this.book(f, m, idx, out);
      if (reg) this.dropExit(reg);
      if (m && (m.kind === 'close' || m.kind === 'close_all' || m.kind === 'overfill')) this.meta.delete(f.orderId);
    }
    this.settle(out, bar.openTime);
    return [...out.values()];
  }

  /** After a bar's calls or a broker event: park / release capped entries, then bring every exit up to date. */
  private settle(batch: Map<string, OrderIntent>, time: number): void {
    this.parkCappedEntries(batch);
    const resting = new Set(this.broker.openOrders(this.symbol).map((o) => o.id));
    for (const reg of [...this.exits.values()]) this.syncExit(reg, batch, resting, time);
  }

  /**
   * Pyramiding is counted when an entry fills (TradingView, PineTS's case "21"). Our broker fills on
   * its own, so while the cap is full for the position's direction, resting strategy.entry adds in that
   * direction are taken off the broker and kept here; they go back as soon as there is room again (a
   * trade closed, or the position went flat or reversed). strategy.order is not limited by pyramiding.
   */
  private parkCappedEntries(batch: Map<string, OrderIntent>): void {
    const net = this.netSize();
    const full = (d: Dir) => net !== 0 && Math.sign(net) === d && this.tradeLots().filter((l) => l.dir === d).length >= this.decl.pyramiding;
    for (const o of this.broker.openOrders(this.symbol)) {
      if (this.meta.get(o.id)?.kind !== 'entry' || batch.has(o.id)) continue;
      if (full(o.side === 'buy' ? 1 : -1)) {
        this.broker.cancel(o.id);
        this.parked.set(o.id, o);
      }
    }
    for (const [id, o] of [...this.parked]) {
      if (batch.has(id)) {
        this.parked.delete(id);
        continue;
      }
      if (!full(o.side === 'buy' ? 1 : -1)) {
        this.parked.delete(id);
        batch.set(id, o);
      }
    }
  }

  scriptView(): ScriptView {
    const pos = this.broker.position(this.symbol);
    const qty = pos?.qty ?? 0;
    const net = this.netSize();
    if (Math.abs(net - qty) > EPS * Math.max(1, Math.abs(qty))) {
      throw new Error(`StrategyLayer(${this.symbol}) is out of sync with the broker (${net} vs ${qty}): every broker fill must reach onFills`);
    }
    const last = this.broker.lastPriceOf(this.symbol);
    // Kept running per symbol by the broker: one shared broker holds every pair's closed trades.
    const netProfit = this.broker.realisedNet(this.symbol);
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
    this.parked.delete(id);
    const cur = this.projected(batch);
    const adding = cur !== 0 && Math.sign(cur) === dir;
    // Pyramiding caps adds to a same-direction position by its open entries (not opening, not reversing).
    // Market entries queued earlier on this bar fill first, so they count as open by the time this one
    // fills (pyramiding 1, two entries from flat on one bar: one trade). Resting limit / stop adds are
    // counted when they fill instead (parkCappedEntries, book).
    const queued = [...batch.values()].filter((o) => o.type === 'market' && o.tag === 'entry' && !o.reduceOnly && (o.side === 'buy' ? 1 : -1) === dir).length;
    if (adding && this.tradeLots().filter((l) => l.dir === dir).length + queued >= this.decl.pyramiding) return;
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
    // An exit for an entry that is neither open nor pending places nothing (and replaces nothing). An
    // open trade this exit id has already filled against does not count: it fills once per trade.
    const eligible = this.eligibleLots(c.id, fromEntry).length > 0;
    if (fromEntry && !eligible && !this.entryPending(fromEntry, batch)) return;
    if (!fromEntry && !eligible && this.tradeLots().length > 0 && !this.anyEntryPending(batch)) return;
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
      awaiting: old?.awaiting ?? new Set(),
      retries: old?.retries ?? new Map(),
      abandoned: old?.abandoned ?? new Set(),
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
    this.parked.delete(id);
    this.broker.cancel(id);
    for (const reg of [...this.exits.values()]) if (reg.exitId === pineId) this.dropExit(reg, batch);
  }

  private cancelAll(batch: Map<string, OrderIntent>): void {
    batch.clear();
    this.parked.clear();
    for (const o of this.broker.openOrders(this.symbol)) {
      const k = this.meta.get(o.id)?.kind;
      if (k !== undefined && k !== 'overfill') this.broker.cancel(o.id);
    }
    for (const reg of [...this.exits.values()]) this.dropExit(reg);
  }

  // ------------------------------------------------------------------ exits ----

  /** Brings the broker's legs of one exit up to date with its trades (sends changes only). */
  private syncExit(reg: ExitReg, batch: Map<string, OrderIntent>, resting: Set<string>, time: number): void {
    const lots = this.eligibleLots(reg.exitId, reg.fromEntry);
    if (lots.length === 0) {
      // Waiting for its entry, or its trade is gone (then it goes too).
      if (reg.wasLive) this.dropExit(reg, batch);
      return;
    }
    reg.wasLive = true;
    const dir = lots[0]!.dir;
    // Other trades to protect (a reversal under an exit for every entry): its legs get a fresh start.
    const protects = `${dir}|${[...new Set(lots.map((l) => l.entryId))].join('|')}`;
    if (reg.protects !== undefined && reg.protects !== protects) {
      reg.retries.clear();
      reg.abandoned.clear();
    }
    reg.protects = protects;
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
    // A leg handed out earlier that the broker does not hold: in a user OCA group a sibling's fill took
    // it (the exit is used up); otherwise the broker rejected it at submit, so it is sent again (bounded).
    for (const [id] of legs) {
      if (!reg.sent.has(id) || resting.has(id) || batch.has(id)) continue;
      if (reg.ocaName) {
        for (const l of lots) l.exitsFilled.add(reg.exitId);
        this.dropExit(reg, batch);
        return;
      }
      reg.sent.delete(id);
      reg.awaiting.add(id);
    }
    for (const [id, intent] of legs) {
      if (intent) {
        if (reg.abandoned.has(id)) continue;
        const json = JSON.stringify(intent);
        if (reg.sent.get(id) !== json) {
          if (reg.awaiting.has(id) && !this.mayResend(reg, id, time)) continue;
          reg.sent.set(id, json);
          this.meta.set(id, { kind: 'exit', entryId: reg.fromEntry || undefined, exitKey: reg.key });
          batch.set(id, intent);
        }
      } else {
        reg.awaiting.delete(id);
        if (reg.sent.has(id)) {
          reg.sent.delete(id);
          batch.delete(id);
          this.broker.cancel(id);
          this.meta.delete(id);
        }
      }
    }
  }

  /**
   * A rejected leg is due again: counts the re-send (logged), or holds it to the next bar once this bar
   * has had MAX_RESENDS_PER_BAR, or abandons it for good (logged once) after MAX_RESENDS.
   */
  private mayResend(reg: ExitReg, id: string, time: number): boolean {
    let r = reg.retries.get(id);
    if (!r) reg.retries.set(id, (r = { total: 0, bar: time, inBar: 0 }));
    if (r.bar !== time) {
      r.bar = time;
      r.inBar = 0;
    }
    if (r.total >= MAX_RESENDS) {
      reg.awaiting.delete(id);
      reg.abandoned.add(id);
      this.meta.delete(id);
      this.anomalyLog.push({ kind: 'exit_leg_abandoned', orderId: id, time });
      return false;
    }
    if (r.inBar >= MAX_RESENDS_PER_BAR) return false;
    r.total++;
    r.inBar++;
    reg.awaiting.delete(id);
    this.anomalyLog.push({ kind: 'exit_leg_resent', orderId: id, time });
    return true;
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
        : this.tradeLots().length > 0 || this.anyEntryPending();
      if (!waiting) this.exits.delete(reg.key);
    }
  }

  /** The trades an exit id may still act on: its entry's (or all) script trades it has not filled against. */
  private eligibleLots(exitId: string, fromEntry: string): Lot[] {
    return (fromEntry ? this.lotsOf(fromEntry) : this.tradeLots()).filter((l) => !l.exitsFilled.has(exitId));
  }

  // ------------------------------------------------------------------ booking fills ----

  private book(f: Fill, m: OrderMeta | undefined, idx: number, out: Map<string, OrderIntent>): void {
    const dir: Dir = f.side === 'buy' ? 1 : -1;
    let qty = f.qty;
    const net = this.netSize();
    if (net !== 0 && Math.sign(net) !== dir) {
      const closing = Math.min(qty, Math.abs(net));
      const named = m?.kind === 'overfill' ? OVERFILL : m && (m.kind === 'exit' || m.kind === 'close') ? m.entryId : undefined;
      const fromOverfill = this.closeLots(closing, named);
      this.closeRecords(closing - fromOverfill.reduce((s, p) => s + p.qty, 0), named);
      this.attribute(f, m, closing, fromOverfill, -dir as Dir);
      qty -= closing;
    }
    if (qty <= EPS) return;
    if (m?.kind === 'entry' && net !== 0 && Math.sign(net) === dir && this.tradeLots().filter((l) => l.dir === dir).length >= this.decl.pyramiding) {
      // An add past the pyramiding cap that the broker filled before the layer could take it off (two
      // adds filling inside one broker call). TradingView would have cancelled it: it is not a script
      // trade, and a market close takes it out at the next price event. Logged as an anomaly.
      this.lots.push({ entryId: OVERFILL, qty, dir, price: f.price, time: f.time, exitsFilled: new Set(), overfill: true });
      this.tainted = true;
      const id = `${this.symbol}|OF|${this.seq++}`;
      this.meta.set(id, { kind: 'overfill' });
      out.set(id, this.closeIntent(id, dir, qty));
      this.anomalyLog.push({ kind: 'pyramiding_overfill', orderId: f.orderId, time: f.time });
      return;
    }
    const entryId = m?.entryId ?? f.orderId;
    const held = this.scriptQty();
    this.scriptAvg = (held * this.scriptAvg + qty * f.price) / (held + qty);
    this.lots.push({ entryId, qty, dir, price: f.price, exitsFilled: new Set() });
    this.records.push({ entryId, qty, dir, price: f.price, barIndex: idx, time: f.time });
  }

  /**
   * Physical lots: a close / exit for an entry takes that entry's lots first, oldest first. Returns
   * the pieces taken from overfill lots (not script trades), each at its lot's fill price and time.
   */
  private closeLots(qty: number, entryId?: string): OverfillPiece[] {
    const order = entryId ? [...this.lots.filter((l) => l.entryId === entryId), ...this.lots.filter((l) => l.entryId !== entryId)] : this.lots;
    let need = qty;
    const pieces: OverfillPiece[] = [];
    for (const l of order) {
      if (need <= EPS) break;
      const take = Math.min(l.qty, need);
      l.qty -= take;
      need -= take;
      if (l.overfill) pieces.push({ qty: take, price: l.price, time: l.time ?? 0 });
    }
    this.lots = this.lots.filter((l) => l.qty > EPS);
    return pieces;
  }

  private overfillParts(pieces: OverfillPiece[], exit: number, posDir: Dir): AttributionPart[] {
    return pieces.map((p): AttributionPart => ({ kind: 'overfill', qty: p.qty, entryPrice: p.price, entryTime: p.time, pnl: posDir * (exit - p.price) * p.qty }));
  }

  /** A liquidation or delisting took the whole position: while tainted, it is restated like any other closing fill. */
  private attributeFullClose(f: Fill): void {
    const net = this.netSize();
    if (this.tainted && Math.abs(net) > EPS) {
      const posDir: Dir = net > 0 ? 1 : -1;
      const scriptPart = this.scriptQty();
      const parts: AttributionPart[] = [];
      if (scriptPart > EPS) parts.push({ kind: 'script', qty: scriptPart, entryPrice: this.scriptAvg, pnl: posDir * (f.price - this.scriptAvg) * scriptPart });
      parts.push(...this.overfillParts(this.lots.filter((l) => l.overfill).map((l) => ({ qty: l.qty, price: l.price, time: l.time ?? 0 })), f.price, posDir));
      this.attributionLog.push({ orderId: f.orderId, time: f.time, parts });
    }
    this.lots = [];
    this.records = [];
    this.scriptAvg = 0;
    this.tainted = false;
  }

  /**
   * The broker keeps one averaged entry per position, so once an overfill lot has been in it, the
   * broker's P&L for each closing fill mixes the overfill's price into the script's. While that is so,
   * every closing fill is restated in parts: the script's share at the script's own average entry
   * (the broker's averaging rule over the script fills only) and the overfill share at its lots' prices.
   * Over a whole position the parts add up to the broker's P&L.
   */
  private attribute(f: Fill, m: OrderMeta | undefined, closing: number, pieces: OverfillPiece[], posDir: Dir): void {
    const fromOverfill = pieces.reduce((s, p) => s + p.qty, 0);
    const scriptPart = closing - fromOverfill;
    if (this.tainted) {
      const parts: AttributionPart[] = [];
      if (scriptPart > EPS) parts.push({ kind: 'script', qty: scriptPart, entryPrice: this.scriptAvg, pnl: posDir * (f.price - this.scriptAvg) * scriptPart });
      if (fromOverfill > EPS) {
        parts.push(...this.overfillParts(pieces, f.price, posDir));
        // The script's own close took overfill quantity before the overfill close could (it never fills).
        if (m?.kind !== 'overfill') this.anomalyLog.push({ kind: 'overfill_absorbed', orderId: f.orderId, time: f.time });
      }
      this.attributionLog.push({ orderId: f.orderId, time: f.time, parts });
    }
    if (this.scriptQty() <= EPS) this.scriptAvg = 0;
    if (Math.abs(this.netSize()) <= EPS) this.tainted = false;
  }

  private scriptQty(): number {
    return this.tradeLots().reduce((s, l) => s + l.qty, 0);
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

  /** An unfilled entry / order with this id: queued on this bar, resting at the broker or parked. */
  private entryPending(pineId: string, batch?: Map<string, OrderIntent>): boolean {
    const id = this.entryOrderId(pineId);
    return (batch?.has(id) ?? false) || this.parked.has(id) || this.broker.openOrders(this.symbol).some((o) => o.id === id);
  }

  private anyEntryPending(batch?: Map<string, OrderIntent>): boolean {
    if (this.parked.size > 0) return true;
    if (batch && [...batch.keys()].some((id) => this.isEntryOrder(id))) return true;
    return this.broker.openOrders(this.symbol).some((o) => this.isEntryOrder(o.id));
  }

  /** The script's trades in physical form (overfill lots excluded). */
  private tradeLots(): Lot[] {
    return this.lots.filter((l) => !l.overfill);
  }

  private lotsOf(entryId: string): Lot[] {
    return this.lots.filter((l) => l.entryId === entryId && !l.overfill);
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
    const sizing = this.broker.sizingRule();
    if (sizing.kind === 'fixed') return this.roundQty(sizing.notionalUsd / price);
    if (qtyArg !== undefined) return this.roundQty(Math.abs(qtyArg));
    const value = this.decl.defaultQtyValue;
    // The declaration's commission and slippage stand for the fees the run started with; after an owner
    // edit (broker.setFees) the broker's fees in force are used instead.
    const fees = this.feesEdited() ? this.broker.feeConfig() : undefined;
    if (type === 'market' || type === 'stop') {
      if (!fees) price += dir * (this.decl.overridden.slippage ?? 0) * this.rules.tickSize;
      else if (fees.slippageTicks !== undefined) price += dir * fees.slippageTicks * this.rules.tickSize;
      else price *= 1 + dir * fees.slippagePct;
    }
    const commissionPct = fees ? fees.takerRate * 100 : (this.decl.overridden.commission ?? 0);
    switch (this.decl.defaultQtyType) {
      case 'fixed':
        return this.roundQty(value);
      case 'cash':
        return this.roundQty(value / price);
      case 'percent_of_equity': {
        const margin = dir > 0 ? this.decl.marginLong : this.decl.marginShort;
        const pct = margin === 0 ? Math.min(value, 100) : value;
        const amount = (this.broker.account().equity * pct) / 100;
        return this.roundQty(amount / (price * (1 + commissionPct / 100)));
      }
    }
  }

  private feesEdited(): boolean {
    const a = this.baseFees;
    const b = this.broker.feeConfig();
    return a.makerRate !== b.makerRate || a.takerRate !== b.takerRate || a.slippagePct !== b.slippagePct || a.slippageTicks !== b.slippageTicks;
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
