import { smaSeriesFull } from './indicators';
import type { Candle } from '../components/PriceChart';
import type { Trade, ProviderKey, NewsResult } from './types';

export function fmtUSD(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Adaptive-precision oz formatter — a $10,000 account's positions round
// fine to 4 decimals, but a micro account can hold e.g. 0.00004 oz, which
// would print as "0.0000" at fixed precision. Widen the precision as the
// quantity shrinks so small accounts don't just see zeroes.
export function fmtOz(oz: number | null | undefined): string {
  if (oz === null || oz === undefined || isNaN(oz)) return '--';
  if (oz === 0) return '0.0000';
  const decimals = oz < 0.0001 ? 8 : oz < 0.001 ? 6 : 4;
  return oz.toFixed(decimals);
}

export function buildCandles(rawPoints: { t: number; p: number }[], groupSize: number): Candle[] {
  const points = rawPoints.filter(
    (pt) =>
      pt &&
      typeof pt.t === 'number' &&
      typeof pt.p === 'number' &&
      !isNaN(pt.t) &&
      !isNaN(pt.p)
  );
  const prices = points.map((pt) => pt.p);
  const sma20s = smaSeriesFull(prices, 20);
  const sma50s = smaSeriesFull(prices, 50);
  const candles: Candle[] = [];
  for (let i = 0; i < points.length; i += groupSize) {
    const chunk = points.slice(i, i + groupSize);
    if (chunk.length === 0) continue;
    const endIdx = Math.min(i + groupSize, points.length) - 1;
    const o = chunk[0].p;
    const c = chunk[chunk.length - 1].p;
    const h = Math.max(...chunk.map((pt) => pt.p));
    const l = Math.min(...chunk.map((pt) => pt.p));
    candles.push({
      time: chunk[0].t,
      o,
      h,
      l,
      c,
      sma20: sma20s[endIdx],
      sma50: sma50s[endIdx],
    });
  }
  return candles;
}

export function backfillTradePnl(trades: Trade[]): Trade[] {
  const chronological = [...trades].reverse();
  let openBuy: Trade | null = null;
  const withPnl = chronological.map((t) => {
    if (t.side === 'BUY') {
      openBuy = t;
      return t;
    }
    if (typeof t.pnl === 'number') {
      openBuy = null;
      return t;
    }
    if (openBuy) {
      const pnl = (t.price - openBuy.price) * t.oz;
      const pnlPct = ((t.price - openBuy.price) / openBuy.price) * 100;
      openBuy = null;
      return { ...t, pnl, pnlPct };
    }
    return t;
  });
  return withPnl.reverse();
}

export async function fetchNewsAnalysis({
  providerKey,
  apiKey,
  model,
}: {
  providerKey: ProviderKey;
  apiKey: string;
  model: string;
}): Promise<NewsResult> {
  const res = await fetch('/api/news', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerKey, apiKey, model }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'News request failed');
  return data as NewsResult;
}
