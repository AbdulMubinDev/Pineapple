// Strategy-tester style summary of a replay, and the trade list as CSV.
// Money stays plain numbers here; rounding happens only in the CSV (8 dp quantities, 2 dp USD).
import type { ClosedTrade } from '../core/types.js';

export interface Summary {
  tradeCount: number;
  /** Percent of trades with a positive net P&L. */
  winRatePct: number;
  /** Gross profit / |gross loss| over net trade P&L; Infinity with no losing trade, 0 with no trades. */
  profitFactor: number;
  /** Mean net P&L of winning trades (0 if none). */
  avgWin: number;
  /** Mean net P&L of losing trades, negative (0 if none). */
  avgLoss: number;
  /** The largest winning trade's net P&L (0 if none). */
  biggestWin: number;
  /** The largest losing trade's net P&L, negative (0 if none). */
  biggestLoss: number;
  /** Largest peak-to-trough fall of the equity curve, in percent of the peak (the starting balance counts as a peak). */
  maxDrawdownPct: number;
  /** Sum of the closed trades' net P&L (open P&L at the end is not included, as on TradingView). */
  netProfit: number;
  netProfitPct: number;
}

/** A closed trade's P&L after fees and funding: what TradingView calls the trade's profit. */
export function tradeNet(t: ClosedTrade): number {
  return t.pnl - t.fees + t.funding;
}

export function summarize(trades: ClosedTrade[], startingBalance: number, equityCurve: { time: number; equity: number }[]): Summary {
  const nets = trades.map(tradeNet);
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x < 0);
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const grossProfit = sum(wins);
  const grossLoss = sum(losses);
  const netProfit = sum(nets);

  let peak = startingBalance;
  let maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    else if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }

  return {
    tradeCount: trades.length,
    winRatePct: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    profitFactor: trades.length === 0 ? 0 : grossLoss === 0 ? Infinity : grossProfit / Math.abs(grossLoss),
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    biggestWin: wins.length > 0 ? Math.max(...wins) : 0,
    biggestLoss: losses.length > 0 ? Math.min(...losses) : 0,
    maxDrawdownPct: maxDd * 100,
    netProfit,
    netProfitPct: startingBalance > 0 ? (netProfit / startingBalance) * 100 : 0,
  };
}

const usd = (n: number) => n.toFixed(2);
const qty = (n: number) => n.toFixed(8);
const iso = (t: number) => new Date(t).toISOString();
// Prices to 8 dp without trailing zeros (an averaged entry price can carry float noise).
const price = (n: number) => String(Number(n.toFixed(8)));

export const TRADES_CSV_HEADER = 'symbol,side,entryTime,entryPrice,exitTime,exitPrice,qty,pnl,fees,funding,net,exitReason';

/** One row per closed trade. Prices to 8 dp. */
export function tradesCsv(trades: ClosedTrade[]): string {
  const rows = trades.map((t) =>
    [t.symbol, t.side, iso(t.entryTime), price(t.entryPrice), iso(t.exitTime), price(t.exitPrice), qty(t.qty), usd(t.pnl), usd(t.fees), usd(t.funding), usd(tradeNet(t)), t.exitReason].join(','),
  );
  return [TRADES_CSV_HEADER, ...rows].join('\n') + '\n';
}
