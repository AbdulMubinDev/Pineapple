# PineTS 0.13.1 spike: findings

Date: 2026-11-23 (fix round 1 applied). Package: `pinets@0.13.1` (LuxAlgo, AGPL-3.0-only), plus
`isolated-vm@7.0.2`. Evidence: `tests/spike/probe.test.ts` (one `describe` per question;
`it.fails` = a capability PineTS does not have, with the reason in a comment, each paired with a
positive test that pins the actual failure). Hook code: `spike/probe.ts`; isolate runners:
`spike/isolate.ts`, `spike/isolate-cli.ts`; rebuild benchmark: `spike/rebuild-bench.ts`.
Probes: `spike/probes/01..07-*.pine`; probe 08 is `tests/fixtures/KyberSwing.pine` (the owner's
real strategy, unchanged).

All runs use in-memory candles only (`tests/fixtures/BTCUSDT_4h.csv`, 8,508 bars, 2023-01-01 to
2026-11-18), either as a plain array or through `MemoryProvider` (an `IProvider` over the same
candles that also serves daily candles aggregated from them). The spike suite stubs `fetch` to
throw and asserts it was never called.

Labels: numbers marked **(test)** are asserted or printed by the test suite (`SPIKE_LOG=1` prints
timings); **(bench)** comes from `node --expose-gc --import tsx spike/rebuild-bench.ts`;
**(observed manually)** comes from one-off runs and is not re-checked by anything. All timings were
taken on a shared Windows machine and moved by up to 2x with load.

Sources read: the installed bundle and its source map (`node_modules/pinets/dist/*.map` embeds the
full TypeScript source), `dist/types`, and docs.luxalgo.com/developers/pinets (api-coverage,
api-coverage/strategy, architecture, pagination).

## Answers

| # | Question | Answer |
|---|---|---|
| 1 | Order calls visible per bar, with arguments | **Yes** |
| 2 | Broker state fed back from our broker | **Yes** |
| 3 | Bar-by-bar running with state kept | **Yes**, ~170 us/bar for probe 01 when stepping |
| 4 | Serialise / restore per-bar state | **No**. Rebuild with a warm start instead: one page over the window, then stepping. KyberSwing with a 3,000-bar window takes ~0.34 s |
| 5 | Daily `request.security` from 4h candles | **No** with a bare array. **Yes** with a provider that serves daily candles. Bar-by-bar needs our workaround |
| 6 | Line numbers for errors; declaration readable | **Partly**. Syntax errors yes; undeclared, unknown and unsupported functions no. Declaration kind and args yes; `library` no |
| 7 | Runs inside `isolated-vm` | **Yes**, on Windows and Linux, hook included; heap used ~16-17 MB for 8,508 bars |
| 8 | PineTS's own results vs TradingView | KyberSwing: PineTS 59 trades / 32.2% / PF 1.64 / +20.6% vs TV 58 / 32.8% / 1.71 / +22.6%. Probe 01: PineTS results recorded; TV numbers pending from the owner |

### Q1. Order calls: yes

The transpiled script is one async function that PineTS calls once per bar with the run's
`Context` (`$`). Its first line destructures the namespaces each bar:
`const {ta, strategy, plot, ...} = $.pine;`, and every order is a call like
`strategy.entry(p21, temp_6)` or `strategy.exit(id, {from_entry, stop, limit})` (named
arguments arrive as one trailing plain object). `$.pine.strategy` is a per-run object whose methods
are own, writable properties, so they can be replaced before the first bar runs.

`hookScript()` in `spike/probe.ts` wraps the prepared function and, the first time it sees a run's
context, replaces `entry`, `exit`, `close`, `close_all`, `order`, `cancel`, `cancel_all` with
recorders. That happens once per run: a full run, and a stepped run across all its bars, both
patch exactly once **(test: `patchCount() === 1`)**.

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

Evidence **(test)**:
- Probe 02 yields `entry {id:'L', direction:'long', qty:0.1, comment:'go long'}`.
- `exit {id:'L-x', from_entry:'L', stop: close*0.97, limit: close*1.05}`; its unused args such as `qty` and `trail_points` read as `undefined`.
- `close {id:'L', comment}`.
- `order {id:'Dip', direction:'long', qty:0.05, limit: close*0.9}` on bars where `bar_index % 50 == 0`.
- `cancel {id:'Dip'}` on `% 50 == 3`, `cancel_all` on `% 500 == 499`, `close_all {comment:'flatten'}`.

Each call carries its bar index and open time. Probe 01 passes no qty, and every recorded entry has
`qty: undefined`, so our broker applies the `strategy()` default. Because calls are not forwarded,
PineTS's ledger stays empty (0 closed, 0 open, 0 pending).

For KyberSwing, every entry has `qty > 0` and below the `equity × 3 / close` cap at the fed equity.
On the entry bar, the matching `L-X` / `S-X` exit has `from_entry` = the entry id, no limit, and a
finite stop below the close for longs (above it for shorts).

