// ─── One Live Tick (server-side) ───────────────────────────────────────────
// The always-on counterpart to the client's setInterval tick loop and the
// backtest's per-bar loop — same strategy (technical scoring, fixed-lot
// sizing, optional Kelly sizing, the regime brain, breakeven/trailing stop),
// but driven by a single external call (the cron hitting /api/tick) instead
// of a timer, and priced from a real live feed instead of a random walk.

import { computeIndicators, technicalScore, calculatePositionSize } from './indicators';
import {
  linearRegression,
  zScore,
  kellyFraction,
  computeTradeStats,
  newsEffectiveWeight,
  markToMarketEquity,
} from './quant';
import {
  classifyRegime,
  regimeKey,
  computeRegimeStats,
  regimeThresholdAdjustment,
  regimeShouldBlock,
} from './brain';
import { RISK_PRESETS, RESERVE_FLOOR_PCT } from './riskPresets';
import { fetchServerNews } from './newsProvider';
import type { GlobalBotState } from './serverState';
import type { Trade } from './types';

const TECH_WEIGHT = 0.55;
const NEWS_WEIGHT = 0.45;
const NEWS_REFRESH_MS = 20 * 60_000; // throttle LLM calls to at most once per 20 min
const MIN_HOLD_MS = 90_000; // at least one prior tick's worth of cadence before a signal exit
// After closing a position, don't re-enter for a bit — otherwise the same
// noise that just triggered an exit can immediately re-trigger an entry.
const EXIT_COOLDOWN_MS = 5 * 60_000;
// A signal has to stay past the entry/exit threshold across at least one
// more tick before it's acted on, not just touch it once — the same
// confirmation discipline a discretionary technical trader applies instead
// of reacting to the first tick that crosses a line.
const SIGNAL_CONFIRM_MS = 60_000;
const FALLBACK_PRICE = 4000;

// Prices come from Yahoo Finance's GC=F (COMEX gold futures) chart endpoint —
// the same source /api/history already uses for the backtest, so the live bot
// and the backtest are priced off one feed rather than two that can disagree.
//
// This previously used api.metals.live, which has since stopped responding
// entirely (TLS handshake failure). Because the failure was caught and
// swallowed into the random-walk fallback below, the bot kept "working" while
// quietly trading synthetic prices — the label was the only clue. That
// fallback is still here (an unattended cron shouldn't die on one bad
// response), but it is now clearly labelled as not-real so it can't be
// mistaken for live data in the UI.
async function fetchLivePrice(lastPrice: number | null): Promise<{ price: number; label: string }> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=1m',
      {
        signal: controller.signal,
        cache: 'no-store',
        // Yahoo rejects requests without a browser-ish User-Agent.
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AurumTerminal/1.0)' },
      }
    );
    clearTimeout(t);
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;

    // Prefer the live quote; fall back to the last close so the bot still
    // gets a real number outside futures trading hours.
    const live = Number(meta?.regularMarketPrice);
    const prevClose = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    const price = Number.isFinite(live) && live > 0 ? live : prevClose;

    if (Number.isFinite(price) && price > 100 && price < 100000) {
      return { price, label: 'Live COMEX gold futures (Yahoo GC=F)' };
    }
    throw new Error('no usable price in Yahoo response');
  } catch {
    const base = lastPrice ?? FALLBACK_PRICE;
    const noise = (Math.random() - 0.5) * 0.004;
    return {
      price: Math.max(1, base * (1 + noise)),
      label: 'NOT REAL — synthetic prices, live feed unreachable',
    };
  }
}

