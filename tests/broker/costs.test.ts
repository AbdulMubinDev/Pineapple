import { describe, expect, it } from 'vitest';
import { DEFAULT_FEES, fillPrice, floorToStep, roundToTick, tradeFee } from '../../src/broker/costs.js';

describe('costs', () => {
  it('has the default fee config', () => {
    expect(DEFAULT_FEES).toEqual({ makerRate: 0.0002, takerRate: 0.0005, slippagePct: 0.0002 });
  });

  it('roundToTick rounds up or down without float noise', () => {
    expect(roundToTick(50010.000000000004, 0.1, 'up')).toBe(50010);
    expect(roundToTick(50010.04, 0.1, 'up')).toBe(50010.1);
    expect(roundToTick(50010.09, 0.1, 'down')).toBe(50010);
    expect(roundToTick(47990.4, 0.1, 'down')).toBe(47990.4);
  });

  it('floorToStep floors quantity to the lot step', () => {
    expect(floorToStep(0.0004, 0.001)).toBe(0);
    expect(floorToStep(0.1239, 0.001)).toBe(0.123);
    expect(floorToStep(0.3, 0.001)).toBe(0.3);
  });

  it('fillPrice applies slippage against the trader', () => {
    expect(fillPrice(50000, 'buy', 0.0002)).toBeCloseTo(50010, 8);
    expect(fillPrice(48000, 'sell', 0.0002)).toBeCloseTo(47990.4, 8);
  });

  it('tradeFee is |qty| x price x rate', () => {
    expect(tradeFee(-0.1, 50010, 0.0005)).toBeCloseTo(2.5005, 10);
  });
});
