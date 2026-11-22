import type { FeeConfig } from '../core/types.js';

export const DEFAULT_FEES: FeeConfig = { makerRate: 0.0002, takerRate: 0.0005, slippagePct: 0.0002 };

/** Relative tolerance so 500100.00000000006 ticks counts as 500100. */
const EPS = 1e-9;

function decimalsOf(x: number): number {
  const s = String(x);
  const e = s.indexOf('e-');
  if (e >= 0) {
    const mantissa = s.slice(0, e);
    const dot = mantissa.indexOf('.');
    return Number(s.slice(e + 2)) + (dot >= 0 ? mantissa.length - dot - 1 : 0);
  }
  const dot = s.indexOf('.');
  return dot >= 0 ? s.length - dot - 1 : 0;
}

function snap(n: number, unit: number): number {
  return Number((n * unit).toFixed(decimalsOf(unit)));
}

/** Round a price to the tick grid. Buys round up, sells round down. */
export function roundToTick(price: number, tickSize: number, dir: 'up' | 'down'): number {
  const q = price / tickSize;
  return snap(dir === 'up' ? Math.ceil(q - EPS) : Math.floor(q + EPS), tickSize);
}

/** Floor a quantity to the lot step. */
export function floorToStep(qty: number, stepSize: number): number {
  return snap(Math.floor(qty / stepSize + EPS), stepSize);
}

/** Market fill price: slippage always goes against the trader. */
export function fillPrice(price: number, side: 'buy' | 'sell', slippagePct: number): number {
  return side === 'buy' ? price * (1 + slippagePct) : price * (1 - slippagePct);
}

export function tradeFee(qty: number, price: number, rate: number): number {
  return Math.abs(qty) * price * rate;
}

export function marginRequired(qty: number, price: number, leverage: number): number {
  return (Math.abs(qty) * price) / leverage;
}
