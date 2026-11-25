# Pineapple: handoff for any coding agent

This is where v1 stands and how to continue it. Read this first.

## Where the work is
- Branch `worktree-plan-2-scanner` holds all current work. `main` only has Plan 1. Start from this branch.
- The newest commit is a WIP: `wip: pause mid Task 7 fix round 1 (partial, unreviewed)`. Review it before you build on it.

## Documents (read in this order)
1. `docs/spec/v1-feature-spec.md` is the product spec, written by the owner.
2. `docs/superpowers/specs/2026-11-23-pineapple-scanner-design.md` is the design, with the owner's decisions. Where it disagrees with the spec, the design wins. It fixes the size at 768 MB and 1 run.
3. `docs/spike/pinets-findings.md` covers the PineTS internals, resident instances with bounded history, and memory and speed numbers.
4. `docs/superpowers/plans/2026-11-23-plan-1-engine-broker-replay.md` is Plan 1. It is done and merged to main.
5. `docs/superpowers/plans/2026-11-24-plan-2-live-scanner.md` is Plan 2. It is in progress.
6. `docs/superpowers/plans/plan-2-progress-ledger.md` is the task-by-task progress log. It holds every ruling, deferred minor and carry item. Rulings are lines starting `Ruling`, and carries are lines starting `Carry →`.
7. `docs/superpowers/plans/plan-2-3-carry-notes.md` lists items Plans 2 and 3 must include.

## Status (2026-11-26)
- **Plan 1**: done and merged. It covers the engine, paper broker, replay, and acceptance tests 1–3. KyberSwing gives 59 trades, 32.2% win rate, PF 1.64 and +20.6%, against TradingView's 58, 32.8%, 1.71 and +22.6%.
- **Plan 2, Tasks 1–6**: done and reviewed. They cover the exchange client, the SQLite store and REST budget, the live feed, funding, layer snapshot/restore, the resident engine and the run store.
- **Plan 2, Task 7** (scanner, manager, CLI): built at commit 637c66a. A live smoke run covered 519 pairs, with a 0.6 s pass. Its review needs fixes: a Critical issue with live fills followed by a full-bar walk, plus 6 Important items. That fix round is part done in the WIP commit. The findings and Rulings H2, I and J are in the ledger.
- **Next steps:**
  1. Finish the Task 7 fixes and re-review them.
  2. Task 7b: LiveFeed close-anchored deadline (Ruling J).
  3. Task 8: restart recovery, plus acceptance tests 4 and 5. It must also include the ledger carries: bar_index rebase, flat warm-up versus restored position, and funding via FundingRepo for gaps over 30 days.
  4. The Plan 2 final whole-branch review.
- **Plan 3** (login, wizard, dashboard, isolate sandbox, Docker, deploy) is not planned yet. Write it from the spec, the design and the carry notes.

## Quality bar (owner requirement, not optional)
This software computes money: fills, fees, funding, margin, liquidation and P&L. The owner has said explicitly, more than once, that quality must not be traded for speed or cost.
- **Every task gets the full process.** That means TDD, a separate independent review, fix rounds until there is no open Critical or Important finding, and a scoped re-review after every fix.
- **Every plan ends with a final whole-branch review on the most capable model.**
- **Money maths is hand-checked by reviewers.** Acceptance tests (TradingView parity, costs exact to the cent, restart with no lost or duplicated trades) are never loosened without the owner's approval.
- **Never skip a review, merge a fix without its re-review, or relax a tolerance to make a test pass.**
- **Say plainly what is unverified.**

## How work is done here
- **Process:** one task at a time. A builder implements each task with TDD, a separate reviewer checks it, and fix rounds follow, each with a scoped re-review. A final whole-branch review closes each plan. The owner wants this full quality bar, with no shortcuts.
- **Commands:**
  - Run `npm ci`, then `npx vitest run`, then `npx tsc --noEmit`, then `npx eslint .`. All must be clean.
  - Tests run on fakes, with no network. The recorder and smoke runs use real public Binance endpoints.
- **Rules:**
  - Network code goes only in `src/net/**`. The allowlist is `fapi.binance.com` and `fstream.binance.com`. No API keys, ever.
  - Don't push to `main` without the owner's approval. Push the work branch after every completed task.
