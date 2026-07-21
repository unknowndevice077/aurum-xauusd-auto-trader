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
} from 'lucide-react';
import PriceChart, { Candle, TIMEFRAMES, TimeframeKey } from './PriceChart';
import {
  computeIndicators,
  technicalScore,
  calculatePositionSize,
  smaSeriesFull,
} from './indicators';
import type { Portfolio, Trade, NewsResult, ProviderKey, ProviderMeta } from './types';

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
const TECH_WEIGHT = 0.55;
const NEWS_WEIGHT = 0.45;
const START_CASH = 10000;
const FALLBACK_PRICE = 4000;

const FONT_SERIF = "'Source Serif 4', Georgia, serif";
const FONT_MONO = "'JetBrains Mono', 'Courier New', monospace";
const FONT_SANS = "'Inter', -apple-system, sans-serif";

// ─── Risk Presets ──────────────────────────────────────────────────────────
const RISK_PRESETS: Record<
  string,
  { label: string; threshold: number; positionPct: number; slPct: number; tpPct: number; beTriggerPct: number }
> = {
  conservative: {
    label: 'Conservative',
    threshold: 0.3,
    positionPct: 12,
    slPct: 0.008,
    tpPct: 0.024,
    beTriggerPct: 0.75,
  },
  balanced: {
    label: 'Balanced',
    threshold: 0.22,
    positionPct: 25,
    slPct: 0.012,
    tpPct: 0.036,
    beTriggerPct: 0.7,
  },
  aggressive: {
    label: 'Aggressive',
    threshold: 0.15,
    positionPct: 50,
    slPct: 0.02,
    tpPct: 0.06,
    beTriggerPct: 0.65,
  },
};

// ─── Provider Metadata ───────────────────────────────────────────────────
const PROVIDER_META: Record<ProviderKey, ProviderMeta> = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-sonnet-4-6', supportsWebSearch: true },
  openai: { label: 'OpenAI (GPT)', defaultModel: 'gpt-5.5', supportsWebSearch: false },
  xai: { label: 'Grok (xAI)', defaultModel: 'grok-4', supportsWebSearch: false },
};

// ─── Helpers ───────────────────────────────────────────────────────────────
function fmtUSD(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function buildCandles(rawPoints: { t: number; p: number }[], groupSize: number): Candle[] {
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

function backfillTradePnl(trades: Trade[]): Trade[] {
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

async function fetchNewsAnalysis({
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

// ─── Component ─────────────────────────────────────────────────────────────
export default function AurumTerminal() {
  // ─── State ─────────────────────────────────────────────────────────────
  const [price, setPrice] = useState<number | null>(null);
  const [dataSourceLabel, setDataSourceLabel] = useState('Seeding price feed...');
  const [priceHistory, setPriceHistory] = useState<{ t: number; p: number }[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio>({
    cash: START_CASH,
    oz: 0,
    entryPrice: null,
    slPrice: null,
    tpPrice: null,
    beActive: false,
    positionThreshold: null,
    positionBeTriggerPct: null,
    positionUsesNews: null,
    trades: [],
  });
  const [equityCurve, setEquityCurve] = useState<{ t: number; value: number }[]>([]);
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
    } catch {
      // ignore parse errors
    }
    setLoaded(true);
  }, []);

  // ─── Persistence Effects ─────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-portfolio', JSON.stringify(portfolio));
  }, [portfolio, loaded]);

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
      const sentiment = canUseNews && newsRef.current ? newsRef.current.sentiment_score : 0;
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

      if (botRunning) {
        const cur = portfolioRef.current;
        const preset = RISK_PRESETS[riskKey];

        // Dynamic threshold adjustment based on losing streak
        let adjustedThreshold = preset.threshold;
        if (consecutiveLossesRef.current >= 3) {
          adjustedThreshold = Math.min(
            0.5,
            preset.threshold * (1 + consecutiveLossesRef.current * 0.15)
          );
        }

        if (cur.oz > 0 && cur.entryPrice != null) {
          const posThreshold = cur.positionThreshold ?? preset.threshold;
          const posBeTriggerPct = cur.positionBeTriggerPct ?? preset.beTriggerPct;
          const posUsesNews = cur.positionUsesNews ?? canUseNews;

          // ─── Stop-Loss Hit ───────────────────────────────────────────────
          if (cur.slPrice != null && nextPrice <= cur.slPrice) {
            const proceeds = cur.oz * nextPrice;
            const label = cur.beActive ? 'Breakeven stop hit' : 'Stop-loss hit';
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
          // ─── Breakeven Trigger ───────────────────────────────────────────
          else {
            if (!cur.beActive && cur.tpPrice != null) {
              const beTriggerPrice =
                cur.entryPrice + (cur.tpPrice - cur.entryPrice) * posBeTriggerPct;
              if (nextPrice >= beTriggerPrice) {
                portfolioRef.current = { ...cur, slPrice: cur.entryPrice, beActive: true };
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
              rawPrices
            );
            const combined = posUsesNews
              ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment
              : tech;
            if (combined < -posThreshold) {
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
        else if (cur.oz === 0 && cur.cash > 10) {
          const tech = technicalScore(
            nextPrice,
            ema12,
            ema26,
            rsi,
            macd,
            macdSignal,
            atr,
            bbWidth,
            rawPrices
          );
          const combined = canUseNews
            ? TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment
            : tech;

          if (combined > adjustedThreshold) {
            const { spend, oz, actualSlPct } = calculatePositionSize(
              cur.cash,
              preset.positionPct,
              nextPrice,
              atr,
              preset.slPct
            );
            // FIX: Use actualSlPct from calculatePositionSize instead of preset.slPct
            const slPrice = nextPrice * (1 - actualSlPct);
            const tpPrice = nextPrice * (1 + preset.tpPct);
            const reasoning = !canUseNews
              ? `Uptrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (math-only)`
              : `${tech >= 0 ? 'Uptrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment >= 0 ? 'supportive' : 'cautious'}${newsRef.current?.key_driver ? ' (' + newsRef.current.key_driver + ')' : ''}`;
            const trade: Trade = {
              id: Date.now(),
              ts: nowSec,
              time: new Date().toLocaleTimeString(),
              side: 'BUY',
              price: nextPrice,
              oz,
              value: spend,
              reasoning: `${reasoning} · SL $${fmtUSD(slPrice)} / TP $${fmtUSD(tpPrice)}${atr ? ' · ATR $' + fmtUSD(atr) : ''}`,
            };
            portfolioRef.current = {
              ...cur,
              cash: cur.cash - spend,
              oz: cur.oz + oz,
              entryPrice: nextPrice,
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

      const finalPortfolio = portfolioRef.current;
      setEquityCurve((eq) => {
        const val = finalPortfolio.cash + finalPortfolio.oz * nextPrice;
        return [...eq, { t: eq.length, value: val }].slice(-150);
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [price, botRunning, riskKey, canUseNews]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setBotRunning(false);
    const fresh: Portfolio = {
      cash: START_CASH,
      oz: 0,
      entryPrice: null,
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
  }, []);

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

  const equityValue = price ? portfolio.cash + portfolio.oz * price : portfolio.cash;
  const pnl = equityValue - START_CASH;
  const pnlPct = (pnl / START_CASH) * 100;
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
          onClick={handleReset}
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
            value: `${portfolio.oz.toFixed(4)} oz`,
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
            Long {portfolio.oz.toFixed(4)} oz @ ${fmtUSD(portfolio.entryPrice)}
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
            {portfolio.beActive && ' (BE)'}
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
                  {t.oz.toFixed(4)} oz @ ${fmtUSD(t.price)}
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