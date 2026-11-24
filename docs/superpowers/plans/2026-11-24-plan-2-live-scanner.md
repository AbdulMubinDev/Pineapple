# Plan 2: Live Data, Scanner, Saved State and Restart Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a pasted Pine strategy forward on every active Binance USDT-M perpetual, live, from a headless CLI. Each run has one shared paper account, its state is saved to SQLite after every candle pass, and it recovers after a restart with no lost or duplicated trades. Plan 2 passes acceptance tests 4 (scale) and 5 (restart).

**Architecture:**
- **Data in.** An `ExchangeClient` interface is implemented twice:
  - `BinanceClient` uses public REST plus one combined WebSocket.
  - `FakeExchange` serves recorded candles for the tests.
- **Data held.** A candle store and run state live in SQLite (`node:sqlite`).
- **Execution.** Each run holds:
  - one `PaperBroker`, shared by every pair;
  - one `StrategyLayer` per pair;
  - one resident PineTS instance per pair, with history trimmed to a bound (from spike Task 2b).
- **The pass.** At every candle close, the scanner steps every pair in order of 24-hour volume, highest first. It uses Plan 1's `barHooks` per pair, so live trading follows the same event order as replay. The whole pass then commits in one SQLite transaction.

**Tech Stack:** Node 24, TypeScript strict ESM, `pinets@0.13.1`, `node:sqlite` (built in, no native dependency), Node's global `WebSocket`, vitest. No new npm dependencies unless a step says so.

**Spec:** read all of these:
- `docs/spec/v1-feature-spec.md`
- `docs/superpowers/specs/2026-11-23-pineapple-scanner-design.md` (wins on conflicts)
- `docs/superpowers/plans/plan-2-3-carry-notes.md`: its "Plan 2" items are requirements of this plan
- `docs/spike/pinets-findings.md`, sections 2b.1–2b.7 (resident instances)

## Global Constraints

- **Toolchain.** Node 24, TS `strict`, ESM, exact-pinned dependencies, and `pinets` exactly `0.13.1`.
- **Network.**
  - Only files under `src/net/` may use the network. Extend the eslint override from `src/net/http.ts` to `src/net/**`, and nothing else.
  - The outbound allowlist stays exactly `fapi.binance.com` (https) and `fstream.binance.com` (wss).
  - Public endpoints only. No API keys, no signed endpoints, no order endpoints.
- **Rate-limit budget.**
  - REST weight must stay at or below **50% of Binance's 2400/min limit** (1200/min). Read `X-MBX-USED-WEIGHT-1M` from every response.
  - On HTTP 429, back off as `Retry-After` says (default 60 s).
  - On HTTP 418, stop all REST for `Retry-After` and raise a scanner warning.
- **Universe.** Every contract with `contractType === 'PERPETUAL'`, `status === 'TRADING'`, `quoteAsset === 'USDT'` and `underlyingType === 'COIN'`. Rebuild it every **hour**.
- **Warm-up.** 3,000 chart bars per pair. Each higher timeframe the script requests gets 1,000 bars of its own, fetched natively. A pair with fewer chart bars than the script's required history is "insufficient history": it is skipped and never errors.
- **Pass deadline.** A full pass must finish within **10 s** of the candle close, with no rate-limit errors.
- **Exactly once.** Each candle is processed once per pair per run. The key is `processed_candles(run_id, symbol, open_time)`. A pass commits broker state, layer states, trades, equity and those keys in **one** transaction.
- **Run limit.** `RUN_LIMIT = max(1, floor((MEM_LIMIT_MB − 125) / 512))`. It defaults to 1 at 768 MB (owner decision). Read `MEM_LIMIT_MB` from the environment, default 768.
- **Pair rules without a public leverage source.** `maxLeverage` is **20** with `leverageEstimated: true`. Brackets are a single tier, `{ notionalCap: Infinity, maintMarginRate: 0.01, maintAmount: 0 }`, flagged `bracketsEstimated: true`.
- **Time and money.** Times are UTC epoch ms. Money is JS numbers, rounded only for display.
- **Machine load.** Keep CPU moderate (shared machine). Docker benches run one at a time with `--cpus 1 --memory 768m`.

## Review Focus