`normaliseOrderArgs` maps positional and named args onto the Pine v6 signatures (the same lists
PineTS uses) and unwraps a Series to its current value. Every signature key is present: an
omitted argument is `undefined`, and `na` comes through as `NaN`.

### Q2. Broker state: yes

The read-backs are getter methods on the same namespace object (`strategy.position_size` compiles to
`strategy.position_size()`). The hook replaces `position_size`, `position_avg_price`, `equity`,
`netprofit`, `openprofit` and `opentrades` with functions that return the broker view for the
current bar. `opentrades` returns a scalar helper (`{__value: n, valueOf, size(i), entry_price(i), entry_id(i), entry_bar_index(i), entry_time(i), profit(i)}`),
the same shape PineTS uses.

Evidence **(test)**: probe 04 runs over 300 bars with a synthetic broker. On every bar these plotted
values equal what we fed:
- `position_size`, `position_avg_price`, `equity`, `netprofit`, `openprofit`;
- `opentrades` (the count);
- `opentrades.size(0)`, `.entry_price(0)`, `.entry_id(0)`, `.entry_bar_index(0)`, `.entry_time(0)` and `.profit(0)`, including the `0` / `na` values when we report no trade.

`strategy.position_size[1]` (used by KyberSwing) equals the value we fed on the previous bar.
`$.param` records the getter's value per call site into a history series, so no extra code is
needed.

The script's `qty = strategy.equity * 0.5 / close` used OUR equity on every entry, and entries only
happened on bars our broker reported flat. With our avg price set far above the market, the script
called `strategy.close` on every bar. Probe 03 entered on green bars before bar 100 and never after,
once our broker reported 3 open trades (`strategy.opentrades < 3`).

### Q3. Bar-by-bar: yes

`pine.run(indicator, undefined, pageSize)` returns an async generator that processes up to
`pageSize` bars per `next()`. It re-reads `data.length` before each page. A bar appended to the
PineTS instance's public arrays (`data`, `open`, `high`, `low`, `close`, `volume`, `hl2`, `hlc3`,
`ohlc4`, `hlcc4`, `openTime`, `closeTime`) before calling `next()` is processed on that call, and
all script state is kept: var/let series, ta state and our patched namespace.

`createStepper()` in `spike/probe.ts` does this. It sets the page size to the history length, so
an optional warm-up history goes through in one page (see Q4), and each later `next()` finds
exactly one appended bar. Rules:
- only call `next()` after appending a bar (if it finds nothing new, the generator ends);
- the hook sets `$.length` so `barstate.islast` stays right.

Evidence **(test)**:
- Stepping probe 01 over 1,000 bars produces exactly the same order calls as a full run over those bars.
- KyberSwing stepped over 3,000 bars, with its daily `request.security` (see Q5), produces exactly the same calls as a full run.

| Run | us per bar | Source |
|---|---|---|
| probe 01, stepped, 1,000 bars | 160-300 (174 in the last run) | test |
| probe 01, stepped, all 8,508 bars | 157 | observed manually |
| probe 01, full run / warm start, 1,000 bars | ~18-27 | test |
| KyberSwing, full run, 8,508 bars | ~118 (1.0 s) | bench |
| KyberSwing, stepped from bar 0, 3,000 bars, HTF rebuilt at day boundaries | ~3,100 | test |

Stepping overhead: the paginated path builds a new page `Context` per bar. With an HTF request it
also has to rebuild the daily context (Q5), and that cost grows with the history held.

Heap growth for one stepped probe-01 instance over 8,508 bars: ~2.3 MB **(observed manually)**.
Series grow by one value per bar per variable, and PineTS has no trimming.

### Q4. Saving state: no. Rebuild with a warm start

`structuredClone(context)` and `v8.serialize(context)` both throw `... could not be cloned` on a
Promise **(test, pinned)**. The Context holds:
- the transpiled function;
- namespace objects whose methods are closures over the context;
- class instances (Series, drawing helpers);
- promises.

PineTS's own `_snapshotVarState` is an in-memory rollback point for the last bar only (length plus
last value per series). It is not a serialisable state, and it does not cover ta internals.

**Warm start** (the rebuild path we recommend): `createStepper(src, { history })` hands the whole
window to PineTS as one page, at full-run speed, then steps. The hand-over is exact **(test)**.
Probe 01 warm-started on 1,000 bars and stepped 500 more produces exactly the calls of a full run
over the 1,500 bars. Stepping alone from bar 0 would cost ~170 us/bar instead of ~20 us/bar.

**The window must be long enough for the script's lookbacks** **(test)**. KyberSwing was warm-started on the window just before the last 500 bars, then stepped through them. These were compared with the full-history run's entries in those 500 bars:

