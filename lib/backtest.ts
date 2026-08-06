// ─── Backtest Engine ─────────────────────────────────────────────────────
// Replays the same strategy the live bot runs — technical scoring, fixed-lot
// sizing, optional Kelly sizing, the regime "brain", and the
// breakeven/trailing stop — against real historical daily closes instead of
// live simulated ticks. This is a pure function: no timers, no React state,
// just a fast pass over the price array.
//
// Two honest limitations, both surfaced in the result and in the UI:
//  1. Only daily closes are available (Yahoo GC=F) — no intraday highs/
//     lows, so a stop-loss/take-profit is checked against the day's close,
//     not against whatever the price did intraday. Real intraday execution
//     would differ.
//  2. There is no historical news feed — the LLM sentiment blend can't be
//     backtested, so this always runs in math-only (technical + brain) mode.

import { computeIndicators, technicalScore, calculatePositionSize } from './indicators';
import {
  linearRegression,
  zScore,
  kellyFraction,
  computeTradeStats,
  maxDrawdownFromEquityCurve,
  annualizedRiskStats,
  winRateConfidenceInterval,
  detectPriceAnomalies,
  type TradeStats,
  type PriceAnomaly,
} from './quant';
import {
  classifyRegime,
  regimeKey,
  computeRegimeStats,
  regimeThresholdAdjustment,
  regimeShouldBlock,
} from './brain';
import { RISK_PRESETS, RESERVE_FLOOR_PCT, type RiskPresetKey } from './riskPresets';
import type { Trade } from './types';

const WARMUP_BARS = 50; // computeIndicators needs 50+ closes before it returns real values
// Same discipline as the live/server engines, expressed in real elapsed
// time (bars here are ~1 day apart): don't re-enter right after an exit,
// and require a signal to persist across at least one more bar before
// acting on it, rather than firing on the first bar that crosses the line.
const EXIT_COOLDOWN_SEC = 2 * 86400;
const SIGNAL_CONFIRM_SEC = 86400;

export type BacktestResult = {
  trades: Trade[]; // newest-first, matching the live trade ledger's convention
  equityCurve: { t: number; value: number }[];
  startCash: number;
  finalEquity: number;
  totalReturnPct: number;
  stats: TradeStats;
  winRateCI: { low: number; high: number } | null;
  anomalies: PriceAnomaly[]; // unusually large single-bar moves in the input data — disclosed, not altered
  barsTraded: number;
  dateRange: { from: number; to: number } | null;
};