1. **The WebSocket stalls silently** (connected, but no messages). The feed flags it stale when no closed kline for the chart timeframe arrives within `tf + 30 s` of a close. It then reconnects, fills the gap from REST, shows a warning until it has caught up, and never skips or repeats a bar. Test in Task 3, `stale socket reconnects and backfills the gap`.
2. **Binance repeats a final kline** (a resend, or a replay after reconnect). It is processed exactly once. Test in Task 6, `duplicate closed kline is ignored`.
3. **A pair is delisted while a position is open.** The position closes at the last price with exitReason `'delisting'` and a log note, and the pair leaves the universe. Test in Task 7, `delisted pair closes its position`.
4. **REST returns 429 or 418 during warm-up.** The client backs off for `Retry-After`, the budget is never exceeded, and warm-up resumes where it stopped. Test in Task 2, `429 backs off and resumes`.
5. **A new listing has less history than the warm-up.** It shows as `insufficient_history` and joins automatically once it has enough bars. Test in Task 7, `new listing joins when history suffices`.

---

## File Structure

```
src/net/http.ts            (modify) + httpGet() returning { status, headers, body } for weight/backoff
src/net/ws.ts              WebSocket wrapper: open, message, close, heartbeat, allowlist
src/exchange/client.ts     ExchangeClient interface + shared types (PairInfo, Ticker, MarkUpdate, ...)
src/exchange/binance.ts    BinanceClient (REST + combined streams), RestBudget
src/exchange/universe.ts   buildUniverse(exchangeInfo) and rules extraction
src/exchange/fake.ts       FakeExchange for tests (recorded candles, scripted events)
src/store/db.ts            openDb(path), schema + migrations (node:sqlite, WAL)
src/store/candles.ts       CandleRepo (upsert, range, latest), FundingRepo
src/store/runs.ts          RunRepo: runs, settings history, run state, trades, equity, logs, processed keys
src/exchange/history.ts    loadHistory(): warm-up and gap fill through the budget
src/exchange/live-feed.ts  LiveFeed: closed klines, last prices, marks, staleness, reconnect + backfill
src/exchange/funding.ts    FundingTracker: next funding times, settled rates after each time
src/engine/layer-state.ts  StrategyLayer snapshot/restore (+ carry-note fixes in strategy-layer.ts)
src/engine/resident.ts     ResidentStrategy (production version of spike/resident.ts) + bounds
src/scanner/run.ts         ScannerRun: one run, its pairs, passes, live prices, status
src/scanner/manager.ts     RunManager: runs, run limit, shared feeds, pause/resume/stop, settings edits
src/scanner/recovery.ts    catchUp(): replay missed candles through the same pass
src/cli/scan.ts            headless CLI: start / list / status / pause / resume / stop
tests/** mirroring src/**, tests/acceptance/scale.test.ts, tests/acceptance/restart.test.ts
```

---

### Task 1: Exchange client, universe and pair rules

**Files:**
- Create: `src/exchange/client.ts`, `src/exchange/universe.ts`, `src/exchange/binance.ts` (REST part only)
- Modify: `src/net/http.ts`, `eslint.config.js`
- Test: `tests/exchange/universe.test.ts`, `tests/net/http-meta.test.ts`
- Fixture: `tests/fixtures/exchangeInfo.json`. Record one real response with a small one-off script, trimmed to about 30 symbols that cover every filter case.

**Interfaces:**
- Produces (`src/net/http.ts`): `httpGet(url: string, opts?: { timeoutMs?: number }): Promise<{ status: number; headers: Headers; body: unknown }>`. It uses the same allowlist and `redirect: 'error'`. `httpGetJson` stays for existing callers.
- Produces (`src/exchange/client.ts`):
  - `PairInfo { symbol: string; rules: PairRules & { bracketsEstimated: boolean }; onboardDate: number }`
  - `Ticker24h { symbol: string; quoteVolume: number; lastPrice: number }`
  - `MarkUpdate { symbol: string; markPrice: number; fundingRate: number; nextFundingTime: number; time: number }`
  - `interface ExchangeClient`:
    - `pairs(): Promise<PairInfo[]>`
    - `tickers24h(): Promise<Ticker24h[]>`
    - `klines(symbol, tf, fromMs, toMs): Promise<Candle[]>`
    - `fundingHistory(symbol, fromMs, toMs): Promise<FundingEvent[]>`
    - `fundingIntervalHours(): Promise<Map<string, number>>`, from `/fapi/v1/fundingInfo`; symbols missing there use 8
    - `stream(streams: string[], onMsg: (m: unknown) => void, onState: (s: 'open'|'closed') => void): { close(): void }`
