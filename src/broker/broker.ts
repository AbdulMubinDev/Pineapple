import type {
  AccountView,
  BrokerMode,
  BrokerState,
  Candle,
  ClosedTrade,
  FeeConfig,
  Fill,
  OrderIntent,
  PairRules,
  Position,
  PositionMeta,
  SizingRule,
  StoredOrder,
  SubmitResult,
} from '../core/types.js';
import { fillPrice, floorToStep, marginRequired, roundToTick, tradeFee } from './costs.js';

export interface BrokerOptions {
  startingBalance: number;
  fees: FeeConfig;
  mode: BrokerMode;
  rules: (s: string) => PairRules;
  sizing: SizingRule;
}

type ExitReason = ClosedTrade['exitReason'];

/** Where an order would trigger while price moves cursor -> target. */
interface Trigger {
  price: number;
  dist: number;
}

const QTY_EPS = 1e-12;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * Deterministic paper broker. No I/O and no clock: all time comes in as a parameter.
 * Balance is the wallet balance (starting balance + realised P&L - fees).
 */
export class PaperBroker {
  private readonly o: BrokerOptions;
  private balance: number;
  private feesPaid = 0;
  private fundingNet = 0;
  private nextSeq = 0;
  private positions: Record<string, Position> = {};
  private meta: Record<string, PositionMeta> = {};
  private lastPrice: Record<string, number> = {};
  private orders: StoredOrder[] = [];
  private closed: ClosedTrade[] = [];

  constructor(o: BrokerOptions) {
    this.o = o;
    this.balance = o.startingBalance;
  }

  /** Queue an order. Market orders fill at the next onBarOpen/onPrice. */
  submit(i: OrderIntent, now: number): SubmitResult {
    const ref = this.lastPrice[i.symbol];
    if (ref === undefined) throw new Error(`no reference price known for ${i.symbol}`);
    const rules = this.o.rules(i.symbol);
    const binance = this.o.mode === 'binance';

    let qty = i.qty;
    if (this.o.sizing.kind === 'fixed' && i.tag === 'entry' && !i.reduceOnly) {
      qty = this.o.sizing.notionalUsd / ref;
    }
    if (binance) qty = floorToStep(qty, rules.stepSize);
    if (!(qty > 0)) return { accepted: false, reason: 'zero_qty_after_rounding' };
    if (binance && qty * ref < rules.minNotional) return { accepted: false, reason: 'below_min_notional' };

    if (!i.reduceOnly && i.tag !== 'exit') {
      const pos = this.positions[i.symbol];
      const opposes = pos !== undefined && (pos.qty > 0) !== (i.side === 'buy');
      const openQty = opposes ? Math.max(0, qty - Math.abs(pos.qty)) : qty;
      if (openQty > 0) {
        const need = marginRequired(openQty, ref, i.leverage) + tradeFee(openQty, ref, this.o.fees.takerRate);
        if (need > this.account().freeMargin) return { accepted: false, reason: 'no_free_balance' };
      }
    }

    this.orders = this.orders.filter((x) => x.id !== i.id);
    this.orders.push({ ...i, qty, seq: this.nextSeq++, submittedAt: now });
    return { accepted: true };
  }

  cancel(orderId: string): void {
    this.orders = this.orders.filter((x) => x.id !== orderId);
  }

  /** A new bar opened: pending market orders fill at bar.open plus slippage. */
  onBarOpen(symbol: string, bar: Candle): Fill[] {
    this.lastPrice[symbol] = bar.open;
    // TODO(Task 4): apply funding events due at this bar open.
    return this.fillMarketOrders(symbol, bar.open, bar.openTime);
  }

  /** Trigger resting stop/limit orders along the bar path (TradingView's intrabar assumption). */
  onBarRange(symbol: string, bar: Candle): Fill[] {
    const lowFirst = Math.abs(bar.high - bar.open) >= Math.abs(bar.open - bar.low);
    const path = lowFirst
      ? [bar.open, bar.low, bar.high, bar.close]
      : [bar.open, bar.high, bar.low, bar.close];
    // TODO(Task 4): check liquidation along this path before processing orders.
    const fills = this.walkPath(symbol, path, bar.openTime);
    this.lastPrice[symbol] = bar.close;
    return fills;
  }

  /** Live tick: market orders fill at price, resting orders trigger on the move from the last price. */
  onPrice(symbol: string, price: number, time: number): Fill[] {
    const prev = this.lastPrice[symbol];
    this.lastPrice[symbol] = price;
    const fills = this.fillMarketOrders(symbol, price, time);
    if (prev !== undefined) fills.push(...this.walkPath(symbol, [prev, price], time));
    return fills;
  }

  markToMarket(symbol: string, price: number): void {
    this.lastPrice[symbol] = price;
  }

  position(symbol: string): Position | null {
    const p = this.positions[symbol];
    return p ? { ...p } : null;
  }

