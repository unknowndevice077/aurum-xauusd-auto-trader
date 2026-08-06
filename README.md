# Aurum — XAU/USD Paper Trading Terminal

A Next.js paper-trading terminal for gold (XAU/USD). It runs a rules-based
technical + optional LLM-news strategy across three modes — an always-on
server-side bot, a local per-browser simulation, and a historical
backtester — all sharing the same underlying signal/risk logic so results
are comparable across them. No real orders are placed, no brokerage is
connected, and nothing here is financial advice.

## The three tabs (`app/page.tsx`)

- **Always-On Bot** (`components/AlwaysOnBot.tsx`) — one shared portfolio
  that keeps trading 24/7 whether or not anyone has the page open. State
  lives server-side (Upstash Redis, see below) and is advanced by an
  external cron hitting `/api/tick`, not by anything running in your
  browser tab.
- **Local Simulation** (`components/AurumTerminal.tsx`) — a per-browser
  simulation ticking on a `setInterval` in the client, with its own
  portfolio persisted to `localStorage`. Useful for watching the strategy
  reason in real time (chart, live signal score, market-memory panel).
- **Backtest** (`components/BacktestPanel.tsx`) — replays the strategy
  against real historical daily GC=F data (`/api/history`), with
  date-range/year filtering and honest statistics (see below).

## Strategy

- **Indicators** (`lib/indicators.ts`): EMA12/26, Wilder's RSI14, ATR14,
  Bollinger Bands, MACD, combined into a single `technicalScore`.
- **Quant overlay** (`lib/quant.ts`): 20-period least-squares regression
  (slope % + R²) for trend strength, a rolling z-score for mean-reversion,
  a logistic win-probability calibration, Kelly-criterion sizing (opt-in,
  half-Kelly, capped), equity-curve-based Sharpe/Sortino/max-drawdown,
  Wilson-score win-rate confidence intervals, and single-bar price-anomaly
  detection (flags likely data-feed artifacts, e.g. unadjusted futures
  rollovers, without silently altering the data).
- **Market memory / "brain"** (`lib/brain.ts`): classifies the current
  market into a regime bucket (trend × RSI zone × volatility × news bias)
  and tracks the bot's own historical win rate per bucket. A regime with a
  strong track record nudges the entry threshold down; a regime with a
  poor one (enough samples to trust it) nudges it up or blocks entry
  outright.
- **Chop filter**: `classifyRegime` calls the market "Flat" when the
  regression R² < 0.3 or the slope is too shallow to call a direction. New
  entries are hard-blocked in that condition — trend-following signals
  otherwise whipsaw badly in a sideways/range-bound market (RSI oscillating
  through 50 with no real trend under it).
- **Signal confirmation + re-entry cooldown**: an entry/exit score has to
  stay past its threshold across an extra tick/bar, not just touch it once,
  before it's acted on; and after any exit there's a cooldown before
  re-entering — both applied to stop the bot from reacting to single-tick
  noise. Stop-loss and take-profit are exempt (instant, since they're risk
  controls, not signal calls).
- **Position sizing**: fixed lot size in oz, set by the user, not scaled by
  account size/tier. An optional Kelly toggle can *shrink* (never grow) the
  lot based on the bot's own trailing win rate/avg win/avg loss.
- **Leverage** (1x–20x, default 1x/off): at 1x, buying a lot costs its full
  notional value in cash (`lotOz * price`) — at gold's price that puts even
  a modest lot out of reach for a small account, silently shrinking every
  trade down to whatever cash affords regardless of the lot size
  configured. Raising leverage requires only `notional / leverage` in
  margin instead, the same mechanism real gold CFD/forex brokers use, so a
  small account can actually trade the lot size it set. Closing a position
  returns the margin plus/minus P&L (not the full notional) and a
  liquidation floor — the price at which a position's margin would be
  fully lost — always takes priority over the preset's own stop-loss if
  leverage makes the margin cushion tighter.
- **Exits**: hard stop-loss and take-profit, a breakeven arm once price
  moves a configurable fraction toward TP, and a genuine trailing stop that
  ratchets behind the peak price (via ATR) once breakeven is armed.
- **Risk presets** (`lib/riskPresets.ts`): Conservative / Balanced /
  Aggressive, each setting the entry threshold, SL/TP %, and breakeven
  trigger %.