- Produces (`src/exchange/universe.ts`):
  - `buildUniverse(exchangeInfo: unknown): { pairs: PairInfo[]; excluded: { symbol: string; reason: string }[] }`
  - Rules mapping: `tickSize` from `PRICE_FILTER`, `stepSize` from `MARKET_LOT_SIZE` (falling back to `LOT_SIZE`), `minNotional` from `MIN_NOTIONAL.notional`, plus the estimated leverage and bracket values from Global Constraints.
- Produces (`src/exchange/binance.ts`): `class BinanceClient implements ExchangeClient`, with the REST methods only in this task. `stream` throws `not implemented` until Task 3.

- [ ] **Step 1: Write failing tests:**
  - `universe keeps only active USDT coin perpetuals`: from the fixture, exactly the expected symbols, with exclusion reasons `not_perpetual`, `not_trading`, `not_usdt` and `not_coin`.
  - `rules come from the filters`: BTCUSDT gets tickSize 0.1, stepSize 0.001 and minNotional 100 (or whatever the fixture states). Every pair gets `leverageEstimated: true`, `maxLeverage: 20` and `bracketsEstimated: true`.
  - `httpGet returns status and headers`: with a mocked fetch, the result has `X-MBX-USED-WEIGHT-1M` and status 429.
  - `httpGet allows only the allowlist`: `fstream.binance.com` over https is allowed, `example.com` is rejected.
- [ ] **Step 2: Run** `npx vitest run tests/exchange tests/net`. Expected: FAIL.
- [ ] **Step 3: Implement.** Point eslint's network override at `src/net/**`.
- [ ] **Step 4: Run.** Expected: PASS. Then run the full suite plus `npx tsc --noEmit` and `npx eslint .`.
- [ ] **Step 5: Commit** `feat: exchange client interface, universe and pair rules`

---

### Task 2: SQLite store, REST budget and history loader

**Files:**
- Create: `src/store/db.ts`, `src/store/candles.ts`, `src/exchange/history.ts`
- Modify: `src/exchange/binance.ts`, adding a `RestBudget` used by every REST call
- Test: `tests/store/candles.test.ts`, `tests/exchange/history.test.ts`, `tests/exchange/budget.test.ts`

**Interfaces:**
- Produces:
  - `openDb(path: string): DatabaseSync`. WAL mode, `foreign_keys=ON`, migrations applied in order, `PRAGMA user_version` holding the schema version. `':memory:'` works for tests.
  - Tables in this task:
    - `candles(symbol TEXT, tf TEXT, open_time INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY(symbol, tf, open_time))`
    - `funding(symbol TEXT, time INTEGER, rate REAL, mark REAL, PRIMARY KEY(symbol, time))`
  - `class CandleRepo`:
    - `upsert(symbol, tf, candles: Candle[]): void`
    - `range(symbol, tf, fromMs, toMs): Candle[]`
    - `latest(symbol, tf): Candle | null`
    - `count(symbol, tf): number`
    - `pruneBefore(symbol, tf, ms): void`
  - `class FundingRepo`:
    - `upsert(symbol, events): void`
    - `range(symbol, fromMs, toMs): FundingEvent[]`
  - `class RestBudget`:
    - `constructor(o: { limitPerMin: number; now: () => number; sleep: (ms) => Promise<void> })`
    - `acquire(weight: number): Promise<void>`
    - `observe(usedWeight1m: number): void`
    - `backoff(ms: number): void`
    - Kline weight by `limit`: <100 → 1, <500 → 2, ≤1000 → 5, otherwise 10. Funding: 1. `exchangeInfo`: 1. `ticker/24hr` (all symbols): 40.
  - `loadHistory(o: { client: ExchangeClient; repo: CandleRepo; symbol: string; tf: Timeframe; bars: number; now: number }): Promise<{ loaded: number; available: number }>`. It fetches only what the repo is missing at the tail, stops at the listing date, and keeps candles closed by `now` only.
  - **Retention:** after loading, call `pruneBefore` to keep at most `bars + 500` chart bars and `1000 + 50` bars per higher timeframe.