| Window (4h bars) | Entries reproduced | Warm start | Step, us/bar | Retained heap / instance | 2,500 instances, warm start on 1 CPU |
|---|---|---|---|---|---|
| 1,000 | 3 / 13 | 125 ms | 2,785 | 3.9 MB | 5.2 min |
| 2,000 | 9 / 13 | 233 ms | 4,425 | 6.9 MB | 9.7 min |
| 3,000 | 13 / 13 | 328 ms | 5,993 | 10.2 MB | 13.7 min |
| 4,500 | 13 / 13 | 475 ms | 8,413 | 15.3 MB | 19.8 min |
| 8,008 (all) | 13 / 13 | 809 ms | 14,206 | 27.6 MB | 33.7 min |

(Bench; the test asserts the 3,000 and 1,000 rows' reproduction counts and prints both warm-start
times: 338 ms and 135 ms in the last run.)

Why 1,000 bars fails: 1,000 4h bars is 167 days. PineTS fetches the daily context from the chart's
first bar minus 30 days, so it has fewer than the 200 daily bars KyberSwing's EMA-200 regime needs.
Truncation in general changes EMA/var state compared with the full backtest. The windowed run
converges once the window is about 3x the longest lookback (here 3,000 bars, about 500 days).

**Answer to the controller's sizing question** (2,500 KyberSwing-sized instances, 1 CPU):
- 1,000-bar window: ~0.13 s each, **~5 min total, but it is not correct for KyberSwing** (it misses 10 of 13 entries).
- 3,000-bar window (the smallest that matched): ~0.33 s each, **~14 min total**.
- Keeping all 2,500 instances live in memory needs ~10 MB each at 3,000 bars: **~25 GB. Not viable** on a small server.

### Q5. Higher timeframes: no with an array, yes with a provider

`request.security` creates a secondary `PineTS(context.source, symbol, "D", ...)`. With an array
source, `context.source` is the same 4h array, so the "daily" context is just the 4h bars
relabelled **(test)**:
- the lookahead_on `close[1]` form returns the previous 4h close;
- the default form returns the current 4h close;
- `syminfo` is empty (`tickerid`, `mintick` and `mincontract` are undefined), so slippage in ticks and tick/qty rounding do not apply.

KyberSwing on a bare array takes different entries **(test)**, and in emulator mode gets 87
trades instead of 59 **(test, Q8)**.

With an `IProvider` (our `MemoryProvider`: 4h candles plus UTC-day candles aggregated from them,
and BTCUSDT perpetual symbol info `mintick 0.1, mincontract 0.001`), every bar checked (1,488 bars)
matches TradingView's historical rules **(test)**:
- `request.security(syminfo.tickerid, "D", close[1], lookahead = barmerge.lookahead_on)`: the previous completed day's close on all six 4h bars of a day (the non-repainting form).
- `request.security(syminfo.tickerid, "D", close)` (lookahead off): the previous day's close on the first five bars, and the day's own close on the 20:00 bar, whose close is the day's close.
- The tuple form `[close[1], ta.ema(close, 3)[1]]` with lookahead_on: element 1 equals the previous day's close, and element 2 equals our own SMA-seeded daily EMA(3) of the previous day (to 1e-6).

Daily candles must come from us: PineTS asks the provider for timeframe `"D"`. It only aggregates
inside its own `BaseProvider` subclasses.

**Bar-by-bar caveat.** The secondary context is built once, from the provider data at that
moment. PineTS's refresh path (bump `dataVersion`, then `updateTail`) pulls the new daily candles
but returns stale values **(test, pinned)**: day 1's close is still returned on bars 12-47, where
TradingView moves to a new day every 6 bars. Our reading of the source is that its rollback
truncates Series but not the plain `params` arrays the values are read from. That cause is
inferred, not proven.

Workaround: drop the cached secondary contexts (the `$.cache` entries holding a `pineTS`) and reset
`$.secondaryContextCount`, otherwise PineTS's 40-context limit trips. The next call then rebuilds
them in full from a provider that has grown with the pushed bars. Proven **(test)** for the
`close[1]` lookahead_on, default `close` and tuple forms, both when rebuilt on every bar (600
bars) and when rebuilt only on bars that open or close a UTC day (1,500 bars). It is also proven
for KyberSwing (day-boundary rebuild, 3,000 bars, same calls as a full run).

Not tested: repainting forms such as `close` with lookahead_on. Rebuilding on every bar should
cover them, because a rebuild is a full secondary run on the data so far, but that is untested.
Cost: a rebuild is O(history) (see the step column in Q4).

Performance note: the HTF lookup (`findSecContextIdx`) is a linear scan per bar, so full runs are
O(chart bars × HTF bars).

### Q6. Validation: partly