  account(): AccountView {
    let unrealised = 0;
    let usedMargin = 0;
    for (const p of Object.values(this.positions)) {
      const last = this.lastPrice[p.symbol] ?? p.entryPrice;
      unrealised += p.qty * (last - p.entryPrice);
      usedMargin += p.margin;
    }
    const equity = this.balance + unrealised;
    return {
      balance: this.balance,
      equity,
      usedMargin,
      freeMargin: equity - usedMargin,
      feesPaid: this.feesPaid,
      fundingNet: this.fundingNet,
    };
  }

  closedTrades(): ClosedTrade[] {
    return this.closed.map((t) => ({ ...t }));
  }

  openOrders(symbol?: string): OrderIntent[] {
    return this.orders
      .filter((x) => symbol === undefined || x.symbol === symbol)
      .map((x) => {
        const intent: Partial<StoredOrder> = { ...x };
        delete intent.seq;
        delete intent.submittedAt;
        delete intent.triggered;
        return intent as OrderIntent;
      });
  }

  snapshot(): BrokerState {
    return clone({
      balance: this.balance,
      feesPaid: this.feesPaid,
      fundingNet: this.fundingNet,
      nextSeq: this.nextSeq,
      positions: this.positions,
      meta: this.meta,
      lastPrice: this.lastPrice,
      orders: this.orders,
      closed: this.closed,
    });
  }

  static restore(s: BrokerState, o: BrokerOptions): PaperBroker {
    const b = new PaperBroker(o);
    const c = clone(s);
    b.balance = c.balance;
    b.feesPaid = c.feesPaid;
    b.fundingNet = c.fundingNet;
    b.nextSeq = c.nextSeq;
    b.positions = c.positions;
    b.meta = c.meta;
    b.lastPrice = c.lastPrice;
    b.orders = c.orders;
    b.closed = c.closed;
    return b;
  }

  // ---------------------------------------------------------------- internals

  private fillMarketOrders(symbol: string, price: number, time: number): Fill[] {
    const fills: Fill[] = [];
    const pending = this.orders.filter((x) => x.symbol === symbol && x.type === 'market');
    for (const ord of pending) {
      if (!this.orders.includes(ord)) continue; // cancelled by an OCA sibling
      const f = this.execute(ord, price, time);
      if (f) fills.push(f);
    }
    return fills;
  }

  /** Where `o` triggers while price moves from cursor to target, or null. */
  private trigger(o: StoredOrder, cursor: number, target: number): Trigger | null {
    const buy = o.side === 'buy';
    if (o.type === 'limit' || (o.type === 'stop_limit' && o.triggered)) {
      const limit = o.limitPrice as number;
      if (buy) {
        if (cursor <= limit) return { price: cursor, dist: 0 };
        if (target <= limit) return { price: limit, dist: cursor - limit };
      } else {
        if (cursor >= limit) return { price: cursor, dist: 0 };
        if (target >= limit) return { price: limit, dist: limit - cursor };
      }
      return null;
    }
    const stop = o.stopPrice as number;
    if (buy) {
      if (cursor >= stop) return { price: cursor, dist: 0 }; // gapped through the stop
      if (target >= stop) return { price: stop, dist: stop - cursor };
    } else {
      if (cursor <= stop) return { price: cursor, dist: 0 };
      if (target <= stop) return { price: stop, dist: cursor - stop };
    }
    return null;
  }

  private walkPath(symbol: string, path: number[], time: number): Fill[] {
    const fills: Fill[] = [];
    const filledGroups = new Set<string>();
    for (let i = 0; i + 1 < path.length; i++) {
      let cursor = path[i] as number;
      const target = path[i + 1] as number;
      for (;;) {
        let best: { ord: StoredOrder; t: Trigger } | null = null;
        for (const ord of this.orders) {
          if (ord.symbol !== symbol || ord.type === 'market') continue;
          if (ord.ocaGroup !== undefined && filledGroups.has(ord.ocaGroup)) continue;
          const t = this.trigger(ord, cursor, target);
          if (t && (best === null || t.dist < best.t.dist)) best = { ord, t };
        }
        if (best === null) break;
        cursor = best.t.price;
        if (best.ord.type === 'stop_limit' && !best.ord.triggered) {
          best.ord.triggered = true; // now rests as a limit; re-evaluate from here
          continue;
        }
        const f = this.execute(best.ord, best.t.price, time);
        if (f) {
          fills.push(f);
          if (best.ord.ocaGroup !== undefined) filledGroups.add(best.ord.ocaGroup);
        }
      }
    }
    return fills;
  }