- [ ] **Step 1: Write failing tests:**
  - `candles round-trip and upsert is idempotent`.
  - `budget never exceeds limit`: with a fake clock, 200 acquisitions of weight 10 under a limit of 1200/min. The sum in any 60 s window stays ≤ 1200.
  - `429 backs off and resumes`: a fake client answers 429 with `Retry-After: 5` once, then succeeds. `loadHistory` finishes with no duplicates and no gaps, and waits ≥ 5 s on the fake clock.
  - `418 pauses all REST`: the next `acquire` waits for the full `Retry-After`.
  - `loadHistory fetches only the missing tail`: with 2,900 bars in the repo and 3,000 wanted, it makes exactly one request.
  - `young pair reports available < bars`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, plus a clean full suite, tsc and eslint.
- [ ] **Step 5: Commit** `feat: sqlite candle store, REST budget and history loader`

---

### Task 3: Live feed (WebSocket)

**Files:**
- Create: `src/net/ws.ts`, `src/exchange/live-feed.ts`
- Modify: `src/exchange/binance.ts` (`stream`), `src/exchange/fake.ts` (create, with scripted stream events)
- Test: `tests/exchange/live-feed.test.ts`, `tests/net/ws.test.ts`

**Interfaces:**
- Produces (`src/net/ws.ts`): `openSocket(url: string, h: { onMessage(data: string): void; onOpen(): void; onClose(code: number): void }): { close(): void }`. Only `wss://fstream.binance.com/...` is allowed; anything else throws `EgressBlockedError`. It uses the global `WebSocket`.
- Produces (`src/exchange/live-feed.ts`): `class LiveFeed`
  - `constructor(o: { client: ExchangeClient; repo: CandleRepo; tf: Timeframe; symbols: string[]; now: () => number; setTimer: typeof setTimeout })`
  - `start(): void`, `stop(): void`
  - `setSymbols(symbols: string[]): void` reconnects with the new stream list.
  - `onClose(cb: (closeTime: number, bars: Map<string, Candle>) => void)`: fires once per chart-timeframe close, after every symbol's closed kline has arrived or been backfilled, and at the latest 3 s after the first kline of that close arrived. Symbols still missing are backfilled over REST.
  - `onPrice(cb: (symbol: string, last: number, time: number) => void)`, from `!ticker@arr`.
  - `onMark(cb: (m: MarkUpdate) => void)`, from `!markPrice@arr@1s`.
  - `status(): { connected: boolean; stale: boolean; lastMessageAt: number; catchingUp: boolean }`
- **Streams:** `<symbol lowercase>@kline_<tf>` for every symbol, plus `!ticker@arr` and `!markPrice@arr@1s`, split across connections at **200 streams per connection**. Every closed kline (`k.x === true`) is upserted to the repo before `onClose` fires.

- [ ] **Step 1: Write failing tests** with `FakeExchange` scripted streams and fake timers:
  - `emits one close with every symbol's bar`.
  - `missing symbol is backfilled over REST within 3 s`.
  - `stale socket reconnects and backfills the gap`: messages stop for `tf + 30 s`. Then `stale` is true, a reconnect happens, the missed closes are fetched over REST, `onClose` fires once per missed close in order, and `stale` goes back to false.
  - `streams split at 200 per connection`: 450 symbols give 3 connections.
  - `ws rejects non-allowlisted host`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, plus a clean full suite, tsc and eslint.
- [ ] **Step 5: Commit** `feat: live feed with combined streams, staleness and backfill`

---

### Task 4: Funding tracker

**Files:**
- Create: `src/exchange/funding.ts`
- Test: `tests/exchange/funding.test.ts`

