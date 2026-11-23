# Plan 1: Engine, Paper Broker and Replay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that a pasted Pine `strategy()` can be run through PineTS and paper-traded by our own broker with results that match TradingView. Deliver this as a replay CLI that passes acceptance tests 1–3.

**Architecture:**
- **TypeScript library code only.** There is no server, database or UI in this plan.
- **Data:** a recorder CLI saves Binance candles and funding to CSV.
- **Engine:** a PineTS adapter runs the script bar by bar, and a strategy layer turns Pine order calls into order intents.
- **Broker:** a pure, deterministic paper broker fills those orders, charges costs and owns the position. The script reads its position and equity from the broker.
- **Replay:** a replay CLI wires these together in TradingView mode or Binance mode.

**Tech Stack:** Node 24, TypeScript 5 (strict, ESM), `pinets@0.13.1` (pinned, AGPL-3.0, private use only), `isolated-vm` (probe only in this plan), vitest, tsx, eslint.

**Spec:** `docs/spec/v1-feature-spec.md` and `docs/superpowers/specs/2026-11-23-pineapple-scanner-design.md`. Read both. Where they disagree, the design doc wins.

**Later plans (not this one):**
- **Plan 2:** Binance live data layer, scanner loop, SQLite state and restart recovery (tests 4–5).
- **Plan 3:** login, wizard, dashboard, sandbox pool, Docker and hardening (test 6).

Both get written after Task 2's findings are approved.

## Global Constraints

- **Runtime:** Node 24. TypeScript `strict: true`, `"type": "module"`. Pin every dependency to an exact version (no `^`/`~`).
- **PineTS:** `pinets` stays at exactly `0.13.1` unless the owner approves a change.
- **Network access:**
  - Only `src/net/http.ts` may import `fetch`, `undici`, `ws`, `node:http`, `node:https` or `node:net`. An eslint `no-restricted-imports` / `no-restricted-globals` rule enforces this.
  - The outbound host allowlist is exactly `fapi.binance.com` and `fstream.binance.com`.
- **Exchange access:**
  - No exchange API keys, signed endpoints or order endpoints, anywhere.
  - No code path can place a real order.
- **Time and units:**
  - Times are UTC epoch milliseconds (`number`). Candles are keyed by `openTime`.
  - Money is a JS `number` in USDT. Round only for display and CSV output, to 8 dp for quantities and 2 dp for USD.
- **Default costs** (Binance USDT-M base tier): maker `0.0002`, taker `0.0005`, slippage `0.0002` (0.02%) per market fill.
- **Broker modes:**
  - **`tradingview`:** no lot rounding, no min notional, no funding, no liquidation. Commission and slippage come from the supplied TV properties.
  - **`binance`:** everything on.
- **Machine load:** Vitest uses `maxWorkers: 2`, since long jobs on this machine must stay around 40–45% CPU.

## Review Focus

1. **An order that rounds to zero.** If an order's quantity rounds down to 0 at the pair's lot step, the broker rejects it with `zero_qty_after_rounding` and opens no position. Test: Task 3, `rejects order that rounds to zero lots`.
2. **A stop gapped through at the bar open.** If a bar opens beyond a stop, the stop fills at the open (plus slippage), never at the stop price. Test: Task 3, `gapped stop fills at open`.
3. **A reversal.** If `strategy.entry` fires in the opposite direction while a position is open, the position is closed and reversed in one order (qty = new qty + |old qty|), and fees are charged on the whole fill. Test: Task 5, `opposite entry reverses position`.
4. **Funding at the same moment as an entry.** Funding is charged only on a position opened strictly before the funding time. A position opened at exactly the funding timestamp pays nothing for it. Test: Task 4, `no funding on position opened at funding time`.
5. **Missing candles in recorded data.** If recorded data has a gap, replay stops with an error listing the first missing `openTime`. It never silently skips the gap. Test: Task 1, `loadCandles throws on gap`.

---

## File Structure

