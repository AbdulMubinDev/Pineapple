# Pineapple: Pine Strategy Paper-Trading Scanner — Design

Date: 2026-11-23 · Owner: Abdul Mubin

The requirements come from `docs/spec/v1-feature-spec.md` (the v1 spec). This document doesn't repeat it. It records the decisions made on top of it and how the parts fit. When this doc and the spec disagree, this doc wins.

## Intent

The owner wants to paste any Pine `strategy()` script, often one from the TradingView community library, and see how it would trade forward across the whole Binance USDT-M perpetual market. It has to be honest about fees, funding, lot sizes and liquidation, and it has to survive restarts. The results only matter if the engine reproduces TradingView's strategy tester. That's why matching TradingView is the first milestone and the gate for everything after it.

## Goals, non-goals, anti-goals

- **Goals:** everything in the v1 spec, running on the owner's shared server with a small, capped resource footprint.
- **Non-goals:** everything in the spec's "Not in v1", plus multi-server or multi-user scaling.
- **Anti-goals.** v1 is a failure even if it works, if it does any of these:
  - contains any code path that could place a real order or store an exchange key
  - lets a pasted script reach the network, the disk or other runs
  - reports numbers that silently drift from TradingView
  - starves the other application already running on the server
  - exposes the admin panel to the internet without the tunnel

## Constraints

- **Shared server.** Another production app runs on the same host. Pineapple gets a hard cap: Docker `mem_limit` 768 MB and `cpus` 1.0 by default, both set in `.env`. It must run normally inside that cap with the default limit of 5 runs.
- **Access only through a tunnel.** The HTTP server listens only on `127.0.0.1` (compose maps `127.0.0.1:${PORT}:${PORT}`). The owner reaches it through a tunnel of their choice (Cloudflare Tunnel, Tailscale or SSH forward). The tunnel provides HTTPS, so the app does not manage TLS certificates.
- **Outbound only to Binance.** The app contacts Binance. Binance never contacts the app.
- **Smallest timeframe is 15m.** The wizard offers 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h and 1d. Sizing and performance targets assume 15m is the worst case: 5 runs × all pairs, a pass every 15 minutes.
- **Binance is reachable.** The owner ran `fapi.binance.com/fapi/v1/ping` from the server on 2026-11-23 and got 200.
- **Fixed amount per trade is position size (notional), not margin.** For example, "$100" at 10x is a $100 position holding $10 margin.
- **The script arrives after login.** It is pasted in the wizard. No script ships with the app.
- The project lives in `C:\Users\abdul\Documents\Code\Pineapple`. It is new and empty, and is unrelated to `kyberfutures` and `srp_backtest`.

## Approaches considered

1. **All TypeScript on Node** (chosen). Node 24 server, PineTS for Pine, SQLite for state, React dashboard served as static files, all in one Docker container. It uses one language with PineTS, has the smallest footprint and has no database server. The owner chose it as "safe and good, low resources".
2. **Python server with Node Pine workers.** Rejected. It means two runtimes, an IPC bridge and more memory, for no v1 benefit.
3. **Docker Compose with Postgres and Redis.** Rejected. It costs extra resident memory on a shared server, and only multi-user or multi-host setups need it.

## Architecture (decided)

A single Node 24 process inside one container:

| Part | Choice |
|---|---|
| HTTP and API | Fastify. The dashboard gets live updates over Server-Sent Events, which are lighter than WebSockets and one-way is enough. |
| Dashboard | React + Vite, built to static files at image build time and served by Fastify. No dev server in production. |
| Storage | SQLite (`better-sqlite3`, WAL mode) on a mounted volume `./data`. |
| Pine engine | PineTS at a pinned version, run inside sandboxed isolates (see Sandboxing). |
| Exchange layer | One module that owns all Binance traffic: REST for exchange info, klines, funding history and premium index; WebSocket for live klines and prices. |
| Paper broker | Pure TypeScript with no I/O, so the replay tool and live runs share it exactly. |
| Scheduler | Fires a scanner pass per timeframe when Binance's closed-kline events arrive, with a timer fallback. |

### Network rules

- **Inbound:**
  - Bind `127.0.0.1` only.
  - Reject requests whose `Host` header isn't in `ALLOWED_HOSTS` (the tunnel hostname plus `localhost`). This blocks DNS-rebinding attempts.
  - Every state-changing request must carry an `Origin` that matches.
- **Outbound:**
  - All network calls go through the exchange module. It refuses any host not in a fixed allowlist: `fapi.binance.com`, `fstream.binance.com`, plus Binance's documented futures fallbacks if needed.
  - No other module imports `fetch`, `http` or `ws`. A lint rule enforces this.
  - Script isolates have no network at all.

### Login