export async function runOneTick(state: GlobalBotState): Promise<GlobalBotState> {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const { price: nextPrice, label } = await fetchLivePrice(state.price);

  const priceHistory = [...state.priceHistory, { t: nowSec, p: nextPrice }];
  const prices = priceHistory.map((pt) => pt.p);

  const { ema12, ema26, rsi, atr, bbWidth, macd, macdSignal } = computeIndicators(prices);
  const regression = linearRegression(prices, 20);
  const mrz = zScore(prices, 20);

  // Throttled news refresh — a fresh LLM call every tick would be wasteful
  // (news doesn't move that fast) and could burn through API credits fast
  // on an unattended schedule.
  let news = state.news;
  let lastNewsAt = state.lastNewsAt;
  if (!lastNewsAt || now - lastNewsAt >= NEWS_REFRESH_MS) {
    const fetched = await fetchServerNews();
    if (fetched) {
      news = fetched;
      lastNewsAt = now;
    }
  }
  const canUseNews = !!news;
  const newsAgeWeight = news ? newsEffectiveWeight(now - news.ts, news.confidence) : 0;
  const sentiment = news ? news.sentiment_score * newsAgeWeight : 0;

  const preset = RISK_PRESETS[state.riskKey] ?? RISK_PRESETS.balanced;
  const reserveFloor = Math.max(state.startCash * RESERVE_FLOOR_PCT, 0.01);

  let portfolio = { ...state.portfolio };
  let consecutiveLosses = state.consecutiveLosses;
  let lastExitAt = state.lastExitAt;
  let pendingEntrySince = state.pendingEntrySince;
  let pendingExitSince = state.pendingExitSince;

  let adjustedThreshold = preset.threshold;
  if (consecutiveLosses >= 3) {
    adjustedThreshold = Math.min(0.5, adjustedThreshold * (1 + consecutiveLosses * 0.15));
  }

  const regimeNow = classifyRegime(regression, rsi, bbWidth, canUseNews ? news!.bias : null);
  const regimeNowKey = regimeKey(regimeNow);
  // Chop filter: classifyRegime already calls a market 'Flat' when the
  // regression R² < 0.3 (a line that doesn't actually fit the recent price
  // path) or the slope is too shallow to call a direction. Most of this
  // bot's losing trades are round-trips inside exactly that condition — RSI
  // oscillating through 50 with no real trend underneath it. Block new
  // entries outright when there's no trend to follow; a discretionary
  // trader wouldn't take a trend-following entry in a range either.
  const trendConfirmed = regimeNow.trend !== 'Flat';

  if (state.botRunning) {
    if (portfolio.oz > 0 && portfolio.entryPrice != null) {
      const posThreshold = portfolio.positionThreshold ?? preset.threshold;
      const posBeTriggerPct = portfolio.positionBeTriggerPct ?? preset.beTriggerPct;
      const posUsesNews = portfolio.positionUsesNews ?? canUseNews;

      const closePosition = (reasoning: string): number => {
        const pnl = (nextPrice - portfolio.entryPrice!) * portfolio.oz;
        const pnlPct = ((nextPrice - portfolio.entryPrice!) / portfolio.entryPrice!) * 100;
        // Return the margin that was actually committed plus/minus P&L —
        // not oz * price (the full notional). Crediting the full notional
        // back against a margin-only debit would fabricate the leveraged
        // portion of the position as free money.
        const returned = (portfolio.marginUsed ?? portfolio.oz * portfolio.entryPrice!) + pnl;
        const trade: Trade = {
          id: now,
          ts: nowSec,
          time: new Date(now).toLocaleString(),
          side: 'SELL',
          price: nextPrice,
          oz: portfolio.oz,
          value: returned,
          pnl,
          pnlPct,
          reasoning,
        };
        portfolio = {
          ...portfolio,
          cash: portfolio.cash + Math.max(0, returned),
          oz: 0,
          entryPrice: null,
          entryTs: null,
          peakPrice: null,
          slPrice: null,
          tpPrice: null,
          beActive: false,
          positionThreshold: null,
          positionBeTriggerPct: null,
          positionUsesNews: null,
          marginUsed: null,
          trades: [trade, ...portfolio.trades].slice(0, 100),
        };
        return pnl;
      };

      if (portfolio.slPrice != null && nextPrice <= portfolio.slPrice) {
        const label2 = !portfolio.beActive
          ? 'Stop-loss hit'
          : portfolio.slPrice > portfolio.entryPrice
            ? 'Trailing stop hit (profit locked)'
            : 'Breakeven stop hit';
        const pnl = closePosition(label2);
        lastExitAt = now;
        pendingEntrySince = null;
        pendingExitSince = null;
        consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
      } else if (portfolio.tpPrice != null && nextPrice >= portfolio.tpPrice) {
        closePosition('Take-profit hit');
        lastExitAt = now;
        pendingEntrySince = null;
        pendingExitSince = null;
        consecutiveLosses = 0;
      } else {
        const newPeak = Math.max(portfolio.peakPrice ?? portfolio.entryPrice, nextPrice);
        if (!portfolio.beActive && portfolio.tpPrice != null) {
          const beTriggerPrice =
            portfolio.entryPrice + (portfolio.tpPrice - portfolio.entryPrice) * posBeTriggerPct;
          if (nextPrice >= beTriggerPrice) {
            portfolio = { ...portfolio, slPrice: portfolio.entryPrice, beActive: true, peakPrice: newPeak };
          } else {
            portfolio = { ...portfolio, peakPrice: newPeak };
          }
        } else if (portfolio.beActive) {
          const trailDistance = atr ? atr * 1.5 : nextPrice * preset.slPct * 0.6;
          const candidateSl = Math.max(portfolio.entryPrice, newPeak - trailDistance);
          const nextSl = Math.max(portfolio.slPrice ?? portfolio.entryPrice, candidateSl);
          portfolio = { ...portfolio, slPrice: nextSl, peakPrice: newPeak };
        } else {
          portfolio = { ...portfolio, peakPrice: newPeak };
        }

        const heldMs = portfolio.entryTs != null ? now - portfolio.entryTs : Infinity;
        const tech = technicalScore(
          nextPrice, ema12, ema26, rsi, macd, macdSignal, atr, bbWidth, prices, regression, mrz
        );
        const combined = posUsesNews ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment : tech;

        const exitSignalActive = combined < -posThreshold;
        if (!exitSignalActive) {
          pendingExitSince = null;
        } else if (pendingExitSince == null) {
          pendingExitSince = now;
        }
        const exitConfirmed =
          exitSignalActive && pendingExitSince != null && now - pendingExitSince >= SIGNAL_CONFIRM_MS;

        if (heldMs >= MIN_HOLD_MS && exitConfirmed) {
          const reasoning = !posUsesNews
            ? `Downtrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (server, math-only)`
            : `${tech <= 0 ? 'Downtrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment < 0 ? 'negative' : 'cooling'}`;
          const pnl = closePosition(reasoning);
          lastExitAt = now;
          pendingEntrySince = null;
          pendingExitSince = null;
          consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
        }
      }
    } else if (
      portfolio.oz === 0 &&
      portfolio.cash > reserveFloor &&
      (lastExitAt == null || now - lastExitAt >= EXIT_COOLDOWN_MS)
    ) {
      const tech = technicalScore(
        nextPrice, ema12, ema26, rsi, macd, macdSignal, atr, bbWidth, prices, regression, mrz
      );
      const combined = canUseNews ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment : tech;

      const regimeStatsNow = computeRegimeStats(portfolio.trades);
      const matchedRegimeStat = regimeStatsNow.find((s) => s.regime === regimeNowKey);
      const regimeAdj = regimeThresholdAdjustment(matchedRegimeStat);
      const brainBlocked = regimeShouldBlock(matchedRegimeStat);

      const entrySignalActive = trendConfirmed && !brainBlocked && combined > adjustedThreshold + regimeAdj;
      if (!entrySignalActive) {
        pendingEntrySince = null;
      } else if (pendingEntrySince == null) {
        pendingEntrySince = now;
      }
      const entryConfirmed =
        entrySignalActive && pendingEntrySince != null && now - pendingEntrySince >= SIGNAL_CONFIRM_MS;

      if (entryConfirmed) {
        const leverage = state.leverage || 1;
        let effectiveLotOz = state.lotOz;
        if (state.useKelly) {
          const stats = computeTradeStats(portfolio.trades);
          const kelly = kellyFraction(stats.winRate, stats.avgWinPct, stats.avgLossPct, 8, stats.totalTrades);
          if (kelly != null && nextPrice > 0) {
            const kellyOz = (portfolio.cash * kelly * leverage) / nextPrice;
            effectiveLotOz = Math.min(state.lotOz, kellyOz);
          }
        }

        const sized = calculatePositionSize(portfolio.cash, effectiveLotOz, nextPrice, atr, preset.slPct, leverage);
        const maxSpend = Math.max(0, portfolio.cash - reserveFloor);
        const spendScale = sized.spend > 0 ? Math.min(1, maxSpend / sized.spend) : 0;
        const spend = sized.spend * spendScale;
        const oz = sized.oz * spendScale;

        if (spend >= 0.01 && oz > 0) {
          // Effective stop can never sit looser than the leverage
          // liquidation floor — at high leverage the margin cushion can be
          // tighter than the preset's own stop-loss %.
          const slPrice = Math.max(nextPrice * (1 - sized.actualSlPct), sized.liqPrice);
          const tpPrice = nextPrice * (1 + preset.tpPct);
          const brainNote =
            matchedRegimeStat && matchedRegimeStat.trades >= 6
              ? ` · brain: ${(matchedRegimeStat.winRate * 100).toFixed(0)}% win in "${regimeNowKey}" (${matchedRegimeStat.trades} past trades)`
              : '';
          const leverageNote = leverage > 1 ? ` · ${leverage}x, notional $${sized.notional.toFixed(0)}` : '';
          const reasoning = !canUseNews
            ? `Uptrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (server, math-only)`
            : `${tech >= 0 ? 'Uptrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment >= 0 ? 'supportive' : 'cautious'}`;
          const trade: Trade = {
            id: now,
            ts: nowSec,
            time: new Date(now).toLocaleString(),
            side: 'BUY',
            price: nextPrice,
            oz,
            value: spend,
            reasoning: `${reasoning} · SL $${slPrice.toFixed(2)} / TP $${tpPrice.toFixed(2)}${brainNote}${leverageNote}`,
            regime: regimeNowKey,
          };
          portfolio = {
            ...portfolio,
            cash: portfolio.cash - spend,
            oz: portfolio.oz + oz,
            entryPrice: nextPrice,
            entryTs: now,
            peakPrice: nextPrice,
            slPrice,
            tpPrice,
            beActive: false,
            marginUsed: spend,
            positionThreshold: adjustedThreshold,
            positionBeTriggerPct: preset.beTriggerPct,
            positionUsesNews: canUseNews,
            trades: [trade, ...portfolio.trades].slice(0, 100),
          };
          pendingEntrySince = null;
        }
      }
    }
  }

  const equityCurve = [
    ...state.equityCurve,
    {
      t: now,
      value: markToMarketEquity(portfolio.cash, portfolio.oz, portfolio.entryPrice, portfolio.marginUsed, nextPrice),
    },
  ];

  return {
    ...state,
    price: nextPrice,
    priceHistory,
    dataSourceLabel: label,
    portfolio,
    equityCurve,
    consecutiveLosses,
    lastExitAt,
    pendingEntrySince,
    pendingExitSince,
    news,
    lastNewsAt,
    lastTickAt: now,
    updatedAt: now,
  };
}
