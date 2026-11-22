import type {
  AccountView,
  BrokerMode,
  BrokerState,
  Candle,
  ClosedTrade,
  FeeConfig,
  Fill,
  FundingEvent,
  OrderIntent,
  PairRules,
  Position,
  PositionMeta,
  Rejection,
  SizingRule,
  StoredOrder,
  SubmitResult,
} from '../core/types.js';
import { fillPrice, floorToStep, marginRequired, roundToTick, tradeFee } from './costs.js';
import { liquidationPrice, maintenance } from './margin.js';

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
  private rejected: Rejection[] = [];

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

    const reduce = this.isReduce(i);
    const pos = this.positions[i.symbol];
    let qty = i.qty;
    if (this.o.sizing.kind === 'fixed' && i.tag === 'entry' && !i.reduceOnly) {
      // Fixed sizing sizes only the opening part; an opposing order also has to close the old position.
      const opposes = pos !== undefined && (pos.qty > 0) !== (i.side === 'buy');
      qty = this.o.sizing.notionalUsd / ref + (opposes ? Math.abs(pos.qty) : 0);
    }
    if (binance) qty = floorToStep(qty, rules.stepSize);
    if (!(qty > 0)) return { accepted: false, reason: 'zero_qty_after_rounding' };
    // Reduce-only orders skip min notional so a dust remainder can always be closed.
    if (binance && !reduce && qty * ref < rules.minNotional) return { accepted: false, reason: 'below_min_notional' };

    if (!reduce) {
      const openQty = this.openingQty(i, qty);
      if (openQty > 0) {
        const need = this.marginAndFee(openQty, ref, i.leverage);
        // A reversal frees the old position's margin but pays a fee on the closing leg.
        const closeQty = qty - openQty;
        const released = pos && closeQty > 0 ? (pos.margin * closeQty) / Math.abs(pos.qty) : 0;
        const closeFee = tradeFee(closeQty, ref, this.o.fees.takerRate);
        // Pending opening orders already spoken for part of the free margin.
        if (need > this.account().freeMargin - this.reservedMargin(i.id) + released - closeFee) {
          return { accepted: false, reason: 'no_free_balance' };
        }
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
    // Funding is not applied here: the replay calls applyFunding explicitly for events in the bar.
    return this.fillMarketOrders(symbol, bar.open, bar.openTime);
  }

  /** Trigger resting stop/limit orders along the bar path (TradingView's intrabar assumption). */
  onBarRange(symbol: string, bar: Candle): Fill[] {
    const lowFirst = Math.abs(bar.high - bar.open) >= Math.abs(bar.open - bar.low);
    const path = lowFirst
      ? [bar.open, bar.low, bar.high, bar.close]
      : [bar.open, bar.high, bar.low, bar.close];
    // Liquidation is not checked here: the replay calls onMark explicitly after the bar.
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

  /**
   * Mark price update (binance mode only): liquidates an isolated position once the mark crosses its
   * liquidation price. The trade closes at LP and the whole isolated margin is lost: the loss up to LP plus
   * the maintenance remainder, which is forfeited as a clearance fee. Entry fees and funding were already
   * charged to the balance, so the balance drops by exactly the isolated margin.
   */
  onMark(symbol: string, mark: number, time: number): Fill[] {
    if (this.o.mode !== 'binance') return [];
    const pos = this.positions[symbol];
    const m = this.meta[symbol];
    if (!pos || !m) return [];
    const long = pos.qty > 0;
    const qty = Math.abs(pos.qty);
    const { rate, amount } = maintenance(qty * pos.entryPrice, this.o.rules(symbol).brackets);
    const lp = liquidationPrice({
      side: long ? 1 : -1,
      qty,
      entryPrice: pos.entryPrice,
      isolatedMargin: pos.margin,
      mmr: rate,
      maintAmount: amount,
    });
    if (long ? mark > lp : mark < lp) return [];

    this.balance -= pos.margin;
    this.closed.push({
      symbol,
      side: long ? 'long' : 'short',
      entryTime: pos.openTime,
      entryPrice: pos.entryPrice,
      exitTime: time,
      exitPrice: lp,
      qty,
      pnl: -pos.margin,
      fees: m.fees,
      funding: m.funding,
      exitReason: 'liquidation',
    });
    delete this.positions[symbol];
    delete this.meta[symbol];
    this.lastPrice[symbol] = mark;
    this.purgeOrphanExits(symbol);
    return [
      {
        orderId: `liquidation:${symbol}:${time}`,
        symbol,
        time,
        price: lp,
        qty,
        side: long ? 'sell' : 'buy',
        fee: 0,
        liquidity: 'taker',
      },
    ];
  }

  /**
   * Apply a funding payment to the open position (binance mode only). Returns the signed balance change:
   * a long pays when the rate is positive. 0 when there is no position, the position opened at or after the
   * event, or no mark price is known (old rows store markPrice 0, so the last price stands in).
   */
  applyFunding(symbol: string, ev: FundingEvent): number {
    if (this.o.mode !== 'binance') return 0;
    const pos = this.positions[symbol];
    const m = this.meta[symbol];
    if (!pos || !m || !(pos.openTime < ev.time)) return 0;
    const mark = ev.markPrice > 0 ? ev.markPrice : this.lastPrice[symbol];
    if (mark === undefined || !(mark > 0)) return 0;
    const change = -pos.qty * mark * ev.rate;
    this.balance += change;
    this.fundingNet += change;
    m.funding += change;
    return change;
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

  /** Opening orders dropped at fill time because they no longer fit the free margin. */
  rejections(): Rejection[] {
    return this.rejected.map((r) => ({ ...r }));
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
      rejections: this.rejected,
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
    b.rejected = c.rejections ?? [];
    return b;
  }

  // ---------------------------------------------------------------- internals

  private isReduce(o: { reduceOnly: boolean; tag: 'entry' | 'exit' }): boolean {
    return o.reduceOnly || o.tag === 'exit';
  }

  /** The part of an order that opens (or adds to) a position rather than closing one. */
  private openingQty(o: { symbol: string; side: 'buy' | 'sell' }, qty: number): number {
    const pos = this.positions[o.symbol];
    const opposes = pos !== undefined && (pos.qty > 0) !== (o.side === 'buy');
    return opposes ? Math.max(0, qty - Math.abs(pos.qty)) : qty;
  }

  private marginAndFee(qty: number, price: number, leverage: number): number {
    return marginRequired(qty, price, leverage) + tradeFee(qty, price, this.o.fees.takerRate);
  }

  /** Margin + entry fee that pending opening orders (other than `excludeId`) will need. */
  private reservedMargin(excludeId: string): number {
    let sum = 0;
    for (const x of this.orders) {
      if (x.id === excludeId || this.isReduce(x)) continue;
      const price = this.lastPrice[x.symbol];
      if (price === undefined) continue;
      sum += this.marginAndFee(this.openingQty(x, x.qty), price, x.leverage);
    }
    return sum;
  }

  /** A reduce-only/exit order can only act while there is an opposing position to reduce. */
  private canAct(o: StoredOrder): boolean {
    if (!this.isReduce(o)) return true;
    const pos = this.positions[o.symbol];
    return pos !== undefined && (pos.qty > 0) !== (o.side === 'buy');
  }

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
          if (!this.canAct(ord)) continue; // exit with nothing to exit stays resting
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
    if (!this.canAct(ord)) {
      // A market exit has nothing to do now; resting stops/limits are kept (walkPath never offers them).
      if (ord.type === 'market') this.orders = this.orders.filter((x) => x !== ord);
      return null;
    }
    this.orders = this.orders.filter((x) => x !== ord);
    const pos = this.positions[ord.symbol];
    let qty = ord.qty;
    if (this.isReduce(ord) && pos) qty = Math.min(qty, Math.abs(pos.qty));

    const maker = ord.type === 'limit' || (ord.type === 'stop_limit' && ord.triggered === true);
    let price = refPrice;
    if (!maker) {
      price = fillPrice(refPrice, ord.side, this.o.fees.slippagePct);
      if (this.o.mode === 'binance') {
        price = roundToTick(price, this.o.rules(ord.symbol).tickSize, ord.side === 'buy' ? 'up' : 'down');
      }
    }
    if (!this.isReduce(ord)) {
      // Re-check against the actual fill price; closing an opposing position frees its margin.
      const openQty = this.openingQty(ord, qty);
      if (openQty > 0) {
        const closeQty = qty - openQty;
        const released = pos && closeQty > 0 ? (pos.margin * closeQty) / Math.abs(pos.qty) : 0;
        const closeFee = tradeFee(closeQty, price, maker ? this.o.fees.makerRate : this.o.fees.takerRate);
        const need = marginRequired(openQty, price, ord.leverage) + tradeFee(openQty, price, this.o.fees.takerRate);
        if (need > this.account().freeMargin + released - closeFee) {
          this.rejected.push({ orderId: ord.id, symbol: ord.symbol, time, reason: 'no_free_balance' });
          return null;
        }
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