- One owner account. There is no registration page. The password is set with a CLI command run inside the container, `pineapple set-password`, and stored as an argon2id hash.
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Strict`. It expires after 30 minutes of inactivity, configurable.
- Login is rate-limited to 5 attempts a minute per IP, with growing lockouts.
- Every route except `/login` and static assets requires a session.

### Sandboxing pasted scripts

- PineTS turns Pine into JavaScript. That code runs inside `isolated-vm` isolates: separate V8 heaps with no Node APIs, no network and no file system. Only candle data and a broker interface are passed in.
- There is a small pool of isolates, default 2 and set by `SCRIPT_WORKERS`. Each has a memory cap (default 96 MB) and a per-pass CPU timeout.
- A pair that breaches a limit is flagged in Scanner status, and the other pairs carry on.
- **Builder's call:** if PineTS can't run inside `isolated-vm`, for example because it needs Node APIs, fall back to child processes started with Node's `--permission` model (no fs write, no child processes, no workers) plus an in-process network block. Record which was used.

### Keeping resources low

- **Live data:**
  - One combined WebSocket connection carries the closed-kline stream for every pair at the timeframes active runs use. Split it when the stream count passes Binance's per-connection limit.
  - Two all-market streams cover live prices: last price (`!ticker@arr`) for stops and limits, and mark price (`!markPrice@arr@1s`) for liquidation and open P&L. There is no per-pair price socket.
- **History:** loaded gradually when a run starts and kept within 50% of Binance's REST weight budget. Each pair keeps only the candles its warm-up needs in memory. Older candles live in SQLite.
- **Sharing:** runs on the same timeframe share the candle cache and the feed. Each run has its own script instances and broker state.
- **Budget:** idle memory target under 250 MB. The default load is 5 runs × all pairs on 4h.

### Correctness and replay

- **Replay tool:** a CLI, `pineapple replay --script <file.pine> --symbol BTCUSDT --tf 4h --from ... --to ...`. It drives the same engine and broker from recorded candles and funding, and prints the trade list plus TradingView-style summary numbers. Acceptance tests 1–3 use it.
- **Fill timing:** for TradingView parity, fills follow the strategy tester's defaults. Market orders fill at the next bar's open plus slippage. In replay, stops and limits trigger on bar high and low the way TradingView simulates them. In live runs they trigger on the price stream.
- **Exactly once:** a `processed_candles(run_id, symbol, open_time)` unique key gives exactly-once handling. Each pass commits broker state, the trade log and that key in one SQLite transaction.
- **Restart:** the app backfills the candles it missed, then replays them in order through the same path before going live.

## The first milestone (gate)

Before any dashboard work, the builder runs a spike:

1. Check how much of `strategy.*` PineTS supports: entries and exits, stops and limits, pyramiding, `strategy.equity`, `request.security` on higher timeframes without lookahead.
2. Pass acceptance test 1 with the replay tool.

KyberSwing.pine and its TradingView numbers come from the owner later. Until then, the spike uses a simple public strategy that the owner also runs on TradingView to provide reference numbers.

If PineTS lacks `strategy()` support, the builder stops and reports to the owner with the gaps and the options. Options include adding a strategy layer over PineTS's indicator engine, or another runtime. The builder doesn't push ahead.

## Calls made after the builder review (owner to check)

- **The paper broker is the single source of truth.** The script never keeps its own book. `strategy.position_size`, `strategy.opentrades`, `strategy.equity` and related values are fed from the broker. This follows from the spec: equity-based sizing must see the shared account.
  - **Order model:** a strategy layer implements TradingView's order rules (pyramiding, `strategy.exit` brackets/OCA, `close_entries_rule`, partial exits) on top of the broker.
  - **Rejected, shrunk or liquidated orders:** what the script sees afterwards is what really happened to the account.
- **Warm-up runs flat.** Orders a script issues while it warms up are ignored. A run starts with no positions.
- **Default leverage is 1x.** A script with no `margin_long`/`margin_short` uses Pine's default of 100%, which is 1x, capped by the pair maximum as the spec says.
- **The replay tool has two modes.**
  - **TradingView mode** (test 1): matches the Properties-tab settings given with the reference numbers and turns off lot rounding, minimum notional, funding and liquidation.
  - **Binance mode** (tests 3 and 5): full realism.
  - Live runs always use Binance mode.
- **Test 1 pass threshold** (proposed):
  - trade count within ±3
  - win rate within ±3 points
  - profit factor within ±0.15
  - net profit within ±3 points
- **Live stops and limits:**
  - **Trigger and fill:** on last-traded price from the all-market ticker stream, the way Binance and TradingView do. Each closed candle's high/low is checked as well, so a wick between samples isn't missed.
  - **Mark price:** used only for liquidation and open P&L.
- **Test 4 target:** a full pass finishes within 10 seconds of candle close. If the resource cap can't hold everything, pass latency and the run limit give way. The memory/CPU cap never does.

## Left to the builder

- Folder layout, test framework and exact library versions. Pin everything.
- The SQLite schema, as long as it meets the exactly-once and per-pass transaction rules.
- How each script's stored variables survive a restart: either serialize PineTS state, or rebuild it by replaying stored candles from the warm-up start (deterministic). Pick whichever PineTS supports reliably, and test it with acceptance test 5.
- The simplified maintenance-margin formula, taken from Binance's published leverage brackets.
- Dashboard look: plain, fast, no chart library beyond a light one for the equity curve.
