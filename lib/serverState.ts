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
import { DEFAULT_START_CASH_FALLBACK, DEFAULT_LOT_OZ, DEFAULT_LEVERAGE } from './riskPresets';

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
  leverage: number; // 1 = cash-settled (off); >1 lets a lot's margin cost less than its full notional
  useKelly: boolean; // opt-in: when true, Kelly can shrink (never grow) the lot
  consecutiveLosses: number;
  lastExitAt: number | null; // re-entry cooldown — don't re-enter right into the noise that just exited
  pendingEntrySince: number | null; // signal confirmation: entry score has to stay past threshold, not just touch it once
  pendingExitSince: number | null;
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
    marginUsed: null,
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
    leverage: DEFAULT_LEVERAGE,
    useKelly: false,
    consecutiveLosses: 0,
    lastExitAt: null,
    pendingEntrySince: null,
    pendingExitSince: null,
    news: null,
    lastNewsAt: null,
    lastTickAt: null,
    updatedAt: Date.now(),
  };
}

const STATE_KEY = 'aurum:bot-state:v1';

// Env values get pasted by hand during setup, and the most common mistakes
// are mechanical rather than conceptual: surrounding quotes carried over
// from a .env snippet, stray whitespace/newlines, a trailing slash, or the
// whole `NAME="value"` line pasted when only the value was wanted. Left
// alone, those produce an unparseable URL, which makes fetch() throw and
// surfaces as an opaque 500 with nothing explaining it. Normalizing here is
// cheap and turns a confusing dead end into a working setup.
function normalizeEnv(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  // `UPSTASH_REDIS_REST_URL=https://...` pasted whole. Anchored to the known
  // prefix so it can't chew into a base64 token that happens to contain '='.
  const linePaste = s.match(/^UPSTASH_[A-Z0-9_]*\s*=\s*(.*)$/);
  if (linePaste) s = linePaste[1].trim();
  // Surrounding quotes (neither a URL nor an Upstash token contains one).
  s = s.replace(/^["']+/, '').replace(/["']+$/, '').trim();
  return s || undefined;
}

const REST_URL = normalizeEnv(process.env.UPSTASH_REDIS_REST_URL)?.replace(/\/+$/, '');
const REST_TOKEN = normalizeEnv(process.env.UPSTASH_REDIS_REST_TOKEN);

export const hasPersistentStore = !!(REST_URL && REST_TOKEN);

// Last failure talking to Upstash, surfaced through /api/state so a
// misconfigured store shows up as a readable message in the UI instead of
// silently degrading to in-memory state (which looks identical until the
// next cold start wipes it).
let lastStoreError: string | null = null;
export function getLastStoreError(): string | null {
  return lastStoreError;
}

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // fetch() throws this when the URL can't be parsed at all — by far the
  // likeliest cause is a malformed pasted value, so say so directly.
  if (/Failed to parse URL|Invalid URL/i.test(msg)) {
    return `UPSTASH_REDIS_REST_URL is not a valid URL (${msg}). Re-add it as just the https://... value, with no quotes, no variable name, and no trailing slash.`;
  }
  return msg;
}

// Only meaningful within a single warm process (local dev). On Vercel this
// resets on every cold start when Upstash isn't configured.
let memoryState: GlobalBotState | null = null;

export async function getState(): Promise<GlobalBotState> {
  if (REST_URL && REST_TOKEN) {
    try {
      const res = await fetch(`${REST_URL}/get/${STATE_KEY}`, {
        headers: { Authorization: `Bearer ${REST_TOKEN}` },
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastStoreError =
          res.status === 401 || res.status === 403
            ? `Upstash rejected the token (HTTP ${res.status}). Check UPSTASH_REDIS_REST_TOKEN matches this database.`
            : `Upstash GET failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`;
        return defaultState();
      }
      const data = await res.json().catch(() => null);
      lastStoreError = null;
      if (data?.result) {
        try {
          const parsed = JSON.parse(data.result);
          return { ...defaultState(parsed.startCash), ...parsed };
        } catch {
          return defaultState();
        }
      }
      return defaultState();
    } catch (e: unknown) {
      // Never let a store problem take the whole endpoint down — fall back
      // to a fresh in-memory state and report why through /api/state.
      lastStoreError = describeError(e);
      return defaultState();
    }
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
    try {
      const res = await fetch(`${REST_URL}/set/${STATE_KEY}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(trimmed),
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastStoreError = `Upstash SET failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`;
      } else {
        lastStoreError = null;
      }
    } catch (e: unknown) {
      lastStoreError = describeError(e);
    }
    // Mirror into memory too, so a single failed write doesn't lose the tick
    // within a warm process.
    memoryState = trimmed;
    return;
  }
  memoryState = trimmed;
}
