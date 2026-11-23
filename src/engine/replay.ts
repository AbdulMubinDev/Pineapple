// Deterministic replay: one Pine strategy() over recorded candles, through the strategy layer and the
// paper broker. barHooks() is the per-bar wiring on its own, so the live scanner (Plan 2) drives a
// symbol with exactly the same event order.
//
// Per bar b at or after `from` (market orders fill at the next bar's open):
//   hooks.before(b):
//     1. broker.onBarOpen(b)                      -> layer.onFills -> submit its intents
//     2. funding events with b.openTime <= t < b.openTime + tf (markPrice 0: the broker uses the last price)
//     3. broker.onBarRange(b), in binance mode with the liquidation check on the same intrabar path as the
//        stops (O-H-L-C or O-L-H-C): whichever the path reaches first acts first. This takes the place of a
//        separate onMark at the bar's adverse extreme, which could not tell a stop and the liquidation
//        price apart within the bar.                -> layer.onFills -> submit its intents
//     4. broker.markToMarket(b.close)
//     5. return layer.scriptView()
//   hooks.after(b, calls):
//     6. submit layer.toIntents(calls, b), logging submit rejections
//     7. process_orders_on_close only: broker.fillMarketAt(b.close) -> layer.onFills -> submit
// Bars before `from` are warm-up: the script sees a flat account and its calls are discarded.
import { PaperBroker } from '../broker/broker.js';
import { DEFAULT_FEES } from '../broker/costs.js';
import { tfToMs } from '../core/timeframe.js';
import type {
  AccountView,
  BrokerMode,
  Candle,
  ClosedTrade,
  FeeConfig,
  Fill,
  FundingEvent,
  OrderIntent,
  PairRules,
  Position,
  SizingRule,
  SubmitResult,
  Timeframe,
} from '../core/types.js';
import { DataGapError } from '../data/csv.js';
import { summarize, type Summary } from '../report/summary.js';
import { compileScript, runStrategy, type BarHooks, type PineOrderCall, type StrategyDeclaration } from './pine-runner.js';
import { StrategyLayer, type LayerAnomaly, type ScriptView } from './strategy-layer.js';

/** TradingView's Strategy Properties: commission in percent, slippage in ticks. */
export interface TvProperties {
  initialCapital: number;
  commissionPct: number;
  slippageTicks: number;
}

/** An order the broker turned down: at submit, or at fill time (no longer fits the free margin). */
export interface ReplayRejection {
  stage: 'submit' | 'fill';
  orderId: string;
  time: number;
  reason: Extract<SubmitResult, { accepted: false }>['reason'];
}

export interface ReplayOptions {
  source: string;
  symbol: string;
  tf: Timeframe;
  candles: Candle[];
  funding: FundingEvent[];
  from: number;
  to: number;
  mode: BrokerMode;
  /** tradingview mode: the Properties to match (default: the declaration's own, else TradingView's defaults). */
  tv?: TvProperties;
  rules: PairRules;
  /** binance mode fees (default DEFAULT_FEES). tradingview mode takes its fees from `tv`. */
  fees?: FeeConfig;
  /** binance mode starting balance. tradingview mode starts with `tv.initialCapital`. */
  startingBalance: number;
  sizing: SizingRule;
}

export interface ReplayResult {
  /** Closed script trades, overfill round trips excluded. */
  trades: ClosedTrade[];
  /** Account equity at each replayed bar's end (after its fills), keyed by the bar's openTime. */
  equityCurve: { time: number; equity: number }[];
  summary: Summary;
  /** Round trips of pyramiding overfill lots (see StrategyLayer): TradingView would not have them. */
  overfills: ClosedTrade[];
  anomalies: LayerAnomaly[];
  rejections: ReplayRejection[];
  /** Still open at `to` (not in trades or the summary, as on TradingView). */
  openPosition: Position | null;
  account: AccountView;
  startingBalance: number;
  /** The declaration as replayed (Properties applied). */
  declaration: StrategyDeclaration;
}

/** TradingView's Properties for a script: what its declaration states, TradingView's defaults otherwise. */
export function tvPropertiesOf(decl: StrategyDeclaration): TvProperties {
  return {
    initialCapital: decl.overridden.initialCapital ?? 1_000_000,
    commissionPct: decl.overridden.commission ?? 0,
    slippageTicks: decl.overridden.slippage ?? 0,
  };
}