```
Pineapple/
  package.json, tsconfig.json, vitest.config.ts, eslint.config.js, .gitignore
  src/core/types.ts          shared types (Candle, PairRules, OrderIntent, Fill, Position, ClosedTrade...)
  src/core/timeframe.ts      timeframe parsing and bar math
  src/net/http.ts            the only outbound HTTP; host allowlist
  src/data/binance-rest.ts   klines + funding history fetch (public endpoints)
  src/data/csv.ts            candle/funding CSV read/write with gap check
  src/broker/costs.ts        fee, slippage, rounding helpers
  src/broker/margin.ts       leverage, margin, maintenance, liquidation price
  src/broker/broker.ts       PaperBroker
  src/engine/strategy-layer.ts  Pine order semantics → OrderIntents, broker → script state
  src/engine/pine-runner.ts  PineTS adapter (compile, validate, per-bar step)
  src/engine/replay.ts       replay loop (shared later by the live scanner)
  src/report/summary.ts      TradingView-style summary numbers
  src/cli/record.ts, src/cli/replay.ts
  spike/probes/*.pine, spike/probe.ts
  docs/spike/pinets-findings.md
  tests/** mirroring src/**, tests/acceptance/*.test.ts, tests/fixtures/*
```

---

### Task 1: Scaffold, outbound allowlist, candle recorder

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore` (ignore `node_modules`, `data/`, `.env`)
- Create: `src/core/types.ts`, `src/core/timeframe.ts`, `src/net/http.ts`, `src/data/binance-rest.ts`, `src/data/csv.ts`, `src/cli/record.ts`
- Test: `tests/net/http.test.ts`, `tests/core/timeframe.test.ts`, `tests/data/csv.test.ts`, `tests/lint/restricted-imports.test.ts`

**Interfaces:**
- Produces (in `src/core/types.ts`):
  - `Candle { openTime: number; open: number; high: number; low: number; close: number; volume: number }`
  - `FundingEvent { time: number; rate: number; markPrice: number }`
  - `Timeframe = '15m'|'30m'|'1h'|'2h'|'4h'|'6h'|'8h'|'12h'|'1d'`
- Produces (functions):
  - `tfToMs(tf: Timeframe): number`
  - `barOpenFor(time: number, tf: Timeframe): number`
  - `httpGetJson<T>(url: string, opts?: { timeoutMs?: number }): Promise<T>` throws `EgressBlockedError` for hosts not on the allowlist
  - `fetchKlines(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]>` uses `/fapi/v1/klines`, 1500 per page, pages until `toMs`, sleeps ≥250 ms between pages, returns closed candles only
  - `fetchFundingHistory(symbol: string, fromMs: number, toMs: number): Promise<FundingEvent[]>` uses `/fapi/v1/fundingRate`, 1000 per page; `markPrice` from the response field
  - `writeCandles(path, Candle[])`, `loadCandles(path, tf): Candle[]` throws `DataGapError(firstMissingOpenTime)` on a gap
  - `writeFunding(path, FundingEvent[])`, `loadFunding(path): FundingEvent[]`
  - CLI: `npx tsx src/cli/record.ts --symbol BTCUSDT --tf 4h --from 2019-09-08 --to 2026-11-18` writes `data/BTCUSDT_4h.csv` and `data/BTCUSDT_funding.csv`

- [ ] **Step 1: Write failing tests**
  - `httpGetJson rejects non-allowlisted host`: `await expect(httpGetJson('https://example.com/x')).rejects.toBeInstanceOf(EgressBlockedError)`. The call must throw before any socket opens. Spy on `globalThis.fetch` and expect zero calls.
  - `httpGetJson allows fapi.binance.com`: use a mocked `fetch` and expect one call.
  - `tfToMs('15m') === 900_000`, `tfToMs('4h') === 14_400_000`, `tfToMs('1d') === 86_400_000`.
  - `barOpenFor(Date.UTC(2024,0,1,5,30), '4h') === Date.UTC(2024,0,1,4)`.
  - `csv round-trips candles exactly`.
  - `loadCandles throws on gap`: a 4h CSV missing the 08:00 bar throws `DataGapError` with `firstMissing === Date.UTC(2024,0,1,8)`.
  - `restricted imports`: run eslint on a fixture file under `src/` that imports `node:https` and expect an error. The same import inside `src/net/http.ts` must pass.
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run tests/net tests/core tests/data tests/lint`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement the files above.** Use the global `fetch` inside `src/net/http.ts` only. The allowlist check parses the URL with `new URL()` and compares `hostname` exactly.
- [ ] **Step 4: Run to verify they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Record real data.** Run the record CLI above. Expected: `data/BTCUSDT_4h.csv` holds roughly 7,000+ rows and `loadCandles` on it does not throw. Copy the slice Jan 1, 2024 – Nov 18, 2026, plus 1 year of warm-up before it, to `tests/fixtures/BTCUSDT_4h.csv`, together with the matching funding file. This data is committed so the tests don't need the network.
- [ ] **Step 6: Commit.** `git commit -m "feat: scaffold, egress allowlist, Binance candle recorder"`

