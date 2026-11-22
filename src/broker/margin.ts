import type { MaintBracket } from '../core/types.js';

/** Used when a pair has no bracket data at all: the lowest Binance tier rate, no amount. */
const FALLBACK_MMR = 0.004;

/**
 * Leverage a strategy's `margin_long/short` percentage implies: 100 / pct, capped by the pair's max,
 * never below 1. No percentage (or a non-positive one) means unleveraged.
 */
export function leverageInForce(scriptMarginPct: number | undefined, maxLeverage: number): number {
  const pct = scriptMarginPct !== undefined && scriptMarginPct > 0 ? scriptMarginPct : 100;
  return Math.max(1, Math.min(100 / pct, maxLeverage));
}

/** The maintenance bracket for a notional: the first tier whose cap covers it, else the last tier. */
export function maintenance(notional: number, brackets: MaintBracket[]): { rate: number; amount: number } {
  if (brackets.length === 0) return { rate: FALLBACK_MMR, amount: 0 };
  const sorted = [...brackets].sort((a, b) => a.notionalCap - b.notionalCap);
  const tier = sorted.find((b) => notional <= b.notionalCap) ?? (sorted[sorted.length - 1] as MaintBracket);
  return { rate: tier.maintMarginRate, amount: tier.maintAmount };
}

/**
 * Binance isolated-margin liquidation price for a single position.
 * `qty` is absolute and `isolatedMargin` is the wallet balance allocated to the position.
 */
export function liquidationPrice(p: {
  side: 1 | -1;
  qty: number;
  entryPrice: number;
  isolatedMargin: number;
  mmr: number;
  maintAmount: number;
}): number {
  return (p.isolatedMargin - p.side * p.qty * p.entryPrice + p.maintAmount) / (p.qty * p.mmr - p.side * p.qty);
}
