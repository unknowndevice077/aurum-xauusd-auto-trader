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
  History,
} from 'lucide-react';
import PriceChart, { Candle, TIMEFRAMES, TimeframeKey } from './PriceChart';
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
} from '../lib/quant';
import {
  classifyRegime,
  regimeKey,
  computeRegimeStats,
  regimeThresholdAdjustment,
  regimeShouldBlock,
} from '../lib/brain';
import { getAccountTier } from '../lib/accountTier';
import { RISK_PRESETS } from '../lib/riskPresets';
import { runBacktest, type BacktestResult } from '../lib/backtest';
import type { Portfolio, Trade, NewsResult, ProviderKey, ProviderMeta } from '../lib/types';
import {
  fmtUSD,
  fmtOz,
  buildCandles,
  backfillTradePnl,
  fetchNewsAnalysis,
} from '../lib/helpers';

// ─── Theme ─────────────────────────────────────────────────────────────────
const THEME = {
  bg: '#0E0F10',
  panel: '#17181A',
  panelAlt: '#1D1E20',
  hairline: '#2A2B2D',
  gold: '#C6A15B',
  goldBright: '#E8C878',
  text: '#EDEAE0',
  muted: '#8B8D93',
  gain: '#5B9279',
  loss: '#B5533C',
};