All of the following is **(test)**:
- **Syntax errors: yes.** `Indicator.prepare()` throws e.g. `... Unexpected token OPERATOR '=' at 4:4` (line:column). For an unclosed parenthesis on line 3 it reports `EOF at 5:1`: where the parser gave up, not the line that opened it.
- **Undeclared identifiers:** rejected at compile time with exactly `Undeclared identifier "foo"`. **No line.**
- **Unknown functions** (`ta.notafunction(...)`): **compile fine**. At run time they throw a JS `TypeError: ta.notafunction is not a function`, with no Pine line.
- **Unsupported data requests** (`request.financial`, `request.economic`, `request.seed`, `request.dividends`): no error. They return `na` on every bar and add one warning per function to `ctx.warnings` (`{message, method, bar}`); the rest of the script still runs. No line.
- **No type checking:** `x = close + "abc"` compiles and runs.
- `runtime.error("boom")` throws a `PineRuntimeError` (message `boom`), with no line.
- **Declaration: yes for `strategy` / `indicator`.** `new Indicator(src).getDeclarationType()` and `indicator.prop` give the source arguments merged over the schema defaults:
  - probe 06: `precision: 2`;
  - probe 01: `initial_capital: 10000, default_qty_type: 'percent_of_equity', commission_value: 0.05, pyramiding: 0`;
  - KyberSwing: `slippage: 2, margin_long/short: 20, process_orders_on_close: false, calc_on_order_fills: false`.
- **`library(...)` scripts read as `null`**, so we detect libraries ourselves.

Our UI therefore needs its own pre-run validator:
- a whitelist scan of the transpiled code for namespace members, with line mapping done by us;
- our own `library` detection.

**Imports and the network.** `import user/lib/N as x` with no resolver set fails at run with
`Unresolved Pine Script import: "TradingView/ta/7". Provide the library source with an import resolver ...`,
and no fetch is attempted **(test)**. PineTS only fetches libraries through resolvers we install
(`setImportResolver` with `UrlImportResolver` / `GitHubImportResolver` / a function resolver).

How to block it:
- never install a network resolver; use `MapImportResolver` with library sources we store, or none;
- run inside the isolate, which has no `fetch` (Q7);
- the project eslint rule already forbids `fetch` outside `src/net/http.ts`.

### Q7. Sandboxing: yes

`spike/isolate.ts` sets up a fresh isolate with no Node APIs:
- it loads `dist/pinets.min.browser.js` (UMD, sets `globalThis.PineTSLib`) as a script;
- inside the isolate, `require`, `process`, `fetch`, `setTimeout`, `Buffer` and `module` are all `undefined` **(test)**;
- it passes the candles as an `ExternalCopy` and the Pine source as a string;
- it runs `new PineTSLib.PineTS(candles, ...).run(src)`.

The result matches the same run outside the isolate: the closed-trade count and net profit are
equal **(test)**.

**The hook inside the isolate (test).** `runHookedInIsolate` evaluates a plain-JS copy of the hook
(`ISOLATE_HOOK` in `spike/isolate.ts`) inside the isolate. The broker stays in the host: the isolate
calls it once per bar through an `ivm.Reference` that returns the view as JSON. For probe 02 (no
broker) and probe 04 (host broker), the order calls captured inside are identical to the calls
`hookScript` captures outside.

The isolate copy duplicates `normaliseOrderArgs` and the patch logic. Task 5 should keep one
source (plain JS, loaded into the isolate as text) to avoid drift.

| Platform | Node | Bars | Closed trades | Heap used | Heap total | Run | Source |
|---|---|---|---|---|---|---|---|
| Windows 11 x64 (vitest) | 24.19.0 | 2,000 | = outside | 9.2-9.5 MB | 13.4 MB | | test |
| Windows 11 x64 (`npx tsx spike/isolate-cli.ts`) | 24.19.0 | 8,508 | 982 | 16.8 MB | 21.0 MB | 222 ms | observed manually |
| Linux x64, `node:24-bookworm` container | 24.22.3 | 8,508 | 982 | 15.9 MB | 21.0 MB | 304 ms | observed manually |

`isolated-vm@7.0.2` ships prebuilt binaries (win32-x64, linux-x64, linux-arm64, darwin-arm64), so
no compiler was needed on either platform.

Container run: the worktree was mounted read-only and copied into the container, then
`npm ci && npx tsx spike/isolate-cli.ts`.

### Q8. PineTS's own emulator vs TradingView

Emulator mode means our hook forwards every call to PineTS's broker (no broker override), with
symbol info from `MemoryProvider` (mintick 0.1, qty step 0.001). All numbers below are **(test,
pinned with `toEqual`)**, so any drift after an upgrade shows up.

**KyberSwing.** The owner's TV numbers are for BTCUSDT 4h, Jan 1 2024 - Nov 18 2026. To mimic the
tester's date range, the hook forwards only calls on bars inside the window; the indicators still
warm up on 2023.

| | Trades | Win rate | Profit factor | Net profit |
|---|---|---|---|---|
| TradingView (owner) | 58 | 32.8% | 1.71 | +22.6% |
| PineTS emulator | 59 | 32.2% | 1.64 | +20.58% |
| PineTS, orders not gated before 2024 | 59 in window | 32.2% | 1.64 | +21.87% |
| PineTS, bare array source (no daily data, no syminfo) | 87 | 22.99% | 1.28 | +12.66% |