---

### Task 2: PineTS spike and probe (GATE)

**Files:**
- Create: `spike/probes/01-ma-cross.pine`, `02-exit-brackets.pine`, `03-pyramiding.pine`, `04-equity-sizing.pine`, `05-mtf-daily.pine`, `06-indicator.pine`, `07-unsupported.pine`
- Create: `spike/probe.ts`, `docs/spike/pinets-findings.md`
- Test: `tests/spike/probe.test.ts`

**Purpose:** Find out, with evidence, how PineTS exposes strategy behaviour. The answers below decide how Tasks 5–6 hook into PineTS. Each probe is a small Pine v6 strategy run on `tests/fixtures/BTCUSDT_4h.csv` through `new PineTS(candles)`.

The findings doc must answer each of these with a yes/no and a code snippet:
1. **Order calls.** Can we see each `strategy.entry` / `strategy.exit` / `strategy.close` / `strategy.order` / `strategy.cancel` call, with its arguments, per bar? This could be a hook, an overridable namespace, or the emulator's order list.
2. **Broker state.** Can we replace or feed what the script reads back (`strategy.position_size`, `strategy.position_avg_price`, `strategy.equity`, `strategy.opentrades`, `strategy.netprofit`) from our broker?
3. **Bar-by-bar running.** Can a script run one bar at a time with state kept between calls? This could use `stream()` with appended bars, or pagination. Measure µs per bar for probe 01 over 1,000 bars.
4. **Saving state.** Can that per-bar state be serialised and restored? If not, how long does a 1,000-bar replay rebuild take?
5. **Higher timeframes.** Does `request.security(syminfo.tickerid, "D", close[1], lookahead=barmerge.lookahead_on)` and the default-lookahead form give TradingView's non-repainting values when only 4h candles are supplied? How are daily candles derived or supplied?
6. **Validation.** Do compile errors and unsupported-function errors give line numbers (probe 07)? Is the declaration kind (`strategy`/`indicator`/`library`) and its arguments readable (probe 06)?
7. **Sandboxing.** Does the PineTS bundle load and run probe 01 inside an `isolated-vm` isolate (no Node APIs; candles passed in as a copied array)? Record the isolate heap used.
8. **PineTS's own results.** Compare the emulator's closed trades for probe 01 with TradingView. The owner supplies TradingView numbers for probe 01 (see Step 4).

- [ ] **Step 1: Write `tests/spike/probe.test.ts`.** Make one `it` per question. Each asserts the capability it found. For example, `it('exposes order calls per bar')` expects at least 1 captured `entry` call with `{ id, direction, qty }`. Unknowns start as `it.todo`.
- [ ] **Step 2: Run it.** Run `npx vitest run tests/spike`. Expected: FAIL / todo.
- [ ] **Step 3: Read PineTS source and docs, then write `spike/probe.ts`.** Sources are `node_modules/pinets/dist`, `types/`, and docs.luxalgo.com/developers/pinets (api-coverage, architecture, pagination). Make the tests pass for whatever PineTS actually supports. Turn unsupported items into `it.fails` with a comment, never delete them.
- [ ] **Step 4: Ask the owner for TradingView reference numbers.** Ask for TradingView strategy-tester numbers for `01-ma-cross.pine` on `BINANCE:BTCUSDT.P` 4h, Jan 1 2024 – Nov 18 2026, with the Properties written at the top of the probe file: initial capital 10000, order size 100% of equity, commission 0.05%, slippage 0, pyramiding 0, no bar magnifier. Store them in `tests/fixtures/tv-reference.json` as `{ "ma-cross": { trades, winRatePct, profitFactor, netProfitPct } }`.
- [ ] **Step 5: Write `docs/spike/pinets-findings.md`.** Give an answer per question, a recommended hook design for Task 5, and a recommendation on state persistence (serialise or replay). If question 1 or 2 is "no", the doc must list the options: patch/fork PineTS, wrap its emulator, or another runtime.
- [ ] **Step 6: Commit.** `git commit -m "spike: PineTS capability probe and findings"`
- [ ] **Step 7: STOP. Hand the findings to the owner.** Do not start Task 5 until the owner approves the hook design. Tasks 3–4 don't depend on PineTS and may proceed meanwhile.