**Interfaces:**
- Produces: `class FundingTracker`
  - `constructor(o: { client: ExchangeClient; repo: FundingRepo; now: () => number })`
  - `onMark(m: MarkUpdate): void` records `nextFundingTime` per symbol.
  - `due(symbols: string[], now: number): Promise<{ symbol: string; event: FundingEvent }[]>`. For each given symbol whose recorded funding time has passed, it fetches the settled event once (`fundingHistory(symbol, t − 1000, t + 60_000)`), stores it, and returns it. If the event isn't published yet, it retries on later calls for up to 10 minutes, then logs `funding_missing`.
  - `range(symbol, fromMs, toMs): FundingEvent[]` delegates to the repo, for catch-up.
- The scanner calls `due` only for symbols with an open position, so REST stays small.

- [ ] **Step 1: Write failing tests:**
  - `fetches each funding event once`.
  - `retries an unpublished event, then logs funding_missing after 10 min`.
  - `only asks for given symbols`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, plus a clean full suite, tsc and eslint.
- [ ] **Step 5: Commit** `feat: funding tracker`

---

### Task 5: Strategy layer persistence and carry-note fixes

**Files:**
- Create: `src/engine/layer-state.ts`
- Modify: `src/engine/strategy-layer.ts`, `src/engine/pine-runner.ts`, `src/broker/broker.ts`
- Test: `tests/engine/layer-state.test.ts`, plus additions to the existing engine and broker tests

**Interfaces:**
- Produces:
  - `StrategyLayer.snapshot(): LayerState` and `static StrategyLayer.restore(s: LayerState, decl, broker, symbol, sizing, opts): StrategyLayer`.
    - `LayerState` is plain JSON. It holds `lots` (with `exitsFilled` as arrays), `records`, `meta`, `exits` (with `sent`), `parked`, `scriptAvg`, `tainted`, `seq`, anomalies and attributions.
    - `seq` is restored exactly, so order ids never collide after a restart.
  - `PaperBroker.forceClose(symbol: string, price: number, time: number, reason: 'delisting'): Fill[]`. It closes the whole position at `price` with no slippage, at the taker fee, and cancels that symbol's orders.
  - `PaperBroker.setFees(f: FeeConfig): void` and `PaperBroker.setSizing(s: SizingRule): void`. Both apply from the next submit or fill, and are needed for owner edits after approval.
  - `compileScript(source, tf = '4h', symbol = 'BTCUSDT')` validates as the given symbol. Carry note: an own-symbol string on another pair's chart must work.
  - `compileScript` also returns `securityTimeframes: string[]`, the timeframes of every `request.security` call, so Task 6 knows which higher timeframes to load.
- Carry-note fixes:
  - `scriptView()` keeps a per-symbol running netProfit instead of cloning `broker.closedTrades()` on every bar.
  - An exit leg the broker keeps rejecting is re-sent at most 3 times per bar and 10 times in total, after which it logs one `exit_leg_abandoned` anomaly. No unbounded growth.

- [ ] **Step 1: Write failing tests:**
  - `layer snapshot round-trips mid-trade`.
    1. Replay KyberSwing on the fixture to an arbitrary bar with an open position and a held exit.
    2. Snapshot the broker and the layer, then restore both.
    3. Continue to the end.
    4. Closed trades must equal an uninterrupted replay exactly.
  - `restored seq never reuses an order id`.
  - `forceClose books a delisting trade`: exitReason `'delisting'`, the taker fee, and no open orders left.
  - `setFees applies from the next fill only`.
  - `own-symbol string compiles on its own chart`: `request.security("ETHUSDT", "D", close)` with symbol `ETHUSDT` is ok.
  - `compileScript lists security timeframes`: KyberSwing gives `['D']`.
  - `scriptView cost does not grow with closed trades`: 5,000 closed trades on other symbols leave this symbol's netProfit correct, and `broker.closedTrades` is not called per bar (spy).
  - `rejected exit leg is abandoned after 10 resends`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. The full suite stays green, including acceptance tests 1–3 unchanged, plus tsc and eslint.
- [ ] **Step 5: Commit** `feat: strategy layer snapshot/restore, delisting close, editable fees and sizing`

---

### Task 6: Resident strategy engine and run state store

**Files:**
- Create: `src/engine/resident.ts`, `src/store/runs.ts`
- Modify: `src/store/db.ts` (new migration), `spike/resident.ts` (import from `src/engine/resident.ts`, so there is one source)
- Test: `tests/engine/resident.test.ts`, `tests/store/runs.test.ts`

