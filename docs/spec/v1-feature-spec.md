# Pine Strategy Paper-Trading Scanner: v1 Feature Spec

Nov 22, 2026 · @Abdul Mubin

## Overview

v1 is a private web app that scans every perpetual futures pair on one exchange with a pasted Pine Script strategy, and paper-trades every entry and exit signal the strategy produces, using real exchange fees, funding and pair rules.

It is a scanner, not a single-chart tester. The user does not pick pairs. They pick an exchange, and the app runs the script on every perpetual pair that exchange lists, the way a screener scans a market. The script decides which pairs get a trade and when.

- **Paper only.** No live trading, no exchange accounts, no API keys. The Live Trading option is shown but disabled.
- **Forward only.** It trades on live prices from the moment a run starts. It has no historical backtesting for users in v1.
- **Private.** It runs on the owner's server, is reachable only by the owner, and has no sign-up, sharing or public pages.
- **Crypto only.** Forex and stocks appear in the wizard as disabled options.

## How a run works

1. The owner pastes a Pine strategy, picks Paper Trading, then crypto, an exchange, a timeframe, the paper balance and the position-size rule.
2. An overview screen shows every choice. The owner edits anything, then approves. The run starts.
3. The app builds the list of every active perpetual pair on that exchange and loads enough past candles for each pair to warm up the script's indicators.
4. At every candle close on the chosen timeframe, the script runs on every pair in the list.
5. Wherever the script issues an entry or exit order, the paper broker handles it: it checks the pair's rules and the free balance, then simulates the fill with the exchange's fees and slippage.
6. While positions are open, the broker charges funding at the exchange's real funding times, watches stops and limit orders on live prices, and closes positions that hit them or get liquidated.
7. The dashboard shows the account, open positions, closed trades and the scanner's health, live.
8. The run keeps going until the owner pauses or stops it. It survives server restarts.

## Setup wizard and approval screen

One step per screen, in this order. Every step has Back, and the last step is the approval screen.

| Step | What the user does | Notes |
| --- | --- | --- |
| 1. Script | Pastes Pine v5 or v6 source and gives the run a name | Validated on paste (see Pine engine). Errors show with line numbers and block Next. |
| 2. Mode | Chooses Paper Trading or Live Trading | Live Trading is visible, disabled, labelled "coming later". |
| 3. Market | Chooses Crypto, Forex or Stocks | Only Crypto is selectable. The others are disabled. |
| 4. Exchange | Chooses one of five exchanges | Choice sets the fee schedule, funding data and the pair list. v1 ships with Binance only; the other four are listed as "soon". |
| 5. Timeframe | Chooses the timeframe the script runs on | Defaults to the chart timeframe the script declares, if any. |
| 6. Paper money | Enters the starting balance in USD | Positive number, no upper limit. |
| 7. Position size | Chooses "Use the script's own size" (default) or "Fixed amount per trade" and enters USD | See Paper broker for how each works. |
| 8. Overview | Reviews every choice and approves | Shows the fee and funding rules in use, the number of pairs to be scanned, and any script settings the platform overrides. |

No leverage question is asked. The app takes each pair's limits from the exchange (see Paper broker).

**After approval**

- Editable, with a warning and a log entry: the position-size rule and the fee rates.
- Locked: the script, exchange, timeframe and starting balance. Changing any of them means starting a new run, so a run's results always come from one fixed setup.
- Every change is recorded in the run's history with the time it took effect. It applies from then on, never to past trades.

## Scanner and pair universe

- **Universe.** Every perpetual contract the chosen exchange lists as actively trading, quoted in USDT or the exchange's main stablecoin. Delisted, suspended and non-crypto contracts (commodities, stocks, indices) are excluded.
- **Automatic refresh.** The list is rebuilt from the exchange every hour. New listings join once they have enough history for the script. Delisted pairs are dropped, and any open position in one is closed at the last price with a log note.
- **Short history.** Each script needs a minimum number of candles to warm up (for example, a 200-day average needs 200 days). A pair with less history than that is skipped and shown as "insufficient history" until it has enough. It never causes an error or a trade.
- **All pairs at once.** Hundreds of pairs close their candles at the same instant. The scanner must finish a full pass within a few seconds of each candle close and must not hit exchange rate limits. It shares one live data feed per pair across all runs, and it loads history gradually when a run starts.
- **Scanner status** is always visible: pairs in the universe, pairs scanned on the last close, pairs skipped and why, the time of the last pass and how long it took.
- **Signal order.** When several pairs signal on the same candle, they are handled in order of highest 24-hour volume first. If the free balance runs out, later signals are skipped and logged as "no free balance".