---

### Task 3: Paper broker: orders, fills, costs

**Files:**
- Create: `src/broker/costs.ts`, `src/broker/broker.ts`
- Modify: `src/core/types.ts` (add broker types)
- Test: `tests/broker/costs.test.ts`, `tests/broker/fills.test.ts`

**Interfaces:**
- Produces (types):
  - `PairRules { symbol: string; tickSize: number; stepSize: number; minNotional: number; maxLeverage: number; leverageEstimated: boolean; brackets: MaintBracket[] }`
  - `MaintBracket { notionalCap: number; maintMarginRate: number; maintAmount: number }`
  - `FeeConfig { makerRate: number; takerRate: number; slippagePct: number }` and `DEFAULT_FEES`
  - `BrokerMode = 'tradingview' | 'binance'`
  - `SizingRule = { kind: 'script' } | { kind: 'fixed'; notionalUsd: number }`, where `notionalUsd` is position size, not margin
  - `OrderIntent { id: string; symbol: string; side: 'buy'|'sell'; type: 'market'|'limit'|'stop'|'stop_limit'; qty: number; limitPrice?: number; stopPrice?: number; reduceOnly: boolean; ocaGroup?: string; ocaType?: 'cancel'|'reduce'; tag: 'entry'|'exit'; entryId?: string; leverage: number }`
  - `SubmitResult = { accepted: true } | { accepted: false; reason: 'no_free_balance'|'below_min_notional'|'zero_qty_after_rounding' }`
  - `Fill { orderId: string; symbol: string; time: number; price: number; qty: number; side: 'buy'|'sell'; fee: number; liquidity: 'maker'|'taker' }`
  - `Position { symbol: string; qty: number /* signed */; entryPrice: number; leverage: number; margin: number; openTime: number }`
  - `ClosedTrade { symbol; side: 'long'|'short'; entryTime; entryPrice; exitTime; exitPrice; qty; pnl; fees; funding; exitReason: 'signal'|'stop'|'target'|'liquidation'|'delisting' }`
  - `AccountView { balance; equity; usedMargin; freeMargin; feesPaid; fundingNet }`
- Produces (`class PaperBroker`):
  - `constructor(o: { startingBalance: number; fees: FeeConfig; mode: BrokerMode; rules: (s: string) => PairRules; sizing: SizingRule })`
  - `submit(i: OrderIntent, now: number): SubmitResult`
  - `cancel(orderId: string): void`
  - `onBarOpen(symbol: string, bar: Candle): Fill[]` fills pending market orders at `bar.open` ± slippage
  - `onBarRange(symbol: string, bar: Candle): Fill[]` triggers stop/limit orders on the bar's path (replay)
  - `onPrice(symbol: string, price: number, time: number): Fill[]` (live; Plan 2)
  - `markToMarket(symbol: string, price: number): void`
  - `position(symbol): Position | null`, `account(): AccountView`, `closedTrades(): ClosedTrade[]`, `openOrders(symbol?): OrderIntent[]`
  - `snapshot(): BrokerState` and `static restore(s: BrokerState, o): PaperBroker` (state is JSON-serialisable)

**Rules the tests pin:**
- **Market fills:**
  - Price: buy `price × (1 + slippagePct)`, sell `price × (1 − slippagePct)`.
  - In `binance` mode the price rounds to `tickSize`: buys up, sells down.
  - Market and stop fills are taker. Limit fills are maker.
- **Quantity:**
  - `binance` mode: floor to `stepSize`.
  - Fixed sizing: qty = `notionalUsd / referencePrice` before rounding, where referencePrice is the last close.