The same strategy logic (`technicalScore`, sizing, brain, chop filter,
confirmation/cooldown) is reimplemented per-engine to match each engine's
time granularity (seconds for the local sim, minutes for the server bot,
days for the backtest) — see `lib/liveStep.ts` (server), the trading
effect in `components/AurumTerminal.tsx` (local), and `lib/backtest.ts`
(historical).

## Backtest honesty

`lib/backtest.ts` builds a real dollar equity curve and derives Sharpe,
Sortino, and max drawdown from it (not from summing per-trade % returns,
which misstates drawdown once position size varies trade-to-trade). Win
rate is reported with a 95% Wilson-score confidence interval, and the UI
warns on small sample sizes (<30 trades) and discloses any detected price
anomalies in the underlying data rather than hiding them.

## Project structure

- `app/`
  - `page.tsx` — tabbed shell (Always-On Bot / Local Simulation / Backtest).
  - `api/history/route.ts` — historical daily price data (Yahoo Finance
    GC=F), `?range=1y|2y|5y|10y|25y` (no `max` — Yahoo silently downsamples
    that to monthly bars).
  - `api/news/route.ts` — client-triggered LLM news/sentiment read for the
    local simulation (bring your own API key).
  - `api/state/route.ts` — public read of the always-on bot's current
    global state.
  - `api/control/route.ts` — start/pause/reset the always-on bot, change
    risk preset, lot size, or the Kelly toggle.
  - `api/tick/route.ts` — advances the always-on bot by one tick; meant to
    be called by an external cron, gated by `CRON_SECRET`.
- `components/` — `AurumTerminal.tsx` (local sim), `AlwaysOnBot.tsx`
  (server-bot control panel), `BacktestPanel.tsx`, `PriceChart.tsx`.
- `lib/` — `indicators.ts`, `quant.ts`, `brain.ts`, `backtest.ts`,
  `liveStep.ts` (server-side single-tick strategy), `serverState.ts`
  (Upstash-backed global state), `newsProvider.ts` (server-side LLM news
  fetch), `riskPresets.ts`, `theme.ts`, `types.ts`, `helpers.ts`.

## 1. Run it locally

```bash
npm install
```

Create a `.env` file in the project root. All keys are optional — the app
runs fully in math-only mode with none of them set:

```
# Local Simulation's LLM news mode (client picks provider, brings its own key)
OPENAI_API_KEY=sk-...
# and/or ANTHROPIC_API_KEY=..., XAI_API_KEY=...

# Always-On Bot's server-side news fetch (only server keys are ever used here)
ANTHROPIC_API_KEY=...

# Always-on server bot persistence (see below) — without these, the bot
# still runs locally but resets on every dev-server restart / cold start
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...

# Shared secret required to call /api/tick
CRON_SECRET=...
```

```bash
npm run dev
```

Open http://localhost:3000.

## 2. Making the Always-On Bot actually always-on

Vercel functions have no memory between invocations, so the bot needs two
things outside the app itself:

1. **Upstash Redis** — a free Redis DB (REST API, no SDK) so bot state
   survives across serverless cold starts. Add
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` to your Vercel
   project's env vars. Without these, `/api/state` reports
   `persistent: false` and state only survives while a single dev process
   stays warm.
2. **An external cron** hitting `/api/tick?secret=<CRON_SECRET>` every 1–5
   minutes (e.g. [cron-job.org](https://cron-job.org) — Vercel's own Hobby
   plan cron is limited to once/day, too infrequent for this).

## 3. Deploy to Vercel

See [DEPLOYING.md](DEPLOYING.md).

## Notes

- **Math-only mode** (technical indicators only, no LLM) needs no API key
  and costs nothing — it's the default until a key is configured.
- **News mode** (Local Simulation) calls `/api/news` periodically while
  enabled; that's the only place client-side LLM tokens get spent. The
  Always-On Bot's news read is separate, server-side, and throttled to at
  most once per ~20 minutes.
- Local Simulation's portfolio and provider/model choice persist per
  browser via `localStorage`, not shared across devices. The Always-On
  Bot's portfolio is one shared global state, independent of any browser.
- Grok's real-time X/Twitter access isn't wired here — this uses xAI's
  plain chat-completions endpoint, so like OpenAI it answers from general
  knowledge rather than live search. Only the Anthropic path has web search
  enabled (`web_search_20250305`).
- There's no auth model for the always-on bot's controls — it's a personal
  paper-trading tool, not multi-tenant. It can't move real money, only a
  shared simulated portfolio.
