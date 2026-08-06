// ─── Market Memory / "Brain" ────────────────────────────────────────────────
// A lightweight, fully local learning loop: bucket the market into discrete
// "regimes" (trend × RSI zone × volatility × news bias), and remember how
// the bot's own past trades performed in each bucket. This is a contextual
// win-rate table, not a neural net — but it's exactly the kind of
// conditional-edge bookkeeping systematic desks keep before trusting a
// signal in a given regime.

import type { Trade } from './types';
import type { linearRegression } from './quant';

type Regression = ReturnType<typeof linearRegression>;

export type Regime = {
  trend: 'Uptrend' | 'Downtrend' | 'Flat';
  rsiZone: 'Oversold' | 'Neutral' | 'Overbought';
  volRegime: 'Low vol' | 'Normal vol';
  newsBias: 'News bullish' | 'News neutral' | 'News bearish' | null;
};

export function classifyRegime(
  regression: Regression,
  rsi: number | null,
  bbWidth: number | null,
  newsBias: 'bullish' | 'bearish' | 'neutral' | null
): Regime {
  let trend: Regime['trend'] = 'Flat';
  if (regression && regression.r2 >= 0.3) {
    if (regression.slopePct > 0.02) trend = 'Uptrend';
    else if (regression.slopePct < -0.02) trend = 'Downtrend';
  }

  let rsiZone: Regime['rsiZone'] = 'Neutral';
  if (rsi != null) {
    if (rsi < 35) rsiZone = 'Oversold';
    else if (rsi > 65) rsiZone = 'Overbought';
  }

  const volRegime: Regime['volRegime'] = bbWidth != null && bbWidth < 0.3 ? 'Low vol' : 'Normal vol';

  const newsBiasLabel: Regime['newsBias'] =
    newsBias === 'bullish'
      ? 'News bullish'
      : newsBias === 'bearish'
        ? 'News bearish'
        : newsBias === 'neutral'
          ? 'News neutral'
          : null;

  return { trend, rsiZone, volRegime, newsBias: newsBiasLabel };
}

// Human-readable key used both for display and as the map key for stats.
export function regimeKey(r: Regime): string {
  return [r.trend, r.rsiZone, r.volRegime, r.newsBias].filter(Boolean).join(' · ');
}

export type RegimeStat = {
  regime: string;
  trades: number;
  winRate: number;
  avgPnlPct: number;
};

export function computeRegimeStats(trades: Trade[]): RegimeStat[] {
  const closed = trades.filter((t) => t.regime && typeof t.pnlPct === 'number');
  const map = new Map<string, { wins: number; total: number; pnlSum: number }>();
  for (const t of closed) {
    const key = t.regime as string;
    const entry = map.get(key) || { wins: 0, total: 0, pnlSum: 0 };
    entry.total++;
    entry.pnlSum += t.pnlPct as number;
    if ((t.pnlPct as number) > 0) entry.wins++;
    map.set(key, entry);
  }
  return Array.from(map.entries())
    .map(([regime, v]) => ({
      regime,
      trades: v.total,
      winRate: v.wins / v.total,
      avgPnlPct: v.pnlSum / v.total,
    }))
    .sort((a, b) => b.trades - a.trades);
}

// Learned threshold nudge: a regime with a strong historical edge lowers the
// bar to enter (more eager); a regime with a poor track record raises it
// (more cautious). Requires a minimum sample size before it trusts the data
// at all — with too few trades this is a no-op.
export function regimeThresholdAdjustment(
  stat: RegimeStat | undefined,
  minSamples: number = 6
): number {
  if (!stat || stat.trades < minSamples) return 0;
  if (stat.winRate >= 0.5) {
    return -Math.min(0.08, (stat.winRate - 0.5) * 0.25);
  }
  return Math.min(0.2, (0.5 - stat.winRate) * 0.5);
}

// Hard learned avoidance: regimes with a clearly negative track record and
// enough samples to trust it get skipped entirely rather than just
// penalized — the bot has "learned" this setup doesn't work for it.
export function regimeShouldBlock(stat: RegimeStat | undefined, minSamples: number = 8): boolean {
  if (!stat || stat.trades < minSamples) return false;
  return stat.winRate < 0.25 && stat.avgPnlPct < 0;
}