PineTS is one trade off, close but not exact. Possible causes, not yet separated:
- the TV chart symbol (BTCUSDT.P perpetual vs spot is unconfirmed; our fixture is perpetual);
- TV's qty step and tick for that symbol;
- how TV's date-range setting treats the first bars;
- remaining emulator differences.

**Probe 01** (MA cross, 100% of equity, 0.05% commission), Jan 1 2024 - Nov 18 2026: the PineTS
emulator gives **346 trades, 17.05% win rate, profit factor 0.96, -20.86% net**. The TradingView
comparison is pending the owner's numbers; the test asserts `"ma-cross": null` until they arrive.

Probe 01 is a weak reference:
- At 100% of equity plus commission, the emulator books many margin-call partial closes ("Close position order" rows).
- The result depends heavily on the qty step. Without symbol info (step 1e-6) it is 716 trades, 11.87%, PF 1.01, +10.21%.

So probe 01 tests margin handling more than signals; KyberSwing is the better reference.

## Recommended hook design for Task 5

PineTS is the script runtime only. Our broker is the source of truth, and PineTS's emulator gets
no orders.

1. **Compile.** `const ind = new Indicator(src); ind.prepare();` (errors go to our validator, Q6).
   - Read `ind.getDeclarationType()` and `ind.prop` for the strategy settings (initial capital, sizing, commission, slippage, pyramiding, margin, `process_orders_on_close`) and give them to our broker.
   - Reject non-strategy scripts.
   - Reject `calc_on_order_fills = true`: PineTS re-runs the script mid-bar for it, which would call our hook several times per bar.
   - Reject any `strategy.*` read-back we do not feed (see 4).
2. **Wrap** `prepared.fn`, keeping `_pineVersion` and `_ltfSlices` on the wrapper. In the wrapper, skip secondary contexts (`$.isSecondaryContext`) and patch `$.pine.strategy` once per run context. Then, per bar:
   - before `original($)`: ask our broker to fill orders pending from earlier bars against this bar's OHLC (our fill rules), then take its view for this bar;
   - run `original($)`; the recorders collect this bar's calls (`{bar, time, method, args}`);
   - after it: hand the calls to the broker. It queues them for the next bar, or fills them at the close when `process_orders_on_close` is set.

   PineTS's own pre-bar broker step still runs, but it is a no-op with an empty ledger.
3. **Capture orders** with recorders for `entry`, `exit`, `close`, `close_all`, `order`, `cancel` and `cancel_all`, normalised to the Pine v6 signatures (`normaliseOrderArgs`). Do not forward them.
4. **Feed state back** by replacing the getters `position_size`, `position_avg_price`, `equity`, `netprofit`, `openprofit` and `opentrades`. `opentrades` is a scalar helper with `size / entry_price / entry_id / entry_bar_index / entry_time / profit`, all tested.
   - Anything else (`closedtrades.*`, `wintrades`, `grossprofit`, `max_drawdown`, `position_entry_name`, `opentrades.commission / max_runup / ...`, `default_entry_qty`, ...) would silently read the empty emulator. Either add a getter backed by our broker or reject the script in validation.
   - History reads such as `strategy.position_size[1]` work with no extra code.
5. **Data.** Always run through a provider (ours, in memory), so `syminfo` carries the exchange's tick size and qty step and the daily (or other HTF) candles come from our candle store. Never use `Provider.Binance`, and never install a network import resolver.
6. **Bar by bar.** Use `createStepper`-style paging: page size = warm-up length, then append closed bars. Rebuild HTF contexts as in Q5, dropping the security cache at HTF boundaries; do not rely on `updateTail`.
7. **Sandbox.** Run the bundle, the hook and the candles inside an `isolated-vm` isolate with a memory limit. The broker stays in the host and is called per bar through a reference (tested).

**Fragility.** The design relies on internals that are stable in 0.13.1 but not documented as API:
- `PreparedScript.fn` being mutable and reused by `run()`;
- the per-bar call of that function with the Context;
- `$.pine.strategy` methods being replaceable own properties, read through per-bar destructuring;
- `$.idx`, `$.marketData`, `$.length`, `$.cache`, `$.isSecondaryContext` and `$.secondaryContextCount`.

Keep `pinets` exact-pinned, and keep `tests/spike/probe.test.ts` as the canary for upgrades.

**Fallbacks** if an upgrade breaks this:
- (a) Maintain a small patch (`patch-package`) that adds a documented per-bar hook and order sink to `PineTS._executeIterations`.
- (b) Fork PineTS (AGPL) and expose the hook.
- (c) Use another runtime (none known with equal Pine v6 coverage).

Wrapping PineTS's own emulator as our broker is not recommended. It is good (KyberSwing within one
trade of TV), but it is not ours to control, and the design wants one broker for backtest, replay
and live.

## Resident instances with bounded history (Task 2b)