export class ScriptCompileError extends Error {
  constructor(public readonly errors: { line: number; message: string }[]) {
    super(`Script does not compile: ${errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
    this.name = 'ScriptCompileError';
  }
}

export interface BarHooksOptions {
  broker: PaperBroker;
  layer: StrategyLayer;
  symbol: string;
  tf: Timeframe;
  mode: BrokerMode;
  /** Bars opening before this are warm-up. */
  from: number;
  /** Sorted by time. */
  funding: FundingEvent[];
  processOrdersOnClose: boolean;
  /** The equity a warm-up bar's flat view reports. */
  warmupEquity: number;
  onRejected?: (r: ReplayRejection) => void;
  /** After a replayed bar's last fill. */
  onBarDone?: (bar: Candle) => void;
}

/** The per-bar wiring of broker, funding and strategy layer, in the order documented above. */
export function barHooks(o: BarHooksOptions): BarHooks {
  const { broker, layer, symbol } = o;
  const tfMs = tfToMs(o.tf);
  let fi = 0;
  const submit = (intents: OrderIntent[], now: number) => {
    for (const i of intents) {
      const r = broker.submit(i, now);
      if (!r.accepted) o.onRejected?.({ stage: 'submit', orderId: i.id, time: now, reason: r.reason });
    }
  };
  const settle = (fills: Fill[], bar: Candle, idx: number) => submit(layer.onFills(fills, bar, idx), bar.openTime);

  return {
    before(bar: Candle, idx: number): ScriptView {
      if (bar.openTime < o.from) return StrategyLayer.flatView(o.warmupEquity);
      settle(broker.onBarOpen(symbol, bar), bar, idx);
      while (fi < o.funding.length && o.funding[fi]!.time < bar.openTime) fi++;
      while (fi < o.funding.length && o.funding[fi]!.time < bar.openTime + tfMs) broker.applyFunding(symbol, o.funding[fi++]!);
      settle(broker.onBarRange(symbol, bar, { liquidation: o.mode === 'binance' }), bar, idx);
      broker.markToMarket(symbol, bar.close);
      return layer.scriptView();
    },
    after(bar: Candle, idx: number, calls: PineOrderCall[]): void {
      if (bar.openTime < o.from) return;
      submit(layer.toIntents(calls, bar), bar.openTime);
      if (o.processOrdersOnClose) settle(broker.fillMarketAt(symbol, bar.close, bar.openTime), bar, idx);
      o.onBarDone?.(bar);
    },
  };
}

function assertContiguous(candles: Candle[], tf: Timeframe): void {
  const step = tfToMs(tf);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    if (candles[i]!.openTime !== prev.openTime + step) throw new DataGapError(prev.openTime + step);
  }
}

export async function replay(o: ReplayOptions): Promise<ReplayResult> {
  assertContiguous(o.candles, o.tf);
  const candles = o.candles.filter((c) => c.openTime <= o.to);
  if (!candles.some((c) => c.openTime >= o.from)) throw new Error('replay: no candles between from and to');

  const compiled = await compileScript(o.source);
  if (!compiled.ok) throw new ScriptCompileError(compiled.errors);

  let declaration: StrategyDeclaration;
  let fees: FeeConfig;
  let startingBalance: number;
  if (o.mode === 'tradingview') {
    const tv = o.tv ?? tvPropertiesOf(compiled.declaration);
    // The Properties replace the declaration's own (the layer sizes percent-of-equity orders with them).
    declaration = { ...compiled.declaration, overridden: { initialCapital: tv.initialCapital, commission: tv.commissionPct, slippage: tv.slippageTicks } };
    fees = { makerRate: tv.commissionPct / 100, takerRate: tv.commissionPct / 100, slippagePct: 0, slippageTicks: tv.slippageTicks };
    startingBalance = tv.initialCapital;
  } else {
    fees = o.fees ?? DEFAULT_FEES;
    // Binance costs: taker commission, and no tick slippage (the broker applies slippagePct).
    declaration = { ...compiled.declaration, overridden: { ...compiled.declaration.overridden, commission: fees.takerRate * 100, slippage: 0 } };
    startingBalance = o.startingBalance;
  }

  const broker = new PaperBroker({ startingBalance, fees, mode: o.mode, rules: () => o.rules, sizing: o.sizing });
  const layer = new StrategyLayer(declaration, broker, o.symbol, o.sizing, { rules: o.rules, from: o.from });
  const equityCurve: { time: number; equity: number }[] = [];
  const submitRejections: ReplayRejection[] = [];
  const hooks = barHooks({
    broker,
    layer,
    symbol: o.symbol,
    tf: o.tf,
    mode: o.mode,
    from: o.from,
    funding: [...o.funding].sort((a, b) => a.time - b.time),
    processOrdersOnClose: declaration.processOrdersOnClose === true,
    warmupEquity: startingBalance,
    onRejected: (r) => submitRejections.push(r),
    onBarDone: (bar) => equityCurve.push({ time: bar.openTime, equity: broker.account().equity }),
  });

  await runStrategy({
    source: o.source,
    symbol: o.symbol,
    tf: o.tf,
    candles,
    syminfo: { mintick: o.rules.tickSize, qtyStep: o.rules.stepSize },
    hooks,
  });

  const closed = broker.closedTrades().filter((t) => t.symbol === o.symbol);
  const isOverfill = (t: ClosedTrade) => t.exitOrderId !== undefined && StrategyLayer.isOverfillClose(o.symbol, t.exitOrderId);
  const trades = closed.filter((t) => !isOverfill(t));
  const rejections = [
    ...submitRejections,
    ...broker.rejections().map((r): ReplayRejection => ({ stage: 'fill', orderId: r.orderId, time: r.time, reason: r.reason })),
  ].sort((a, b) => a.time - b.time);

  return {
    trades,
    equityCurve,
    summary: summarize(trades, startingBalance, equityCurve),
    overfills: closed.filter(isOverfill),
    anomalies: layer.anomalies(),
    rejections,
    openPosition: broker.position(o.symbol),
    account: broker.account(),
    startingBalance,
    declaration,
  };
}
