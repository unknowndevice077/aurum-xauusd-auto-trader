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
const FALLBACK_PRICE = 4000;

async function fetchLivePrice(lastPrice: number | null): Promise<{ price: number; label: string }> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://api.metals.live/v1/spot/gold', {
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(t);
    const json = await res.json();
    const last = Array.isArray(json) ? json[json.length - 1] : null;
    const seed = last ? Number(last[1] ?? last.price) : null;
    if (seed && seed > 100 && seed < 100000) {
      return { price: seed, label: 'Live spot (metals.live)' };
    }
    throw new Error('bad seed');
  } catch {
    const base = lastPrice ?? FALLBACK_PRICE;
    const noise = (Math.random() - 0.5) * 0.004;
    return { price: Math.max(1, base * (1 + noise)), label: 'Simulated (live feed unavailable)' };
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

  let adjustedThreshold = preset.threshold;
  if (consecutiveLosses >= 3) {
    adjustedThreshold = Math.min(0.5, adjustedThreshold * (1 + consecutiveLosses * 0.15));
  }

  const regimeNowKey = regimeKey(
    classifyRegime(regression, rsi, bbWidth, canUseNews ? news!.bias : null)
  );

  if (state.botRunning) {
    if (portfolio.oz > 0 && portfolio.entryPrice != null) {
      const posThreshold = portfolio.positionThreshold ?? preset.threshold;
      const posBeTriggerPct = portfolio.positionBeTriggerPct ?? preset.beTriggerPct;
      const posUsesNews = portfolio.positionUsesNews ?? canUseNews;

      const closePosition = (reasoning: string): number => {
        const proceeds = portfolio.oz * nextPrice;
        const pnl = (nextPrice - portfolio.entryPrice!) * portfolio.oz;
        const pnlPct = ((nextPrice - portfolio.entryPrice!) / portfolio.entryPrice!) * 100;
        const trade: Trade = {
          id: now,
          ts: nowSec,
          time: new Date(now).toLocaleString(),
          side: 'SELL',
          price: nextPrice,
          oz: portfolio.oz,
          value: proceeds,
          pnl,
          pnlPct,
          reasoning,
        };
        portfolio = {
          ...portfolio,
          cash: portfolio.cash + proceeds,
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
        consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
      } else if (portfolio.tpPrice != null && nextPrice >= portfolio.tpPrice) {
        closePosition('Take-profit hit');
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
        if (heldMs >= MIN_HOLD_MS && combined < -posThreshold) {
          const reasoning = !posUsesNews
            ? `Downtrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (server, math-only)`
            : `${tech <= 0 ? 'Downtrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment < 0 ? 'negative' : 'cooling'}`;
          const pnl = closePosition(reasoning);
          consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
        }
      }
    } else if (portfolio.oz === 0 && portfolio.cash > reserveFloor) {
      const tech = technicalScore(
        nextPrice, ema12, ema26, rsi, macd, macdSignal, atr, bbWidth, prices, regression, mrz
      );
      const combined = canUseNews ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment : tech;

      const regimeStatsNow = computeRegimeStats(portfolio.trades);
      const matchedRegimeStat = regimeStatsNow.find((s) => s.regime === regimeNowKey);
      const regimeAdj = regimeThresholdAdjustment(matchedRegimeStat);
      const brainBlocked = regimeShouldBlock(matchedRegimeStat);

      if (!brainBlocked && combined > adjustedThreshold + regimeAdj) {
        let effectiveLotOz = state.lotOz;
        if (state.useKelly) {
          const stats = computeTradeStats(portfolio.trades);
          const kelly = kellyFraction(stats.winRate, stats.avgWinPct, stats.avgLossPct, 8, stats.totalTrades);
          if (kelly != null && nextPrice > 0) {
            const kellyOz = (portfolio.cash * kelly) / nextPrice;
            effectiveLotOz = Math.min(state.lotOz, kellyOz);
          }
        }

        const sized = calculatePositionSize(portfolio.cash, effectiveLotOz, nextPrice, atr, preset.slPct);
        const maxSpend = Math.max(0, portfolio.cash - reserveFloor);
        const spendScale = sized.spend > 0 ? Math.min(1, maxSpend / sized.spend) : 0;
        const spend = sized.spend * spendScale;
        const oz = sized.oz * spendScale;

        if (spend >= 0.01 && oz > 0) {
          const slPrice = nextPrice * (1 - sized.actualSlPct);
          const tpPrice = nextPrice * (1 + preset.tpPct);
          const brainNote =
            matchedRegimeStat && matchedRegimeStat.trades >= 6
              ? ` · brain: ${(matchedRegimeStat.winRate * 100).toFixed(0)}% win in "${regimeNowKey}" (${matchedRegimeStat.trades} past trades)`
              : '';
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
            reasoning: `${reasoning} · SL $${slPrice.toFixed(2)} / TP $${tpPrice.toFixed(2)}${brainNote}`,
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
            positionThreshold: adjustedThreshold,
            positionBeTriggerPct: preset.beTriggerPct,
            positionUsesNews: canUseNews,
            trades: [trade, ...portfolio.trades].slice(0, 100),
          };
        }
      }
    }
  }

  const equityCurve = [
    ...state.equityCurve,
    { t: now, value: portfolio.cash + portfolio.oz * nextPrice },
  ];

  return {
    ...state,
    price: nextPrice,
    priceHistory,
    dataSourceLabel: label,
    portfolio,
    equityCurve,
    consecutiveLosses,
    news,
    lastNewsAt,
    lastTickAt: now,
    updatedAt: now,
  };
}
