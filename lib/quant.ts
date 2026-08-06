// ─── Quant Toolkit ──────────────────────────────────────────────────────────
// Statistical helpers a discretionary/systematic quant desk would lean on:
// trend regression, mean-reversion z-scores, probability calibration,
// risk-adjusted performance stats, and Kelly-criterion position sizing.

import type { Trade } from './types';

// ─── Trend: Least-Squares Linear Regression ────────────────────────────────
// Fits a line to the last `period` prices and returns the slope normalized
// as "% of price per bar" plus R² (0-1) as a measure of how clean the trend
// is. A steep, high-R² slope is a much stronger trend signal than a raw
// two-point rate-of-change — it's resistant to single-tick noise.
export function linearRegression(
  prices: number[],
  period: number = 20
): { slopePct: number; r2: number } | null {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const n = slice.length;
  const xMean = (n - 1) / 2;
  const yMean = slice.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (i - xMean) * (slice[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  if (denominator === 0) return { slopePct: 0, r2: 0 };
  const slope = numerator / denominator;
  const intercept = yMean - slope * xMean;

  // R²: how much variance the fitted line explains
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fitted = slope * i + intercept;
    ssRes += (slice[i] - fitted) ** 2;
    ssTot += (slice[i] - yMean) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  // Express slope as % price change per bar, scaled by trend length so a
  // slope held over the full window is comparable across periods.
  const slopePct = yMean !== 0 ? (slope / yMean) * 100 : 0;

  return { slopePct, r2 };
}

// ─── Mean Reversion: Z-Score ────────────────────────────────────────────────
// How many standard deviations the current price sits from its rolling
// mean. Extreme readings (|z| > 2) flag statistically stretched moves that
// tend to snap back — a classic mean-reversion filter to fade momentum
// chasing at exhaustion points.
export function zScore(prices: number[], period: number = 20): number | null {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (prices[prices.length - 1] - mean) / sd;
}

// ─── Probability Calibration ────────────────────────────────────────────────
// Squashes a bounded signal score (~[-1, 1]) into a win-probability estimate
// via a logistic function. `k` controls how aggressively the mapping curves
// toward 0/1 — higher k means the model claims more confidence per unit of
// signal strength.
export function sigmoid(x: number, k: number = 4): number {
  return 1 / (1 + Math.exp(-k * x));
}

// Combines the technical+news composite score into a directional win
// probability (0-1, 0.5 = coin flip). Not a guarantee — it's a calibration
// curve, not a backtested edge.
export function winProbability(combinedScore: number, k: number = 4): number {
  return sigmoid(combinedScore, k);
}

// ─── News Decay ──────────────────────────────────────────────────────────
// A news read has a "half-life" — its relevance to price decays over time.
// Blend an LLM-reported confidence with a time-decay factor so an hour-old
// headline stops carrying full weight in the trading decision.
export function newsEffectiveWeight(
  ageMs: number,
  confidence: number = 1,
  halfLifeMs: number = 15 * 60_000
): number {
  const decay = Math.pow(0.5, ageMs / halfLifeMs);
  return Math.max(0, Math.min(1, confidence)) * decay;
}

// ─── Windowed Trend Summary (day / week / month monitoring) ───────────────
// Summarizes a price series restricted to a trailing time window — e.g. the
// last 24h, 7d, or 30d — into a % change plus a regression-confirmed trend
// read. Used for the "what has this market actually been doing lately"
// monitoring panel, distinct from the tick-level trading signals.
export type TrendWindow = {
  changePct: number;
  slopePct: number;
  r2: number;
  points: number;
};

export function trendSummary(
  history: { t: number; p: number }[],
  windowMs: number,
  now: number = Date.now()
): TrendWindow | null {
  const cutoffSec = (now - windowMs) / 1000;
  const slice = history.filter((pt) => pt.t >= cutoffSec);
  if (slice.length < 2) return null;
  const prices = slice.map((pt) => pt.p);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const changePct = first !== 0 ? ((last - first) / first) * 100 : 0;
  const reg = linearRegression(prices, prices.length) || { slopePct: 0, r2: 0 };
  return { changePct, slopePct: reg.slopePct, r2: reg.r2, points: slice.length };
}

// ─── Performance Statistics ─────────────────────────────────────────────────
export type TradeStats = {
  totalTrades: number;
  winRate: number; // 0-1
  avgWinPct: number;
  avgLossPct: number; // positive number
  profitFactor: number | null; // gross win / gross loss
  expectancyPct: number; // avg pnl% per trade
  sharpe: number | null; // mean/std of per-trade returns
  sortino: number | null; // mean/downside-std of per-trade returns
  maxDrawdownPct: number | null;
};

export function computeTradeStats(trades: Trade[]): TradeStats {
  const closed = trades.filter((t) => typeof t.pnlPct === 'number');
  const returns = closed.map((t) => t.pnlPct as number);

  if (returns.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      profitFactor: null,
      expectancyPct: 0,
      sharpe: null,
      sortino: null,
      maxDrawdownPct: null,
    };
  }

  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r < 0);
  const winRate = wins.length / returns.length;
  const avgWinPct = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLossPct = losses.length
    ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
    : 0;
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : null;
  const expectancyPct = returns.reduce((a, b) => a + b, 0) / returns.length;

  const mean = expectancyPct;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? mean / sd : null;

  const downside = returns.filter((r) => r < 0);
  const downsideVariance = downside.length
    ? downside.reduce((a, b) => a + b ** 2, 0) / downside.length
    : 0;
  const downsideSd = Math.sqrt(downsideVariance);
  const sortino = downsideSd > 0 ? mean / downsideSd : null;

  // Max drawdown across the chronological (oldest-first) equity path implied
  // by cumulative closed-trade PnL%.
  const chronological = [...closed].reverse();
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of chronological) {
    cum += t.pnlPct as number;
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
  }

  return {
    totalTrades: returns.length,
    winRate,
    avgWinPct,
    avgLossPct,
    profitFactor,
    expectancyPct,
    sharpe,
    sortino,
    maxDrawdownPct: maxDd,
  };
}

// ─── Kelly Criterion ─────────────────────────────────────────────────────
// f* = W - (1-W)/R, where W = win rate, R = avg win / avg loss.
// Full Kelly is aggressive and assumes stationary edge; we return a
// half-Kelly fraction (industry-standard haircut for estimation error) and
// clamp to a sane band so a lucky streak can't blow up position sizing.
export function kellyFraction(
  winRate: number,
  avgWinPct: number,
  avgLossPct: number,
  minTrades: number = 8,
  sampleSize: number = 0
): number | null {
  if (sampleSize < minTrades || avgLossPct <= 0 || avgWinPct <= 0) return null;
  const R = avgWinPct / avgLossPct;
  const full = winRate - (1 - winRate) / R;
  const half = full / 2;
  return Math.max(0, Math.min(0.5, half));
}