The question: can about 2,500 KyberSwing-sized instances (5 runs × ~500 pairs) stay resident and
be stepped once per bar, inside a 768 MB / 1 CPU container, with a pass finishing within ~10 s?
The two options from Task 2 failed. Rebuilding every pass takes ~14 min; keeping instances
resident needs ~25 GB.

Code: `spike/resident.ts` (pure; also bundled into the isolate), `spike/hook-core.ts` (the order
recorder and arg normaliser, shared with `probe.ts`). Tests: `tests/spike/resident.test.ts`.
Benches: `spike/resident-bench.ts` (Node), `spike/resident-isolate.ts` (isolated-vm) and
`spike/docker-resident.sh` (the Linux run).

### 2b.1 Trimming: yes, by trimming PineTS internals between bars

No PineTS option exists for this. A resident instance runs three mechanisms.

**1. Stepping without rebuilding the daily context.** Each new bar bumps `$.dataVersion`, so
PineTS's own `updateTail()` refreshes every cached `request.security` context incrementally from
our provider. Its rollback bug (Q5) is fixed by `installUpdateTailFix()`. It wraps
`PineTS.prototype._snapshotVarState` / `_restoreVarState` so the plain arrays under `params` are
snapshotted and restored as well. The fix applies only to PineTS instances fed by our
`StoreProvider`.

**2. Trimming after every step** (`ResidentInstance.trim`):
- **Series and `params` buffers** (`$.const/var/let/params`, `$.lctx`, `$.data.*`) are cut to `keep` once they exceed `keep + slack`.
  - The cut is done in place (same array object), and the backing store is re-allocated.
  - `splice` would keep the old capacity.
  - This is safe because PineTS reads all of them relative to their end (`Series.get`, `$.param`).
- **The daily context uses one uniform cut.** `request.security` reads `params[expr][i]`, with `i` taken from `data.openTime.data`, so every buffer drops the same count. The stored rollback snapshot `_varSnapshot` is shifted by what each buffer lost.
- **The chart arrays** of the main and daily PineTS instances (`data/open/.../closeTime`, `marketData`) are absolutely indexed by bar number. They are replaced by `SlidingArray` Proxies: `length` and indexes are offset, and index 0 is kept, because `chart.left_visible_bar_time`, the drawing helpers and `request.security` read `marketData[0]`.
- **ta window buffers** (`History` inside CarryHistory / nonNaWindow state) keep max(5,000, 2 × length) entries and never shrink. Between bars they are cut to the `keep` their users last asked for and re-allocated, and `keep` is reset to 0 so the next `keepFor(length)` sets 2 × length.
- **highest/lowest deques** (`idx/val/head`) drop their dead prefix early. PineTS waits until head > 1024.
- **Plots, `result`, `alerts` and `warnings`** are cut to their last entry.
- **`barstate.isconfirmed`** is overridden to `true`, because PineTS indexes `closeTime.data[idx]` absolutely and we only step closed bars.
- **The shared candle store** is trimmed once instances are warm.

**3. Sharing.** One `SharedScript` (one transpile, ~2 MB) serves every instance of a script, and
one `FeedStore` per symbol serves every instance on that symbol.

**Internals relied on** (pinets 0.13.1):
- `PreparedScript.fn` mutable;
- `$.pine.strategy` methods;
- `$.pine.barstate`;
- `$.const/var/let/params/lctx/data/plots/result/alerts/warnings/taState/cache/dataVersion/_varSnapshot/marketData/idx/length/isSecondaryContext`;
- `PineTS.prototype._snapshotVarState/_restoreVarState`;
- PineTS's public per-field chart arrays;
- the cache entries `{pineTS, context}`;
- the `History` fields `v/nan/ph/pl/qh/ql/off/start/end/keep` and the deque fields `idx/val/head/saved`.

Correctness **(test)**: order calls equal a full run on a broker view that changes every bar.

| Script | Bounds | Bars stepped (after warm-up) | Result |
|---|---|---|---|
| probe 01 | keep 200 | 3,000 (warm-up 500) | = full run over 3,500 |
| KyberSwing | keep 100, daily 50 | 8,008 (warm-up 500) | = full run over 8,508 |
| KyberSwing | keep 60 + slack 20, daily 10 | 8,008 | = full run over 8,508 |
| KyberSwing, 2 instances on one SharedScript, different brokers | keep 200 | 3,000 | each = its own full run |
| KyberSwing untrimmed (incremental daily via the fixed updateTail) | none | 3,000 | = full run |
| probe 05 daily values (lookahead_on `close[1]`, default `close`, tuple) | keep 50 | 1,100, checked every bar | = full run on every bar |

Further tests **(test)**:
- With trimming, the main and daily buffers, the ta histories (≤ 512 slots), the deques, alerts and the store all stay bounded, and `marketData[0]` / `marketData[last]` stay readable.
- **The bound must cover the script's series lookbacks.** A script using `close[50]` matches the full run with keep 60 and diverges with keep 30.
- KyberSwing itself matches even at keep 30. Its 55-bar windows live in taState, and its series lookbacks are `[1]`. The bound that matters is the largest `x[n]` history reference, not the ta lengths.
- Not tested: a ta function first called late, after trimming. Its one-time backfill reads up to 5,000 bars of its source series, so it could see fewer bars than in a full run.

