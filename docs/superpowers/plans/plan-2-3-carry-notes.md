# Carry notes for Plans 2 and 3

These come from Plan 1's reviews (2026-11-23/24). Each one is real work that a later plan must include.

## Plan 2: live data, scanner, saved state, restart

- **StrategyLayer snapshot/restore.** The layer keeps its own state: `lots` (with `exitsFilled` Sets), `records`, `meta`/`exits`/`parked` Maps, `sent`, `scriptAvg`, `tainted`, `seq`, and the anomaly and attribution logs. It has no `snapshot()`/`restore()` yet.
  - Persist it in the same SQLite transaction as the broker state.
  - Restore `seq`, so that order ids (`|C|`, `|CA|`, `|OF|`) can't collide after a restart.
- **Per-symbol running netProfit.** `scriptView()` currently clones every closed trade of every symbol on each bar. With one shared broker per run and about 500 symbols, that is O(all trades) per symbol per bar.
- **Bounded re-send of rejected exits.** An exit leg the broker permanently rejects is re-sent on every settle, and each re-send adds an `exit_leg_resent` anomaly, without limit. Dedupe or back off.
- **Validating rules loader.** It must check tickSize, stepSize, minNotional and brackets.
  - Empty brackets currently fall back silently to 0.004/0. Surface that the same way as `leverageEstimated`.
  - `tests/fixtures/BTCUSDT-rules.json` brackets were written from memory and are marked TODO(Plan 2).
- **`compileScript(source, tf, symbol)`.** Validation always runs as BTCUSDT. On another pair's chart, a hard-coded own-symbol string such as `request.security("ETHUSDT", ...)` is rejected as "another symbol". `syminfo.tickerid` works. The scanner runs every pair, so pass the chart symbol in.
- **Resident stepping in production.** Move the bounded-history resident instances from `spike/resident.ts` into `src/engine/`.
  - Derive `keep`/`htfKeep` per script. This is an open item; see `docs/spike/pinets-findings.md` 2b.7.
  - The restart warm-up window is about 3,000 bars and must start before the oldest open trade's entry.
  - `ResidentInstance.create()` calls must not overlap.
- **Run limit from memory.** Derive it from the container cap: about 125 MB base plus about 0.5 GB per 500-pair run. The default is 1 run at 768 MB.
- **Broker money-path tests.** Missing cases:
  - short liquidation price and pnl
  - non-zero `maintAmount`
  - funding across a snapshot/restore
  - `fundingNet` after several events
  - funding on a position that has already closed
- **Smaller broker items:**
  - `pos.leverage` is overwritten when adding to a position.
  - Limit and stop prices are tick-snapped only by the layer. Keep that rule, or snap in the broker.
  - A marketable limit filled at the gap price is booked as maker; Binance charges taker.
  - Funding isn't taken from isolated margin, so the liquidation price doesn't move during long holds.
- **Funding on charts longer than 8h.** On 12h and 1d charts, funding is applied before the intrabar path. Split the path at funding times.

## Plan 3: sandbox, web, Docker

- **Sandbox both runs.** `compileScript` runs the pasted script for 300 bars in-process to validate it. The isolated-vm sandbox must cover that validation run as well as the scanner run.
- **Pin esbuild** exactly once the isolate bundle is production code. `spike/isolate.ts` currently uses tsx's transitive copy.
- **Local Docker test.** Run the full container in Docker Desktop with `--memory 768m --cpus 1` and `MALLOC_ARENA_MAX=2` before deploying to the server.

## For the owner

- **TradingView reference.** Confirm the window it was measured over (assumed 2024-01-01 to 2026-11-18) and whether the chart was BTCUSDT.P or spot. Net profit already uses 67% of its ±3 point tolerance.
- **Known v1 divergences from TradingView:**
  - TradingView's margin-call partial closes are not modelled. Scripts sized at 100% of equity get "no free balance" rejections instead.
  - Exits without `from_entry` share one bracket priced from the average entry. TradingView places one per trade, which matters for pyramiding scripts.
  - An add that the broker fills past the pyramiding cap is closed at the next open. It is kept out of the stats and listed separately.