export function runBacktest(
  history: { t: number; p: number }[],
  opts: {
    riskKey: RiskPresetKey | string;
    startCash: number;
    lotOz: number;
    useKelly?: boolean;
    from?: number;
    to?: number;
  }
): BacktestResult | null {
  const preset = RISK_PRESETS[opts.riskKey];
  if (!preset) return null;

  const allPoints = history
    .filter(
      (pt) => pt && typeof pt.t === 'number' && typeof pt.p === 'number' && !isNaN(pt.t) && !isNaN(pt.p)
    )
    .sort((a, b) => a.t - b.t);

  // Respect an optional end date (never look past it), but keep real
  // preceding history for indicator warmup even when a mid-range start
  // date is chosen — starting a 20/50-bar indicator cold exactly at the
  // user's chosen window boundary would bias the first few signals.
  const points = opts.to != null ? allPoints.filter((pt) => pt.t <= opts.to!) : allPoints;
  if (points.length < WARMUP_BARS + 5) return null;

  const rangeStartIdx =
    opts.from != null ? points.findIndex((pt) => pt.t >= opts.from!) : WARMUP_BARS;
  const startIdx = Math.max(WARMUP_BARS, rangeStartIdx === -1 ? points.length : rangeStartIdx);
  if (startIdx >= points.length) return null;

  const anomalies = detectPriceAnomalies(points.slice(Math.max(0, startIdx - WARMUP_BARS)));

  const reserveFloor = Math.max(opts.startCash * RESERVE_FLOOR_PCT, 0.01);

  let cash = opts.startCash;
  let oz = 0;
  let entryPrice: number | null = null;
  let peakPrice: number | null = null;
  let slPrice: number | null = null;
  let tpPrice: number | null = null;
  let beActive = false;
  let positionThreshold: number | null = null;
  let positionBeTriggerPct: number | null = null;
  let consecutiveLosses = 0;
  let lastExitAt: number | null = null;
  let pendingEntrySince: number | null = null;
  let pendingExitSince: number | null = null;

  // Chronological (oldest first) while building; reversed at the end to
  // match the live ledger's newest-first convention.
  const trades: Trade[] = [];
  const equityCurve: { t: number; value: number }[] = [];

  for (let i = startIdx; i < points.length; i++) {
    const prices = points.slice(0, i + 1).map((pt) => pt.p);
    const price = prices[prices.length - 1];
    const ts = points[i].t;

    const { ema12, ema26, rsi, atr, bbWidth, macd, macdSignal } = computeIndicators(prices);
    const regression = linearRegression(prices, 20);
    const mrz = zScore(prices, 20);
    const regimeNowKey = regimeKey(classifyRegime(regression, rsi, bbWidth, null));

    let adjustedThreshold = preset.threshold;
    if (consecutiveLosses >= 3) {
      adjustedThreshold = Math.min(0.5, adjustedThreshold * (1 + consecutiveLosses * 0.15));
    }

    if (oz > 0 && entryPrice != null) {
      const posThreshold = positionThreshold ?? preset.threshold;
      const posBeTriggerPct = positionBeTriggerPct ?? preset.beTriggerPct;

      const closePosition = (reasoning: string) => {
        const proceeds = oz * price;
        const pnl = (price - (entryPrice as number)) * oz;
        const pnlPct = ((price - (entryPrice as number)) / (entryPrice as number)) * 100;
        trades.push({
          id: i,
          ts,
          time: new Date(ts * 1000).toLocaleDateString(),
          side: 'SELL',
          price,
          oz,
          value: proceeds,
          pnl,
          pnlPct,
          reasoning,
        });
        cash += proceeds;
        oz = 0;
        entryPrice = null;
        peakPrice = null;
        slPrice = null;
        tpPrice = null;
        beActive = false;
        positionThreshold = null;
        positionBeTriggerPct = null;
        return pnl;
      };

      if (slPrice != null && price <= slPrice) {
        const label = !beActive
          ? 'Stop-loss hit'
          : slPrice > entryPrice
            ? 'Trailing stop hit (profit locked)'
            : 'Breakeven stop hit';
        const pnl = closePosition(label);
        lastExitAt = ts;
        pendingEntrySince = null;
        pendingExitSince = null;
        consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
      } else if (tpPrice != null && price >= tpPrice) {
        closePosition('Take-profit hit');
        lastExitAt = ts;
        pendingEntrySince = null;
        pendingExitSince = null;
        consecutiveLosses = 0;
      } else {
        const newPeak = Math.max(peakPrice ?? entryPrice, price);
        if (!beActive && tpPrice != null) {
          const beTriggerPrice = entryPrice + (tpPrice - entryPrice) * posBeTriggerPct;
          if (price >= beTriggerPrice) {
            slPrice = entryPrice;
            beActive = true;
          }
          peakPrice = newPeak;
        } else if (beActive) {
          const trailDistance = atr ? atr * 1.5 : price * preset.slPct * 0.6;
          const candidateSl = Math.max(entryPrice, newPeak - trailDistance);
          slPrice = Math.max(slPrice ?? entryPrice, candidateSl);
          peakPrice = newPeak;
        } else {
          peakPrice = newPeak;
        }

        const tech = technicalScore(
          price, ema12, ema26, rsi, macd, macdSignal, atr, bbWidth, prices, regression, mrz
        );

        const exitSignalActive = tech < -posThreshold;
        if (!exitSignalActive) {
          pendingExitSince = null;
        } else if (pendingExitSince == null) {
          pendingExitSince = ts;
        }
        const exitConfirmed =
          exitSignalActive && pendingExitSince != null && ts - pendingExitSince >= SIGNAL_CONFIRM_SEC;

        if (exitConfirmed) {
          const pnl = closePosition(
            `Downtrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (backtest, math-only)`
          );
          lastExitAt = ts;
          pendingEntrySince = null;
          pendingExitSince = null;
          consecutiveLosses = pnl < 0 ? consecutiveLosses + 1 : 0;
        }
      }
    } else if (
      oz === 0 &&
      cash > reserveFloor &&
      (lastExitAt == null || ts - lastExitAt >= EXIT_COOLDOWN_SEC)
    ) {
      const tech = technicalScore(
        price, ema12, ema26, rsi, macd, macdSignal, atr, bbWidth, prices, regression, mrz
      );

      const regimeStatsNow = computeRegimeStats(trades);
      const matchedRegimeStat = regimeStatsNow.find((s) => s.regime === regimeNowKey);
      const regimeAdj = regimeThresholdAdjustment(matchedRegimeStat);
      const brainBlocked = regimeShouldBlock(matchedRegimeStat);

      const entrySignalActive = !brainBlocked && tech > adjustedThreshold + regimeAdj;
      if (!entrySignalActive) {
        pendingEntrySince = null;
      } else if (pendingEntrySince == null) {
        pendingEntrySince = ts;
      }
      const entryConfirmed =
        entrySignalActive && pendingEntrySince != null && ts - pendingEntrySince >= SIGNAL_CONFIRM_SEC;

      if (entryConfirmed) {
        // Fixed lot size by default — the user's chosen oz amount is used
        // exactly. Kelly is opt-in: when enabled, it can only shrink the
        // lot (never grow it beyond what was requested), based on realized
        // win rate / avg win-loss once there's enough trade history.
        let effectiveLotOz = opts.lotOz;
        if (opts.useKelly) {
          const stats = computeTradeStats([...trades].reverse());
          const kelly = kellyFraction(stats.winRate, stats.avgWinPct, stats.avgLossPct, 8, stats.totalTrades);
          if (kelly != null && price > 0) {
            const kellyOz = (cash * kelly) / price;
            effectiveLotOz = Math.min(opts.lotOz, kellyOz);
          }
        }

        const sized = calculatePositionSize(cash, effectiveLotOz, price, atr, preset.slPct);
        const maxSpend = Math.max(0, cash - reserveFloor);
        const spendScale = sized.spend > 0 ? Math.min(1, maxSpend / sized.spend) : 0;
        const spend = sized.spend * spendScale;
        const ozBought = sized.oz * spendScale;

        if (spend >= 0.01 && ozBought > 0) {
          const brainNote =
            matchedRegimeStat && matchedRegimeStat.trades >= 6
              ? ` · brain: ${(matchedRegimeStat.winRate * 100).toFixed(0)}% win in "${regimeNowKey}" (${matchedRegimeStat.trades} past trades)`
              : '';
          trades.push({
            id: i,
            ts,
            time: new Date(ts * 1000).toLocaleDateString(),
            side: 'BUY',
            price,
            oz: ozBought,
            value: spend,
            reasoning: `Uptrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (backtest, math-only)${brainNote}`,
            regime: regimeNowKey,
          });
          cash -= spend;
          oz += ozBought;
          entryPrice = price;
          peakPrice = price;
          slPrice = price * (1 - sized.actualSlPct);
          tpPrice = price * (1 + preset.tpPct);
          beActive = false;
          positionThreshold = adjustedThreshold;
          positionBeTriggerPct = preset.beTriggerPct;
          pendingEntrySince = null;
        }
      }
    }

    equityCurve.push({ t: ts, value: cash + oz * price });
  }

  const finalPrice = points[points.length - 1].p;
  const finalEquity = cash + oz * finalPrice;
  const totalReturnPct = ((finalEquity - opts.startCash) / opts.startCash) * 100;
  const tradesDesc = [...trades].reverse(); // newest-first, matches live ledger

  // Win rate / avg win-loss / profit factor / expectancy come from the
  // per-trade stats as before (those are correctly per-trade metrics).
  // Sharpe, Sortino, and max drawdown are recomputed from the real $
  // equity curve instead — computeTradeStats' version of those three
  // approximates via summed trade %, which misstates drawdown whenever
  // position size varies between trades (it does here, under Kelly/tier
  // sizing) and isn't annualized.
  const tradeStats = computeTradeStats(tradesDesc);
  const { sharpe, sortino } = annualizedRiskStats(equityCurve);
  const stats: TradeStats = {
    ...tradeStats,
    sharpe,
    sortino,
    maxDrawdownPct: maxDrawdownFromEquityCurve(equityCurve),
  };

  const closedCount = tradesDesc.filter((t) => typeof t.pnlPct === 'number').length;
  const wins = tradesDesc.filter((t) => typeof t.pnlPct === 'number' && (t.pnlPct as number) > 0).length;
  const winRateCI = winRateConfidenceInterval(wins, closedCount);

  return {
    trades: tradesDesc,
    equityCurve,
    startCash: opts.startCash,
    finalEquity,
    totalReturnPct,
    stats,
    winRateCI,
    anomalies,
    barsTraded: points.length - startIdx,
    dateRange: points.length > startIdx ? { from: points[startIdx].t, to: points[points.length - 1].t } : null,
  };
}