### 2b.2 Memory per resident instance (bench)

The bench runs 50 KyberSwing instances in one process with one shared store and script. Each is
warm-started on 500 bars, then stepped in lockstep. Heap is measured with `process.memoryUsage().heapUsed`
after `global.gc()` (`--expose-gc`) every 100 passes, minus the baseline taken after the store
and script were built. Each row gives the min-max in steady state.

| Bounds | Windows, Node 24.19 | Linux `node:24-bookworm`, 1 CPU, 768 MB, Node 24.22 |
|---|---|---|
| keep 60 + slack 20, daily 10 (tight for KyberSwing) | 0.42-0.45 MB, flat over 2,000 steps | 0.42-0.45 MB, flat over 1,500 steps |
| keep 100, daily 50 (safer default) | 0.64-0.69 MB, flat over 4,000 steps (0.65-0.93 MB before the ta/deque/alert trims, rising) | 0.64-0.69 MB, flat over 1,500 steps |
| no trimming | 1.9 → 5.3 MB after 1,500 steps, +~2.6 KB per bar, unbounded | 1.9 → 4.2 MB after 1,000 steps |

Where the ~0.45 MB goes (tight bounds, freeing one component at a time from all 50 instances):

| Component | KB per instance |
|---|---|
| main Context + namespaces + PineTS + generator (fixed) | ~120 |
| daily `request.security` Context + PineTS (fixed) | ~120 |
| main var/let/const/params buffers (~71 series × ≤ 80 bars) | ~84 |
| main ta state | ~28 |
| main data series | ~18 |
| daily buffers | ~17 |
| plots | ~7 |

About 240 KB is fixed cost: PineTS builds every namespace (ta, strategy, array, map, drawing
helpers, ...) as closures per Context, and KyberSwing has two Contexts.

### 2b.3 Pass time (bench)

One pass = append one bar to the store, then step every instance (median over 500 passes).

| Where | ms per instance per bar | 2,500 instances, one core |
|---|---|---|
| Windows, Node, 50 instances | 0.41-0.45 (tight), 0.42-0.45 (default), 0.37 (untrimmed) | ~1.1 s |
| Linux 1 CPU, Node, 50 instances | 0.71-0.83 (tight), ~1.0 (default) | ~2.0-2.5 s |
| Linux 1 CPU, one isolate, 50 instances | 1.33 (tight), 1.35 (default) | ~3.3 s |
| Linux 1 CPU, one isolate, **1,000** instances near its 512 MB limit | 3.87 | ~9.7 s (GC pressure) |

Trimming adds ~15% to the step cost. The step cost is flat per bar.

The 4h fixture was used for all of this. The cost per step does not depend on the chart
timeframe, but **a 15m chart was not run.** Its daily context gets 96 chart bars per daily bar,
and updateTail re-executes the developing day every bar, as it does here.

### 2b.4 Isolate layout (bench, Linux container)

| Layout | Heap | Process RSS |
|---|---|---|
| One isolate per instance (10 isolates × 1 tight instance) | 6.4 MB used per isolate | +10.3 MB per isolate. **2,500 → ~25 GB. No.** |
| One isolate, 50 tight instances (limit 256 MB) | 28.8 MB used / 44.3 MB total: 6.8 MB base (bundle + store + script) + 0.45 MB per instance | +122 MB for the whole run |
| One isolate, 50 default-bound instances | 41.2 MB used / 65.6 MB total (0.69 MB per instance) | +147 MB |
| One isolate, **1,000** tight instances (limit 512 MB, container 768 MB) | 393.5 MB used / 473.7 MB total (0.39-0.40 MB per instance) | +587 MB |

Per-instance heap is the same inside an isolate as in plain Node. The isolate itself costs
~2 MB (bundle) plus ~5 MB (store and script), and V8 runs at total ≈ 1.2-1.5 × used.
`gc()` is available inside isolates when Node runs with `--expose-gc`.

### 2b.5 Verdict

Budget: 768 MB minus ~200 MB for the app, feeds and SQLite leaves ~568 MB for the engine.
Measured end to end, 1,000 tight instances in one isolate cost **+587 MB RSS** (heap total 474 MB),
which is already over 568 MB. Process RSS per resident instance is ~0.55-0.6 MB once V8 headroom
and the isolate are counted (default bounds: ~0.85-0.9 MB).

- **Fits in 768 MB:** about **850-900** KyberSwing instances with tight bounds, or about **550-600** with the safer default bounds, leaving no GC headroom. Plan on ~800 / ~500.
- **2,500 does not fit.** It needs ~1.4-1.5 GB for the engine at tight bounds (~2.2 GB at default bounds), so a container of about **1.75 GB** (tight) or 2.5 GB (default), with 200 MB for the rest. Alternatively, cap the load at ~800 instances (for example 5 runs × 160 pairs, or fewer runs).
- **Pass time is fine** at those sizes: ~3.3 s for 2,500 instances in isolates on one Linux core, if the heap is not at its limit. Near the limit, GC triples the cost (3.9 ms per instance per bar at 1,000 in 512 MB). Give each isolate ~30% headroom.