**Interfaces:**
- Produces (`src/engine/resident.ts`):
  - `class ResidentStrategy`
    - `static create(o: { source: string; symbol: string; tf: Timeframe; rules: PairRules; history: Candle[]; htf: Record<string, Candle[]>; hooks: BarHooks; keep: number; htfKeep: number }): Promise<ResidentStrategy>`
      - Warm-start over `history`. During warm-up the hooks see bars before `from` and stay flat, as in replay.
      - Instances must be created one at a time, never concurrently (spike 2b.7). Enforce this with an internal promise queue.
    - `step(bar: Candle): Promise<void>` runs hooks.before, the script, then hooks.after for one new closed bar. It also aggregates the new chart bar into each higher-timeframe series, the same way replay's MemoryProvider builds them, and closes a higher-timeframe bar on its boundary.
    - `dispose(): void`
  - `scriptBounds(source: string): { keep: number; htfKeep: number } | { error: string }`. A static scan of `x[n]` history references:
    - `keep = max(100, 3 × max n)`; `htfKeep = max(50, 3 × max n inside request.security expressions)`.
    - An offset that isn't a literal (an input or runtime expression) returns `{ error: 'history offset on line N cannot be bounded in v1' }`.
    - Default when there are no references: keep 100, htfKeep 50.
  - Plan 3 will move `ResidentStrategy` into an isolate. Keep `create`'s options JSON-serialisable apart from `hooks`, and make `hooks` the only callbacks.
- Produces (`src/store/runs.ts`): `class RunRepo`, with migration tables:
  - `runs(id, name, status ['running'|'paused'|'stopped'], created_at, setup_json)`. `setup_json` holds the script, exchange, tf, starting balance, sizing, fees and slippage.
  - `settings_history(run_id, time, field, old_json, new_json)`
  - `run_state(run_id PRIMARY KEY, last_close INTEGER, broker_json, layers_json, updated_at)`
  - `processed_candles(run_id, symbol, open_time, PRIMARY KEY(...))`
  - `trades(run_id, ...ClosedTrade fields, overfill INTEGER)`
  - `equity(run_id, time, equity, PRIMARY KEY(run_id, time))`
  - `run_log(run_id, time, kind, symbol, detail_json)` for rejections, anomalies, delistings, skips and warnings. Its type is `RunLogEntry { time: number; kind: string; symbol?: string; detail?: unknown }`.
  - Methods:
    - `createRun`, `getRun`, `listRuns`, `setStatus`, `recordSetting`
    - `commitPass(runId, p: { close: number; processed: { symbol: string; openTime: number }[]; broker: BrokerState; layers: Record<string, LayerState>; trades: ClosedTrade[]; equity: { time: number; equity: number }; logs: RunLogEntry[] }): void`, in **one** transaction
    - `isProcessed(runId, symbol, openTime): boolean`
    - `loadState(runId)`
    - `trades(runId)`, `equityCurve(runId)`, `logs(runId, kind?)`

- [ ] **Step 1: Write failing tests:**
  - `resident stepping equals replay`. Run KyberSwing on the BTCUSDT fixture with a warm start of 3,000 bars, then step the rest one bar at a time through `barHooks`, using a fresh broker and layer. Its closed trades must equal `replay()` over the same `from`/`to`, given the replay's warm-up starts at the same bar.
  - `trimmed instance stays bounded`: after 2,000 steps, the history arrays are ≤ keep + slack (the spike canary, moved here).
  - `scriptBounds`: KyberSwing returns finite bounds; `close[len]` with an input `len` returns the error naming its line.
  - `instances are created one at a time`: concurrent `create()` calls are serialised (spy).
  - `commitPass is atomic`: when a trade insert is forced to throw, nothing of the pass is stored, including processed keys.
  - `duplicate closed kline is ignored`: once a key is committed, `isProcessed` is true, and a second pass for the same key commits nothing for that pair.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Move the spike's trimming, the updateTail fix and the store provider into `src/engine/resident.ts`, then delete the duplicated code from the spike. The spike tests must still pass.
