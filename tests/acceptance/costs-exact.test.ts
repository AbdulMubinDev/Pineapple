// Acceptance test 3: costs exact to the cent, against the hand calculation in tests/fixtures/hand-calc.md.
// One deterministic long (0.1 BTC) on one real recorded week of BTCUSDT 4h (2026-11-10 -> 2026-11-17),
// binance mode, Binance's default costs. Every expected figure below is copied from hand-calc.md, where it
// is derived from the fixture's candle opens and funding rows alone. None of it was read off a replay.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PairRules } from '../../src/core/types.js';
import { loadCandles, loadFunding } from '../../src/data/csv.js';
import { replay, type ReplayOptions } from '../../src/engine/replay.js';

const H4 = 14_400_000;
const rules = JSON.parse(readFileSync('tests/fixtures/BTCUSDT-rules.json', 'utf8')) as PairRules;
const candles = loadCandles('tests/fixtures/BTCUSDT_4h_week.csv', '4h');
const funding = loadFunding('tests/fixtures/BTCUSDT_funding_week.csv');

// Enter on the signal bar 2026-11-14 00:00 (fills at the 04:00 open), close on the signal bar
// 2026-11-16 08:00 (fills at the 12:00 open). Neither fill is on a funding hour.
const SOURCE = `//@version=6
strategy("Cost check long", overlay = true)
if time == timestamp("UTC", 2026, 11, 14, 0, 0)
    strategy.entry("L", strategy.long, qty = 0.1)
if time == timestamp("UTC", 2026, 11, 16, 8, 0)
    strategy.close("L")
`;

const FROM = Date.UTC(2026, 10, 10);
const TO = Date.UTC(2026, 10, 18) - 1;
const ENTRY_FILL = Date.UTC(2026, 10, 14, 4);
const EXIT_FILL = Date.UTC(2026, 10, 16, 12);

// hand-calc.md, section by section.
const HAND = {
  entryPrice: 66741.2,
  exitPrice: 64401.1,
  entryFee: 3.33706,
  exitFee: 3.220055,
  fees: 6.557115,
  pnl: -234.01,
  /** In event order: Nov 14 08:00, 14 16:00, 15 00:00, 15 08:00, 15 16:00, 16 00:00, 16 08:00. */
  funding: [-0.29951683, -0.25444422, -0.29927144, -0.14736577, 0.01598582, 0.08262429, -0.0465763],
  fundingTotal: -0.94856444,
  net: -241.51567944,
  finalBalance: 9758.48432056,
};

const opts = (to: number): ReplayOptions => ({
  source: SOURCE,
  symbol: 'BTCUSDT',
  tf: '4h',
  candles,
  funding,
  from: FROM,
  to,
  mode: 'binance',
  rules,
  startingBalance: 10_000,
  sizing: { kind: 'script' },
});

describe('acceptance 3: costs exact to the cent (binance mode, one real week)', () => {
  it('the fixtures are the recorded week, and the hold covers at least 3 funding events', () => {
    expect(candles).toHaveLength(48);
    expect(candles[0]!.openTime).toBe(FROM);
    expect(candles.at(-1)!.openTime).toBe(Date.UTC(2026, 10, 17, 20));
    const held = funding.filter((f) => f.time > ENTRY_FILL && f.time < EXIT_FILL);
    expect(held.length).toBe(HAND.funding.length);
    expect(held.length).toBeGreaterThanOrEqual(3);
    // Both signs of funding are in the hold, and every event has a real mark price.
    expect(held.some((f) => f.rate > 0) && held.some((f) => f.rate < 0)).toBe(true);
    expect(held.every((f) => f.markPrice > 0)).toBe(true);
  });

  it('the whole trade matches the hand calculation', { timeout: 60_000 }, async () => {
    const r = await replay(opts(TO));
    expect(r.rejections).toEqual([]);
    expect(r.anomalies).toEqual([]);
    expect(r.openPosition).toBeNull();
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.side).toBe('long');
    expect(t.qty).toBe(0.1);
    expect(t.entryTime).toBe(ENTRY_FILL);
    expect(t.exitTime).toBe(EXIT_FILL);
    // Fill prices: slippage 0.02 % against the trader, then tick rounding (buy up, sell down).
    expect(t.entryPrice).toBeCloseTo(HAND.entryPrice, 8);
    expect(t.exitPrice).toBeCloseTo(HAND.exitPrice, 8);
    expect(t.pnl).toBeCloseTo(HAND.pnl, 2);
    expect(t.fees).toBeCloseTo(HAND.fees, 2);
    expect(t.funding).toBeCloseTo(HAND.fundingTotal, 2);
    expect(t.pnl - t.fees + t.funding).toBeCloseTo(HAND.net, 2);
    expect(r.summary.netProfit).toBeCloseTo(HAND.net, 2);
    expect(r.account.feesPaid).toBeCloseTo(HAND.fees, 2);
    expect(r.account.fundingNet).toBeCloseTo(HAND.fundingTotal, 2);
    expect(r.account.balance).toBeCloseTo(HAND.finalBalance, 2);
    expect(r.account.equity).toBeCloseTo(HAND.finalBalance, 2);
  });

  it('the entry fee alone, and each funding payment, match the hand calculation', { timeout: 120_000 }, async () => {
    // Stop the replay at the end of the entry bar: only the entry fill has happened.
    const atEntry = await replay(opts(ENTRY_FILL));
    expect(atEntry.openPosition?.entryPrice).toBeCloseTo(HAND.entryPrice, 8);
    expect(atEntry.account.feesPaid).toBeCloseTo(HAND.entryFee, 2);
    expect(atEntry.account.fundingNet).toBe(0);

    // Then end it at each funding event's bar in turn: the running funding total steps by one payment.
    const held = funding.filter((f) => f.time > ENTRY_FILL && f.time < EXIT_FILL);
    let before = 0;
    for (let k = 0; k < held.length; k++) {
      const bar = Math.floor(held[k]!.time / H4) * H4;
      const r = await replay(opts(bar));
      const payment = r.account.fundingNet - before;
      expect(payment, `funding event ${k} at ${new Date(held[k]!.time).toISOString()}`).toBeCloseTo(HAND.funding[k]!, 2);
      before = r.account.fundingNet;
    }

    // The exit fee is what the whole trade paid on top of the entry fee.
    const all = await replay(opts(TO));
    expect(all.account.feesPaid - atEntry.account.feesPaid).toBeCloseTo(HAND.exitFee, 2);
  });
});
