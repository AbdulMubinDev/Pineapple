# PineTS 0.13.1 spike: findings

Date: 2026-11-23. Package: `pinets@0.13.1` (LuxAlgo, AGPL-3.0-only), plus `isolated-vm@7.0.2`.
Evidence: `tests/spike/probe.test.ts` (one `describe` per question; `it.fails` = capability PineTS
does not have, with the reason in a comment). Hook code: `spike/probe.ts`, isolate runner:
`spike/isolate.ts`, `spike/isolate-cli.ts`. Probes: `spike/probes/01..07-*.pine`, probe 08 is
`tests/fixtures/KyberSwing.pine` (owner's real strategy, unchanged).

All runs use in-memory candles only (`tests/fixtures/BTCUSDT_4h.csv`, 8,508 bars, 2023-01-01 to
2026-11-18), either as a plain array or through `MemoryProvider` (an `IProvider` over the same
array that also serves daily candles aggregated from it). Nothing calls the network.

Sources read: the installed bundle and its source map (`node_modules/pinets/dist/*.map` embeds the
full TypeScript source), `dist/types`, and docs.luxalgo.com/developers/pinets (api-coverage,
api-coverage/strategy, architecture, pagination).

## Answers

| # | Question | Answer |
|---|---|---|
| 1 | Order calls visible per bar, with arguments | **Yes** |
| 2 | Broker state fed back from our broker | **Yes** |
| 3 | Bar-by-bar running with state kept | **Yes** (~160-300 us/bar for probe 01) |
| 4 | Serialise / restore per-bar state | **No**. Replay instead: 1,000 bars in ~17-27 ms |
| 5 | Daily `request.security` from 4h candles | **No** with a bare array; **yes** with a provider that serves daily candles. Bar-by-bar needs a workaround |
| 6 | Line numbers for errors; declaration readable | **Partly**: syntax errors yes; unknown/unsupported functions no. Declaration kind and args yes, `library` no |
| 7 | Runs inside `isolated-vm` | **Yes**, Windows and Linux; heap used ~16-17 MB for 8,508 bars |
| 8 | PineTS's own results vs TradingView | KyberSwing: 59 trades / 32.2% / PF 1.64 / +20.6% vs TV 58 / 32.8% / 1.71 / +22.6%. Probe 01: PineTS results recorded, TV numbers pending from owner |

### Q1. Order calls: yes

The transpiled script is one async function that PineTS calls once per bar with the run's
`Context` (`$`). Its first line destructures the namespaces each bar:
`const {ta, strategy, plot, ...} = $.pine;`, and every order is a call like
`strategy.entry(p21, temp_6)` or `strategy.exit(id, {from_entry, stop, limit})` (named
arguments arrive as one trailing plain object). `$.pine.strategy` is a per-run object whose methods
are own, writable properties, so they can be replaced before the first bar runs.

`hookScript()` in `spike/probe.ts` wraps the prepared function and, on the first bar, replaces
`entry`, `exit`, `close`, `close_all`, `order`, `cancel`, `cancel_all` with recorders:

```ts
const indicator = new Indicator(source);           // public API
const prepared = indicator.prepare();              // cached on the instance; run() reuses it
const original = prepared.fn;
prepared.fn = async ($) => {                       // called once per bar, after PineTS's broker step
  if (!$.isSecondaryContext && patched !== $) { patch($); patched = $; }
  if (opts.broker) view = opts.broker($.idx, $);  // our broker's state for this bar
  return original($);
};
// patch(): ns[method] = (...raw) => { calls.push({ bar: $.idx, time, method, args: normaliseOrderArgs(method, raw) });
//                                     return forward ? orig(...raw) : undefined; }
await new PineTS(candles, 'BINANCE:BTCUSDT.P', '240').run(indicator);
```

Evidence (`Q1` tests): probe 02 yields `entry {id:'L', direction:'long', qty:0.1, comment:'go long'}`,
`exit {id:'L-x', from_entry:'L', stop: close*0.97, limit: close*1.05}`, `close {id:'L', comment}`,
`order {id:'Dip', direction:'long', qty:0.05, limit}`, `cancel {id:'Dip'}`, `cancel_all`,
`close_all {comment:'flatten'}`, each with bar index and bar open time. Because calls are not
forwarded, PineTS's emulator ledger stays empty (0 closed, 0 open, 0 pending). KyberSwing's
equity-sized `strategy.entry(..., qty = q)` and stop-only `strategy.exit("L-X", from_entry="Long", stop=stopPx)`
are captured with the computed numbers. `normaliseOrderArgs` maps positional and named args onto
the Pine v6 signatures (the same lists PineTS uses) and unwraps Series to the current value; `na`
comes through as `NaN`, an omitted argument as `undefined`.

### Q2. Broker state: yes

The read-backs are getter methods on the same namespace object (`strategy.position_size` compiles to
`strategy.position_size()`). The hook replaces `position_size`, `position_avg_price`, `equity`,
`netprofit`, `openprofit` and `opentrades` with functions that return the broker view for the
current bar. `opentrades` returns a scalar helper (`{__value: n, valueOf, size(i), entry_price(i), entry_id(i), entry_bar_index(i), entry_time(i)}`),
the same shape PineTS uses, so `strategy.opentrades < 3` and `strategy.opentrades.size(0)` work.

Evidence (`Q2` tests, probe 04 over 300 bars with a synthetic broker): every bar's plotted
`position_size`, `position_avg_price`, `equity`, `netprofit`, `opentrades` equals what we fed;
`strategy.position_size[1]` (used by KyberSwing) equals the value we fed on the previous bar,
because `$.param` records the getter's value per call site into a history series; the script's
`qty = strategy.equity * 0.5 / close` used OUR equity on every entry; entries only happened on bars
our broker reported flat. Probe 03 gates on `strategy.opentrades < 3` and stopped entering when our
broker reported 3 open trades.

### Q3. Bar-by-bar: yes

`pine.run(indicator, undefined, 1)` returns an async generator that processes one bar per `next()`.
It re-reads `data.length` before each page, so a bar appended to the PineTS instance's public
arrays (`data`, `open`, `high`, `low`, `close`, `volume`, `hl2`, `hlc3`, `ohlc4`, `hlcc4`,
`openTime`, `closeTime`) before calling `next()` is processed on that call, with all script state
(var/let series, ta state, our patched namespace) kept. `createStepper()` in `spike/probe.ts` does
this. Rules: only call `next()` after appending (if it finds nothing new, the generator ends);
the hook sets `$.length` so `barstate.islast` stays right.

Evidence: stepping probe 01 over 1,000 bars produces exactly the same order calls as a full run
over those bars; KyberSwing stepped over 3,000 bars (with daily `request.security`, see Q5)
produces exactly the same calls as a full run. Timing on this machine (Windows, shared CPU):

| Run | us per bar |
|---|---|
| probe 01, stepped, 1,000 bars | 160-300 (varied with machine load; 157 over all 8,508 bars) |
| probe 01, full run, 1,000 bars | 17-27 |
| KyberSwing, full run, 8,508 bars | ~117 (1.0 s) |
| KyberSwing, stepped, 3,000 bars, HTF rebuilt at day boundaries | ~3,000 |

The paginated path builds a new page `Context` per bar, which is most of the stepping overhead.
Heap growth for one stepped probe-01 instance over 8,508 bars: ~2.3 MB (series grow by one value
per bar per variable; PineTS has no trimming).

### Q4. Saving state: no, replay

`structuredClone(context)` and `v8.serialize(context)` both throw (`DataCloneError: #<Promise> could not be cloned`):
the Context holds the transpiled function, namespace objects whose methods are closures over the
context, class instances (Series, drawing helpers) and promises. PineTS's own
`_snapshotVarState` is an in-memory rollback point for the last bar only (length + last value per
series), not a serialisable state, and it does not cover ta internals.

Replay cost: rebuilding 1,000 bars of probe 01 takes 17-27 ms and gives identical calls each time
(deterministic). KyberSwing's full 8,508 bars take ~1 s.

### Q5. Higher timeframes: no with an array, yes with a provider

`request.security` creates a secondary `PineTS(context.source, symbol, "D", ...)`. With an array
source, `context.source` is the same 4h array, so the "daily" context is the 4h bars relabelled:
the plotted daily value is simply the previous / current 4h close (`it.fails` test; KyberSwing on a
bare array gives 87 trades instead of 59 because its regime filter reads 4h EMAs as daily).
Also, with an array source `syminfo` is empty (no `tickerid`, `mintick`, `mincontract`), so slippage
in ticks and tick/qty rounding do not apply.

With an `IProvider` (our `MemoryProvider`: 4h candles plus UTC-day candles aggregated from them,
and BTCUSDT perpetual symbol info), both forms match TradingView's historical rules on every bar
checked (1,488 bars):
- `request.security(syminfo.tickerid, "D", close[1], lookahead = barmerge.lookahead_on)`: the
  previous completed day's close on all six 4h bars of a day (non-repainting form);
- `request.security(syminfo.tickerid, "D", close)` (lookahead off): the previous day's close on the
  first five bars, the day's own close on the 20:00 bar whose close is the day's close.
KyberSwing's tuple form `[close[1], ta.ema(close, 50)[1], ta.ema(close, 200)[1]]` works the same way.
Daily candles must be supplied by us: PineTS asks the provider for timeframe `"D"`; it only
aggregates inside its own `BaseProvider` subclasses.

Bar-by-bar caveat: the secondary context is built once, from the provider data at that moment.
PineTS's refresh path (bump `dataVersion` -> `updateTail`) pulls the new daily candles but then
returns stale values (`it.fails` test): its rollback truncates Series but not the plain `params`
arrays the values are read from. Workaround proven in the tests: drop the cached secondary
contexts (`$.cache` entries holding a `pineTS`, and reset `$.secondaryContextCount`, else PineTS's
40-context limit trips) so the next call rebuilds them in full from a provider that has grown with
the pushed bars. Rebuilding on every bar is correct for every form but costs O(history) per bar;
rebuilding only on bars that open or close a UTC day is enough for daily requests and matched the
full run exactly (probe 05 and KyberSwing).

Performance note: HTF lookup (`findSecContextIdx`) is a linear scan per bar, so full runs are
O(chart bars x HTF bars).

### Q6. Validation: partly

- Syntax errors: **yes**, `Indicator.prepare()` throws `Failed to transpile Pine Script version 6: Unexpected token OPERATOR '=' at 4:4`
  (line:column). For an unclosed parenthesis the position is where the parser gave up
  (`EOF at 5:1`), not the line that opened it.
- Undeclared identifiers: rejected at compile time (`Undeclared identifier "foo"`) but **no line**.
- Unknown functions (`ta.notafunction(...)`): **not caught at compile time**; at run time a JS
  `TypeError: ta.notafunction is not a function` whose stack points into the generated code, not the Pine line.
- Unsupported data requests (`request.financial`, `request.economic`, `request.seed`,
  `request.dividends`, ...): no error; they return `na` and add one warning per function to
  `ctx.warnings` (`{message, method, bar}`). No line number.
- No type checking: `x = close + "abc"` runs.
- `runtime.error("boom")` throws `PineRuntimeError` (with `.method`), no line.
- Declaration: **yes** for `strategy` / `indicator`: `new Indicator(src).getDeclarationType()` and
  `indicator.prop` (source arguments merged over the schema defaults, e.g. probe 06 `precision: 2`,
  probe 01 `initial_capital: 10000, default_qty_type: 'percent_of_equity', commission_value: 0.05, pyramiding: 0`).
  `library(...)` scripts read as `null` (`it.fails`), so we detect libraries ourselves.

For our UI this means: we need our own pre-run validator (a whitelist scan of the transpiled code
for namespace members, plus our own `library` detection) to give line-numbered "unsupported" errors.

### Q7. Sandboxing: yes

`spike/isolate.ts` loads `dist/pinets.min.browser.js` (UMD, sets `globalThis.PineTSLib`) as a
script into a fresh isolate with no Node APIs (checked inside: `require`, `process`, `fetch`,
`setTimeout`, `Buffer`, `module` are all `undefined`), passes candles as an `ExternalCopy` and the
Pine source as a string, and runs `new PineTSLib.PineTS(candles, ...).run(src)`. The result matches
the same run outside the isolate (closed-trade count and net profit equal).

| Platform | Node | Bars | Closed trades | Heap used | Heap total | Run |
|---|---|---|---|---|---|---|
| Windows 11 x64 (vitest) | 24.19.0 | 2,000 | = outside | 9.2 MB | 13.4 MB | |
| Windows 11 x64 (`npx tsx spike/isolate-cli.ts`) | 24.19.0 | 8,508 | 982 | 16.8 MB | 21.0 MB | 222 ms |
| Linux x64, `node:24-bookworm` container | 24.22.3 | 8,508 | 982 | 15.9 MB | 21.0 MB | 304 ms |

`isolated-vm@7.0.2` ships prebuilt binaries (win32-x64, linux-x64, linux-arm64, darwin-arm64);
no compiler was needed on either platform. Container run: worktree mounted read-only, copied into
the container, `npm ci`, `npx tsx spike/isolate-cli.ts`. The hook (Q1/Q2) has to run inside the
isolate too, since it patches the context; it is plain JS and needs nothing from Node.

### Q8. PineTS's own emulator vs TradingView

Emulator mode = our hook forwards every call to PineTS's broker (no broker override), symbol info
from `MemoryProvider` (mintick 0.1, qty step 0.001).

KyberSwing (owner's TV numbers: BTCUSDT 4h, Jan 1 2024 - Nov 18 2026). To mimic the tester's date
range, the hook forwards only calls on bars inside the window (indicators still warm up on 2023):

| | Trades | Win rate | Profit factor | Net profit |
|---|---|---|---|---|
| TradingView (owner) | 58 | 32.8% | 1.71 | +22.6% |
| PineTS emulator | 59 | 32.2% | 1.64 | +20.58% |
| PineTS, orders not gated before 2024 | 59 in window | 32.2% | 1.64 | +21.87% |
| PineTS, bare array source (no daily data, no syminfo) | 87 | 23.0% | 1.28 | +12.66% |

Close (one trade apart) but not exact. Possible causes, not yet separated: TV chart symbol
(BTCUSDT.P perpetual vs spot is unconfirmed; our fixture is perpetual), TV's qty step and tick for
the symbol, how TV's date-range setting treats the first bars, and remaining emulator differences.

Probe 01 (MA cross, 100% of equity, 0.05% commission), Jan 1 2024 - Nov 18 2026: PineTS emulator
**346 trades, 17.05% win rate, profit factor 0.96, -20.86% net**. TradingView comparison pending
the owner's numbers (`tests/fixtures/tv-reference.json` `"ma-cross": null`). Note: at 100% of
equity plus commission, the emulator books many margin-call partial closes ("Close position order"
rows), and the result is very sensitive to the qty step: with no symbol info (step 1e-6) it is
716 trades, 11.87%, PF 1.01, +10.21%. So probe 01 is a stress test of margin handling more than of
signals; KyberSwing is the better reference.

## Recommended hook design for Task 5

Keep PineTS as the script runtime only; our broker is the source of truth; PineTS's emulator gets
no orders.

1. **Compile**: `const ind = new Indicator(src); ind.prepare();` (errors -> our validator, Q6).
   Read `ind.getDeclarationType()` and `ind.prop` for strategy settings (initial capital, sizing,
   commission, slippage, pyramiding, margin, `process_orders_on_close`) and give them to our broker.
   Reject: non-strategy scripts, `calc_on_order_fills = true` (PineTS re-runs the script mid-bar
   for it, which would call our hook several times per bar), and any `strategy.*` read-back we do
   not feed (see 4).
2. **Wrap** `prepared.fn` (keep `_pineVersion`, `_ltfSlices` on the wrapper). In the wrapper, skip
   secondary contexts (`$.isSecondaryContext`), patch `$.pine.strategy` once per run, and per bar:
   - before `original($)`: ask our broker to fill orders pending from earlier bars against this
     bar's OHLC (our fill rules), then take its view for this bar;
   - run `original($)`; the recorders collect this bar's calls (`{bar, time, method, args}`);
   - after it: hand the calls to the broker (it queues them for the next bar, or fills at the close
     when `process_orders_on_close`).
   PineTS's own pre-bar broker step still runs but is a no-op with an empty ledger.
3. **Capture orders** with recorders for `entry`, `exit`, `close`, `close_all`, `order`, `cancel`,
   `cancel_all`, normalised to the Pine v6 signatures (`normaliseOrderArgs`). Do not forward.
4. **Feed state back** by replacing the getters `position_size`, `position_avg_price`, `equity`,
   `netprofit`, `openprofit`, `opentrades` (scalar helper with `size/entry_price/entry_id/entry_bar_index/entry_time/profit`).
   Anything else (`closedtrades.*`, `wintrades`, `grossprofit`, `max_drawdown`,
   `position_entry_name`, `opentrades.profit`, `default_entry_qty`, ...) would silently read the
   empty emulator: either add a getter backed by our broker or reject the script in validation.
   History reads like `strategy.position_size[1]` work with no extra code.
5. **Data**: always run through a provider (ours, in memory) so `syminfo` carries the exchange's
   tick size and qty step, and daily (or other HTF) candles come from our candle store. Never
   `Provider.Binance`.
6. **Live, bar by bar**: one stepper per (script, symbol) via `run(ind, undefined, 1)` plus appending
   closed bars; HTF contexts rebuilt as in Q5 (drop the security cache at HTF boundaries; do not
   rely on `updateTail`).
7. **Sandbox**: run the whole thing (bundle + hook + candles) inside an `isolated-vm` isolate with a
   memory limit; the broker can stay outside, called per bar through a reference, or the broker
   view is copied in per bar.

Fragility: this relies on internals that are stable in 0.13.1 but not documented as API:
`PreparedScript.fn` being mutable and reused by `run()`, the per-bar call of that function with
the Context, `$.pine.strategy` methods being replaceable own properties read through per-bar
destructuring, and `$.idx`, `$.marketData`, `$.length`, `$.cache`, `$.isSecondaryContext`,
`$.secondaryContextCount`. Keep `pinets` exact-pinned and keep `tests/spike/probe.test.ts` as the
canary for upgrades.

Fallbacks if an upgrade breaks this: (a) maintain a small patch (`patch-package`) that adds a
documented per-bar hook and order-sink to `PineTS._executeIterations`; (b) fork PineTS (AGPL) and
expose the hook; (c) another runtime (none known with equal Pine v6 coverage). Wrapping PineTS's own
emulator as our broker is not recommended: it is good (KyberSwing within one trade of TV) but it
is not ours to control, and the design wants one broker for backtest, replay and live.

## State persistence recommendation

**Replay, do not serialise.** PineTS state cannot be serialised (Q4). Rebuild a script instance by
replaying stored candles through the stepper with our broker answering from its persisted ledger
(the broker view for bar i must be a pure function of our stored fills, so replay is
deterministic). Cost is small: 1,000 bars ~20 ms for a simple script, ~1 s for KyberSwing over
8,508 bars with a daily request. Keep live instances in memory between bars; on restart or upgrade,
replay. Bound memory and replay time with a fixed history window per instance (enough for the
script's longest lookback, e.g. KyberSwing needs 200 daily bars), rebuilding periodically.

## Concerns

- AGPL-3.0-only: fine for a private app; if it is ever offered to others over a network, AGPL
  section 13 requires offering the source of the combined work.
- Probe-01 TV numbers are pending; the KyberSwing chart symbol (perpetual vs spot) is unconfirmed.
- Bar-by-bar MTF needs our workaround because PineTS's `updateTail` gives stale values.
- Order-argument normalisation is ours; Task 5 should unit-test it against PineTS's own parsed
  orders (forward mode makes that easy).