  /** Fill an order at a reference price. Returns null if it was dropped (nothing to reduce). */
  private execute(ord: StoredOrder, refPrice: number, time: number): Fill | null {
    this.orders = this.orders.filter((x) => x !== ord);
    const pos = this.positions[ord.symbol];
    let qty = ord.qty;
    if (ord.reduceOnly || ord.tag === 'exit') {
      if (!pos || (pos.qty > 0) === (ord.side === 'buy')) return null;
      qty = Math.min(qty, Math.abs(pos.qty));
    }

    const maker = ord.type === 'limit' || (ord.type === 'stop_limit' && ord.triggered === true);
    let price = refPrice;
    if (!maker) {
      price = fillPrice(refPrice, ord.side, this.o.fees.slippagePct);
      if (this.o.mode === 'binance') {
        price = roundToTick(price, this.o.rules(ord.symbol).tickSize, ord.side === 'buy' ? 'up' : 'down');
      }
    }
    const fee = tradeFee(qty, price, maker ? this.o.fees.makerRate : this.o.fees.takerRate);
    const reason: ExitReason =
      ord.type === 'stop' || ord.type === 'stop_limit' ? 'stop' : ord.type === 'limit' && ord.tag === 'exit' ? 'target' : 'signal';

    this.applyFill(ord, qty, price, fee, time, reason);
    this.applyOca(ord, qty);
    this.purgeOrphanExits(ord.symbol);

    return {
      orderId: ord.id,
      symbol: ord.symbol,
      time,
      price,
      qty,
      side: ord.side,
      fee,
      liquidity: maker ? 'maker' : 'taker',
    };
  }

  private applyFill(ord: StoredOrder, qty: number, price: number, fee: number, time: number, reason: ExitReason): void {
    const sym = ord.symbol;
    const sign = ord.side === 'buy' ? 1 : -1;
    this.balance -= fee;
    this.feesPaid += fee;

    const pos = this.positions[sym];
    const m = this.meta[sym];
    if (!pos || !m || Math.sign(pos.qty) === sign) {
      this.addToPosition(ord, qty, price, fee, time);
      return;
    }

    const closeQty = Math.min(qty, Math.abs(pos.qty));
    const closeFee = (fee * closeQty) / qty;
    const frac = closeQty / Math.abs(pos.qty);
    const entryFees = m.fees * frac;
    const funding = m.funding * frac;
    const pnl = closeQty * (price - pos.entryPrice) * Math.sign(pos.qty);
    this.balance += pnl;
    this.closed.push({
      symbol: sym,
      side: pos.qty > 0 ? 'long' : 'short',
      entryTime: pos.openTime,
      entryPrice: pos.entryPrice,
      exitTime: time,
      exitPrice: price,
      qty: closeQty,
      pnl,
      fees: entryFees + closeFee,
      funding,
      exitReason: reason,
    });

    if (Math.abs(pos.qty) - closeQty <= QTY_EPS) {
      delete this.positions[sym];
      delete this.meta[sym];
    } else {
      pos.qty -= Math.sign(pos.qty) * closeQty;
      pos.margin *= 1 - frac;
      m.fees -= entryFees;
      m.funding -= funding;
    }

    const openQty = qty - closeQty;
    if (openQty > QTY_EPS) this.addToPosition(ord, openQty, price, fee - closeFee, time);
  }

  private addToPosition(ord: StoredOrder, qty: number, price: number, fee: number, time: number): void {
    const sym = ord.symbol;
    const sign = ord.side === 'buy' ? 1 : -1;
    const pos = this.positions[sym];
    const m = this.meta[sym];
    const margin = marginRequired(qty, price, ord.leverage);
    if (pos && m) {
      const total = Math.abs(pos.qty) + qty;
      pos.entryPrice = (Math.abs(pos.qty) * pos.entryPrice + qty * price) / total;
      pos.qty += sign * qty;
      pos.margin += margin;
      pos.leverage = ord.leverage;
      m.fees += fee;
    } else {
      this.positions[sym] = { symbol: sym, qty: sign * qty, entryPrice: price, leverage: ord.leverage, margin, openTime: time };
      this.meta[sym] = { fees: fee, funding: 0 };
    }
  }

  private applyOca(filled: StoredOrder, qty: number): void {
    if (filled.ocaGroup === undefined) return;
    const siblings = this.orders.filter((x) => x.symbol === filled.symbol && x.ocaGroup === filled.ocaGroup);
    for (const s of siblings) {
      if (filled.ocaType === 'reduce') {
        s.qty -= qty;
        if (s.qty <= QTY_EPS) this.orders = this.orders.filter((x) => x !== s);
      } else {
        this.orders = this.orders.filter((x) => x !== s);
      }
    }
  }

  /** Drop exits that can no longer do anything because the position they protect is gone. */
  private purgeOrphanExits(symbol: string): void {
    const pos = this.positions[symbol];
    this.orders = this.orders.filter((x) => {
      if (x.symbol !== symbol || !(x.reduceOnly || x.tag === 'exit')) return true;
      return pos !== undefined && (pos.qty > 0) !== (x.side === 'buy');
    });
  }
}
