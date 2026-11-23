# Hand calculation for acceptance test 3 (costs exact to the cent)

These figures come only from the two week fixtures and Binance's published costs. None of them were read
off a replay. Every line can be checked with a calculator. `tests/acceptance/costs-exact.test.ts` asserts
the replay against them with `toBeCloseTo(x, 2)`, except the fill prices, which must be exact.

## Inputs

- Data: `BTCUSDT_4h_week.csv` (48 candles, 2026-11-10 00:00 to 2026-11-17 20:00 UTC) and
  `BTCUSDT_funding_week.csv` (24 events). Both were recorded from Binance's public USDT-M REST endpoints
  with `src/cli/record.ts --symbol BTCUSDT --tf 4h --from 2026-11-10 --to 2026-11-17`.
- Mode: binance. Starting balance 10000 USDT.
- Costs: taker fee 0.0005 (0.05 %), maker 0.0002 (not used: both orders are market orders), and
  slippage 0.0002 (0.02 %) against the trader on market fills.
- BTCUSDT rules: tick 0.1 (buy prices round up, sell prices round down), step 0.001.
- Strategy: one long, `qty = 0.1` (a multiple of the 0.001 step; notional about 6674 USDT, above the
  100 minimum).
  - The entry signal is on the 2026-11-14 00:00 bar. A market order fills at the next bar's open, so it
    fills at the **2026-11-14 04:00** open.
  - The close signal is on the 2026-11-16 08:00 bar, so it fills at the **2026-11-16 12:00** open.
  - Neither fill falls on a funding hour (00:00, 08:00 or 16:00), so it's clear which events the
    position is open for.

## 1. Fill prices

Entry (a buy):

- 2026-11-14 04:00 open = 66727.8
- With slippage: 66727.8 × 1.0002 = 66741.14556
- Rounded up to the 0.1 tick: **66741.2**

Exit (a sell):

- 2026-11-16 12:00 open = 64414.0
- With slippage: 64414.0 × 0.9998 = 64401.1172
- Rounded down to the 0.1 tick: **64401.1**

## 2. Fees (taker, 0.0005 of notional)

| Fee | Calculation | Amount |
|---|---|---|
| Entry fee | 0.1 × 66741.2 × 0.0005 | **3.33706** |
| Exit fee | 0.1 × 64401.1 × 0.0005 | **3.220055** |
| Total fees | 3.33706 + 3.220055 | **6.557115** (6.56) |

## 3. Gross P&L

(64401.1 − 66741.2) × 0.1 = −2340.1 × 0.1 = **−234.01**

## 4. Funding

The position is open from 2026-11-14 04:00 to 2026-11-16 12:00, which covers 7 funding events. Each
payment is −qty × mark × rate: a long pays when the rate is positive and receives when it is negative.

| # | Event time (UTC) | rate | markPrice | −0.1 × mark × rate |
|---|---|---|---|---|
| 1 | 2026-11-14 08:00 | 0.00004461 | 67141.18528986 | −0.29951682757806546 |
| 2 | 2026-11-14 16:00 | 0.00003872 | 65713.90000000 | −0.25444422080000000 |
| 3 | 2026-11-15 00:00 | 0.00004667 | 64125.01326087 | −0.29927143688848029 |
| 4 | 2026-11-15 08:00 | 0.00002303 | 63988.60882309 | −0.14736576611957627 |
| 5 | 2026-11-15 16:00 | −0.00000247 | 64719.90000000 | +0.01598581530000000 |
| 6 | 2026-11-16 00:00 | −0.00001265 | 65315.64627536 | +0.08262429253833040 |
| 7 | 2026-11-16 08:00 | 0.00000717 | 64959.96637681 | −0.04657629589217277 |

Total funding:

- Paid (events 1–4 and 7): −0.29951682757806546 − 0.25444422080000000 − 0.29927143688848029
  − 0.14736576611957627 − 0.04657629589217277 = −1.04717454727829479
- Received (events 5 and 6): 0.01598581530000000 + 0.08262429253833040 = +0.09861010783833040
- Total: −1.04717454727829479 + 0.09861010783833040 = **−0.94856443943996439** (−0.95)

Events left out:

- 2026-11-14 00:00:00.004 is before the entry fill.
- 2026-11-16 16:00:00.004 is after the exit fill.

## 5. Net P&L and final balance

- Net P&L = gross − fees + funding = −234.01 − 6.557115 − 0.94856443943996439
  = **−241.51567943943996439** (−241.52)
- Final balance = 10000 − 241.51567943943996439 = **9758.48432056056003561** (9758.48)

The position is flat at the end, so equity equals the balance.

## Summary (asserted figures)

| Figure | Hand value | To the cent |
|---|---|---|
| Entry fill price | 66741.2 | exact |
| Exit fill price | 64401.1 | exact |
| Entry fee | 3.33706 | 3.34 |
| Exit fee | 3.220055 | 3.22 |
| Total fees | 6.557115 | 6.56 |
| Gross P&L | −234.01 | −234.01 |
| Funding 1–7 | see table | −0.30, −0.25, −0.30, −0.15, +0.02, +0.08, −0.05 |
| Funding total | −0.94856444 | −0.95 |
| Net P&L | −241.51567944 | −241.52 |
| Final balance | 9758.48432056 | 9758.48 |