// ─── Constants ─────────────────────────────────────────────────────────────
const TICK_MS = 4000;
const HISTORY_CAP = 5000;
// Minimum time a position must be held before a *signal-based* exit is
// allowed to fire (stop-loss/take-profit are real risk controls and stay
// instant). Without this, a single noisy tick right after entry — the
// regression/z-score factors both use a short 20-tick lookback that shifts
// every time a new price lands — could cross back through the exit
// threshold and close the trade one tick after it opened.
const MIN_HOLD_MS = TICK_MS * 3; // ~12s at the default 4s tick rate
const TECH_WEIGHT = 0.55;
const NEWS_WEIGHT = 0.45;
const DEFAULT_START_CASH = 10000;
const MIN_START_CASH = 1;
const MAX_START_CASH = 10_000_000;
const FALLBACK_PRICE = 4000;

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
    trades: [],
  });
  const [equityCurve, setEquityCurve] = useState<{ t: number; value: number }[]>([]);
  // Real, uncapped 1y daily history — independent of the live tick buffer
  // (which gets trimmed by HISTORY_CAP) — used purely for the day/week/month
  // "market memory" monitoring panel.
  const [dailyHistory, setDailyHistory] = useState<{ t: number; p: number }[]>([]);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [backtestRunning, setBacktestRunning] = useState(false);
  const [backtestError, setBacktestError] = useState('');
  const [botRunning, setBotRunning] = useState(false);
  const [riskKey, setRiskKey] = useState('balanced');
  const [mathOnly, setMathOnly] = useState(true);
  const [news, setNews] = useState<NewsResult | null>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsErrorMsg, setNewsErrorMsg] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [timeframe, setTimeframe] = useState<TimeframeKey>('20s');
  const [showSettings, setShowSettings] = useState(false);
  const [providerKey, setProviderKey] = useState<ProviderKey>('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(PROVIDER_META.openai.defaultModel);

  // ─── Refs ──────────────────────────────────────────────────────────────
  const priceRef = useRef<number | null>(null);
  const newsRef = useRef<NewsResult | null>(null);
  const portfolioRef = useRef(portfolio);
  portfolioRef.current = portfolio;
  const historyRef = useRef(priceHistory);
  const resumedFromHistory = useRef(false);
  const consecutiveLossesRef = useRef(0);
  const lastTradeResultRef = useRef<'win' | 'loss' | null>(null);

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
      const storedHistory = localStorage.getItem('aurum-price-history');
      if (storedHistory) {
        const parsedHistory: unknown[] = JSON.parse(storedHistory);
        const isValidPricePointArray =
          Array.isArray(parsedHistory) &&
          parsedHistory.length > 0 &&
          parsedHistory.every(
            (pt) =>
              pt &&
              typeof (pt as { t: number }).t === 'number' &&
              typeof (pt as { p: number }).p === 'number' &&
              !isNaN((pt as { t: number }).t) &&
              !isNaN((pt as { p: number }).p)
          );

        if (isValidPricePointArray) {
          const validHistory = parsedHistory as { t: number; p: number }[];
          setPriceHistory(validHistory);
          const last = validHistory[validHistory.length - 1];
          priceRef.current = last.p;
          setPrice(last.p);
          setDataSourceLabel('Resumed from saved session');
          resumedFromHistory.current = true;
        } else {
          localStorage.removeItem('aurum-price-history');
        }
      }
      const storedTf = localStorage.getItem('aurum-timeframe');
      if (storedTf && TIMEFRAMES.some((t) => t.key === storedTf)) {
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

  useEffect(() => {
    if (!loaded || priceHistory.length === 0) return;
    localStorage.setItem('aurum-price-history', JSON.stringify(priceHistory));
  }, [priceHistory, loaded]);

  // ─── Initial Price Feed ──────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded || resumedFromHistory.current) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/history');
        const json = await res.json();
        if (!res.ok || !json.points?.length) throw new Error(json.error || 'no history');
        const points: { t: number; p: number }[] = json.points;
        if (cancelled) return;
        setPriceHistory(points);
        const last = points[points.length - 1];
        priceRef.current = last.p;
        setPrice(last.p);
        setDataSourceLabel('Real 1y history (GC=F daily) + simulated live ticks');
      } catch {
        if (cancelled) return;
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 3000);
          const res2 = await fetch('https://api.metals.live/v1/spot/gold', {
            signal: controller.signal,
          });
          clearTimeout(t);
          const json2 = await res2.json();
          const last2 = Array.isArray(json2) ? json2[json2.length - 1] : null;
          const seed = last2 ? Number(last2[1] || last2.price) : null;
          if (!cancelled && seed && seed > 100 && seed < 100000) {
            priceRef.current = seed;
            setPrice(seed);
            setDataSourceLabel('Live spot seed, simulated ticks (history unavailable)');
          } else {
            throw new Error('bad seed');
          }
        } catch {
          if (!cancelled) {
            priceRef.current = FALLBACK_PRICE;
            setPrice(FALLBACK_PRICE);
            setDataSourceLabel('Simulated (live feed unavailable)');
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  // ─── Daily History (for week/month market memory) ──────────────────────
  // Fetched independently of the resumed-session check above so the
  // monitoring panel always has real week/month context, even when the live
  // tick buffer was restored from localStorage.
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/history');
        const json = await res.json();
        if (!cancelled && !json.error && Array.isArray(json.points) && json.points.length > 0) {
          setDailyHistory(json.points);
        }
      } catch {
        // Non-critical — the monitoring panel just shows "not enough data" if this fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded]);

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

  // ─── Bot Tick ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (price === null) return;
    const id = setInterval(() => {
      // News sentiment is time-decayed (15min half-life) and scaled by the
      // model's own self-reported confidence, so a stale or low-confidence
      // read stops dominating the decision the way a fresh, confident one does.
      const newsAgeWeight =
        canUseNews && newsRef.current
          ? newsEffectiveWeight(Date.now() - newsRef.current.ts, newsRef.current.confidence)
          : 0;
      const sentiment =
        canUseNews && newsRef.current ? newsRef.current.sentiment_score * newsAgeWeight : 0;
      const drift = sentiment * 0.0006;
      const noise = (Math.random() - 0.5) * 0.004;
      const nextPrice = Math.max(1, (priceRef.current as number) * (1 + drift + noise));
      priceRef.current = nextPrice;
      setPrice(nextPrice);

      const nowSec = Math.floor(Date.now() / 1000);
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
      const regimeNow = classifyRegime(
        regression,
        rsi,
        bbWidth,
        canUseNews ? newsRef.current?.bias ?? null : null
      );
      const regimeNowKey = regimeKey(regimeNow);
      // Account-size-aware risk tiering: a $10 account gets smaller bets,
      // pickier entries, and a bigger untouchable cash cushion than a
      // $10,000 one, even though both use the same % math underneath.
      const tier = getAccountTier(startCash);
      const reserveFloor = Math.max(startCash * tier.reserveFloorPct, 0.01);

      if (botRunning) {
        const cur = portfolioRef.current;
        const preset = RISK_PRESETS[riskKey];

        // Dynamic threshold adjustment based on losing streak, plus the
        // account tier's selectivity bump (micro/small accounts demand a
        // cleaner signal before committing capital they can't spare).
        let adjustedThreshold = preset.threshold + tier.thresholdBump;
        if (consecutiveLossesRef.current >= 3) {
          adjustedThreshold = Math.min(
            0.5,
            adjustedThreshold * (1 + consecutiveLossesRef.current * 0.15)
          );
        }

        if (cur.oz > 0 && cur.entryPrice != null) {
          const posThreshold = cur.positionThreshold ?? preset.threshold;
          const posBeTriggerPct = cur.positionBeTriggerPct ?? preset.beTriggerPct;
          const posUsesNews = cur.positionUsesNews ?? canUseNews;

          // ─── Stop-Loss Hit ───────────────────────────────────────────────
          if (cur.slPrice != null && nextPrice <= cur.slPrice) {
            const proceeds = cur.oz * nextPrice;
            const label = !cur.beActive
              ? 'Stop-loss hit'
              : cur.entryPrice != null && cur.slPrice > cur.entryPrice
                ? 'Trailing stop hit (profit locked)'
                : 'Breakeven stop hit';
            const pnl = (nextPrice - cur.entryPrice) * cur.oz;
            const pnlPct = ((nextPrice - cur.entryPrice) / cur.entryPrice) * 100;
            const trade: Trade = {
              id: Date.now(),
              ts: nowSec,
              time: new Date().toLocaleTimeString(),
              side: 'SELL',
              price: nextPrice,
              oz: cur.oz,
              value: proceeds,
              pnl,
              pnlPct,
              reasoning: label,
            };
            portfolioRef.current = {
              ...cur,
              cash: cur.cash + proceeds,
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
              trades: [trade, ...cur.trades].slice(0, 100),
            };
            setPortfolio(portfolioRef.current);
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
            const proceeds = cur.oz * nextPrice;
            const pnl = (nextPrice - cur.entryPrice) * cur.oz;
            const pnlPct = ((nextPrice - cur.entryPrice) / cur.entryPrice) * 100;
            const trade: Trade = {
              id: Date.now(),
              ts: nowSec,
              time: new Date().toLocaleTimeString(),
              side: 'SELL',
              price: nextPrice,
              oz: cur.oz,
              value: proceeds,
              pnl,
              pnlPct,
              reasoning: 'Take-profit hit',
            };
            portfolioRef.current = {
              ...cur,
              cash: cur.cash + proceeds,
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
              trades: [trade, ...cur.trades].slice(0, 100),
            };
            setPortfolio(portfolioRef.current);
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
            const combined = posUsesNews
              ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment
              : tech;
            const heldMs = cur.entryTs != null ? Date.now() - cur.entryTs : Infinity;
            const minHoldElapsed = heldMs >= MIN_HOLD_MS;
            if (minHoldElapsed && combined < -posThreshold) {
              const liveCur = portfolioRef.current;
              const proceeds = liveCur.oz * nextPrice;
              const reasoning = !posUsesNews
                ? `Downtrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (math-only)`
                : `${tech <= 0 ? 'Downtrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment < 0 ? 'negative' : 'cooling'}${newsRef.current?.key_driver ? ' (' + newsRef.current.key_driver + ')' : ''}`;
              const pnl = (nextPrice - liveCur.entryPrice!) * liveCur.oz;
              const pnlPct = ((nextPrice - liveCur.entryPrice!) / liveCur.entryPrice!) * 100;
              const trade: Trade = {
                id: Date.now(),
                ts: nowSec,
                time: new Date().toLocaleTimeString(),
                side: 'SELL',
                price: nextPrice,
                oz: liveCur.oz,
                value: proceeds,
                pnl,
                pnlPct,
                reasoning,
              };
              portfolioRef.current = {
                ...liveCur,
                cash: liveCur.cash + proceeds,
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
                trades: [trade, ...liveCur.trades].slice(0, 100),
              };
              setPortfolio(portfolioRef.current);
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
        // Gate scales with account size: below the tier's reserve floor there
        // isn't enough spare cash to justify a new position.
        else if (cur.oz === 0 && cur.cash > reserveFloor) {
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
          const combined = canUseNews
            ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment
            : tech;

          // Brain lookup: has this exact market regime historically been a
          // winner or a loser for this bot's own trades?
          const regimeStatsNow = computeRegimeStats(cur.trades);
          const matchedRegimeStat = regimeStatsNow.find((s) => s.regime === regimeNowKey);
          const regimeAdj = regimeThresholdAdjustment(matchedRegimeStat);
          const brainBlocked = regimeShouldBlock(matchedRegimeStat);

          if (!brainBlocked && combined > adjustedThreshold + regimeAdj) {
            // Kelly-criterion position sizing: once we have enough closed-trade
            // history, size the bet by our actual realized edge (win rate vs.
            // avg win/loss) rather than a fixed % — a thin or negative edge
            // shrinks the bet instead of always betting the preset max. The
            // account tier further caps how large a single bet is allowed
            // to be relative to the risk preset (smaller accounts get a
            // tighter cap).
            const stats = computeTradeStats(cur.trades);
            const kelly = kellyFraction(
              stats.winRate,
              stats.avgWinPct,
              stats.avgLossPct,
              8,
              stats.totalTrades
            );
            const tierCappedPositionPct = preset.positionPct * tier.positionCapMultiplier;
            const effectivePositionPct =
              kelly != null ? Math.min(tierCappedPositionPct, kelly * 100) : tierCappedPositionPct;

            const sized = calculatePositionSize(
              cur.cash,
              effectivePositionPct,
              nextPrice,
              atr,
              preset.slPct
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
              // FIX: Use actualSlPct from calculatePositionSize instead of preset.slPct
              const slPrice = nextPrice * (1 - actualSlPct);
              const tpPrice = nextPrice * (1 + preset.tpPct);
              const reasoning = !canUseNews
                ? `Uptrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (math-only)`
                : `${tech >= 0 ? 'Uptrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment >= 0 ? 'supportive' : 'cautious'}${newsRef.current?.key_driver ? ' (' + newsRef.current.key_driver + ')' : ''}`;
              const brainNote =
                matchedRegimeStat && matchedRegimeStat.trades >= 6
                  ? ` · brain: ${(matchedRegimeStat.winRate * 100).toFixed(0)}% win in "${regimeNowKey}" (${matchedRegimeStat.trades} past trades)`
                  : '';
              const trade: Trade = {
                id: Date.now(),
                ts: nowSec,
                time: new Date().toLocaleTimeString(),
                side: 'BUY',
                price: nextPrice,
                oz,
                value: spend,
                reasoning: `${reasoning} · SL $${fmtUSD(slPrice)} / TP $${fmtUSD(tpPrice)}${atr ? ' · ATR $' + fmtUSD(atr) : ''}${brainNote}`,
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
                positionUsesNews: canUseNews,
                trades: [trade, ...cur.trades].slice(0, 100),
              };
              setPortfolio(portfolioRef.current);
            }
          }
        }
      }

      const finalPortfolio = portfolioRef.current;
      setEquityCurve((eq) => {
        const val = finalPortfolio.cash + finalPortfolio.oz * nextPrice;
        return [...eq, { t: eq.length, value: val }].slice(-150);
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [price, botRunning, riskKey, canUseNews, startCash]);

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
        trades: [],
      };
      setPortfolio(fresh);
      setEquityCurve([]);
      consecutiveLossesRef.current = 0;
      lastTradeResultRef.current = null;
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

  const handleRunBacktest = useCallback(() => {
    setBacktestError('');
    if (dailyHistory.length === 0) {
      setBacktestError('No historical data loaded yet — try again in a moment.');
      return;
    }
    setBacktestRunning(true);
    // Yield a frame so the "running" state actually paints before the
    // (synchronous, fast) backtest loop runs.
    setTimeout(() => {
      try {
        const result = runBacktest(dailyHistory, { riskKey, startCash });
        if (!result) {
          setBacktestError('Not enough historical data to backtest (need 55+ daily bars).');
          setBacktestResult(null);
        } else {
          setBacktestResult(result);
        }
      } catch (e: unknown) {
        setBacktestError(e instanceof Error ? e.message : 'Backtest failed');
      } finally {
        setBacktestRunning(false);
      }
    }, 10);
  }, [dailyHistory, riskKey, startCash]);

  const handleResetChart = useCallback(() => {
    setPriceHistory([]);
    priceRef.current = null;
    setPrice(null);
    localStorage.removeItem('aurum-price-history');
    setDataSourceLabel('Seeding price feed...');
    resumedFromHistory.current = false;
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

  const accountTier = useMemo(() => getAccountTier(startCash), [startCash]);
  const equityValue = price ? portfolio.cash + portfolio.oz * price : portfolio.cash;
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
  const activeGroupSize =
    TIMEFRAMES.find((t) => t.key === timeframe)?.groupSize ?? 5;
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
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: '11px',
                color: THEME.goldBright,
                background: THEME.panel,
                border: `1px solid ${THEME.hairline}`,
                borderRadius: '4px',
                padding: '6px 10px',
              }}
            >
              {accountTier.name} account
            </span>
          </div>
          <div style={{ fontSize: '11px', color: THEME.muted, marginBottom: '20px' }}>
            {accountTier.description} Position sizing is capped at{' '}
            {(accountTier.positionCapMultiplier * 100).toFixed(0)}% of the risk preset&apos;s
            normal size, entries need a{' '}
            {accountTier.thresholdBump >= 0 ? 'stricter' : 'slightly looser'} signal (
            {accountTier.thresholdBump >= 0 ? '+' : ''}
            {accountTier.thresholdBump.toFixed(2)} threshold), and{' '}
            {(accountTier.reserveFloorPct * 100).toFixed(0)}% of starting capital (
            ${fmtUSD(Math.max(startCash * accountTier.reserveFloorPct, 0.01))}) is always kept
            in reserve, untouched by any single trade. Changing this resets the portfolio.
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
          title="Clear saved chart history and reseed from real historical data"
        >
          <RotateCcw size={14} /> Reset chart
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
          title={accountTier.description}
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
          <Target size={13} /> {accountTier.name} &middot; ${fmtUSD(startCash, 0)}
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
          title="Skip the LLM news call entirely and trade on improved technical signals only"
        >
          <Calculator size={14} /> {mathOnly ? 'Math-only mode' : 'Use LLM news'}
        </button>
      </div>

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

      {/* Backtest */}
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
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '10px',
            marginBottom: '12px',
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '12px',
              color: THEME.muted,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            <History size={13} /> Backtest &middot; 1-year daily history
          </span>
          <button
            onClick={handleRunBacktest}
            disabled={backtestRunning || dailyHistory.length === 0}
            aria-label="Run backtest against 1-year historical data"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: THEME.gold,
              color: '#1A1508',
              border: 'none',
              borderRadius: '6px',
              padding: '8px 14px',
              fontFamily: FONT_SANS,
              fontSize: '13px',
              fontWeight: 500,
              cursor: backtestRunning || dailyHistory.length === 0 ? 'not-allowed' : 'pointer',
              opacity: backtestRunning || dailyHistory.length === 0 ? 0.6 : 1,
            }}
          >
            {backtestRunning ? <Loader2 size={14} className="spin" /> : <History size={14} />}
            {backtestRunning ? 'Running…' : 'Run backtest'}
          </button>
        </div>
        <div style={{ fontSize: '11px', color: THEME.muted, marginBottom: '12px' }}>
          Replays the same strategy (technical scoring, account-tier sizing, Kelly sizing, the
          regime brain, breakeven &amp; trailing stop) against real historical GC=F daily closes,
          using the current <strong style={{ color: THEME.text }}>{RISK_PRESETS[riskKey]?.label}</strong>{' '}
          preset and <strong style={{ color: THEME.text }}>${fmtUSD(startCash, 0)}</strong> starting
          capital. Two honest limits: stop/take-profit checks use daily closes, not intraday highs
          and lows, and there&apos;s no historical news feed, so this always runs math-only.
        </div>

        {backtestError && (
          <div style={{ fontSize: '12px', color: THEME.loss, marginBottom: '10px' }}>
            {backtestError}
          </div>
        )}

        {backtestResult && (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '10px',
                marginBottom: '14px',
              }}
            >
              {[
                {
                  label: 'Total return',
                  value: `${backtestResult.totalReturnPct >= 0 ? '+' : ''}${backtestResult.totalReturnPct.toFixed(2)}%`,
                  color: backtestResult.totalReturnPct >= 0 ? THEME.gain : THEME.loss,
                },
                { label: 'Final equity', value: `$${fmtUSD(backtestResult.finalEquity)}` },
                { label: 'Trades', value: `${backtestResult.stats.totalTrades}` },
                { label: 'Win rate', value: `${(backtestResult.stats.winRate * 100).toFixed(0)}%` },
                {
                  label: 'Sharpe',
                  value: backtestResult.stats.sharpe != null ? backtestResult.stats.sharpe.toFixed(2) : '--',
                },
                {
                  label: 'Max drawdown',
                  value:
                    backtestResult.stats.maxDrawdownPct != null
                      ? `${backtestResult.stats.maxDrawdownPct.toFixed(2)}%`
                      : '--',
                  color: THEME.loss,
                },
              ].map((kpi) => (
                <div
                  key={kpi.label}
                  style={{
                    background: THEME.panelAlt,
                    border: `1px solid ${THEME.hairline}`,
                    borderRadius: '6px',
                    padding: '8px 10px',
                  }}
                >
                  <div style={{ fontSize: '10px', color: THEME.muted, marginBottom: '2px' }}>
                    {kpi.label}
                  </div>
                  <div
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: '14px',
                      color: kpi.color || THEME.text,
                    }}
                  >
                    {kpi.value}
                  </div>
                </div>
              ))}
            </div>

            {backtestResult.dateRange && (
              <div style={{ fontSize: '10px', color: THEME.muted, marginBottom: '10px' }}>
                {new Date(backtestResult.dateRange.from * 1000).toLocaleDateString()} &ndash;{' '}
                {new Date(backtestResult.dateRange.to * 1000).toLocaleDateString()} &middot;{' '}
                {backtestResult.barsTraded} daily bars
              </div>
            )}

            <div style={{ height: '100px', marginBottom: '10px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={backtestResult.equityCurve}>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={['auto', 'auto']} tick={{ fill: THEME.muted, fontSize: 10 }} width={50} />
                  <Tooltip
                    contentStyle={{
                      background: THEME.panelAlt,
                      border: `1px solid ${THEME.hairline}`,
                      fontSize: '12px',
                    }}
                    labelFormatter={(t: number) => new Date(t * 1000).toLocaleDateString()}
                    formatter={(v: number) => [`$${fmtUSD(v)}`, 'Equity']}
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

            {backtestResult.trades.length > 0 ? (
              <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
                {backtestResult.trades.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 0',
                      borderBottom: `1px solid ${THEME.hairline}`,
                      gap: '10px',
                      fontSize: '11px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: '10px',
                          padding: '2px 6px',
                          borderRadius: '3px',
                          background: t.side === 'BUY' ? 'rgba(91,146,121,0.15)' : 'rgba(181,83,60,0.15)',
                          color: t.side === 'BUY' ? THEME.gain : THEME.loss,
                          flexShrink: 0,
                        }}
                      >
                        {t.side}
                      </span>
                      <span
                        style={{
                          color: THEME.muted,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {t.time} &middot; {t.reasoning}
                      </span>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: FONT_MONO }}>
                        {fmtOz(t.oz)} oz @ ${fmtUSD(t.price)}
                      </div>
                      {typeof t.pnl === 'number' && (
                        <div
                          style={{
                            fontFamily: FONT_MONO,
                            color: t.pnl >= 0 ? THEME.gain : THEME.loss,
                          }}
                        >
                          {t.pnl >= 0 ? '+' : '-'}${fmtUSD(Math.abs(t.pnl))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: THEME.muted }}>
                No trades fired over this history at the current risk preset &mdash; try a less
                conservative preset or a smaller account tier threshold bump.
              </div>
            )}
          </>
        )}

        {!backtestResult && !backtestError && (
          <div style={{ fontSize: '11px', color: THEME.muted }}>
            {dailyHistory.length === 0
              ? 'Loading historical data…'
              : `${dailyHistory.length} days of real GC=F history loaded — click "Run backtest" to see how this strategy would have performed.`}
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