- [ ] **Step 4: Run.** Expected: PASS, the full suite including spike and acceptance tests, plus tsc and eslint.
- [ ] **Step 5: Commit** `feat: resident strategy engine and run state store`

---

### Task 7: Scanner run, run manager and headless CLI

**Files:**
- Create: `src/scanner/run.ts`, `src/scanner/manager.ts`, `src/cli/scan.ts`
- Test: `tests/scanner/run.test.ts`, `tests/scanner/manager.test.ts`

**Interfaces:**
- Produces (`src/scanner/run.ts`): `class ScannerRun`
  - `constructor(o: { runId: string; repo: RunRepo; candles: CandleRepo; client: ExchangeClient; funding: FundingTracker; setup: RunSetup; now: () => number })`
  - `RunSetup { name; source; tf; startingBalance; sizing: SizingRule; fees: FeeConfig }`. The mode is always `binance`.
  - `start(universe: PairInfo[], volumes: Map<string, number>): Promise<void>`
    1. Compile the script. A failure throws `ScriptCompileError`.
    2. Load history for every pair through the budget.
    3. Create one resident instance per pair that has enough history.
    4. Record `insufficient_history` skips.
  - `onClose(closeTime: number, bars: Map<string, Candle>): Promise<PassReport>`, one pass:
    1. Skip pairs whose `(runId, symbol, openTime)` is already processed.
    2. Apply funding from `funding.due` for pairs with open positions. The funding event's apply time sits inside the bar, as in replay.
    3. Step each remaining pair in **descending 24h quote volume**.
    4. Commit everything with `repo.commitPass`.
    5. Return `PassReport { closeTime; scanned; skipped: Record<reason, string[]>; durationMs; errors: { symbol; message }[] }`.
    - A pair whose step throws is flagged `error` and skipped from then on. The other pairs are unaffected.
  - `onPrice(symbol, last, time)`: for pairs with resting stop or limit orders, `broker.onPrice`. If anything fills, pass it to `layer.onFills`, submit the resulting intents, and commit at once with a state-only `commitPass` (no processed keys).
  - `onMark(m)`: `broker.onMark` for liquidation, with the same immediate commit if it fills.
  - `applyUniverse(next: PairInfo[], volumes)`:
    - A delisted pair with a position: `broker.forceClose(symbol, lastPrice, now, 'delisting')`, then `layer.onFills`, a `delisting` log entry, and the pair is dropped.
    - A new pair: load its history. It joins once history ≥ the required warm-up; until then it is `insufficient_history`.
  - `pause()`: from now on the run drops **entry** intents and logs them as `paused_entry_dropped`. Exits, stops, liquidation and funding carry on.
  - `stop()`: frozen. No more passes, nothing is closed.
  - `status(): ScannerStatus { universe: number; scannedLastPass: number; skipped: Record<string, number>; lastPassAt: number; lastPassMs: number; feed: ReturnType<LiveFeed['status']> }`
- Produces (`src/scanner/manager.ts`): `class RunManager`
  - It starts and stops the runs, at most `RUN_LIMIT` (Global Constraints). Starting past the limit throws `run limit reached (N)`.
  - It keeps one `LiveFeed` per timeframe, shared by all runs on that timeframe.
  - It refreshes the universe hourly and passes it on to each run's `applyUniverse`.
  - `updateSettings(runId, { sizing?, fees? })`: calls `broker.setSizing` / `setFees`, records a `settings_history` row, and applies from the next pass. Anything else is locked: it throws `locked after approval`.
- Produces (`src/cli/scan.ts`): `npx tsx src/cli/scan.ts start --name <n> --script <file> --tf 4h --balance 10000 [--fixed-usd 100]`, plus `list`, `status <id>`, `pause <id>`, `resume <id>` and `stop <id>`. It uses `data/pineapple.db` and prints the PassReport line on each close.

