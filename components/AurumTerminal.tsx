'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  Play,
  Pause,
  RotateCcw,
  Newspaper,
  Landmark,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  RefreshCw,
  Calculator,
  Settings,
  KeyRound,
  Shield,
  Target,
  Brain,
  AlertTriangle,
} from 'lucide-react';
import PriceChart, { INTRADAY_TIMEFRAMES, TimeframeKey } from './PriceChart';
import {
  computeIndicators,
  technicalScore,
  calculatePositionSize,
} from '../lib/indicators';
import {
  linearRegression,
  zScore,
  winProbability,
  newsEffectiveWeight,
  computeTradeStats,
  kellyFraction,
  trendSummary,
  markToMarketEquity,
} from '../lib/quant';
import {
  classifyRegime,
  regimeKey,
  computeRegimeStats,
  regimeThresholdAdjustment,
  regimeShouldBlock,
} from '../lib/brain';
import { RISK_PRESETS, RESERVE_FLOOR_PCT, DEFAULT_LOT_OZ, DEFAULT_LEVERAGE, MAX_LEVERAGE } from '../lib/riskPresets';
import type { Portfolio, Trade, NewsResult, ProviderKey, ProviderMeta } from '../lib/types';
import {
  fmtUSD,
  fmtOz,
  buildCandles,
  backfillTradePnl,
  fetchNewsAnalysis,
} from '../lib/helpers';
import { THEME } from '../lib/theme';

// ─── Constants ─────────────────────────────────────────────────────────────
// This tab trades the real market in real time, on live 1-minute GC=F bars.
// Testing the same logic over a past period is the Backtest tab's job.
//
// It used to generate a random walk instead, which was wrong in two
// compounding ways (both measured against the real strategy modules):
//
//  1. Volatility. `(Math.random() - 0.5) * 0.004` per 12s tick is a 0.1155%
//     per-tick sd, compounding to ~9.8% per simulated day — about 10x real
//     gold's ~1%/day. The SL/TP percentages never matched their own feed.
//  2. Structure. A driftless random walk contains no trend by construction,
//     so a trend-following strategy has nothing to detect. Net P&L measured
//     ~$0 on $10,000 at every volatility setting — the bot wasn't losing, it
//     was being asked to find signal in pure noise.
//
// The visible symptom was constant whipsawing: with MIN_HOLD at 3 ticks
// (~0.2% of drift) but the stop-loss at 1.2%, the signal-exit condition was
// always reachable ~6x sooner than any stop, so essentially every exit was a
// signal flip-flop rather than a real risk event (measured: 130 signal exits
// vs 0 stop-losses on Aggressive).

// Real 1-minute bars, so polling faster just re-reads the same bar. The tick
// body ignores a repeated timestamp rather than manufacturing movement the
// market didn't make.
const LIVE_POLL_MS = 60_000;

const HISTORY_CAP = 5000;
// Whipsaw controls, counted in BARS rather than wall-clock so they track
// actual market activity: when the market is quiet and prints no new bar,
// no time passes as far as the strategy is concerned. One bar is one minute
// here, against lib/backtest.ts's one day — same rule, different granularity.
const SIGNAL_CONFIRM_BARS = 1;
const EXIT_COOLDOWN_BARS = 2;
const TECH_WEIGHT = 0.55;
const NEWS_WEIGHT = 0.45;
const DEFAULT_START_CASH = 10000;
const MIN_START_CASH = 1;
const MAX_START_CASH = 10_000_000;

const FONT_SERIF = "'Source Serif 4', Georgia, serif";
const FONT_MONO = "'JetBrains Mono', 'Courier New', monospace";
const FONT_SANS = "'Inter', -apple-system, sans-serif";


// ─── Provider Metadata ───────────────────────────────────────────────────
const PROVIDER_META: Record<ProviderKey, ProviderMeta> = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-sonnet-4-6', supportsWebSearch: true },
  openai: { label: 'OpenAI (GPT)', defaultModel: 'gpt-5.5', supportsWebSearch: false },
  xai: { label: 'Grok (xAI)', defaultModel: 'grok-4', supportsWebSearch: false },
};