**Recommendation.** Keep instances resident, with bounded history:
- **Use one isolate per run**, limit ≈ 1.3 × (7 MB + instances × 0.45 MB); for example, 500 tight instances → ~300 MB.
- **Size the bound per script:** keep = largest series history reference + margin, min ~50; daily keep likewise. Use our own static scan of `x[n]` indexes, fall back to a safe default (100 / 50) when lengths are dynamic, and reject `max_bars_back` above our cap.
- **Then choose one of:**
  - (a) give the container ~1.75 GB for 2,500;
  - (b) cap at ~800 instances in 768 MB;
  - (c) cut the fixed ~240 KB per instance, which is now the largest part.

  For (c), there are two levers. One is to share the daily `request.security` context between instances with the same script, inputs and symbol: the 5 runs on one pair could share one, saving ~120 KB each, but this is untested. The other is to patch PineTS so namespaces are built once per isolate, not per Context (a fork).
- Rebuild-per-pass (Task 2) stays the restart path. A warm start of 500 bars takes 75-120 ms per instance; with a lookback-sized window it would be faster.

## State persistence recommendation

*(Task 2 analysis below. Task 2b changed the recommendation to resident instances with bounded
history: see "Resident instances with bounded history". A restart then warm-starts each instance
once, on a window that covers its lookbacks and the oldest open trade.)*

**Do not serialise (not possible, Q4). Rebuild with a warm start, and do not keep thousands of
instances resident.**

The numbers (Q4) rule out the obvious design, "keep every instance live in memory and replay all
of them on restart". Holding 2,500 KyberSwing-sized instances at a correct window (3,000 bars)
needs ~25 GB, and a full restart rebuild takes ~14 min of one CPU.

**Recommended: a stateless rebuild per bar close.** On each 4h close, for each (run, pair):
1. Warm-start a fresh instance on the last W bars, with our broker answering from its persisted ledger. The broker view for bar i must be a pure function of our stored fills.
2. Take the order calls of the newest bar only, then discard the instance.

The costs:
- Restarts cost nothing extra.
- Memory is one instance (~10 MB) per worker at a time.
- CPU is ~0.33 s × 2,500 ≈ 14 min per 4h cycle on 1 CPU (~6% duty) at W = 3,000. That is well inside the 4h bar.

Paper fills use the next bar's real open, so computing signals a few minutes after the close
does not change fills. It does delay the moment we know about them.

Rules this needs:
- **W must cover the script's longest lookback, about 3x for EMAs.** 3,000 4h bars for KyberSwing; 1,000 bars is measurably wrong. Derive W per script from its declared lengths, or use a safe default such as 3,000-4,500 bars, and cap it.
- **W must start before the entry of the oldest open trade.** Scripts keep position-related `var` state (KyberSwing's `stopPx` is set on the entry bar). If the window starts after the entry, the rebuilt instance has `stopPx = na`, and its exit has no stop. Untested; Task 5 should test it.
- **Window results are "window-consistent", not identical to the full backtest.** Signals near the window start can differ (Q4 table). The backtest/replay uses the full history; live uses the window. Measure the divergence per script in Task 5.

Alternatives, with trade-offs:
- **Keep a subset resident** (an LRU of hot instances, stepped at ~3-14 ms/bar with HTF rebuild) and rebuild the rest. This needs memory per resident instance.
- **Full-history warm start** (8,008 bars, ~0.8 s each, ~34 min per cycle for 2,500): exact equality with the backtest, at 2.5x the CPU.
- **Fix PineTS's `updateTail` / trimming** (patch or fork) so resident instances stay small and cheap to step. More work, and it goes deeper into internals.

## Concerns

- AGPL-3.0-only: fine for a private app. If it is ever offered to others over a network, AGPL section 13 requires offering the source of the combined work.
- Probe-01 TV numbers are pending, and the KyberSwing chart symbol (perpetual vs spot) is unconfirmed.
- Bar-by-bar HTF needs our workaround, because PineTS's `updateTail` gives stale values.
- Order-argument normalisation is ours. Task 5 should unit-test it against PineTS's own parsed orders (forward mode makes that easy).
- The windowed rebuild's "open trade older than the window" case is untested (see the persistence rules).
- Task 2b's resident design depends on even more PineTS internals (listed in 2b.1). The equality tests in `tests/spike/resident.test.ts` are the canary.
- Stepping makes every bar the last bar: `barstate.islast/isrealtime` are true and `ishistory` is false on each one. A script that orders on those flags behaves like it does live on TradingView, not like its backtest.
- 15m charts and scripts with several `request.security` calls or other timeframes were not benchmarked.
