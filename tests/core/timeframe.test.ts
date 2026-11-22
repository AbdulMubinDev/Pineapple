import { describe, expect, it } from 'vitest';
import { barOpenFor, tfToMs } from '../../src/core/timeframe.js';

describe('timeframe', () => {
  it('tfToMs converts', () => {
    expect(tfToMs('15m')).toBe(900_000);
    expect(tfToMs('4h')).toBe(14_400_000);
    expect(tfToMs('1d')).toBe(86_400_000);
  });

  it('barOpenFor floors to the bar open (UTC)', () => {
    expect(barOpenFor(Date.UTC(2024, 0, 1, 5, 30), '4h')).toBe(Date.UTC(2024, 0, 1, 4));
    expect(barOpenFor(Date.UTC(2024, 0, 1, 4), '4h')).toBe(Date.UTC(2024, 0, 1, 4));
    expect(barOpenFor(Date.UTC(2024, 0, 1, 23, 59), '1d')).toBe(Date.UTC(2024, 0, 1));
  });
});