- [ ] **Step 1: Write failing tests**, all with `FakeExchange` and fake time:
  - `pass steps pairs by volume and commits once`.
  - `signals beyond free balance are rejected in volume order`: three pairs signal on the same bar and there's room for two. The lowest-volume pair's entry is rejected `no_free_balance` and logged.
  - `delisted pair closes its position`.
  - `new listing joins when history suffices`.
  - `script error on one pair flags only that pair`.
  - `pause drops entries but keeps stops and funding`.
  - `live price fills a stop between closes and commits it`.
  - `run limit enforced`: with `MEM_LIMIT_MB=768`, a second start throws `run limit reached (1)`.
  - `fees edit applies from next pass and is logged`.
  - `locked fields throw`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, plus a clean full suite, tsc and eslint.
- [ ] **Step 5: Smoke test against real Binance.** Run `npx tsx src/cli/scan.ts start --name smoke --script tests/fixtures/KyberSwing.pine --tf 15m --balance 10000` for at least one 15m close. Expected:
  - The universe is built (report its size).
  - Warm-up finishes with no 429 or 418 (report the time taken and the peak used weight).
  - One pass completes in under 10 s (report `durationMs`).
  Stop the run afterwards. Record the output in the report.
- [ ] **Step 6: Commit** `feat: scanner run, run manager and headless scan CLI`

---

### Task 8: Restart recovery and acceptance tests 4–5

**Files:**
- Create: `src/scanner/recovery.ts`, `tests/acceptance/scale.test.ts`, `tests/acceptance/restart.test.ts`, `spike/docker-scale.sh`
- Modify: `src/scanner/run.ts` (resume path), `src/scanner/manager.ts` (resume all `running` and `paused` runs on start)

**Interfaces:**
- Produces: `catchUp(run: ScannerRun, from: number, to: number): Promise<PassReport[]>`
  - It loads the missed closed candles and funding events for every pair from REST, through the budget, into the repos.
  - It then calls `run.onClose` for each missed close **in order**. Stops and limits trigger on each bar's path as in replay, because no live prices exist for the downtime.
  - When `catchUp` ends, the run goes live.
- **Resume:** `RunManager.start()` restores every non-stopped run:
  1. Restore broker and layer states from `loadState`.
  2. Rebuild each resident instance by warm-start from stored candles: about 3,000 bars, beginning before the oldest open trade's entry (design §Script state). Instances are not ready until warm.
  3. Run `catchUp(lastClose → now)`.
  4. Subscribe to the live feed.
  - The status shows `catchingUp` until it finishes.

- [ ] **Step 1: Write `restart.test.ts`** (acceptance test 5), using FakeExchange with recorded BTCUSDT and ETHUSDT 4h candles and funding:
  1. Run live until there is an open position with a resting stop.
  2. Kill the run (drop every object, keep the db file).
  3. Advance fake time by 6 closes. Inside that window the fixture data must contain one bar whose low crosses the stop, one funding event, and one new entry signal.
  4. Start a new `RunManager` on the same db.
  5. Assert:
     - the stop filled on its bar, at the stop price or the gap price;
     - funding was charged once;
     - the new entry happened;
     - `processed_candles` holds exactly one key per pair per close;
     - trades and equity equal an uninterrupted run over the same data.
- [ ] **Step 2: Write `scale.test.ts`** (acceptance test 4, in-process part). It builds 500 synthetic pairs, each with 3,500 15m bars derived from the BTCUSDT fixture by deterministic scaling and noise, and runs KyberSwing on them. Assert:
  - one pass over all 500 finishes in < 10 s;
  - warm-up through a FakeExchange that enforces 1200/min never receives more weight than the budget allows in any minute.
  Mark the test as `slow` (vitest tag or file name); it runs in the default suite.
- [ ] **Step 3: Write `spike/docker-scale.sh`.** It runs `scale.test.ts` in `node:24-bookworm` with `--cpus 1 --memory 768m -e MALLOC_ARENA_MAX=2 -e MEM_LIMIT_MB=768`. Expected: PASS with peak RSS < 768 MB. Report the pass time and peak RSS.
- [ ] **Step 4: Run** both acceptance tests, then the Docker script. Expected: PASS. If the pass time or memory misses its target, use superpowers:systematic-debugging, and don't relax a target without the owner.
- [ ] **Step 5: Run everything:** `npx vitest run && npx tsc --noEmit && npx eslint .`. Expected: clean.
- [ ] **Step 6: Commit** `feat: restart recovery; acceptance tests 4 and 5`. Don't push; the controller pushes after the final review.