// ─── Component ─────────────────────────────────────────────────────────────
export default function AurumTerminal() {
  // ─── State ─────────────────────────────────────────────────────────────
  const [price, setPrice] = useState<number | null>(null);
  const [dataSourceLabel, setDataSourceLabel] = useState('Seeding price feed...');
  const [priceHistory, setPriceHistory] = useState<{ t: number; p: number }[]>([]);
  // Starting capital — configurable so the bot's sizing/selectivity can
  // scale to the account, from a $10 micro account up through six figures.
  const [startCash, setStartCash] = useState(DEFAULT_START_CASH);
  const [startCashInput, setStartCashInput] = useState(String(DEFAULT_START_CASH));
  const [portfolio, setPortfolio] = useState<Portfolio>({
    cash: DEFAULT_START_CASH,
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
  });
  const [equityCurve, setEquityCurve] = useState<{ t: number; value: number }[]>([]);
  // Real, uncapped 1y daily history — independent of the live tick buffer
  // (which gets trimmed by HISTORY_CAP) — used purely for the day/week/month
  // "market memory" monitoring panel.
  const [dailyHistory, setDailyHistory] = useState<{ t: number; p: number }[]>([]);
  const [botRunning, setBotRunning] = useState(false);
  const [riskKey, setRiskKey] = useState('balanced');
  const [lotOz, setLotOz] = useState(DEFAULT_LOT_OZ);
  const [lotOzInput, setLotOzInput] = useState(String(DEFAULT_LOT_OZ));
  const [leverage, setLeverage] = useState(DEFAULT_LEVERAGE);
  const [useKelly, setUseKelly] = useState(false);
  const [mathOnly, setMathOnly] = useState(true);
  const [news, setNews] = useState<NewsResult | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsErrorMsg, setNewsErrorMsg] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [timeframe, setTimeframe] = useState<TimeframeKey>('1D');
  const [showSettings, setShowSettings] = useState(false);
  // ─── Replay ───────────────────────────────────────────────────────────
  // The full daily series being replayed, the cursor into it, and playback
  // speed. `replayDone` latches when the cursor reaches the end.
  // 'REGULAR' while the pit is open, 'CLOSED'/'PRE'/'POST' otherwise — used
  // to explain a flat chart rather than letting it look broken.
  const [marketState, setMarketState] = useState<string | null>(null);
  // Bumped to force a re-seed of the live bar buffer from /api/live.
  const [reseedNonce, setReseedNonce] = useState(0);
  const [providerKey, setProviderKey] = useState<ProviderKey>('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(PROVIDER_META.openai.defaultModel);

  // ─── Refs ──────────────────────────────────────────────────────────────
  const priceRef = useRef<number | null>(null);
  const newsRef = useRef<NewsResult | null>(null);
  const portfolioRef = useRef(portfolio);
  portfolioRef.current = portfolio;
  const historyRef = useRef(priceHistory);
  const consecutiveLossesRef = useRef(0);
  const lastTradeResultRef = useRef<'win' | 'loss' | null>(null);
  // Whipsaw controls are tracked as BAR indices, not wall-clock timestamps,
  // so playback speed can't change which trades fire.
  const barIndexRef = useRef(0);
  const lastExitBarRef = useRef<number | null>(null); // re-entry cooldown
  const pendingEntryBarRef = useRef<number | null>(null); // signal confirmation
  const pendingExitBarRef = useRef<number | null>(null);
  const entryBarRef = useRef<number | null>(null);

  // ─── Persisted State Loading ───────────────────────────────────────────
  useEffect(() => {
    try {
      const storedPortfolio = localStorage.getItem('aurum-portfolio');
      if (storedPortfolio) {
        const parsed = JSON.parse(storedPortfolio);
        if (parsed && typeof parsed.cash === 'number') {
          setPortfolio({
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
            ...parsed,
            trades: backfillTradePnl(parsed.trades || []),
          });
          const trades: Trade[] = parsed.trades || [];
          let consecutiveLosses = 0;
          for (const t of trades) {
            if (typeof t.pnl === 'number') {
              if (t.pnl < 0) consecutiveLosses++;
              else consecutiveLosses = 0;
            }
          }
          consecutiveLossesRef.current = consecutiveLosses;
        }
      }
      const storedStartCash = localStorage.getItem('aurum-start-cash');
      if (storedStartCash) {
        const val = Number(storedStartCash);
        if (Number.isFinite(val) && val >= MIN_START_CASH && val <= MAX_START_CASH) {
          setStartCash(val);
          setStartCashInput(String(val));
        }
      }
      const storedBotRunning = localStorage.getItem('aurum-bot-running');
      if (storedBotRunning === 'true') {
        setBotRunning(true);
      }
      const storedLotOz = localStorage.getItem('aurum-lot-oz');
      if (storedLotOz) {
        const val = Number(storedLotOz);
        if (Number.isFinite(val) && val > 0) {
          setLotOz(val);
          setLotOzInput(String(val));
        }
      }
      const storedUseKelly = localStorage.getItem('aurum-use-kelly');
      if (storedUseKelly === 'true') {
        setUseKelly(true);
      }
      const storedLeverage = localStorage.getItem('aurum-leverage');
      if (storedLeverage) {
        const val = Number(storedLeverage);
        if (Number.isFinite(val) && val >= 1 && val <= MAX_LEVERAGE) {
          setLeverage(val);
        }
      }
      const storedConfig = localStorage.getItem('aurum-llm-config');
      if (storedConfig) {
        const parsed = JSON.parse(storedConfig);
        if (parsed.providerKey && PROVIDER_META[parsed.providerKey as ProviderKey]) {
          setProviderKey(parsed.providerKey as ProviderKey);
        }
        if (parsed.model) setModel(parsed.model);
        if (parsed.apiKey) {
          setApiKey(parsed.apiKey);
          setMathOnly(false);
        }
      }
      // The price series is no longer persisted — it's the live market, so
      // it's re-seeded from /api/live on load rather than restored. Clear any
      // buffer saved by an older build, which held synthetic random-walk
      // ticks that would otherwise be mixed in with real bars.
      localStorage.removeItem('aurum-price-history');
      localStorage.removeItem('aurum-replay-year');
      localStorage.removeItem('aurum-replay-speed');
      const storedTf = localStorage.getItem('aurum-timeframe');
      if (storedTf && INTRADAY_TIMEFRAMES.some((t) => t.key === storedTf)) {
        setTimeframe(storedTf as TimeframeKey);
      }
    } catch (e) {
      console.error("Failed to load from localStorage", e);
    }
    setLoaded(true);
  }, []);

  // ─── Persistence Effects ─────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-portfolio', JSON.stringify(portfolio));
  }, [portfolio, loaded]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-start-cash', String(startCash));
  }, [startCash, loaded]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-bot-running', String(botRunning));
  }, [botRunning, loaded]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-lot-oz', String(lotOz));
  }, [lotOz, loaded]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-use-kelly', String(useKelly));
  }, [useKelly, loaded]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-leverage', String(leverage));
  }, [leverage, loaded]);

  useEffect(() => {
    historyRef.current = priceHistory;
  }, [priceHistory]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(
      'aurum-llm-config',
      JSON.stringify({ providerKey, model, apiKey })
    );
  }, [providerKey, model, apiKey, loaded]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-timeframe', timeframe);
  }, [timeframe, loaded]);

  // ─── Daily History (for the week/month market memory panel) ─────────────
  // Long-range daily context only — the trading feed itself is the live
  // 1-minute series below. (The Backtest tab fetches its own copy.)
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/history?range=25y');
        const json = await res.json();
        if (!cancelled && !json.error && Array.isArray(json.points) && json.points.length > 0) {
          setDailyHistory(json.points);
        }
      } catch {
        // Non-critical — only the memory panel needs this.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  // ─── Live Feed Setup ────────────────────────────────────────────────────
  // Seeds the indicator buffer with real 1-minute GC=F bars so EMA26/RSI14/
  // regression-20 are warm immediately, then the tick loop appends each new
  // minute from the same series. Seeding and ticking share one granularity
  // on purpose — mixing daily seed bars with sub-minute appends is what made
  // the old build's indicators meaningless.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      setDataSourceLabel('Loading live gold feed…');
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        const json = await res.json();
        if (cancelled) return;
        if (json.error || !Array.isArray(json.points) || json.points.length === 0) {
          setDataSourceLabel(`Live gold feed unavailable: ${json.error ?? 'no data'}`);
          return;
        }
        const points: { t: number; p: number }[] = json.points;
        barIndexRef.current = 0;
        lastExitBarRef.current = null;
        pendingEntryBarRef.current = null;
        pendingExitBarRef.current = null;
        entryBarRef.current = null;
        historyRef.current = points;
        setPriceHistory(points);
        const last = json.price ?? points[points.length - 1].p;
        priceRef.current = last;
        setPrice(last);
        setMarketState(json.marketState ?? null);
        setDataSourceLabel(`Live COMEX gold (GC=F) · real 1-minute bars · ${points.length} today`);
      } catch {
        if (!cancelled) setDataSourceLabel('Live gold feed unreachable.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, reseedNonce]);

  // ─── News ────────────────────────────────────────────────────────────────
  const canUseNews = !mathOnly;

  const runNewsRefresh = useCallback(async () => {
    if (!canUseNews) return;
    setNewsLoading(true);
    setNewsErrorMsg('');
    try {
      const result = await fetchNewsAnalysis({ providerKey, apiKey, model });
      newsRef.current = result;
      setNews(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Request failed';
      setNewsErrorMsg(msg);
    } finally {
      setNewsLoading(false);
    }
  }, [canUseNews, providerKey, apiKey, model]);

  useEffect(() => {
    if (!canUseNews) {
      newsRef.current = null;
      setNews(null);
      return;
    }
    runNewsRefresh();
    const id = setInterval(runNewsRefresh, 100000);
    return () => clearInterval(id);
  }, [runNewsRefresh, canUseNews]);

  // ─── Bot Tick (one live bar per poll) ────────────────────────────────────
  // Polls the real 1-minute GC=F feed and advances only when the market has
  // actually printed a new bar.
  useEffect(() => {
    if (price === null) return;

    const id = setInterval(async () => {
      let json: {
        price?: number;
        points?: { t: number; p: number }[];
        marketState?: string;
        error?: string;
      };
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        json = await res.json();
      } catch {
        setDataSourceLabel('Live gold feed unreachable — retrying.');
        return;
      }
      if (json.error || !json.points?.length) {
        setDataSourceLabel(`Live gold feed error: ${json.error ?? 'no data'}`);
        return;
      }

      setMarketState(json.marketState ?? null);
      const newest = json.points[json.points.length - 1];
      const lastT = historyRef.current.length
        ? historyRef.current[historyRef.current.length - 1].t
        : 0;
      // Gold futures don't print every minute, and outside trading hours they
      // don't print at all. No new bar means genuinely nothing happened —
      // advancing on a repeated price would manufacture movement the market
      // didn't make, and would also let the bar-counted cooldown/confirmation
      // windows expire while the market sat still.
      if (newest.t <= lastT) {
        const shown = json.price ?? newest.p;
        setPrice(shown);
        priceRef.current = shown;
        return;
      }

      const nextPrice = newest.p;
      const nowSec = newest.t;

      // Live news against a live bar is contemporaneous, so it legitimately
      // informs the score here (unlike the Backtest tab, which is math-only
      // because scoring a past bar with today's headlines is look-ahead bias).
      let sentiment = 0;
      if (canUseNews && newsRef.current) {
        const w = newsEffectiveWeight(
          Date.now() - newsRef.current.ts,
          newsRef.current.confidence
        );
        sentiment = newsRef.current.sentiment_score * w;
      }

      barIndexRef.current += 1;
      priceRef.current = nextPrice;
      setPrice(nextPrice);

      const nextHistory = [...historyRef.current, { t: nowSec, p: nextPrice }].slice(
        -HISTORY_CAP
      );
      historyRef.current = nextHistory;
      setPriceHistory(nextHistory);

      const rawPrices = nextHistory.map((pt) => pt.p);
      const indicators = computeIndicators(rawPrices);
      const { ema12, ema26, rsi, atr, bbWidth, macd, macdSignal } = indicators;
      // Quant overlay: trend regression (slope + R²) and a mean-reversion
      // z-score, both folded into technicalScore as extra graduated factors.
      const regression = linearRegression(rawPrices, 20);
      const mrz = zScore(rawPrices, 20);
      // The "brain": classify the current market condition into a regime
      // bucket and look up how the bot's own past trades performed in that
      // exact bucket, so it can lean into conditions that have worked and
      // pull back (or refuse to trade) in conditions that historically haven't.
      // In replay the news bias is forced to null: the regime bucket a trade
      // is filed under must describe the market at that historical bar, not
      // today's headlines, or the brain learns from mislabelled buckets.
      // Live bars are contemporaneous with the news, so it applies there.
      const regimeNow = classifyRegime(
        regression,
        rsi,
        bbWidth,
        canUseNews ? newsRef.current?.bias ?? null : null
      );
      const regimeNowKey = regimeKey(regimeNow);
      // Chop filter: classifyRegime calls the market 'Flat' when the
      // regression R² < 0.3 (line doesn't fit the recent path) or the slope
      // is too shallow to call a direction — exactly the condition behind
      // most observed whipsaw losses (RSI oscillating through 50 with no
      // real trend underneath). Block new entries when there's no trend to
      // follow, the same discipline a discretionary trader applies to a
      // range-bound chart.
      const trendConfirmed = regimeNow.trend !== 'Flat';
      // A tiny fixed safety rail — not account-size scaling, just prevents
      // a single trade from spending literally all available cash.
      const reserveFloor = Math.max(startCash * RESERVE_FLOOR_PCT, 0.01);

      if (botRunning) {
        const cur = portfolioRef.current;
        const preset = RISK_PRESETS[riskKey];

        // Dynamic threshold adjustment based on losing streak only.
        let adjustedThreshold = preset.threshold;
        if (consecutiveLossesRef.current >= 3) {
          adjustedThreshold = Math.min(
            0.5,
            adjustedThreshold * (1 + consecutiveLossesRef.current * 0.15)
          );
        }

        if (cur.oz > 0 && cur.entryPrice != null) {
          const posThreshold = cur.positionThreshold ?? preset.threshold;
          const posBeTriggerPct = cur.positionBeTriggerPct ?? preset.beTriggerPct;

          // ─── Stop-Loss Hit ───────────────────────────────────────────────
          if (cur.slPrice != null && nextPrice <= cur.slPrice) {
            const label = !cur.beActive
              ? 'Stop-loss hit'
              : cur.entryPrice != null && cur.slPrice > cur.entryPrice
                ? 'Trailing stop hit (profit locked)'
                : 'Breakeven stop hit';
            const pnl = (nextPrice - cur.entryPrice) * cur.oz;
            const pnlPct = ((nextPrice - cur.entryPrice) / cur.entryPrice) * 100;
            // Return margin committed plus/minus P&L, not oz * price (full
            // notional) — crediting full notional back against a
            // margin-only debit would fabricate leveraged gains.
            const returned = (cur.marginUsed ?? cur.oz * cur.entryPrice) + pnl;
            const trade: Trade = {
              id: Date.now(),
              ts: nowSec,
              time: new Date().toLocaleTimeString(),
              side: 'SELL',
              price: nextPrice,
              oz: cur.oz,
              value: returned,
              pnl,
              pnlPct,
              reasoning: label,
            };
            portfolioRef.current = {
              ...cur,
              cash: cur.cash + Math.max(0, returned),
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
              trades: [trade, ...cur.trades].slice(0, 100),
            };
            setPortfolio(portfolioRef.current);
            lastExitBarRef.current = barIndexRef.current;
            entryBarRef.current = null;
            pendingEntryBarRef.current = null;
            pendingExitBarRef.current = null;
            if (pnl < 0) {
              consecutiveLossesRef.current++;
              lastTradeResultRef.current = 'loss';
            } else {
              consecutiveLossesRef.current = 0;
              lastTradeResultRef.current = 'win';
            }
          }
          // ─── Take-Profit Hit ────────────────────────────────────────────
          else if (cur.tpPrice != null && nextPrice >= cur.tpPrice) {
            const pnl = (nextPrice - cur.entryPrice) * cur.oz;
            const pnlPct = ((nextPrice - cur.entryPrice) / cur.entryPrice) * 100;
            const returned = (cur.marginUsed ?? cur.oz * cur.entryPrice) + pnl;
            const trade: Trade = {
              id: Date.now(),
              ts: nowSec,
              time: new Date().toLocaleTimeString(),
              side: 'SELL',
              price: nextPrice,
              oz: cur.oz,
              value: returned,
              pnl,
              pnlPct,
              reasoning: 'Take-profit hit',
            };
            portfolioRef.current = {
              ...cur,
              cash: cur.cash + Math.max(0, returned),
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
              trades: [trade, ...cur.trades].slice(0, 100),
            };
            setPortfolio(portfolioRef.current);
            lastExitBarRef.current = barIndexRef.current;
            entryBarRef.current = null;
            pendingEntryBarRef.current = null;
            pendingExitBarRef.current = null;
            consecutiveLossesRef.current = 0;
            lastTradeResultRef.current = 'win';
          }
          // ─── Breakeven Arm & Trailing Stop ───────────────────────────────
          else {
            // Track the highest price seen since entry — this is what the
            // trailing stop rides behind once armed.
            const peakPrice = Math.max(cur.peakPrice ?? cur.entryPrice, nextPrice);

            if (!cur.beActive && cur.tpPrice != null) {
              const beTriggerPrice =
                cur.entryPrice + (cur.tpPrice - cur.entryPrice) * posBeTriggerPct;
              if (nextPrice >= beTriggerPrice) {
                // Arm: jump SL to breakeven and start trailing from here.
                portfolioRef.current = {
                  ...cur,
                  slPrice: cur.entryPrice,
                  beActive: true,
                  peakPrice,
                };
                setPortfolio(portfolioRef.current);
              } else if (peakPrice !== cur.peakPrice) {
                portfolioRef.current = { ...cur, peakPrice };
                setPortfolio(portfolioRef.current);
              }
            } else if (cur.beActive) {
              // Once armed, ratchet the stop up behind the peak instead of
              // leaving it parked at breakeven — an ATR-based trail distance
              // when available (matching how the initial stop was sized),
              // otherwise a fraction of the preset's stop-loss %. The stop
              // only ever moves up, and never below entry.
              const trailDistance = atr ? atr * 1.5 : nextPrice * preset.slPct * 0.6;
              const candidateSl = Math.max(cur.entryPrice, peakPrice - trailDistance);
              const nextSl = Math.max(cur.slPrice ?? cur.entryPrice, candidateSl);
              if (nextSl !== cur.slPrice || peakPrice !== cur.peakPrice) {
                portfolioRef.current = { ...cur, slPrice: nextSl, peakPrice };
                setPortfolio(portfolioRef.current);
              }
            }
            // ─── Signal-Based Exit ────────────────────────────────────────
            const tech = technicalScore(
              nextPrice,
              ema12,
              ema26,
              rsi,
              macd,
              macdSignal,
              atr,
              bbWidth,
              rawPrices,
              regression,
              mrz
            );
            // `sentiment` is 0 in replay, so this reduces to plain `tech`
            // there rather than scaling it down by NEWS_WEIGHT.
            const combined =
              sentiment !== 0 ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment : tech;
            // Bar-counted, matching lib/backtest.ts: a signal exit needs the
            // score to stay past the threshold for SIGNAL_CONFIRM_BARS, and
            // the position to have existed for at least one prior bar.
            const bar = barIndexRef.current;
            const heldBars = entryBarRef.current != null ? bar - entryBarRef.current : Infinity;
            const exitSignalActive = combined < -posThreshold;
            if (!exitSignalActive) {
              pendingExitBarRef.current = null;
            } else if (pendingExitBarRef.current == null) {
              pendingExitBarRef.current = bar;
            }
            const exitConfirmed =
              exitSignalActive &&
              pendingExitBarRef.current != null &&
              bar - pendingExitBarRef.current >= SIGNAL_CONFIRM_BARS;
            if (heldBars >= 1 && exitConfirmed) {
              const liveCur = portfolioRef.current;
              const reasoning =
                sentiment !== 0
                  ? `${tech <= 0 ? 'Downtrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment < 0 ? 'negative' : 'cooling'}`
                  : `Downtrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (live, math-only)`;
              const pnl = (nextPrice - liveCur.entryPrice!) * liveCur.oz;
              const pnlPct = ((nextPrice - liveCur.entryPrice!) / liveCur.entryPrice!) * 100;
              const returned = (liveCur.marginUsed ?? liveCur.oz * liveCur.entryPrice!) + pnl;
              const trade: Trade = {
                id: Date.now(),
                ts: nowSec,
                time: new Date().toLocaleTimeString(),
                side: 'SELL',
                price: nextPrice,
                oz: liveCur.oz,
                value: returned,
                pnl,
                pnlPct,
                reasoning,
              };
              portfolioRef.current = {
                ...liveCur,
                cash: liveCur.cash + Math.max(0, returned),
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
                trades: [trade, ...liveCur.trades].slice(0, 100),
              };
              setPortfolio(portfolioRef.current);
              lastExitBarRef.current = barIndexRef.current;
              entryBarRef.current = null;
              pendingEntryBarRef.current = null;
              pendingExitBarRef.current = null;
              if (pnl < 0) {
                consecutiveLossesRef.current++;
                lastTradeResultRef.current = 'loss';
              } else {
                consecutiveLossesRef.current = 0;
                lastTradeResultRef.current = 'win';
              }
            }
          }
        }
        // ─── Entry Signal ─────────────────────────────────────────────────
        // Below the reserve floor there isn't enough spare cash to justify
        // a new position; the cooldown blocks re-entering right after a
        // position just closed, into the same noise that closed it.
        else if (cur.oz === 0 && cur.cash > reserveFloor) {
          const cooldownElapsed =
            lastExitBarRef.current == null ||
            barIndexRef.current - lastExitBarRef.current >= EXIT_COOLDOWN_BARS;
          const tech = technicalScore(
            nextPrice,
            ema12,
            ema26,
            rsi,
            macd,
            macdSignal,
            atr,
            bbWidth,
            rawPrices,
            regression,
            mrz
          );
          const combined =
            sentiment !== 0 ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment : tech;

          // Brain lookup: has this exact market regime historically been a
          // winner or a loser for this bot's own trades?
          const regimeStatsNow = computeRegimeStats(cur.trades);
          const matchedRegimeStat = regimeStatsNow.find((s) => s.regime === regimeNowKey);
          const regimeAdj = regimeThresholdAdjustment(matchedRegimeStat);
          const brainBlocked = regimeShouldBlock(matchedRegimeStat);

          // Signal confirmation: the score has to stay past the threshold
          // for SIGNAL_CONFIRM_BARS, not just touch it on one bar, before
          // it's acted on.
          const entrySignalActive =
            trendConfirmed && !brainBlocked && combined > adjustedThreshold + regimeAdj;
          const entryBar = barIndexRef.current;
          if (!entrySignalActive) {
            pendingEntryBarRef.current = null;
          } else if (pendingEntryBarRef.current == null) {
            pendingEntryBarRef.current = entryBar;
          }
          const entryConfirmed =
            entrySignalActive &&
            pendingEntryBarRef.current != null &&
            entryBar - pendingEntryBarRef.current >= SIGNAL_CONFIRM_BARS;

          if (cooldownElapsed && entryConfirmed) {
            // Fixed lot size, chosen directly by the user — not derived
            // from a % of capital or scaled by account size. Kelly is
            // opt-in: when enabled, it can only shrink the lot (never grow
            // it beyond what was requested) based on realized win rate /
            // avg win-loss once there's enough trade history.
            let effectiveLotOz = lotOz;
            if (useKelly) {
              const stats = computeTradeStats(cur.trades);
              const kelly = kellyFraction(
                stats.winRate,
                stats.avgWinPct,
                stats.avgLossPct,
                8,
                stats.totalTrades
              );
              if (kelly != null && nextPrice > 0) {
                const kellyOz = (cur.cash * kelly * leverage) / nextPrice;
                effectiveLotOz = Math.min(lotOz, kellyOz);
              }
            }

            const sized = calculatePositionSize(
              cur.cash,
              effectiveLotOz,
              nextPrice,
              atr,
              preset.slPct,
              leverage
            );
            // Never let a single entry breach the account's reserve floor —
            // clamp spend down (proportionally, so oz stays consistent) if
            // it would.
            const maxSpend = Math.max(0, cur.cash - reserveFloor);
            const spendScale = sized.spend > 0 ? Math.min(1, maxSpend / sized.spend) : 0;
            const spend = sized.spend * spendScale;
            const oz = sized.oz * spendScale;
            const actualSlPct = sized.actualSlPct;

            // Skip dust-sized entries (e.g. a micro account already near
            // its reserve floor) rather than opening a position too small
            // to meaningfully track.
            if (spend >= 0.01 && oz > 0) {
              // Effective stop can never sit looser than the leverage
              // liquidation floor — at high leverage the margin cushion can
              // be tighter than the preset's own stop-loss %.
              const slPrice = Math.max(nextPrice * (1 - actualSlPct), sized.liqPrice);
              const tpPrice = nextPrice * (1 + preset.tpPct);
              const reasoning =
                sentiment !== 0
                  ? `${tech >= 0 ? 'Uptrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment >= 0 ? 'supportive' : 'cautious'}${newsRef.current?.key_driver ? ' (' + newsRef.current.key_driver + ')' : ''}`
                  : `Uptrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (live, math-only)`;
              const brainNote =
                matchedRegimeStat && matchedRegimeStat.trades >= 6
                  ? ` · brain: ${(matchedRegimeStat.winRate * 100).toFixed(0)}% win in "${regimeNowKey}" (${matchedRegimeStat.trades} past trades)`
                  : '';
              const leverageNote =
                leverage > 1 ? ` · ${leverage}x, notional $${fmtUSD(sized.notional, 0)}` : '';
              const trade: Trade = {
                id: Date.now(),
                ts: nowSec,
                time: new Date().toLocaleTimeString(),
                side: 'BUY',
                price: nextPrice,
                oz,
                value: spend,
                reasoning: `${reasoning} · SL $${fmtUSD(slPrice)} / TP $${fmtUSD(tpPrice)}${atr ? ' · ATR $' + fmtUSD(atr) : ''}${brainNote}${leverageNote}`,
                regime: regimeNowKey,
              };
              portfolioRef.current = {
                ...cur,
                cash: cur.cash - spend,
                oz: cur.oz + oz,
                entryPrice: nextPrice,
                entryTs: Date.now(),
                peakPrice: nextPrice,
                slPrice,
                tpPrice,
                beActive: false,
                positionThreshold: adjustedThreshold,
                positionBeTriggerPct: preset.beTriggerPct,
                positionUsesNews: sentiment !== 0,
                marginUsed: spend,
                trades: [trade, ...cur.trades].slice(0, 100),
              };
              setPortfolio(portfolioRef.current);
              entryBarRef.current = barIndexRef.current;
              pendingEntryBarRef.current = null;
            }
          }
        }
      }

      const finalPortfolio = portfolioRef.current;
      setEquityCurve((eq) => {
        const val = markToMarketEquity(
          finalPortfolio.cash,
          finalPortfolio.oz,
          finalPortfolio.entryPrice,
          finalPortfolio.marginUsed,
          nextPrice
        );
        return [...eq, { t: eq.length, value: val }].slice(-150);
      });
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [price, botRunning, riskKey, canUseNews, startCash, lotOz, leverage, useKelly]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const handleReset = useCallback(
    (newStartCash?: number) => {
      setBotRunning(false);
      const cashAmount = newStartCash ?? startCash;
      const fresh: Portfolio = {
        cash: cashAmount,
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
      setPortfolio(fresh);
      setEquityCurve([]);
      consecutiveLossesRef.current = 0;
      lastTradeResultRef.current = null;
      lastExitBarRef.current = null;
      pendingEntryBarRef.current = null;
      pendingExitBarRef.current = null;
      entryBarRef.current = null;
      localStorage.setItem('aurum-portfolio', JSON.stringify(fresh));
    },
    [startCash]
  );

  const handleApplyStartCash = useCallback(() => {
    const val = parseFloat(startCashInput);
    if (!Number.isFinite(val) || val <= 0) {
      setStartCashInput(String(startCash));
      return;
    }
    const clamped = Math.max(MIN_START_CASH, Math.min(MAX_START_CASH, val));
    setStartCashInput(String(clamped));
    setStartCash(clamped);
    handleReset(clamped);
  }, [startCashInput, startCash, handleReset]);

  const handleApplyLotOz = useCallback(() => {
    const val = parseFloat(lotOzInput);
    if (!Number.isFinite(val) || val <= 0) {
      setLotOzInput(String(lotOz));
      return;
    }
    setLotOzInput(String(val));
    setLotOz(val);
  }, [lotOzInput, lotOz]);

  // Re-seed the chart from the live feed, discarding the current bar buffer
  // without touching the portfolio. Useful after a feed outage has left a gap.
  const handleResetChart = useCallback(() => {
    setBotRunning(false);
    setReseedNonce((n) => n + 1);
  }, []);

  const handleProviderChange = useCallback((key: ProviderKey) => {
    setProviderKey(key);
    setModel(PROVIDER_META[key].defaultModel);
    setNews(null);
    newsRef.current = null;
  }, []);

  // ─── Derived Values ──────────────────────────────────────────────────────
  const rawPrices = useMemo(() => priceHistory.map((pt) => pt.p), [priceHistory]);
  const indicators = useMemo(() => computeIndicators(rawPrices), [rawPrices]);
  const { ema12, ema26, rsi, atr, bbWidth, macd, macdSignal } = indicators;

  const regression = useMemo(() => linearRegression(rawPrices, 20), [rawPrices]);
  const meanReversionZ = useMemo(() => zScore(rawPrices, 20), [rawPrices]);
  const newsAgeWeight =
    canUseNews && news ? newsEffectiveWeight(Date.now() - news.ts, news.confidence) : 0;
  const effectiveSentiment = canUseNews && news ? news.sentiment_score * newsAgeWeight : 0;
  const currentTechScore =
    price != null
      ? technicalScore(
          price,
          ema12,
          ema26,
          rsi,
          macd,
          macdSignal,
          atr,
          bbWidth,
          rawPrices,
          regression,
          meanReversionZ
        )
      : 0;
  const currentCombinedScore = canUseNews
    ? TECH_WEIGHT * currentTechScore + NEWS_WEIGHT * effectiveSentiment
    : currentTechScore;
  const currentWinProbability = winProbability(currentCombinedScore);
  const tradeStats = useMemo(() => computeTradeStats(portfolio.trades), [portfolio.trades]);
  const currentKelly = kellyFraction(
    tradeStats.winRate,
    tradeStats.avgWinPct,
    tradeStats.avgLossPct,
    8,
    tradeStats.totalTrades
  );

  // ─── Market Memory ("Brain") ──────────────────────────────────────────
  const currentRegime = useMemo(
    () => classifyRegime(regression, rsi, bbWidth, canUseNews ? news?.bias ?? null : null),
    [regression, rsi, bbWidth, canUseNews, news]
  );
  const currentRegimeStr = regimeKey(currentRegime);
  const regimeStatsAll = useMemo(() => computeRegimeStats(portfolio.trades), [portfolio.trades]);
  const currentRegimeStat = regimeStatsAll.find((s) => s.regime === currentRegimeStr);
  const dayTrend = useMemo(
    () => trendSummary(priceHistory, 24 * 60 * 60 * 1000),
    [priceHistory]
  );
  const weekTrend = useMemo(
    () => trendSummary(dailyHistory, 7 * 24 * 60 * 60 * 1000),
    [dailyHistory]
  );
  const monthTrend = useMemo(
    () => trendSummary(dailyHistory, 30 * 24 * 60 * 60 * 1000),
    [dailyHistory]
  );

  const equityValue = price
    ? markToMarketEquity(portfolio.cash, portfolio.oz, portfolio.entryPrice, portfolio.marginUsed, price)
    : portfolio.cash;
  const pnl = equityValue - startCash;
  const pnlPct = startCash > 0 ? (pnl / startCash) * 100 : 0;
  const biasColor =
    news?.bias === 'bullish'
      ? THEME.gain
      : news?.bias === 'bearish'
        ? THEME.loss
        : THEME.muted;
  const BiasIcon =
    news?.bias === 'bullish'
      ? TrendingUp
      : news?.bias === 'bearish'
        ? TrendingDown
        : Minus;
  const lastBarTime =
    priceHistory.length > 0
      ? new Date(priceHistory[priceHistory.length - 1].t * 1000).toLocaleTimeString()
      : '';
  const marketOpen = marketState === 'REGULAR';

  const activeGroupSize =
    INTRADAY_TIMEFRAMES.find((t) => t.key === timeframe)?.groupSize ?? 1;
  const candles = useMemo(
    () => buildCandles(priceHistory, activeGroupSize),
    [priceHistory, activeGroupSize]
  );
  const activeProvider = PROVIDER_META[providerKey];
  const openPositionPnlPct =
    portfolio.oz > 0 && portfolio.entryPrice && price
      ? ((price - portfolio.entryPrice) / portfolio.entryPrice) * 100
      : null;

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        background: THEME.bg,
        color: THEME.text,
        fontFamily: FONT_SANS,
        padding: '24px',
        borderRadius: '12px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          borderBottom: `1px solid ${THEME.hairline}`,
          paddingBottom: '16px',
          marginBottom: '16px',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: FONT_SERIF,
              fontSize: '26px',
              letterSpacing: '0.02em',
              color: THEME.goldBright,
            }}
          >
            AURUM
          </div>
          <div style={{ fontSize: '12px', color: THEME.muted, marginTop: '2px' }}>
            Paper-trading terminal &middot; XAU/USD &middot; {dataSourceLabel}
          </div>
          {marketState && (
            <div
              style={{
                fontSize: '11px',
                fontFamily: FONT_MONO,
                color: marketOpen ? THEME.gain : THEME.muted,
                marginTop: '4px',
              }}
            >
              {marketOpen
                ? `Market open · ${priceHistory.length} bars today · last ${lastBarTime}`
                : `Market ${(marketState || 'closed').toLowerCase()} — price is static until it reopens, so the bot will sit idle`}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={() => setShowSettings((s) => !s)}
            aria-label="Toggle LLM settings"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: showSettings ? THEME.panelAlt : 'transparent',
              color: THEME.muted,
              border: `1px solid ${THEME.hairline}`,
              borderRadius: '6px',
              padding: '6px 10px',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            <Settings size={13} /> LLM settings
          </button>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: botRunning ? THEME.gain : THEME.muted,
              display: 'inline-block',
            }}
          />
          <span
            style={{ fontSize: '12px', fontFamily: FONT_MONO, color: THEME.muted }}
          >
            {botRunning ? 'RUNNING' : 'PAUSED'}
          </span>
        </div>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div
          style={{
            background: THEME.panelAlt,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '8px',
            padding: '16px',
            marginBottom: '20px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginBottom: '12px',
              fontSize: '12px',
              color: THEME.muted,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            <Target size={13} /> Account size
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: '10px',
              flexWrap: 'wrap',
              marginBottom: '10px',
            }}
          >
            <div>
              <label
                style={{
                  fontSize: '11px',
                  color: THEME.muted,
                  display: 'block',
                  marginBottom: '4px',
                }}
              >
                Starting capital ($)
              </label>
              <input
                className="aurum-input"
                type="number"
                min={MIN_START_CASH}
                max={MAX_START_CASH}
                step="1"
                value={startCashInput}
                onChange={(e) => setStartCashInput(e.target.value)}
                style={{
                  width: '140px',
                  background: THEME.panel,
                  color: THEME.text,
                  border: `1px solid ${THEME.hairline}`,
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '13px',
                  fontFamily: FONT_MONO,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <button
              onClick={handleApplyStartCash}
              aria-label="Apply starting capital and reset portfolio"
              style={{
                background: THEME.gold,
                color: '#1A1508',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 14px',
                fontFamily: FONT_SANS,
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Apply &amp; reset portfolio
            </button>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: '10px',
              flexWrap: 'wrap',
              marginBottom: '10px',
            }}
          >
            <div>
              <label
                style={{
                  fontSize: '11px',
                  color: THEME.muted,
                  display: 'block',
                  marginBottom: '4px',
                }}
              >
                Lot size (oz per trade)
              </label>
              <input
                className="aurum-input"
                type="number"
                min={0.00001}
                step="0.001"
                value={lotOzInput}
                onChange={(e) => setLotOzInput(e.target.value)}
                onBlur={handleApplyLotOz}
                style={{
                  width: '140px',
                  background: THEME.panel,
                  color: THEME.text,
                  border: `1px solid ${THEME.hairline}`,
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '13px',
                  fontFamily: FONT_MONO,
                  boxSizing: 'border-box',
                }}
              />
            </div>
            <div>
              <label
                style={{
                  fontSize: '11px',
                  color: THEME.muted,
                  display: 'block',
                  marginBottom: '4px',
                }}
                title="1x = full notional in cash (today's default). Raising this lets a lot size that would otherwise be unaffordable actually trade, using only a fraction of its value as margin — same mechanism real gold CFD/forex brokers use."
              >
                Leverage
              </label>
              <select
                className="aurum-input"
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                style={{
                  width: '90px',
                  background: THEME.panel,
                  color: THEME.text,
                  border: `1px solid ${THEME.hairline}`,
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '13px',
                  fontFamily: FONT_MONO,
                }}
              >
                {[1, 2, 5, 10, 20].filter((l) => l <= MAX_LEVERAGE).map((l) => (
                  <option key={l} value={l}>
                    {l}x
                  </option>
                ))}
              </select>
            </div>
            {price != null && (
              <span style={{ fontFamily: FONT_MONO, fontSize: '11px', color: THEME.muted }}>
                ≈ ${fmtUSD(((parseFloat(lotOzInput) || 0) * price) / leverage)} margin per trade
                {leverage > 1
                  ? ` (notional $${fmtUSD((parseFloat(lotOzInput) || 0) * price, 0)} at ${leverage}x)`
                  : ''}{' '}
                at current price
              </span>
            )}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                color: THEME.muted,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={useKelly}
                onChange={(e) => setUseKelly(e.target.checked)}
              />
              Let Kelly sizing shrink the lot after a losing streak
            </label>
          </div>
          <div style={{ fontSize: '11px', color: THEME.muted, marginBottom: '20px' }}>
            Position size is a direct lot size you choose — it&apos;s the same regardless of
            account size, and only shrinks below what you set if Kelly sizing is enabled and your
            realized track record looks weak, or if there isn&apos;t enough margin to cover it at
            the current leverage (at 1x, that means not enough cash to cover the lot&apos;s full
            value — raising leverage lowers how much cash a given lot actually costs). A tiny
            fixed rail keeps any single trade from spending literally 100% of cash (
            {(RESERVE_FLOOR_PCT * 100).toFixed(0)}% of starting capital, $
            {fmtUSD(Math.max(startCash * RESERVE_FLOOR_PCT, 0.01))}, always stays untouched).
            Bigger lots and higher leverage both mean bigger swings both ways — sizing up
            doesn&apos;t create more winning trades, it just makes existing ones (and losses)
            count for more. At leverage &gt; 1x, a stop-loss also can&apos;t sit looser than the
            price at which the position&apos;s margin would be fully lost — that floor tightens
            automatically as leverage increases.
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginBottom: '12px',
              fontSize: '12px',
              color: THEME.muted,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            <KeyRound size={13} /> LLM provider
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '10px',
              marginBottom: '10px',
            }}
          >
            <div>
              <label
                style={{
                  fontSize: '11px',
                  color: THEME.muted,
                  display: 'block',
                  marginBottom: '4px',
                }}
              >
                Provider
              </label>
              <select
                value={providerKey}
                onChange={(e) => handleProviderChange(e.target.value as ProviderKey)}
                style={{
                  width: '100%',
                  background: THEME.panel,
                  color: THEME.text,
                  border: `1px solid ${THEME.hairline}`,
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '13px',
                }}
              >
                {(Object.entries(PROVIDER_META) as [ProviderKey, ProviderMeta][]).map(
                  ([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  )
                )}
              </select>
            </div>
            <div>
              <label
                style={{
                  fontSize: '11px',
                  color: THEME.muted,
                  display: 'block',
                  marginBottom: '4px',
                }}
              >
                Model
              </label>
              <input
                className="aurum-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={activeProvider.defaultModel}
                style={{
                  width: '100%',
                  background: THEME.panel,
                  color: THEME.text,
                  border: `1px solid ${THEME.hairline}`,
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '13px',
                  fontFamily: FONT_MONO,
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>
          <div style={{ fontSize: '11px', color: THEME.muted, marginBottom: '10px' }}>
            By default this app reads your key from the server environment (
            <code>{providerKey.toUpperCase()}_API_KEY</code> in <code>.env.local</code> or
            your Vercel project settings) — nothing is sent from the browser. Optional
            override below is sent to your own <code>/api/news</code> route only.
          </div>
          <div>
            <label
              style={{
                fontSize: '11px',
                color: THEME.muted,
                display: 'block',
                marginBottom: '4px',
              }}
            >
              Optional: override API key for this browser
            </label>
            <input
              className="aurum-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Leave blank to use server env var"
              style={{
                width: '100%',
                background: THEME.panel,
                color: THEME.text,
                border: `1px solid ${THEME.hairline}`,
                borderRadius: '6px',
                padding: '8px 10px',
                fontSize: '13px',
                fontFamily: FONT_MONO,
                boxSizing: 'border-box',
              }}
            />
          </div>
          {!activeProvider.supportsWebSearch && (
            <div
              style={{
                fontSize: '11px',
                color: THEME.muted,
                marginTop: '10px',
                borderTop: `1px solid ${THEME.hairline}`,
                paddingTop: '10px',
              }}
            >
              {activeProvider.label} isn&apos;t wired for live web search here, so its
              &quot;news&quot; read is a general-knowledge estimate, not live headlines.
            </div>
          )}
          {newsErrorMsg && (
            <div style={{ fontSize: '11px', color: THEME.loss, marginTop: '10px' }}>
              {newsErrorMsg}
            </div>
          )}
        </div>
      )}

      {/* Disclaimer */}
      <div
        style={{
          background: THEME.panelAlt,
          border: `1px solid ${THEME.hairline}`,
          borderRadius: '8px',
          padding: '10px 14px',
          fontSize: '12px',
          color: THEME.muted,
          marginBottom: '20px',
        }}
      >
        Simulated execution only &mdash; no real funds or brokerage connected. Not
        financial advice; the bot&apos;s signals can be wrong.
      </div>

      {/* Controls */}
      <div
        style={{
          display: 'flex',
          gap: '10px',
          marginBottom: '20px',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <button
          onClick={() => setBotRunning((r) => !r)}
          disabled={price === null}
          aria-label={botRunning ? 'Pause trading bot' : 'Start trading bot'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: botRunning ? THEME.panelAlt : THEME.gold,
            color: botRunning ? THEME.text : '#1A1508',
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 16px',
            fontFamily: FONT_SANS,
            fontSize: '13px',
            fontWeight: 500,
            cursor: price === null ? 'not-allowed' : 'pointer',
            opacity: price === null ? 0.5 : 1,
          }}
        >
          {botRunning ? <Pause size={14} /> : <Play size={14} />}
          {botRunning ? 'Pause bot' : 'Start bot'}
        </button>
        <button
          onClick={() => handleReset()}
          aria-label="Reset portfolio to initial state"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            color: THEME.muted,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 16px',
            fontFamily: FONT_SANS,
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          <RotateCcw size={14} /> Reset portfolio
        </button>
        <button
          onClick={handleResetChart}
          aria-label="Clear saved chart history and reseed"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'transparent',
            color: THEME.muted,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 16px',
            fontFamily: FONT_SANS,
            fontSize: '13px',
            cursor: 'pointer',
          }}
          title="Re-seed the chart from the live feed (keeps your portfolio)"
        >
          <RotateCcw size={14} /> Reload feed
        </button>
        <select
          value={riskKey}
          onChange={(e) => setRiskKey(e.target.value)}
          aria-label="Select risk preset"
          style={{
            background: THEME.panelAlt,
            color: THEME.text,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 12px',
            fontFamily: FONT_SANS,
            fontSize: '13px',
          }}
        >
          {Object.entries(RISK_PRESETS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label} risk
            </option>
          ))}
        </select>
        <span
          title="Lot size per trade — set in LLM settings / Account panel"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontFamily: FONT_MONO,
            fontSize: '12px',
            color: THEME.muted,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 12px',
          }}
        >
          <Target size={13} /> {lotOz} oz lot &middot; ${fmtUSD(startCash, 0)}
        </span>
        <button
          onClick={() => setMathOnly((m) => !m)}
          aria-label={mathOnly ? 'Enable LLM news analysis' : 'Use math-only mode'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: mathOnly ? THEME.gold : 'transparent',
            color: mathOnly ? '#1A1508' : THEME.muted,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '6px',
            padding: '8px 16px',
            fontFamily: FONT_SANS,
            fontSize: '13px',
            cursor: 'pointer',
          }}
          title="Fetch an LLM read on current gold news. In replay this is shown for reference only — it cannot affect trades, since today's headlines say nothing about a historical bar."
        >
          <Calculator size={14} /> {mathOnly ? 'Math-only mode' : 'Show LLM news'}
        </button>
      </div>
      {canUseNews && (
        <div
          style={{
            fontSize: '11px',
            color: THEME.muted,
            marginBottom: '14px',
            display: 'flex',
            gap: '6px',
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={13} color={THEME.gold} style={{ flexShrink: 0, marginTop: '1px' }} />
          <span>
            News is blended into the live score at {(NEWS_WEIGHT * 100).toFixed(0)}% weight,
            decayed by age and by the model&apos;s own confidence. This is legitimate here because
            the headlines and the price bar are contemporaneous — the Backtest tab stays math-only
            for exactly that reason, since scoring a past bar with today&apos;s news would be
            look-ahead bias.
          </span>
        </div>
      )}

      {/* Metrics */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '12px',
          marginBottom: '20px',
        }}
      >
        {[
          { label: 'Portfolio value', value: `$${fmtUSD(equityValue)}` },
          { label: 'Cash', value: `$${fmtUSD(portfolio.cash)}` },
          {
            label: 'Gold held',
            value: `${fmtOz(portfolio.oz)} oz`,
          },
          {
            label: 'P&L',
            value: `${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))}`,
            color: pnl >= 0 ? THEME.gain : THEME.loss,
            sub: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`,
          },
        ].map((m) => (
          <div
            key={m.label}
            style={{
              background: THEME.panel,
              border: `1px solid ${THEME.hairline}`,
              borderRadius: '8px',
              padding: '12px 14px',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                color: THEME.muted,
                marginBottom: '6px',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {m.label}
            </div>
            <div
              style={{
                fontFamily: FONT_SERIF,
                fontSize: '22px',
                color: m.color || THEME.text,
              }}
            >
              {m.value}
            </div>
            {m.sub && (
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: '11px',
                  color: m.color || THEME.muted,
                }}
              >
                {m.sub}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Open Position */}
      {portfolio.oz > 0 && portfolio.entryPrice && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            background: THEME.panelAlt,
            border: `1px solid ${THEME.gold}`,
            borderRadius: '8px',
            padding: '10px 14px',
            marginBottom: '16px',
            fontSize: '12px',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{ fontFamily: FONT_MONO, color: THEME.gold, fontWeight: 600 }}
          >
            OPEN POSITION
          </span>
          <span style={{ color: THEME.muted }}>
            Long {fmtOz(portfolio.oz)} oz @ ${fmtUSD(portfolio.entryPrice)}
          </span>
          {openPositionPnlPct != null && (
            <span
              style={{
                fontFamily: FONT_MONO,
                color: openPositionPnlPct >= 0 ? THEME.gain : THEME.loss,
              }}
            >
              {openPositionPnlPct >= 0 ? '+' : ''}
              {openPositionPnlPct.toFixed(2)}%
            </span>
          )}
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              color: portfolio.beActive ? THEME.muted : THEME.loss,
              fontFamily: FONT_MONO,
            }}
          >
            <Shield size={12} /> SL ${fmtUSD(portfolio.slPrice)}
            {portfolio.beActive &&
              (portfolio.slPrice != null &&
              portfolio.entryPrice != null &&
              portfolio.slPrice > portfolio.entryPrice
                ? ' (trailing)'
                : ' (BE)')}
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              color: THEME.gain,
              fontFamily: FONT_MONO,
            }}
          >
            <Target size={12} /> TP ${fmtUSD(portfolio.tpPrice)}
          </span>
        </div>
      )}

      {/* Chart + News */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: !canUseNews ? '1fr' : 'minmax(0, 1.6fr) minmax(0, 1fr)',
          gap: '16px',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            background: THEME.panel,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '8px',
            padding: '14px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span
              style={{
                fontSize: '12px',
                color: THEME.muted,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              Spot price
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: '13px', color: THEME.goldBright }}>
              ${price ? fmtUSD(price) : '--'}
            </span>
          </div>
          <PriceChart
            candles={candles}
            height={280}
            timeframe={timeframe}
            onTimeframeChange={setTimeframe}
            timeframes={INTRADAY_TIMEFRAMES}
            entryPrice={portfolio.oz > 0 ? portfolio.entryPrice : null}
            slPrice={portfolio.oz > 0 ? portfolio.slPrice : null}
            tpPrice={portfolio.oz > 0 ? portfolio.tpPrice : null}
            beActive={portfolio.beActive}
            trades={portfolio.trades}
          />
          <div
            style={{
              display: 'flex',
              gap: '16px',
              marginTop: '10px',
              fontFamily: FONT_MONO,
              fontSize: '11px',
              color: THEME.muted,
              flexWrap: 'wrap',
            }}
          >
            <span>EMA12 {ema12 ? `$${fmtUSD(ema12)}` : '--'}</span>
            <span>EMA26 {ema26 ? `$${fmtUSD(ema26)}` : '--'}</span>
            <span>RSI14 {rsi ? rsi.toFixed(1) : '--'}</span>
            <span>ATR14 {atr ? `$${fmtUSD(atr)}` : '--'}</span>
            <span>
              MACD {macd != null ? (macd > 0 ? '+' : '') + fmtUSD(macd, 3) : '--'}
            </span>
            <span>BBW {bbWidth != null ? bbWidth.toFixed(2) + '%' : '--'}</span>
            <span>
              Trend {regression ? (regression.slopePct > 0 ? '+' : '') + regression.slopePct.toFixed(3) + '%/bar' : '--'}
              {regression ? ` (R² ${regression.r2.toFixed(2)})` : ''}
            </span>
            <span>Z-score {meanReversionZ != null ? meanReversionZ.toFixed(2) : '--'}</span>
          </div>
        </div>

        {canUseNews && (
          <div
            style={{
              background: THEME.panel,
              border: `1px solid ${THEME.hairline}`,
              borderRadius: '8px',
              padding: '14px',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '10px',
              }}
            >
              <span
                style={{
                  fontSize: '12px',
                  color: THEME.muted,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <Newspaper size={13} /> News &amp; macro &middot; {activeProvider.label}
              </span>
              <button
                onClick={runNewsRefresh}
                disabled={newsLoading}
                aria-label="Refresh news analysis"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: THEME.muted,
                  cursor: 'pointer',
                  display: 'flex',
                }}
              >
                {newsLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
            {newsLoading && !news && (
              <div style={{ fontSize: '12px', color: THEME.muted }}>
                Analyzing latest gold news...
              </div>
            )}
            {newsErrorMsg && !news && (
              <div style={{ fontSize: '12px', color: THEME.loss }}>{newsErrorMsg}</div>
            )}
            {news && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                  <BiasIcon size={14} color={biasColor} />
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: '12px',
                      color: biasColor,
                      textTransform: 'uppercase',
                    }}
                  >
                    {news.bias}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: '11px', color: THEME.muted }}>
                    score {news.sentiment_score.toFixed(2)}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: '11px', color: THEME.muted }}>
                    conf {(news.confidence * 100).toFixed(0)}%
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: '11px', color: THEME.muted }}>
                    · weighted {effectiveSentiment.toFixed(2)}
                  </span>
                </div>
                <p style={{ fontSize: '13px', lineHeight: 1.5, margin: '0 0 10px' }}>
                  {news.summary}
                </p>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '6px',
                    borderTop: `1px solid ${THEME.hairline}`,
                    paddingTop: '10px',
                  }}
                >
                  <Landmark
                    size={13}
                    color={THEME.muted}
                    style={{ marginTop: '2px', flexShrink: 0 }}
                  />
                  <p style={{ fontSize: '12px', color: THEME.muted, lineHeight: 1.5, margin: 0 }}>
                    {news.key_driver}
                  </p>
                </div>
                <div style={{ fontSize: '10px', color: THEME.muted, marginTop: '10px' }}>
                  Updated {new Date(news.ts).toLocaleTimeString()}{' '}
                  {!news.usedWebSearch && '· general-knowledge estimate, not live search'}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Quant Signal + Performance Stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '16px',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            background: THEME.panel,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '8px',
            padding: '14px',
          }}
        >
          <div
            style={{
              fontSize: '12px',
              color: THEME.muted,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginBottom: '10px',
            }}
          >
            Quant signal
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '8px' }}>
            <span
              style={{
                fontFamily: FONT_SERIF,
                fontSize: '26px',
                color: currentWinProbability >= 0.5 ? THEME.gain : THEME.loss,
              }}
            >
              {(currentWinProbability * 100).toFixed(0)}%
            </span>
            <span style={{ fontSize: '11px', color: THEME.muted }}>
              calibrated up-probability (sigmoid of composite score, not a guarantee)
            </span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '6px 12px',
              fontFamily: FONT_MONO,
              fontSize: '11px',
              color: THEME.muted,
            }}
          >
            <span>Technical score {currentTechScore >= 0 ? '+' : ''}{currentTechScore.toFixed(3)}</span>
            <span>Composite {currentCombinedScore >= 0 ? '+' : ''}{currentCombinedScore.toFixed(3)}</span>
            <span>News weight {(newsAgeWeight * 100).toFixed(0)}%</span>
            <span>
              Kelly size {currentKelly != null ? (currentKelly * 100).toFixed(1) + '%' : 'n/a (needs 8+ trades)'}
            </span>
          </div>
        </div>

        <div
          style={{
            background: THEME.panel,
            border: `1px solid ${THEME.hairline}`,
            borderRadius: '8px',
            padding: '14px',
          }}
        >
          <div
            style={{
              fontSize: '12px',
              color: THEME.muted,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginBottom: '10px',
            }}
          >
            Performance stats &middot; {tradeStats.totalTrades} closed trades
          </div>
          {tradeStats.totalTrades === 0 ? (
            <div style={{ fontSize: '12px', color: THEME.muted }}>
              No closed trades yet &mdash; stats populate after the first round-trip.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '6px 12px',
                fontFamily: FONT_MONO,
                fontSize: '11px',
                color: THEME.muted,
              }}
            >
              <span>Win rate {(tradeStats.winRate * 100).toFixed(0)}%</span>
              <span>
                Expectancy{' '}
                <span style={{ color: tradeStats.expectancyPct >= 0 ? THEME.gain : THEME.loss }}>
                  {tradeStats.expectancyPct >= 0 ? '+' : ''}
                  {tradeStats.expectancyPct.toFixed(2)}%
                </span>
              </span>
              <span>
                Profit factor{' '}
                {tradeStats.profitFactor == null
                  ? '--'
                  : tradeStats.profitFactor === Infinity
                    ? '∞'
                    : tradeStats.profitFactor.toFixed(2)}
              </span>
              <span>Avg win/loss +{tradeStats.avgWinPct.toFixed(2)}% / -{tradeStats.avgLossPct.toFixed(2)}%</span>
              <span>Sharpe {tradeStats.sharpe != null ? tradeStats.sharpe.toFixed(2) : '--'}</span>
              <span>Sortino {tradeStats.sortino != null ? tradeStats.sortino.toFixed(2) : '--'}</span>
              <span style={{ gridColumn: '1 / -1' }}>
                Max drawdown{' '}
                <span style={{ color: THEME.loss }}>
                  {tradeStats.maxDrawdownPct != null ? tradeStats.maxDrawdownPct.toFixed(2) : '--'}%
                </span>{' '}
                (cumulative closed-trade PnL%)
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Market Memory / Brain */}
      <div
        style={{
          background: THEME.panel,
          border: `1px solid ${THEME.hairline}`,
          borderRadius: '8px',
          padding: '14px',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: THEME.muted,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: '12px',
          }}
        >
          <Brain size={13} /> Market memory &middot; learned from{' '}
          {tradeStats.totalTrades} closed trade{tradeStats.totalTrades === 1 ? '' : 's'}
        </div>

        {/* Day / Week / Month trend badges */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '10px',
            marginBottom: '14px',
          }}
        >
          {[
            { label: 'Today', trend: dayTrend },
            { label: 'This week', trend: weekTrend },
            { label: 'This month', trend: monthTrend },
          ].map(({ label, trend }) => (
            <div
              key={label}
              style={{
                background: THEME.panelAlt,
                border: `1px solid ${THEME.hairline}`,
                borderRadius: '6px',
                padding: '10px 12px',
              }}
            >
              <div style={{ fontSize: '11px', color: THEME.muted, marginBottom: '4px' }}>
                {label}
              </div>
              {trend ? (
                <>
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: '15px',
                      color: trend.changePct >= 0 ? THEME.gain : THEME.loss,
                    }}
                  >
                    {trend.changePct >= 0 ? '+' : ''}
                    {trend.changePct.toFixed(2)}%
                  </div>
                  <div style={{ fontSize: '10px', color: THEME.muted }}>
                    {trend.r2 >= 0.3
                      ? trend.slopePct > 0
                        ? 'Trending up'
                        : 'Trending down'
                      : 'Choppy / range-bound'}{' '}
                    &middot; {trend.points} pts
                  </div>
                </>
              ) : (
                <div style={{ fontSize: '11px', color: THEME.muted }}>Not enough data yet</div>
              )}
            </div>
          ))}
        </div>

        {/* Current regime + learned win rate */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '10px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '11px', color: THEME.muted }}>Current condition:</span>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: '12px',
              color: THEME.goldBright,
              background: THEME.panelAlt,
              border: `1px solid ${THEME.hairline}`,
              borderRadius: '4px',
              padding: '3px 8px',
            }}
          >
            {currentRegimeStr}
          </span>
          {currentRegimeStat ? (
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: '11px',
                color: currentRegimeStat.winRate >= 0.5 ? THEME.gain : THEME.loss,
              }}
            >
              {(currentRegimeStat.winRate * 100).toFixed(0)}% win rate over{' '}
              {currentRegimeStat.trades} past trade{currentRegimeStat.trades === 1 ? '' : 's'}
            </span>
          ) : (
            <span style={{ fontSize: '11px', color: THEME.muted }}>
              no history yet in this exact condition
            </span>
          )}
          {currentRegime.trend === 'Flat' && (
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: '11px',
                color: THEME.loss,
                border: `1px solid ${THEME.loss}`,
                borderRadius: '4px',
                padding: '2px 6px',
              }}
              title="Regression R² is below 0.3 or the slope is too shallow to call a direction — new entries are blocked until a real trend confirms."
            >
              chop filter: entries blocked (no confirmed trend)
            </span>
          )}
        </div>

        {/* Learned regime table */}
        {regimeStatsAll.length > 0 ? (
          <div style={{ maxHeight: '180px', overflowY: 'auto', overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                minWidth: '480px',
                borderCollapse: 'collapse',
                fontSize: '11px',
                fontFamily: FONT_MONO,
              }}
            >
              <thead>
                <tr style={{ color: THEME.muted, textAlign: 'left' }}>
                  <th style={{ padding: '4px 6px', fontWeight: 400 }}>Learned condition</th>
                  <th style={{ padding: '4px 6px', fontWeight: 400 }}>Trades</th>
                  <th style={{ padding: '4px 6px', fontWeight: 400 }}>Win rate</th>
                  <th style={{ padding: '4px 6px', fontWeight: 400 }}>Avg PnL</th>
                </tr>
              </thead>
              <tbody>
                {regimeStatsAll.slice(0, 10).map((s) => (
                  <tr
                    key={s.regime}
                    style={{
                      borderTop: `1px solid ${THEME.hairline}`,
                      background:
                        s.regime === currentRegimeStr ? 'rgba(198,161,91,0.08)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '4px 6px', color: THEME.text }}>{s.regime}</td>
                    <td style={{ padding: '4px 6px', color: THEME.muted }}>{s.trades}</td>
                    <td
                      style={{
                        padding: '4px 6px',
                        color: s.winRate >= 0.5 ? THEME.gain : THEME.loss,
                      }}
                    >
                      {(s.winRate * 100).toFixed(0)}%
                    </td>
                    <td
                      style={{
                        padding: '4px 6px',
                        color: s.avgPnlPct >= 0 ? THEME.gain : THEME.loss,
                      }}
                    >
                      {s.avgPnlPct >= 0 ? '+' : ''}
                      {s.avgPnlPct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: '11px', color: THEME.muted }}>
            The brain builds this table from the bot&apos;s own closed paper trades &mdash; once
            it has 6-8+ trades in a given condition it starts nudging entries toward setups that
            have worked and away from (or outright skipping) ones that haven&apos;t.
          </div>
        )}
      </div>

      {/* Equity Curve */}
      <div
        style={{
          background: THEME.panel,
          border: `1px solid ${THEME.hairline}`,
          borderRadius: '8px',
          padding: '14px',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            fontSize: '12px',
            color: THEME.muted,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: '8px',
          }}
        >
          Equity curve
        </div>
        <div style={{ height: '110px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityCurve}>
              <XAxis dataKey="t" hide />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: THEME.muted, fontSize: 10 }}
                width={50}
              />
              <Tooltip
                contentStyle={{
                  background: THEME.panelAlt,
                  border: `1px solid ${THEME.hairline}`,
                  fontSize: '12px',
                }}
                labelStyle={{ display: 'none' }}
                formatter={(v: number) => [`$${fmtUSD(v)}`, 'Value']}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={THEME.gold}
                fill={THEME.gold}
                fillOpacity={0.12}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Trade Ledger */}
      <div
        style={{
          background: THEME.panel,
          border: `1px solid ${THEME.hairline}`,
          borderRadius: '8px',
          padding: '14px',
        }}
      >
        <div
          style={{
            fontSize: '12px',
            color: THEME.muted,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            marginBottom: '10px',
          }}
        >
          Trade ledger
        </div>
        {portfolio.trades.length === 0 && (
          <div style={{ fontSize: '12px', color: THEME.muted }}>
            No trades yet. Start the bot to begin the simulation.
          </div>
        )}
        <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
          {portfolio.trades.map((t) => (
            <div
              key={t.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 0',
                borderBottom: `1px solid ${THEME.hairline}`,
                gap: '10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '3px',
                    background:
                      t.side === 'BUY'
                        ? 'rgba(91,146,121,0.15)'
                        : 'rgba(181,83,60,0.15)',
                    color: t.side === 'BUY' ? THEME.gain : THEME.loss,
                    flexShrink: 0,
                  }}
                >
                  {t.side}
                </span>
                <span
                  style={{
                    fontSize: '12px',
                    color: THEME.muted,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {t.reasoning}
                </span>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: '12px' }}>
                  {fmtOz(t.oz)} oz @ ${fmtUSD(t.price)}
                </div>
                {typeof t.pnl === 'number' && (
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: '11px',
                      color: t.pnl >= 0 ? THEME.gain : THEME.loss,
                    }}
                  >
                    {t.pnl >= 0 ? '+' : '-'}${fmtUSD(Math.abs(t.pnl))} (
                    {t.pnlPct != null && t.pnlPct >= 0 ? '+' : ''}
                    {t.pnlPct?.toFixed(2) ?? '--'}%)
                  </div>
                )}
                <div style={{ fontFamily: FONT_MONO, fontSize: '10px', color: THEME.muted }}>
                  {t.time}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}