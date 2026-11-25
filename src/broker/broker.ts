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
import { plainCopy } from '../core/plain-json.js';
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
  /** In force now: the options' until setFees / setSizing (owner edits after approval) replace them. */
  private fees: FeeConfig;
  private sizing: SizingRule;
  private balance: number;
  private feesPaid = 0;
  private fundingNet = 0;
  private nextSeq = 0;
  private positions: Record<string, Position> = {};
  private meta: Record<string, PositionMeta> = {};
  private lastPrice: Record<string, number> = {};
  private orders: StoredOrder[] = [];
  private closed: ClosedTrade[] = [];
  /** Per symbol: the running sum of its closed trades' pnl - fees + funding (in closing order). */
  private realised: Record<string, number> = {};
  private rejected: Rejection[] = [];

  constructor(o: BrokerOptions) {
    this.o = o;
    this.fees = { ...o.fees };
    this.sizing = { ...o.sizing };
    this.balance = o.startingBalance;
  }

  /**
   * Replaces the fees and slippage from the next submit or fill on. Fills already made keep theirs, and
   * a pending opening order keeps the margin reservation it was accepted with.
   */
  setFees(f: FeeConfig): void {
    this.fees = { ...f };
  }

  /** Replaces the sizing rule from the next submit on (orders already queued keep their qty). */
  setSizing(s: SizingRule): void {
    this.sizing = { ...s };
  }

  feeConfig(): FeeConfig {
    return { ...this.fees };
  }

  sizingRule(): SizingRule {
    return { ...this.sizing };
  }

  /** The realised net (pnl - fees + funding) of `symbol`'s closed trades, kept as they close: O(1). */
  realisedNet(symbol: string): number {
    return this.realised[symbol] ?? 0;
  }

  /**
   * Closes `symbol`'s whole position at `price` (no slippage, the taker fee) and cancels all of its
   * orders: the pair is leaving the exchange. Returns the closing fill (none when flat); the caller
   * passes it to the strategy layer's onFills like any other fill.
   */
  forceClose(symbol: string, price: number, time: number, reason: 'delisting'): Fill[] {
    this.orders = this.orders.filter((x) => x.symbol !== symbol);
    this.lastPrice[symbol] = price;
    const pos = this.positions[symbol];
    if (!pos) return [];
    const qty = Math.abs(pos.qty);
    const side = pos.qty > 0 ? 'sell' : 'buy';
    const ord: StoredOrder = {
      id: `${reason}:${symbol}:${time}`,
      symbol,
      side,
      type: 'market',
      qty,
      reduceOnly: true,
      tag: 'exit',
      leverage: pos.leverage,
      seq: -1,
      submittedAt: time,
    };
    const fee = tradeFee(qty, price, this.fees.takerRate);
    this.applyFill(ord, qty, price, fee, time, reason);
    return [{ orderId: ord.id, symbol, time, price, qty, side, fee, liquidity: 'taker' }];
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
    if (this.sizing.kind === 'fixed' && i.tag === 'entry' && !i.reduceOnly) {
      // Fixed sizing sizes only the opening part; an opposing order also has to close the old position.
      const opposes = pos !== undefined && (pos.qty > 0) !== (i.side === 'buy');
      qty = this.sizing.notionalUsd / ref + (opposes ? Math.abs(pos.qty) : 0);
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
        const closeFee = tradeFee(closeQty, ref, this.fees.takerRate);
        // Pending opening orders already spoken for part of the free margin.
        if (need > this.account().freeMargin - this.reservedMargin(i.id) + released - closeFee) {
          return { accepted: false, reason: 'no_free_balance' };
        }
      }
    }

    this.orders = this.orders.filter((x) => x.id !== i.id);
    this.orders.push({ ...i, qty, seq: this.nextSeq++, submittedAt: now, reserveRate: this.fees.takerRate });
    return { accepted: true };
  }

  cancel(orderId: string): void {
    this.orders = this.orders.filter((x) => x.id !== orderId);
  }

  /**
   * A new bar opened: pending market orders fill at bar.open plus slippage. An order submitted after the bar
   * opened (live, mid-bar) is not filled at that open: it fills at a later tick or the next bar's open.
   */
  onBarOpen(symbol: string, bar: Candle): Fill[] {
    this.lastPrice[symbol] = bar.open;
    // Funding is not applied here: the replay calls applyFunding explicitly for events in the bar.
    return this.fillMarketOrders(symbol, bar.open, bar.openTime, (o) => o.submittedAt <= bar.openTime);
  }

  /**
   * Trigger resting stop/limit orders along the bar path (TradingView's intrabar assumption).
   * With `liquidation` (binance mode only), the isolated position's liquidation price is checked on the
   * same path, in order with the orders: whichever the path reaches first acts first, and a tie goes to
   * the order. On a gap past both, the order acts first only if its level lies between the previous price and LP. The bar's prices stand in for the mark price, which the candles do not carry.
   * Ruling H2: only what was active when the bar opened is walked. An order submitted after bar.openTime, or a
   * position opened or added to after it (live fills between closes), already saw the live ticks from then on;
   * the bar's earlier extremes must not act on it. Replay submits and fills at bar boundaries only, so it is unaffected.
   */
  onBarRange(symbol: string, bar: Candle, opts: { liquidation?: boolean } = {}): Fill[] {
    const lowFirst = Math.abs(bar.high - bar.open) >= Math.abs(bar.open - bar.low);
    const path = lowFirst
      ? [bar.open, bar.low, bar.high, bar.close]
      : [bar.open, bar.high, bar.low, bar.close];
    const fills = this.walkPath(symbol, path, bar.openTime, opts.liquidation === true && this.o.mode === 'binance', bar.openTime);
    this.lastPrice[symbol] = bar.close;
    return fills;
  }

  /**
   * Fill pending market orders at `price` plus slippage (process_orders_on_close: the bar's close). With
   * `submittedAfter`, only orders submitted after that time (a live tick fills the market intents a live fill made).
   */
  fillMarketAt(symbol: string, price: number, time: number, opts: { submittedAfter?: number } = {}): Fill[] {
    this.lastPrice[symbol] = price;
    const after = opts.submittedAfter;
    return this.fillMarketOrders(symbol, price, time, after === undefined ? undefined : (o) => o.submittedAt > after);
  }

  /**
   * Live tick: market orders fill at price (unless `markets: false`: they wait for the next bar's open), resting
   * orders trigger on the move from the last price.
   */
  onPrice(symbol: string, price: number, time: number, opts: { markets?: boolean } = {}): Fill[] {
    const prev = this.lastPrice[symbol];
    this.lastPrice[symbol] = price;
    const fills = opts.markets === false ? [] : this.fillMarketOrders(symbol, price, time);
    if (prev !== undefined) fills.push(...this.walkPath(symbol, [prev, price], time));
    return fills;
  }

  markToMarket(symbol: string, price: number): void {
    this.lastPrice[symbol] = price;
  }

  /** Mark price update (binance mode only): liquidates an isolated position once the mark crosses its liquidation price. */
  onMark(symbol: string, mark: number, time: number): Fill[] {
    if (this.o.mode !== 'binance') return [];
    const lp = this.liquidationLevel(symbol);
    if (lp === null) return [];
    const long = (this.positions[symbol] as Position).qty > 0;
    if (long ? mark > lp : mark < lp) return [];
    const fill = this.liquidate(symbol, lp, time);
    this.lastPrice[symbol] = mark;
    return [fill];
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

  /**
   * A funding payment for `symbol` booked after the position (or part of it) that held it was closed live, before
   * the event had settled (binance mode only): balance, funding total and the symbol's realised net move by `amount`.
   * The closed trade itself is not restated.
   */
  adjustFunding(symbol: string, amount: number): void {
    if (this.o.mode !== 'binance' || !Number.isFinite(amount) || amount === 0) return;
    this.balance += amount;
    this.fundingNet += amount;
    this.realised[symbol] = (this.realised[symbol] ?? 0) + amount;
  }

  /** The last price the broker marked `symbol` at (open, path, close or tick), if any. */
  lastPriceOf(symbol: string): number | undefined {
    return this.lastPrice[symbol];
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
        delete intent.reserveRate;
        return intent as OrderIntent;
      });
  }

  snapshot(): BrokerState {
    return plainCopy<BrokerState>({
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
      realisedNet: this.realised,
      fees: this.fees,
      sizing: this.sizing,
    }, 'PaperBroker snapshot');
  }

  /**
   * The broker `s` was snapshotted from. Fees and sizing come from the state (they may have been edited
   * since the run started), else from `o`; older states without running totals rebuild them.
   */
  static restore(s: BrokerState, o: BrokerOptions): PaperBroker {
    const b = new PaperBroker(o);
    const c = clone(s);
    if (c.fees) b.fees = c.fees;
    if (c.sizing) b.sizing = c.sizing;
    if (c.realisedNet) b.realised = c.realisedNet;
    else for (const t of c.closed) b.addRealised(t);
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

  /** When the open position was opened or last added to (its liquidation price was set then); -Infinity when flat. */
  private positionChangedAt(symbol: string): number {
    const pos = this.positions[symbol];
    if (!pos) return -Infinity;
    return Math.max(pos.openTime, this.meta[symbol]?.changedAt ?? -Infinity);
  }

  /** The open position's isolated liquidation price, or null when flat. */
  private liquidationLevel(symbol: string): number | null {
    const pos = this.positions[symbol];
    if (!pos || !this.meta[symbol]) return null;
    const qty = Math.abs(pos.qty);
    const { rate, amount } = maintenance(qty * pos.entryPrice, this.o.rules(symbol).brackets);
    return liquidationPrice({
      side: pos.qty > 0 ? 1 : -1,
      qty,
      entryPrice: pos.entryPrice,
      isolatedMargin: pos.margin,
      mmr: rate,
      maintAmount: amount,
    });
  }

  /**
   * Liquidates the isolated position at its liquidation price `lp`. The trade closes at LP and the whole
   * isolated margin is lost: the loss up to LP plus the maintenance remainder, which is forfeited as a
   * clearance fee. Entry fees and funding were already charged to the balance, so the balance drops by
   * exactly the isolated margin.
   */
  private liquidate(symbol: string, lp: number, time: number): Fill {
    const pos = this.positions[symbol] as Position;
    const m = this.meta[symbol] as PositionMeta;
    const long = pos.qty > 0;
    const qty = Math.abs(pos.qty);
    const orderId = `liquidation:${symbol}:${time}`;
    this.balance -= pos.margin;
    this.pushClosed({
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
      exitOrderId: orderId,
    });
    delete this.positions[symbol];
    delete this.meta[symbol];
    this.purgeOrphanExits(symbol);
    return { orderId, symbol, time, price: lp, qty, side: long ? 'sell' : 'buy', fee: 0, liquidity: 'taker' };
  }

  /**
   * A gap past both an order's level and the liquidation price (both at distance 0): the order acts first
   * only if its level lies between the previous price and LP (a long's stop at or above LP, a short's at or
   * below), so the move reached it first.
   */
  private beforeLiquidation(o: StoredOrder, lp: number, symbol: string): boolean {
    const level = o.type === 'limit' || (o.type === 'stop_limit' && o.triggered) ? o.limitPrice : o.stopPrice;
    if (level === undefined) return true;
    return (this.positions[symbol] as Position).qty > 0 ? level >= lp : level <= lp;
  }

  /** Where the open position's liquidation price is reached while price moves cursor -> target, or null. */
  private liquidationTrigger(symbol: string, cursor: number, target: number): { lp: number; t: Trigger } | null {
    const lp = this.liquidationLevel(symbol);
    if (lp === null) return null;
    if ((this.positions[symbol] as Position).qty > 0) {
      if (cursor <= lp) return { lp, t: { price: cursor, dist: 0 } };
      if (target <= lp) return { lp, t: { price: lp, dist: cursor - lp } };
    } else {
      if (cursor >= lp) return { lp, t: { price: cursor, dist: 0 } };
      if (target >= lp) return { lp, t: { price: lp, dist: lp - cursor } };
    }
    return null;
  }

  private isReduce(o: { reduceOnly: boolean; tag: 'entry' | 'exit' }): boolean {
    return o.reduceOnly || o.tag === 'exit';
  }

  /** The part of an order that opens (or adds to) a position rather than closing one. */
  private openingQty(o: { symbol: string; side: 'buy' | 'sell' }, qty: number): number {
    const pos = this.positions[o.symbol];
    const opposes = pos !== undefined && (pos.qty > 0) !== (o.side === 'buy');
    return opposes ? Math.max(0, qty - Math.abs(pos.qty)) : qty;
  }

  private marginAndFee(qty: number, price: number, leverage: number, rate = this.fees.takerRate): number {
    return marginRequired(qty, price, leverage) + tradeFee(qty, price, rate);
  }

  /** Margin + entry fee that pending opening orders (other than `excludeId`) will need, each at the fee it was accepted with. */
  private reservedMargin(excludeId: string): number {
    let sum = 0;
    for (const x of this.orders) {
      if (x.id === excludeId || this.isReduce(x)) continue;
      const price = this.lastPrice[x.symbol];
      if (price === undefined) continue;
      sum += this.marginAndFee(this.openingQty(x, x.qty), price, x.leverage, x.reserveRate);
    }
    return sum;
  }

  private pushClosed(t: ClosedTrade): void {
    this.closed.push(t);
    this.addRealised(t);
  }

  private addRealised(t: ClosedTrade): void {
    this.realised[t.symbol] = (this.realised[t.symbol] ?? 0) + (t.pnl - t.fees + t.funding);
  }

  /** A reduce-only/exit order can only act while there is an opposing position to reduce. */
  private canAct(o: StoredOrder): boolean {
    if (!this.isReduce(o)) return true;
    const pos = this.positions[o.symbol];
    return pos !== undefined && (pos.qty > 0) !== (o.side === 'buy');
  }

  private fillMarketOrders(symbol: string, price: number, time: number, eligible?: (o: StoredOrder) => boolean): Fill[] {
    const fills: Fill[] = [];
    const pending = this.orders.filter((x) => x.symbol === symbol && x.type === 'market' && (!eligible || eligible(x)));
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

  /** `activeBy`: only orders submitted, and a position last opened or added to, at or before it act (onBarRange). */
  private walkPath(symbol: string, path: number[], time: number, liquidation = false, activeBy = Infinity): Fill[] {
    if (liquidation && this.positionChangedAt(symbol) > activeBy) liquidation = false;
    const fills: Fill[] = [];
    const filledGroups = new Set<string>();
    for (let i = 0; i + 1 < path.length; i++) {
      let cursor = path[i] as number;
      const target = path[i + 1] as number;
      for (;;) {
        let best: { ord: StoredOrder; t: Trigger } | null = null;
        for (const ord of this.orders) {
          if (ord.symbol !== symbol || ord.type === 'market' || ord.submittedAt > activeBy) continue;
          if (!this.canAct(ord)) continue; // exit with nothing to exit stays resting
          if (ord.ocaGroup !== undefined && filledGroups.has(ord.ocaGroup)) continue;
          const t = this.trigger(ord, cursor, target);
          if (t && (best === null || t.dist < best.t.dist)) best = { ord, t };
        }
        const liq = liquidation ? this.liquidationTrigger(symbol, cursor, target) : null;
        if (liq && (best === null || liq.t.dist < best.t.dist || (liq.t.dist === 0 && best.t.dist === 0 && !this.beforeLiquidation(best.ord, liq.lp, symbol)))) {
          fills.push(this.liquidate(symbol, liq.lp, time));
          cursor = liq.t.price;
          continue;
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
      const ticks = this.fees.slippageTicks;
      price =
        ticks !== undefined
          ? refPrice + (ord.side === 'buy' ? 1 : -1) * ticks * this.o.rules(ord.symbol).tickSize
          : fillPrice(refPrice, ord.side, this.fees.slippagePct);
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
        const closeFee = tradeFee(closeQty, price, maker ? this.fees.makerRate : this.fees.takerRate);
        const need = marginRequired(openQty, price, ord.leverage) + tradeFee(openQty, price, this.fees.takerRate);
        if (need > this.account().freeMargin + released - closeFee) {
          this.rejected.push({ orderId: ord.id, symbol: ord.symbol, time, reason: 'no_free_balance' });
          return null;
        }
      }
    }
    const fee = tradeFee(qty, price, maker ? this.fees.makerRate : this.fees.takerRate);
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
    this.pushClosed({
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
      exitOrderId: ord.id,
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
      if (time > pos.openTime) m.changedAt = time;
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