- **Fees:** `fee = |qty| × fillPrice × rate`, deducted from balance on every fill.
- **Margin required:** `|qty| × price / leverage`. The order is rejected with `no_free_balance` if that plus the entry fee is more than `freeMargin`. Reduce-only orders are never rejected for margin.
- **Intrabar path** (`onBarRange`, TradingView's assumption): if `|high − open| < |open − low|` the path is open→high→low→close, otherwise open→low→high→close. Stops and limits trigger in path order. One OCA group fills at most once per bar.
- **Gapped stops:** if `bar.open` is already beyond a stop, it fills at `bar.open` ± slippage.

- [ ] **Step 1: Write failing tests** with these exact values. Use rules `BTCUSDT` with tick 0.1, step 0.001, minNotional 100 and maxLeverage 125, starting balance 10,000 and `DEFAULT_FEES`:
  - `market buy fills at next open plus slippage`: submit buy 0.1, `onBarOpen` open 50000. Fill price `50010`, fee `0.1×50010×0.0005 = 2.5005`, balance `9997.4995`.
  - `rejects order that rounds to zero lots`: qty 0.0004 gives `{accepted:false, reason:'zero_qty_after_rounding'}` and no position.
  - `rejects below min notional`: qty 0.001 at 50000 (notional 50) gives `below_min_notional`.
  - `rejects when margin exceeds free balance`: leverage 1, qty 1 at 50000 gives `no_free_balance`.
  - `tradingview mode skips lot rounding and min notional`: qty 0.0004 is accepted.
  - `gapped stop fills at open`: long 0.1 @50000, stop sell at 49000, next bar opens at 48000. Fill `48000×(1−0.0002)=47990.4`, exitReason `'stop'`.
  - `intrabar path picks stop before limit when low is nearer open`.
  - `OCA cancels sibling on fill`.
  - `snapshot/restore round-trips to identical account()`.
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run tests/broker`. Expected: FAIL.
- [ ] **Step 3: Implement `src/broker/costs.ts` then `src/broker/broker.ts`** to the interfaces above. Leave liquidation and funding to Task 4. Add a `TODO(Task 4)` only at those two call sites.
- [ ] **Step 4: Run to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: paper broker fills, costs and pair rules"`

---

### Task 4: Paper broker: margin, liquidation, funding

**Files:**
- Create: `src/broker/margin.ts`
- Modify: `src/broker/broker.ts`
- Test: `tests/broker/margin.test.ts`, `tests/broker/funding.test.ts`

**Interfaces:**
- Consumes: `PaperBroker`, `PairRules`, `MaintBracket` (Task 3).
- Produces:
  - `leverageInForce(scriptMarginPct: number | undefined, maxLeverage: number): number` returns `min(100 / (scriptMarginPct ?? 100), maxLeverage)`, never below 1
  - `maintenance(notional: number, brackets: MaintBracket[]): { rate: number; amount: number }`
  - `liquidationPrice(p: { side: 1|-1; qty: number; entryPrice: number; isolatedMargin: number; mmr: number; maintAmount: number }): number`
  - `PaperBroker.onMark(symbol: string, mark: number, time: number): Fill[]` (liquidations, `binance` mode only)
  - `PaperBroker.applyFunding(symbol: string, ev: FundingEvent): number` returns the signed balance change, 0 if no position or `tradingview` mode

**Formulas:**
- **Liquidation price** (Binance isolated, single position): `LP = (WB − side·qty·EP + maintAmount) / (qty·mmr − side·qty)`, where `WB` is the isolated margin and `qty` is absolute.
- **Liquidation trigger:** liquidate when `mark` crosses `LP`. The trade closes at `LP` with exitReason `'liquidation'`. The margin left after the loss at `LP` (the maintenance part) is forfeited as a clearance fee, so the trade's `pnl` equals `−isolatedMargin`.
- **Funding:** `change = −signedQty × ev.markPrice × ev.rate`. A long pays when the rate is positive. The change is applied to balance and recorded on the open trade's `funding`. The position must have `openTime < ev.time`.

- [ ] **Step 1: Write failing tests:**
  - `leverageInForce(undefined, 125) === 1`, `leverageInForce(10, 125) === 10`, `leverageInForce(1, 20) === 20`.
  - `liquidation price long 10x`: qty 1, EP 50000, WB 5000, mmr 0.004, amount 0 gives `LP ≈ 45180.72` (to 2 dp).
  - `liquidates on mark cross and books full margin loss`.
  - `long pays positive funding`: long 0.1, mark 50000, rate 0.0001 gives change `−0.5`.
  - `short receives positive funding`: same values give `+0.5`.
  - `no funding on position opened at funding time`: `openTime === ev.time` gives 0.
  - `tradingview mode ignores funding and liquidation`.
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run tests/broker`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** `margin.ts` and wire it into `broker.ts`. Margin used per position = `notional / leverageInForce(...)`.
- [ ] **Step 4: Run to verify they pass.** Run `npx vitest run tests/broker`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: isolated margin, liquidation and funding"`

---

### Task 5: Strategy layer and PineTS runner

*Start only after the owner approves `docs/spike/pinets-findings.md`. If the approved hook design contradicts an interface below, update this task in the plan first, then build.*

**Files:**
- Create: `src/engine/strategy-layer.ts`, `src/engine/pine-runner.ts`
- Test: `tests/engine/strategy-layer.test.ts`, `tests/engine/pine-runner.test.ts`

**Interfaces:**
- Consumes: `PaperBroker` (Tasks 3–4), the findings hook design (Task 2).
- Produces:
  - `type PineOrderCall = { kind: 'entry'|'exit'|'close'|'close_all'|'order'|'cancel'|'cancel_all'; id: string; direction?: 'long'|'short'; qty?: number; qtyPercent?: number; limit?: number; stop?: number; fromEntry?: string; profitTicks?: number; lossTicks?: number; ocaName?: string; ocaType?: 'cancel'|'reduce'|'none' }`
  - `StrategyDeclaration { title: string; pyramiding: number; marginLong?: number; marginShort?: number; closeEntriesRule: 'FIFO'|'ANY'; defaultQtyType: 'fixed'|'cash'|'percent_of_equity'; defaultQtyValue: number; overridden: { initialCapital?: number; commission?: number; slippage?: number } }`
  - `compileScript(source: string): { ok: true; declaration: StrategyDeclaration } | { ok: false; errors: { line: number; message: string }[] }`. It rejects `indicator()`/`library()` with the message `v1 runs strategy() scripts only.`
  - `class StrategyLayer`:
    - `constructor(decl: StrategyDeclaration, broker: PaperBroker, symbol: string, sizing: SizingRule)`
    - `toIntents(calls: PineOrderCall[], bar: Candle): OrderIntent[]` (pyramiding, reversal, brackets/OCA, FIFO exits, qty from `defaultQty*` against broker equity)
    - `scriptView(): ScriptView`, where `ScriptView = { positionSize: number; positionAvgPrice: number; equity: number; openTrades: number; netProfit: number }`
  - `runStrategy(o: { source: string; symbol: string; tf: Timeframe; candles: Candle[]; syminfo: { mintick: number; qtyStep: number }; hooks: BarHooks }): Promise<void>`, where `BarHooks = { before(bar: Candle, idx: number): ScriptView; after(bar: Candle, idx: number, calls: PineOrderCall[]): void }`. This is the full-history driver Task 6's replay uses. Live stepping with bounded history (spike Task 2b) belongs to Plan 2. Build nothing for it here beyond keeping the hook code reusable.
  - `ScriptView` also carries `opentrades` details: `{ size; entryPrice; entryId; entryBarIndex; entryTime; profit }[]`, plus `openProfit`.

**Hook design (approved, from `docs/spike/pinets-findings.md`, section "Recommended hook design for Task 5"; read it first):**
- **Compile and wrap.** Compile with `new Indicator(src).prepare()`, then wrap `prepared.fn` and keep `_pineVersion` and `_ltfSlices` on the wrapper.
- **Each bar:**
  - Skip secondary contexts.
  - Call `hooks.before` and feed its view through replaced getters: `position_size`, `position_avg_price`, `equity`, `netprofit`, `openprofit`, `opentrades`.
  - Run the original.
  - Pass the captured calls (`entry`, `exit`, `close`, `close_all`, `order`, `cancel`, `cancel_all`, normalised to Pine v6 signatures) to `hooks.after`. Never forward them to PineTS's emulator.
- **Data comes from an in-memory provider.**
  - `syminfo` carries the pair's mintick and qty step.
  - Daily and other higher-timeframe candles are built from the stored candles.
  - Never use `Provider.Binance` or a network import resolver.
- **Move the spike code into `src/engine/`.** Take the hook core (`spike/hook-core.ts`, `normaliseOrderArgs`) and keep a single source. The spike may then import from `src/engine/`.

**Validation (`compileScript`) rejects, each with a clear message:**
- `indicator()` / `library()`;
- `calc_on_order_fills = true`;
- any `strategy.*` read-back the view doesn't feed, such as `closedtrades.*`, `wintrades`, `grossprofit`, `max_drawdown` or `position_entry_name`. Message: `strategy.<name> is not supported in v1`.

Unknown functions only fail when the script runs. So `compileScript` also runs the script on 300 bars of fixture candles with a flat view and reports runtime errors; use the Pine line where PineTS gives one, otherwise line 0.

**Controller rulings carried in:**
- **Margin to leverage.**
  - The layer passes `leverageInForce(marginPct, rules.maxLeverage)` into each intent.
  - A declared `margin_long` / `margin_short` of `0` (no margin checking in Pine) maps to `rules.maxLeverage`.
- **Exit orders belong to the strategy layer.** A `strategy.exit` tied to a `from_entry` that hasn't filled yet stays pending in the layer. It is submitted to the broker only once that entry has filled, so the broker's purge of orphan exits can't drop it.
- **Warm-up is flat.** For bars before `from`, `before` returns a flat view with the starting equity, and `after` discards the calls.

- [ ] **Step 1: Write failing tests:**
  - `opposite entry reverses position`: long 1, then `entry('S', short, qty 1)` gives one sell intent of qty 2.
  - `pyramiding 0 ignores second same-direction entry`.
  - `pyramiding 2 allows two entries, blocks the third`.
  - `exit with stop+limit creates reduce-only OCA pair tied to fromEntry`.
  - `percent_of_equity sizes from broker equity`: equity 10000, 50%, close 50000 gives qty 0.1.
  - `fixed sizing rule overrides script qty`: `notionalUsd` 200 at 50000 gives qty 0.004.
  - `rejected entry leaves scriptView flat`.
  - `compileScript rejects indicator with exact message`.
  - `compileScript reports unsupported function with line number` (probe 07).
  - `warm-up orders are discarded`.
  - `pending exit survives until its entry fills`: a limit entry with a stop and take-profit exit. Price touches the take-profit first, then a later bar fills the entry, and the exit is live at the broker.
  - `margin 0 maps to pair max leverage`.
  - `compileScript rejects unfed read-back`: a script reading `strategy.wintrades` gets the exact message.
  - `compileScript rejects calc_on_order_fills`.
  - `runStrategy hooks match spike capture`: KyberSwing on the fixture with PineTS's own fills replayed as the view (spike `recordEmulatorViews`) gives order calls equal to the spike's recorded calls.
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run tests/engine`. Expected: FAIL.
- [ ] **Step 3: Implement** both files using the approved hook design.
- [ ] **Step 4: Run to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: Pine strategy layer and PineTS runner"`

---

### Task 6: Replay loop, summary and replay CLI

**Files:**
- Create: `src/engine/replay.ts`, `src/report/summary.ts`, `src/cli/replay.ts`
- Test: `tests/engine/replay.test.ts`, `tests/report/summary.test.ts`

**Interfaces:**
- Consumes: `runStrategy` and `BarHooks`, `StrategyLayer`, `PaperBroker`, `loadCandles`, `loadFunding`.
- Produces:
  - `TvProperties { initialCapital: number; commissionPct: number; slippageTicks: number }`
  - `replay(o: { source: string; symbol: string; tf: Timeframe; candles: Candle[]; funding: FundingEvent[]; from: number; to: number; mode: BrokerMode; tv?: TvProperties; rules: PairRules; fees?: FeeConfig; startingBalance: number; sizing: SizingRule }): Promise<{ trades: ClosedTrade[]; equityCurve: { time: number; equity: number }[]; summary: Summary }>`
  - `Summary { tradeCount; winRatePct; profitFactor; avgWin; avgLoss; biggestWin; biggestLoss; maxDrawdownPct; netProfit; netProfitPct }` from `summarize(trades, startingBalance, equityCurve)`. Win = `pnl > 0`. Profit factor = gross profit / |gross loss| (`Infinity` if no losses).
  - CLI: `npx tsx src/cli/replay.ts --script <file> --symbol BTCUSDT --tf 4h --from 2024-01-01 --to 2026-11-18 --mode tradingview --tv '{"initialCapital":10000,"commissionPct":0.05,"slippageTicks":0}'` prints the summary table and writes `results/<name>-trades.csv`.

**Order of events for each bar `b` in [from, to] (spec: fill at the next bar's open):**
Inside `hooks.before(b)`:
1. `broker.onBarOpen(b)`
2. Apply funding events with `b.openTime ≤ t < b.openTime + tf`. When `markPrice` is 0, the broker substitutes the last price.
3. `binance` mode only: `broker.onMark` at the bar's adverse extreme (low for a long, high for a short), applied in path order with `onBarRange`. Liquidation wins only if the liquidation price is reached before the stop on the intrabar path (`|H−O| < |O−L|` → O→H→L→C, else O→L→H→C).
4. `broker.onBarRange(b)`
5. `broker.markToMarket(b.close)`
6. Return `layer.scriptView()`.

Inside `hooks.after(b, calls)`:
1. `layer.toIntents(calls, b)`
2. `broker.submit` each intent, logging rejections.

Bars before `from` are warm-up (flat view, calls discarded). Slippage in `tradingview` mode is `slippageTicks × mintick` per market fill.

- [ ] **Step 1: Write failing tests:**
  - `summary of known trades`: pnls `[100, −50, 200, −25]` give winRate 50, PF `300/75 = 4`, biggestWin 200, biggestLoss −25.
  - `max drawdown from equity curve`: `[10000, 11000, 9900, 12000]` gives `10`.
  - `replay fills signal at next open`: with probe 01 on fixture data, the first trade's `entryTime` equals the openTime of the bar after the signal bar.
  - `replay throws DataGapError on gapped fixture`.
- [ ] **Step 2: Run to verify they fail.** Run `npx vitest run tests/engine/replay.test.ts tests/report`. Expected: FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: replay loop, summary and replay CLI"`

---

### Task 7: Acceptance tests 1–3

**Files:**
- Create: `tests/acceptance/tv-parity.test.ts`, `tests/acceptance/mtf.test.ts`, `tests/acceptance/costs-exact.test.ts`
- Create: `tests/fixtures/BTCUSDT_4h_week.csv`, `tests/fixtures/BTCUSDT_funding_week.csv`, `tests/fixtures/hand-calc.md`

**Interfaces:**
- Consumes: `replay`, `summarize`, `tests/fixtures/tv-reference.json` (Task 2).

- [ ] **Step 1: Write `tv-parity.test.ts`.**
  - For every entry in `tv-reference.json`, replay its script in `tradingview` mode and assert:
    - |trades − ref| ≤ 3
    - |winRatePct − ref| ≤ 3
    - |profitFactor − ref| ≤ 0.15
    - |netProfitPct − ref| ≤ 3
  - The `kyber-swing` entry (`trades 58, winRatePct 32.8, profitFactor 1.71, netProfitPct 22.6`, script `tests/fixtures/KyberSwing.pine`) is a required test. The owner supplied it, and its Properties come from its own declaration: capital 10000, commission 0.05%, slippage 2 ticks, margin 20. `ma-cross` stays `it.skipIf(ref === null)`.
- [ ] **Step 2: Write `mtf.test.ts`** with probe 05:
  - The daily regime the script sees on every 4h bar equals the regime computed by hand from the previous closed daily candle (daily candles built from the 4h fixture).
  - No 4h bar ever sees the current day's unclosed daily close.
- [ ] **Step 3: Write `costs-exact.test.ts`.** Record one week of real data, Nov 10–17 2026, holding exactly one long and covering at least 3 funding events. Write the hand calculation in `hand-calc.md`: fill prices with slippage, both fees, each funding payment and net P&L. Assert the replay in `binance` mode matches each figure to the cent: `toBeCloseTo(x, 2)`.
- [ ] **Step 4: Run them.** Run `npx vitest run tests/acceptance`. Expected: all PASS (KyberSwing skipped until provided). If parity fails, use superpowers:systematic-debugging. Don't loosen tolerances without the owner.
- [ ] **Step 5: Run everything.** Run `npx vitest run && npx eslint . && npx tsc --noEmit`. Expected: clean.
- [ ] **Step 6: Commit and push.** `git commit -m "test: acceptance tests 1-3"`, then `git push`.
