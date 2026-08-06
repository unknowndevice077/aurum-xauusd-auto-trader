// ─── Global Bot State (server-side) ────────────────────────────────────────
// One shared portfolio, ticked by an external cron hitting /api/tick, so it
// keeps trading whether or not anyone has the page open. State lives in
// Upstash Redis (REST API, no SDK dependency needed) so it survives across
// serverless invocations — Vercel functions have no persistent memory of
// their own between requests.
//
// Without UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN configured, this
// falls back to an in-process variable — fine for local `next dev` (the
// process stays warm), but on Vercel every cold start gets a blank slate.
// The always-on bot genuinely requires the Upstash env vars to work in
// production.

import type { Portfolio } from './types';
import { DEFAULT_START_CASH_FALLBACK, DEFAULT_LOT_OZ } from './riskPresets';

export type ServerNews = {
  sentiment_score: number;
  confidence: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  key_driver: string;
  ts: number;
  providerLabel: string;
};

export type GlobalBotState = {
  price: number | null;
  priceHistory: { t: number; p: number }[];
  dataSourceLabel: string;
  portfolio: Portfolio;
  equityCurve: { t: number; value: number }[];
  botRunning: boolean;
  riskKey: string;
  startCash: number;
  lotOz: number; // fixed lot size in oz, user-chosen — not auto-scaled by capital
  useKelly: boolean; // opt-in: when true, Kelly can shrink (never grow) the lot
  consecutiveLosses: number;
  news: ServerNews | null;
  lastNewsAt: number | null;
  lastTickAt: number | null;
  updatedAt: number;
};

const PRICE_HISTORY_CAP = 1500;
const EQUITY_CURVE_CAP = 800;

export function freshPortfolio(cash: number): Portfolio {
  return {
    cash,
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
    trades: [],
  };
}

export function defaultState(startCash: number = DEFAULT_START_CASH_FALLBACK): GlobalBotState {
  return {
    price: null,
    priceHistory: [],
    dataSourceLabel: 'Not started yet — waiting for the first cron tick.',
    portfolio: freshPortfolio(startCash),
    equityCurve: [],
    botRunning: false,
    riskKey: 'balanced',
    startCash,
    lotOz: DEFAULT_LOT_OZ,
    useKelly: false,
    consecutiveLosses: 0,
    news: null,
    lastNewsAt: null,
    lastTickAt: null,
    updatedAt: Date.now(),
  };
}

const STATE_KEY = 'aurum:bot-state:v1';
const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export const hasPersistentStore = !!(REST_URL && REST_TOKEN);

// Only meaningful within a single warm process (local dev). On Vercel this
// resets on every cold start when Upstash isn't configured.
let memoryState: GlobalBotState | null = null;

export async function getState(): Promise<GlobalBotState> {
  if (REST_URL && REST_TOKEN) {
    const res = await fetch(`${REST_URL}/get/${STATE_KEY}`, {
      headers: { Authorization: `Bearer ${REST_TOKEN}` },
      cache: 'no-store',
    });
    if (!res.ok) return defaultState();
    const data = await res.json().catch(() => null);
    if (data?.result) {
      try {
        const parsed = JSON.parse(data.result);
        return { ...defaultState(parsed.startCash), ...parsed };
      } catch {
        return defaultState();
      }
    }
    return defaultState();
  }
  return memoryState ?? defaultState();
}

export async function setState(state: GlobalBotState): Promise<void> {
  const trimmed: GlobalBotState = {
    ...state,
    priceHistory: state.priceHistory.slice(-PRICE_HISTORY_CAP),
    equityCurve: state.equityCurve.slice(-EQUITY_CURVE_CAP),
    portfolio: { ...state.portfolio, trades: state.portfolio.trades.slice(0, 100) },
  };

  if (REST_URL && REST_TOKEN) {
    await fetch(`${REST_URL}/set/${STATE_KEY}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(trimmed),
      cache: 'no-store',
    });
    return;
  }
  memoryState = trimmed;
}
