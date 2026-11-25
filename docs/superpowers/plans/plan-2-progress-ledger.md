# SDD ledger — plan: docs/superpowers/plans/2026-11-24-plan-2-live-scanner.md

Spec: docs/spec/v1-feature-spec.md + docs/superpowers/specs/2026-11-23-pineapple-scanner-design.md (design wins) + docs/superpowers/plans/plan-2-3-carry-notes.md (Plan 2 items binding) + docs/spike/pinets-findings.md 2b.
Worktree: .claude/worktrees/plan-2-scanner, branch worktree-plan-2-scanner, base e375bdc (local main; ff from b8ac931). Baseline: 225 pass / 7 it.fails / 1 skip.
Owner preferences: worktree + branch; subagent-driven; pause when asked; no push without asking; owner may say "pause" anytime → TaskStop + ledger note.

## Pre-flight scan

| Rows | Produces / consumes | Finding |
|---|---|---|
| T1 self | ExchangeClient.stream declared, implemented T3 | consistent (throws until T3) |
| T1→T2 | httpGet {status, headers} → RestBudget.observe | consistent |
| T2 self | tests use a "fake client"; FakeExchange file created in T3 | Ruling A |
| T2→T6/T7 | CandleRepo/FundingRepo | consistent |
| T3 self | lint: ws.ts under src/net/** (T1 widens override) | consistent |
| T4→T7 | FundingTracker.due → events into barHooks funding array | Ruling B |
| T5→T6/T7 | LayerState, compileScript(src, tf, symbol) + securityTimeframes, forceClose, setFees/setSizing | consistent |
| T6 self | htf: Record<string, Candle[]> keyed by Pine tf string ('D') from securityTimeframes | consistent |
| T6→T7/T8 | RunRepo.commitPass/isProcessed/loadState, ResidentStrategy.create/step | consistent |
| T7→T8 | ScannerRun.onClose, PassReport, RunManager.start | consistent |
| T8 self | restart fixture window needs stop-cross + funding + new signal within 6 closes | Ruling C |
| all | node:sqlite may print ExperimentalWarning (pristine output) | Ruling D |

Rulings:
- Ruling A: T2 creates src/exchange/fake.ts with the REST half of FakeExchange (pairs, tickers, klines, funding, scripted 429/418); T3 adds scripted streams — the plan creates it in T3 but T2's tests need it — cost: none.
- Ruling B: the scanner keeps one sorted funding array per pair, passed to barHooks at construction, and pushes FundingTracker.due events into it (time ≥ the bar being stepped) before stepping; barHooks' cursor reads them — avoids changing the reviewed barHooks — cost: small refactor if the cursor misses late pushes (test it in T7).
- Ruling C: T8 may record extra real data (e.g. ETHUSDT 4h) with src/cli/record.ts and pick any window from recorded data that satisfies the conditions, or construct the window by scripting FakeExchange candles derived from fixture data — cost: none.
- Ruling D: if node:sqlite prints an ExperimentalWarning, silence only that warning (vitest execArgv / NODE_OPTIONS `--disable-warning=ExperimentalWarning`) in config and the CLI; if node:sqlite is unusable, fall back to exact-pinned better-sqlite3 and say so — cost: one dependency.

## Tasks
- Task 1: dispatched (BASE e375bdc, implementer sonnet, agent a0d916464b89e9c5f)
  - DONE, commit c54f2f9. Real universe 956 total / 519 included (not_perpetual 251, not_trading 138, not_usdt 45, not_coin 3). Concerns: fundingInfo + ticker/24hr shapes unverified live; BinanceClient not on httpGet yet (T2 wires budget). Review dispatched (sonnet).
  - Review: Approved with 2 Important (one bad symbol aborts universe; ticker/fundingInfo shapes unvalidated, silent ?? 8). Fix round 1 sent (+ live fixtures for ticker24h/fundingInfo, fundingHoursFor helper, MARKET_LOT_SIZE precedence test).
  - Fix commit 0e3122e. Live facts: ticker/24hr 817 entries (string numbers); fundingInfo 833 entries, intervals 1h×3 / 4h×466 / 8h×364; ~120 symbols unlisted → 8h default. Re-review dispatched (sonnet).
  - Task 1: fix round 1/5 (3 addressed, 0 open; commits c54f2f9..0e3122e)
  - Task 1: minor (deferred): symbol-less entry passing filters kept as symbol '' (add bad-symbol exclusion); positive() accepts "0x10"/"1e3".
  - Carry → T4/T7: funding consumers must use fundingHoursFor(), not map.get.
Task 1: complete (commits e375bdc..0e3122e, review clean)
- Task 2: dispatched (BASE 0e3122e, implementer sonnet, agent af53d67fd212e1ff0).
  - DONE, commit d17a607. node:sqlite no warning (Node 24.19). loadHistory role 'chart'|'htf'; record.ts on BinanceClient. Concerns: budget tests not RED-first; no interior-gap repair; 418 throws after 5 tries; fundingRate 500/5min bucket not modelled. Review dispatched (opus).
  - Review 1: Needs fixes — Important: obs-weight floor under-counts concurrent callers; head of window never backfilled; interior gaps (a) count check + bounded refetch. Fix round 1 sent with minors 4 (doc retry charge), 7, 8, 10, 11.
  - Fix commit 0168b20 (273 pass). Re-review dispatched (sonnet).
  - Task 2: fix round 1/5 (all addressed, 0 open; commits d17a607..0168b20)
  - Task 2: minor (deferred): in-flight under-count (observe stamps seq at response, not send; out-of-order responses); ROLLBACK TO may mask original error after SQLite auto-rollback; newest-bar-missing triggers refetch every load.
Task 2: complete (commits 0e3122e..0168b20, review clean)
- Task 3: dispatched (BASE 0168b20, implementer opus, agent a28917d0ffa83af2b). Includes T2 carry 3b (crash between stream write and backfill test) and 23h proactive reconnect.
PAUSED by owner: T3 implementer stopped mid-work. On resume: git status (uncommitted src/net/ws.ts, src/exchange/live-feed.ts, fake.ts edits may be partial), SendMessage a28917d0ffa83af2b to continue T3.
RESUMED: only tests/exchange/clock.ts modified; T3 agent resumed via SendMessage.
  - DONE, commit e7e3898 (293 pass). Live smoke: /stream?streams= opens but sends 0 messages; /market/stream delivers {stream,data}. Ruling E: use wss://fstream.binance.com/market/stream (same host, allowlist unchanged) — observed live behaviour beats my dispatch's URL — cost: one-line revert (WS_STREAM_BASE) if Binance changes back.
  - Carry → T7: pass LiveFeed's optional lastCloseTime after warm-up.
  - Review dispatched (opus, ade12975f689ff6e9).
  - Review 1: Needs fixes — no skip/dup/reorder path found; Important I-1 missing backfill bar dropped silently; I-2 stale cleared by tickers; I-3 reconnect/setSymbols near boundary delays close ~30s (break-before-make); I-4 one failing symbol stalls all closes; I-5 unbounded gap fill. Fix round 1 sent (+ M-1, M-2, M-4, M-5, M-7 tests). onClose gains `missing` (interface change for T7).
  - Fix commit 04d96f9 (303 pass). Deviations: retries 1/2/3 s (deadline); gaps ≤99 bars filled, further behind → bar emitted not stored + RepoBehindError (loadHistory repairs). Re-review dispatched (opus).
  - Task 3: fix round 1/5 (I-2, I-3, I-4, I-5, minors addressed; 2 open — I-1 retry not deadline-bounded with >8 missing / gap-region holes; NEW regression repo-covered bars reported missing on partly covered batch; commits e7e3898..04d96f9). Round 2 sent (+ I-3 timer residual, non-HTTP permanent after 3, behind[] in payload/status, clearTimer default, failedAt respected, inCatchUp reset).
  - Round 2 commit b849697 (310 pass; 27 live-feed tests; each fix reverted fails 6/6). onClose(closeTime, bars, {missing, behind}). Re-review dispatched (opus).
  - Task 3: fix round 2/5 (all listed addressed; 1 open — NEW N-1 streak counts network-wide errors → outage emits empty closes; commits 04d96f9..b849697). Round 3 sent (+ N-2 hard deadline incl. fetch, N-3 no-kline anchor to close time). Round 3 commit c5c791a (315 pass; 32 live-feed tests). Implementer concern: lone REST symbol with malformed reply never marked missing → held. Re-review dispatched (opus).
PAUSED by owner: T3 round-3 re-review stopped (read-only; nothing partial). On resume: re-dispatch the round-3 re-review fresh (base b849697, head c5c791a, diff review-b849697..c5c791a.diff, same prompt incl. concern (a)). If findings remain after it, that's round 4 → fresh implementer on a more capable model per fix-loop.
RESUMED 2026-11-25: round-3 re-review re-dispatched (opus).
  - Task 3: fix round 3/5 (N-2, N-3 addressed; N-1 outage path correct; 1 open — lone REST symbol with persistent malformed reply stalls whole feed (regresses I-4); minors: bare TypeError too broad, okInBatch counts own success; commits b849697..c5c791a).
  - Ruling F: first fetch of a batch is not cut by the deadline (a hanging first fetch is indistinguishable from network trouble; cutting it would emit a close REST could still fill, violating N-1) — endorsed by reviewer — cost: a slow-but-successful first fetch makes a close late but complete.
  - Round 4: fresh implementer (opus, most capable available) per fix-loop. Agent a250480413a47413f (BASE c5c791a). Fix: control probe; NetworkError at http layer; okInBatch others only; klines timeout 6000. Commit 7818703 (326 pass; 9 changes revert-fail). Re-review dispatched (opus).
  - Task 3: fix round 4/5 (all addressed, 0 open; commits c5c791a..7818703)
  - Task 3: minor (deferred): probe 4xx counted 'failed' (should be REST-healthy); probe 429/418 can delay close beyond 6 s (ruling F); first close with a persistently malformed symbol ~15 s (streak limit 3); one-symbol feed holds (document on LiveFeed); test typo `=(c`.
  - Carry → T7: loadHistory has no retry — a NetworkError propagates; scanner must retry/backoff warm-up per pair.
Task 3: complete (commits 0168b20..7818703, review clean after 4 rounds)
- Task 4: dispatched (BASE 7818703, implementer sonnet, agent a0b81328405db13be). Rulings in dispatch: fundingRate guard ≤400 calls/5 min; primeFromInterval via fundingHoursFor; keep passed-unfetched funding times; dedupe by (symbol,time) incl. repo.
  - DONE, commit da7072a (337 pass). Concern flagged by controller for review: "event in FundingRepo ⇒ applied" — repo is shared across runs/history; exactly-once application likely belongs per run. Review dispatched (sonnet).
  - Review 1: Needs fixes — Critical: stored ⇒ applied loses events (restart, consumer throw, loader-first, 2nd run). Important: give-up before first attempt; double funding_missing; guard starvation.
  - Ruling G: FundingTracker only supplies events; due(symbols, now, appliedThrough(symbol)) returns every passed settled event with time > appliedThrough (repo or one fetch); each run persists its own funding_applied_through per symbol in RunRepo, committed in the pass transaction — exactly-once belongs to the run, the funding table is shared — cost: one column/table in T6.
  - Carry → T6: RunRepo stores funding applied-through per (run, symbol), written by commitPass. Carry → T7: pass appliedThrough from run state into due(); apply returned events via barHooks funding array; update applied-through in the same commit.
  - Fix round 1 sent. Commit 00dabec (342 pass). Re-review dispatched (sonnet).
  - Task 4: fix round 1/5 (2,3,4,5 addressed; 1 open — prune deletes st.times by caller-driven minApplied → 2nd run with lower appliedThrough loses events; commits da7072a..00dabec). Round 2 sent (+ repo read before guard; bound firstAttempt/gaveUp by 30-day retention). Round 2 commit cb5dbbc (344 pass). Re-review dispatched (sonnet).
  - Task 4: fix round 2/5 (3 addressed, 0 open; commits 00dabec..cb5dbbc)
  - Task 4: minor (deferred): stale minApplied doc comment; give-up check runs before repo read (stored-by-catch-up event with old firstAttempt dropped); no test for 30-day retention / pruneAttempts; st.times for symbols never passed to due() not pruned.
  - Carry → T8: catch-up must apply funding for (appliedThrough, now) from FundingRepo.range (REST-filled) directly, not via the tracker, since the tracker only holds ≤ ~30 days.
Task 4: complete (commits 7818703..cb5dbbc, review clean)
- Task 5: dispatched (BASE cb5dbbc, implementer opus, agent a1cb9ca3b901170c7). Rulings in dispatch: exact snapshot fidelity; forceClose → layer flat, exitReason 'delisting'; setFees/setSizing in BrokerState; non-literal request.security timeframe = compile error; exit_leg_abandoned anomaly kind.
  - DONE, commit afb6db0 (365 pass). KyberSwing unchanged; restore-at-every-bar byte-identical (tv + binance w/ funding).
  - Carry → T6/T7: pass broker.sizingRule() as layer sizing (ctor/restore throw on mismatch); rebuild layer decl commission from broker.feeConfig() after setFees (else pct-of-equity sizing uses old commission); scanner drops a delisted pair (layer doesn't refuse later calls).
  - Review dispatched (opus).
  - Task 4: minor (deferred): one symbol with many pending times can use many slots per pass; shared inflight promise reports guard-full to first caller's closure.
  - Task 3: minor (deferred): stop()+start() sync during retry sleep continues old plans (pre-existing); interior holes in repo-covered span reported missing (contiguous-write should prevent); late stream kline during sleep ignored (REST used).
  - Carry → T7: on RepoBehindError / `behind`, run loadHistory and skip that symbol until repaired.
  - Task 3: minor (deferred): back-to-back connect(true) degrades to break-before-make; setSymbols wasEmpty jump undone by in-flight batch; 60s no-kline stale may false-trigger on illiquid-only feeds; inCatchUp set on any REST fetch (cosmetic); empty repo gets batch bars written.
  - Carry → T7: M-3 one dropped connection reconnects all; M-6 each tf feed subscribes its own !ticker@arr/!markPrice — share one price/mark stream across feeds in the manager.
  - Carry → T7: always pass PairInfo.onboardDate into loadHistory (else an empty head request per young pair per load).
  - Carry → T3: test crash between stream write and backfill → restarted load contiguous (review item 3b).
  - Carry → T4: fundingRate endpoint has separate 500/5min/IP limit — don't bulk-load funding for all symbols at startup.
  - Carry → T7: surface budget.banned as a scanner warning; long 418 ban currently throws after 5 attempts.
  - Task 2: minor (deferred): src/data/binance-rest.ts imports weights from src/exchange/budget.ts (layering). Ruling A applies (T2 creates REST half of src/exchange/fake.ts).
  - T5 Review 1: Needs fixes — Important: setFees not reaching layer pct-of-equity sizing; replay doesn't pass symbol to compileScript. Fix round 1 sent (+ layer.onDelisted() delisted flag, sizing compare by fields + restore default, broker snapshot non-finite guard, abandoned state reset on reversal).
  - Task 5: minor (deferred): securityTimeframes shadowed-param edge; timeframe.period accepted.
  - T5 fix commit b25facd (373 pass; acceptance unchanged). Re-review dispatched (sonnet).
  - Task 5: fix round 1/5 (6 addressed, 0 open; commits afb6db0..b25facd)
  - Task 5: minor (deferred): LayerState v1 baseFees/delisted have no fallback (no persisted v1 states exist yet — OK); re-send cap is per protected set, not strict per trade; post-edit sizing applies slippagePct.
Task 5: complete (commits cb5dbbc..b25facd, review clean)
- Task 6: dispatching (BASE b25facd, implementer opus). Carries in dispatch: Ruling G funding applied-through per (run,symbol) in RunRepo + commitPass; layer sizing = broker.sizingRule(); one source for resident code (spike imports src).
  - T6 dispatched: agent a543282db4ef416ce.
RESUMED 2026-11-26: app restarted mid-T6; uncommitted memory-provider.ts, pine-runner.ts, tests/engine/resident.test.ts, tests/store/runs.test.ts. T6 agent resumed via SendMessage.
  - T6 DONE, commit 8722f7f (393 pass). Equality tv-mode: 43 trades, equity 11,081.64, 5,008 stepped after 3,000 warm start. KyberSwing bounds keep 100 / htfKeep 50. Concerns: bar_index restarts at 0 after restart (entryBarIndex); commitPass returns {duplicates}; duplicate key skips pair layer but broker always replaced → scanner must check isProcessed first; recordSetting updates setup_json. Review dispatched (opus).
  - T6 Review 1: Needs fixes — Critical: duplicate key writes broker while skipping pair layer/trades (+ fresh key marked processed but dropped). Important: stale pass mixes state; htf contract unchecked; bar index after restart (→ T8). Fix round 1 sent (all-or-nothing DuplicatePassError, StalePassError, htf validation, minors 5,6,7,8,9,11).
  - Carry → T8: on restore, rebase stored barIndex from time ((time - newHistory[0].openTime)/tfMs); test entry_bar_index equal across restart. Also: warm-up runs flat while restored broker holds a position → var state / position_size[1] rebuilt flat; first stepped bars may differ — T8 must handle (e.g. warm-up with the restored ledger view, or document).
  - Carry → T7: commitPass accepts passes for stopped runs — scanner must not commit after stop(); surface scriptBounds uses.barstate/barIndex as a warning; after DuplicatePassError reload from loadState.
  - T6 fix commit d233a15 (399 pass; equality exact). Migration 3 for run_log index. Re-review dispatched (sonnet).
  - Task 6: fix round 1/5 (all addressed, 0 open; commits 8722f7f..d233a15)
  - Task 6: minor (deferred): Math.max spread in htf check over huge bucket; step() appends before !core check; partial first bucket open not checked.
Task 6: complete (commits b25facd..d233a15, review clean)
- Pushed worktree-plan-2-scanner after T6.
- Task 7: dispatching (BASE d233a15, implementer opus).
  - T7 dispatched: agent a43748cce6a952f25 (BASE d233a15). Dispatch carried all T1–T6 carries (funding Ruling B/G, isProcessed-before-step, reload on Duplicate/Stale, no commit after stop, sizingRule, delisting sequence, lastCloseTime, missing/behind, shared price/mark stream, warm-up retry/backoff + onboardDate, budget.banned, script warnings, log vocabulary).
  - T7 DONE_WITH_CONCERNS, commit 637c66a (431 pass; 32 new tests; 10 mutations). SMOKE (real Binance, KyberSwing 15m): universe 519, warm-up 616 s, no 429/418, peak weight 1189/1200, first pass 519 pairs in 595 ms. Feed emitted close ~11.5 s after boundary (LiveFeed CLOSE_WAIT + REST retries) → misses 10 s deadline end-to-end. Ticks during a pass dropped; reload re-warms all pairs (minutes); chart+htf same symbol/tf may prune each other (harmless at limit 1); run.ts 632 lines (split ledger/run-pass/types/warmup). Review dispatched (opus).
  - T7 Review 1: Needs fixes — Critical: live fill then full-bar walk (exits before entries, phantom liquidation; mid-bar market fills at bar open). Important: funding lost on live close after funding time; due() REST inside pass + asks too far; RUN_LIMIT per process; pause leaves resting entries; delisted pair in feed during warm-up; latency unmonitored (11.5 s).
  - Ruling H2: orders carry activation time; walkPath ignores orders activated after bar open (ticks cover rest of bar); mid-bar market intents fill at next tick via fillMarketAt — replay unaffected (all orders at bar boundaries) — cost: a wick between ticks after a mid-bar activation can be missed.
  - Ruling I: one RunManager per DB via manager_lease (heartbeat 10 s, stale 30 s); RUN_LIMIT counts DB running+paused; CLI control via DB status picked up within a heartbeat; SIGINT releases lease, keeps status (T8 resumes) — cost: small table + poll.
  - Ruling J: LiveFeed close-anchored deadline (emit by closeTime+7 s, first REST bounded, late symbols → missing) becomes Task 7b after T7 — reviewer: structural defect; T7 adds latencyMs + deadline_missed — cost: one extra small task.
  - Fix round 1 sent to a43748cce6a952f25 (+ minors 1,2,3,4,5).
PAUSED by owner (usage ~94%): T7 fix-round-1 implementer stopped mid-work. Partial work committed as WIP commit (see git log). On resume: inspect WIP diff vs 637c66a, SendMessage a43748cce6a952f25 to continue fix round 1 (same findings + rulings H2/I/J), then re-review (base 637c66a), then Task 7b (LiveFeed close-anchored deadline), Task 8, final review.