## Paper broker

One shared paper account per run. Every pair's trades draw on the same balance, the way a real futures account works.

**Orders and fills**

- A signal on a candle close produces market orders that fill at the next candle's open price, plus slippage. This matches TradingView's default behaviour.
- Stop, limit and stop-limit orders are watched against live prices and trigger when the price crosses them. A stop that is gapped through fills at the first available price, not at the stop level.
- One net position per pair, long or short. The script's own pyramiding setting decides whether it can add to a position.

**Position size**

- *Use the script's own size* (default). The script's order quantity is used as written. Anything in the script that reads account equity (for example, risk-based sizing) must see this run's shared account equity.
- *Fixed amount per trade.* Every entry uses the same USD amount, ignoring the script's quantity. The number of open positions is then limited by the free balance.
- Quantities are always rounded down to the pair's lot size. An order below the pair's minimum notional is rejected and logged.

**Costs, from the exchange**

- **Trading fees:** the exchange's base maker and taker rates, charged on every fill. The owner can edit the rates to reflect a fee tier or discount.
- **Funding:** charged or paid at each of the pair's real funding times, using the actual published funding rate, on every open position's notional value. Longs pay when the rate is positive and shorts receive it, and the reverse when negative. Funding changes the account balance and appears as its own line in the trade log.
- **Slippage:** a small fixed amount applied to every market fill, shown on the approval screen. The default is 0.02% and it is editable.

**Pair rules and margin**

- Each pair's tick size, lot size, minimum order value and maximum leverage come from the exchange's public data. Where the exchange does not publish a pair's leverage limit, use a conservative default and mark that pair "leverage estimated" in the UI.
- Margin is isolated per position. Margin used is the position's value divided by the leverage in force for that pair; the leverage in force is the lower of the script's declared margin setting and the pair's exchange maximum.
- A position is liquidated if its loss reaches the margin held, using a simplified version of the exchange's maintenance-margin rule. The loss is booked as a trade closed by liquidation.
- A new entry is rejected if it would need more margin than the free balance.

## Pine engine

- **Use an existing Pine runtime**, not a new interpreter. PineTS (TypeScript) is the first candidate. The choice is the builder's to confirm in the first task (see Build order).
- **Accepted scripts:** Pine v5 and v6 scripts that declare `strategy()`. A script that declares `indicator()` or `library()` is rejected with a clear message that v1 runs strategies only.
- **Validation on paste:** the script must compile and run on a short sample of candles before the owner can continue. Errors and unsupported functions are listed with line numbers. A script using a function the runtime lacks fails here, never later in a live run.
- **Multi-timeframe data:** `request.security` calls must work, including on a higher timeframe such as daily, and must not use data from a candle that has not closed yet.
- **Settings the platform overrides:** the script's declared starting capital, commission and slippage are ignored in favour of the wizard's choices. The approval screen lists each one it overrides, with the script's value and the value in use. Script-declared pyramiding and margin settings are respected.
- **One script instance per pair.** State kept by the script (variables that persist between candles) is stored per pair and survives restarts.
- **Sandboxing.** Scripts run in an isolated worker with limits on CPU time, memory and run time per pass. A script that exceeds a limit is stopped, the pair is flagged, and other pairs are unaffected. The owner will paste scripts from the TradingView community library, so treat all script code as untrusted.

## Dashboard

One page per run, updating live, with a list of all runs on the home screen.

- **Account:** starting balance, current balance, equity (balance plus open profit and loss), free margin, total fees paid, total funding paid or received.
- **Equity curve** since the run started.
- **Open positions:** pair, side, size, entry price, current price, profit and loss, margin, liquidation price, and the stop level if the script set one.
- **Closed trades:** pair, side, entry and exit time and price, profit and loss, fees, funding, and the exit reason (signal, stop, target, liquidation, delisting). Sortable and filterable by pair and side, with a CSV export.
- **Summary numbers:** trade count, win rate, profit factor, average win and loss, biggest win and loss, and maximum drawdown so far.
- **Scanner status:** the figures listed under Scanner and pair universe, plus a list of pairs skipped or in error.
- **Settings and history:** the approved setup, the script text, and the log of every settings change.
- **Run controls:** pause, resume and stop. Pause stops new entries, still manages open positions and keeps charging funding. Stop closes nothing and freezes the run for review.

## Reliability and access

**Runs**

- Several runs can be active at once (up to a limit the owner can set, default 5), each with its own script, balance and settings, and fully isolated from the others. Runs on the same exchange and timeframe share one live data feed.

**Never lose a trade**

- All run state is saved to disk after every candle pass: balance, positions, open orders, each script's stored variables and the trade log.
- On start or restart, the app fetches every candle it missed from the exchange and replays them through the scripts in order, so signals and stop triggers during the downtime are still handled.
- Each candle is processed exactly once per pair, so a restart or a repeated message never causes a duplicate trade.
- If the live data connection drops, the app reconnects, fills any gap from the exchange's history and shows a visible warning until it has caught up.

**Access**

- One owner account with a strong password, served over HTTPS only. There is no registration page, no password sharing and no public pages.
- Login attempts are rate-limited, and the session expires after inactivity.
- No exchange API keys are ever stored. The app only reads public market data.

## Not in v1

- Live trading, exchange account connections and API keys.
- Historical backtesting available to the user. (An internal replay tool for testing the engine is required; see Acceptance tests.)
- Forex and stocks, and any exchange beyond Binance.
- Indicator-only scripts and alerts. Only `strategy()` scripts run.
- Choosing pairs by hand, or filtering the pair list by volume. The universe is the whole exchange.
- Mobile apps, notifications, charts with trade markers, and multiple users.

## Acceptance tests and build order

v1 is done when all of these pass.

1. **Engine matches TradingView.** Replay KyberSwing.pine on recorded BTCUSDT 4h candles from Jan 1, 2024 to Nov 18, 2026 through an internal test tool. TradingView's strategy tester gave 58 trades, a 32.8% win rate, profit factor 1.71 and +22.6% net profit on that window. The app should land within a few trades of that. If it does not, nothing else it reports can be trusted.
2. **Multi-timeframe works.** The same replay must produce correct daily-filter regimes and no repainting from unclosed higher-timeframe candles.
3. **Costs are exact.** On a recorded week of data, a hand-calculated trade with known fees, slippage and funding payments matches the app's trade log to the cent.
4. **Scanner scale.** A full pass over all pairs finishes within a few seconds of a candle close, with no exchange rate-limit errors.
5. **Restart recovery.** Stop the server for several candles with open positions and a pending stop, restart it, and confirm that missed signals, stop triggers and funding are all handled with no duplicate trades.
6. **Access.** The app is unreachable without the owner login.

**Suggested build order**

1. Spike: run KyberSwing.pine through the chosen Pine runtime and pass test 1. If the runtime fails, try the next candidate before building anything else.
2. Exchange data layer: pair list and rules, candles, live feed, funding rates, fees.
3. Paper broker with fills, costs, margin and liquidation.
4. Scanner loop with state saving and restart recovery.
5. Wizard, approval screen and dashboard.
6. Login, sandboxing and hardening.

## Decisions to confirm

The brief was silent on these, so I chose a default. Change any that are wrong.

| Decision | Default chosen | Why |
| --- | --- | --- |
| How margin is set without asking for leverage | Lower of the script's margin setting and the pair's exchange maximum | Avoids a leverage question while respecting per-pair limits |
| Order of signals on the same candle | Highest 24-hour volume first | Gives the most liquid pairs the free balance |
| Locked vs editable after approval | Script, exchange, timeframe and balance locked; size rule and fees editable | Keeps a run's results from one fixed setup |
| Default slippage | 0.02% per market fill | A small realistic cost; editable |
| Indicator-only scripts | Rejected in v1 | They produce no orders to paper-trade |
| Pause behaviour | Stops new entries only; positions, stops and funding continue | A paused run stays honest |
| Number of simultaneous runs | 5, adjustable | Forward tests are slow, so parallel runs matter |
