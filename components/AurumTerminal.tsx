'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Play, Pause, RotateCcw, Newspaper, Landmark, TrendingUp, TrendingDown, Minus, Loader2, RefreshCw, Calculator, Settings, KeyRound, Shield, Target } from 'lucide-react';
import PriceChart, { Candle, TIMEFRAMES, TimeframeKey } from './PriceChart';

const THEME = {
  bg: '#0E0F10', panel: '#17181A', panelAlt: '#1D1E20', hairline: '#2A2B2D',
  gold: '#C6A15B', goldBright: '#E8C878', text: '#EDEAE0', muted: '#8B8D93',
  gain: '#5B9279', loss: '#B5533C',
};

const TICK_MS = 4000;
const HISTORY_CAP = 5000;
const TECH_WEIGHT = 0.55;  // Reduced from 0.65 — news is unreliable
const NEWS_WEIGHT = 0.45;  // Increased slightly

// IMPROVED: Better risk presets with wider SL/TP ratios and later breakeven
const RISK_PRESETS: Record<string, { label: string; threshold: number; positionPct: number; slPct: number; tpPct: number; beTriggerPct: number }> = {
  conservative: { label: 'Conservative', threshold: 0.30, positionPct: 12, slPct: 0.008, tpPct: 0.024, beTriggerPct: 0.75 },
  balanced: { label: 'Balanced', threshold: 0.22, positionPct: 25, slPct: 0.012, tpPct: 0.036, beTriggerPct: 0.70 },
  aggressive: { label: 'Aggressive', threshold: 0.15, positionPct: 50, slPct: 0.020, tpPct: 0.060, beTriggerPct: 0.65 },
};
const START_CASH = 10000;
const FALLBACK_PRICE = 4000;

const FONT_SERIF = "'Source Serif 4', Georgia, serif";
const FONT_MONO = "'JetBrains Mono', 'Courier New', monospace";
const FONT_SANS = "'Inter', -apple-system, sans-serif";

const PROVIDER_META: Record<string, { label: string; defaultModel: string; supportsWebSearch: boolean }> = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-sonnet-4-6', supportsWebSearch: true },
  openai: { label: 'OpenAI (GPT)', defaultModel: 'gpt-5.5', supportsWebSearch: false },
  xai: { label: 'Grok (xAI)', defaultModel: 'grok-4', supportsWebSearch: false },
};

type PricePoint = { t: number; p: number };

type Portfolio = {
  cash: number;
  oz: number;
  entryPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  beActive: boolean;
  positionThreshold: number | null;
  positionBeTriggerPct: number | null;
  positionUsesNews: boolean | null;
  trades: any[];
};

function fmtUSD(n: number | null | undefined, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ─── IMPROVED INDICATORS ─────────────────────────────────────────────────────

function smaSeriesFull(prices: number[], period: number) {
  const out: (number | null)[] = new Array(prices.length).fill(null);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i];
    if (i >= period) sum -= prices[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function emaSeries(prices: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(prices.length).fill(null);
  const multiplier = 2 / (period + 1);
  for (let i = 0; i < prices.length; i++) {
    if (i === 0) {
      out[i] = prices[i];
    } else if (out[i - 1] !== null) {
      out[i] = (prices[i] - out[i - 1]!) * multiplier + out[i - 1]!;
    }
  }
  // First `period` values are unstable — null them out
  for (let i = 0; i < period - 1; i++) out[i] = null;
  return out;
}

// IMPROVED: Wilder's RSI with proper smoothing (RMA/SMMA)
function wilderRsi(prices: number[], period: number = 14): (number | null)[] {
  const rsi: (number | null)[] = new Array(prices.length).fill(null);
  if (prices.length < period + 1) return rsi;

  let avgGain = 0, avgLoss = 0;

  // Initial simple average
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder's smoothing
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

// IMPROVED: ATR (Average True Range) for volatility-based sizing
function atrSeries(prices: number[], period: number = 14): (number | null)[] {
  const atr: (number | null)[] = new Array(prices.length).fill(null);
  if (prices.length < 2) return atr;

  const trs: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const high = Math.max(prices[i], prices[i - 1]);
    const low = Math.min(prices[i], prices[i - 1]);
    trs.push(high - low);
  }

  if (trs.length < period) return atr;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let prevAtr = sum / period;
  atr[period] = prevAtr;

  for (let i = period; i < trs.length; i++) {
    prevAtr = (prevAtr * (period - 1) + trs[i]) / period;
    atr[i + 1] = prevAtr;
  }

  return atr;
}

// IMPROVED: Bollinger Band width for volatility regime detection
function bollingerWidth(prices: number[], period: number = 20, stdDev: number = 2): { upper: (number | null)[]; lower: (number | null)[]; width: (number | null)[] } {
  const upper: (number | null)[] = new Array(prices.length).fill(null);
  const lower: (number | null)[] = new Array(prices.length).fill(null);
  const width: (number | null)[] = new Array(prices.length).fill(null);

  for (let i = period - 1; i < prices.length; i++) {
    const slice = prices.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + stdDev * sd;
    lower[i] = mean - stdDev * sd;
    width[i] = ((upper[i]! - lower[i]!) / mean) * 100;
  }

  return { upper, lower, width };
}

function buildCandles(rawPoints: PricePoint[], groupSize: number): Candle[] {
  const points = rawPoints.filter((pt) => pt && typeof pt.t === 'number' && typeof pt.p === 'number' && !isNaN(pt.t) && !isNaN(pt.p));
  const prices = points.map((pt) => pt.p);
  const sma20s = smaSeriesFull(prices, 20);
  const sma50s = smaSeriesFull(prices, 50);
  const candles: Candle[] = [];
  for (let i = 0; i < points.length; i += groupSize) {
    const chunk = points.slice(i, i + groupSize);
    if (chunk.length === 0) continue;
    const endIdx = Math.min(i + groupSize, points.length) - 1;
    const o = chunk[0].p, c = chunk[chunk.length - 1].p;
    const h = Math.max(...chunk.map((pt) => pt.p)), l = Math.min(...chunk.map((pt) => pt.p));
    candles.push({ time: chunk[0].t, o, h, l, c, sma20: sma20s[endIdx], sma50: sma50s[endIdx] });
  }
  return candles;
}

// IMPROVED: computeIndicators with EMA, Wilder RSI, ATR, and BB width
function computeIndicators(prices: number[]) {
  if (prices.length < 50) {
    return {
      ema12: null as number | null,
      ema26: null as number | null,
      rsi: null as number | null,
      atr: null as number | null,
      bbWidth: null as number | null,
      macd: null as number | null,
      macdSignal: null as number | null,
    };
  }

  const ema12Arr = emaSeries(prices, 12);
  const ema26Arr = emaSeries(prices, 26);
  const rsiArr = wilderRsi(prices, 14);
  const atrArr = atrSeries(prices, 14);
  const bb = bollingerWidth(prices, 20, 2);

  const ema12 = ema12Arr[ema12Arr.length - 1];
  const ema26 = ema26Arr[ema26Arr.length - 1];
  const rsi = rsiArr[rsiArr.length - 1];
  const atr = atrArr[atrArr.length - 1];
  const bbWidth = bb.width[bb.width.length - 1];

  // MACD line and signal
  const macdLine: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (ema12Arr[i] !== null && ema26Arr[i] !== null) {
      macdLine.push(ema12Arr[i]! - ema26Arr[i]!);
    }
  }
  const macdSignalArr = emaSeries(macdLine, 9);
  const macd = macdLine.length > 0 ? macdLine[macdLine.length - 1] : null;
  const macdSignal = macdSignalArr.length > 0 ? macdSignalArr[macdSignalArr.length - 1] : null;

  return { ema12, ema26, rsi, atr, bbWidth, macd, macdSignal };
}

// IMPROVED: Graduated scoring with multiple factors
function technicalScore(
  price: number,
  ema12: number | null,
  ema26: number | null,
  rsi: number | null,
  macd: number | null,
  macdSignal: number | null,
  atr: number | null,
  bbWidth: number | null,
  prices: number[]
) {
  if (ema12 == null || ema26 == null || rsi == null) return 0;

  let score = 0;

  // 1. EMA trend (graduated, not binary)
  const emaDiff = (ema12 - ema26) / ema26;
  const emaScore = Math.max(-0.4, Math.min(0.4, emaDiff * 50)); // ±0.4 max
  score += emaScore;

  // 2. Price vs EMA12 (momentum)
  const priceVsEma = (price - ema12) / ema12;
  const momentumScore = Math.max(-0.25, Math.min(0.25, priceVsEma * 30));
  score += momentumScore;

  // 3. RSI (graduated — not just 30/70 extremes)
  // RSI 50 = 0, RSI 30 = +0.25, RSI 70 = -0.25
  const rsiScore = (50 - rsi) / 80; // range approx -0.25 to +0.25
  score += Math.max(-0.25, Math.min(0.25, rsiScore));

  // 4. MACD crossover
  if (macd !== null && macdSignal !== null) {
    const macdDiff = macd - macdSignal;
    const macdScore = Math.max(-0.2, Math.min(0.2, macdDiff * 2));
    score += macdScore;
  }

  // 5. Volatility regime filter — avoid trading in extremely low volatility
  if (bbWidth !== null && bbWidth < 0.3) {
    score *= 0.5; // Reduce conviction in dead markets
  }

  // 6. Recent price momentum (3-tick rate of change)
  if (prices.length >= 4) {
    const roc = (price - prices[prices.length - 4]) / prices[prices.length - 4];
    const rocScore = Math.max(-0.15, Math.min(0.15, roc * 20));
    score += rocScore;
  }

  return Math.max(-1, Math.min(1, score));
}

// IMPROVED: Volatility-adjusted position sizing
function calculatePositionSize(
  cash: number,
  positionPct: number,
  price: number,
  atr: number | null,
  slPct: number
): { spend: number; oz: number; actualSlPct: number } {
  const baseSpend = cash * (positionPct / 100);

  // If we have ATR data, adjust position size inversely with volatility
  // Higher ATR = wider stops needed = smaller position to keep risk constant
  if (atr && atr > 0) {
    const atrPct = atr / price;
    const volatilityMultiplier = Math.max(0.3, Math.min(2.0, slPct / atrPct));
    const adjustedSpend = baseSpend * Math.min(1, 1 / volatilityMultiplier);
    const oz = adjustedSpend / price;
    // Adjust SL to be based on ATR (2x ATR) if ATR-based SL is wider than preset
    const atrSlPct = Math.max(slPct, atrPct * 2);
    return { spend: adjustedSpend, oz, actualSlPct: atrSlPct };
  }

  const oz = baseSpend / price;
  return { spend: baseSpend, oz, actualSlPct: slPct };
}

const EXECUTION_ADAPTER = {
  async placeOrder({ side, units }: { side: string; units: number }) {
    return { filled: true, side, units, simulated: true };
  },
};

function backfillTradePnl(trades: any[]): any[] {
  const chronological = [...trades].reverse();
  let openBuy: any = null;
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

async function fetchNewsAnalysis({ providerKey, apiKey, model }: { providerKey: string; apiKey: string; model: string }) {
  const res = await fetch('/api/news', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerKey, apiKey, model }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'News request failed');
  return data;
}

export default function AurumTerminal() {
  const [price, setPrice] = useState<number | null>(null);
  const [dataSourceLabel, setDataSourceLabel] = useState('Seeding price feed...');
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio>({ cash: START_CASH, oz: 0, entryPrice: null, slPrice: null, tpPrice: null, beActive: false, positionThreshold: null, positionBeTriggerPct: null, positionUsesNews: null, trades: [] });
  const [equityCurve, setEquityCurve] = useState<{ t: number; value: number }[]>([]);
  const [botRunning, setBotRunning] = useState(false);
  const [riskKey, setRiskKey] = useState('balanced');
  const [mathOnly, setMathOnly] = useState(true);
  const [news, setNews] = useState<any>(null);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsErrorMsg, setNewsErrorMsg] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [timeframe, setTimeframe] = useState<TimeframeKey>('20s');

  const [showSettings, setShowSettings] = useState(false);
  const [providerKey, setProviderKey] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(PROVIDER_META.openai.defaultModel);

  const priceRef = useRef<number | null>(null);
  const newsRef = useRef<any>(null);
  const portfolioRef = useRef(portfolio);
  portfolioRef.current = portfolio;
  const historyRef = useRef<PricePoint[]>([]);
  const resumedFromHistory = useRef(false);

  // Track consecutive losses for dynamic threshold adjustment
  const consecutiveLossesRef = useRef(0);
  const lastTradeResultRef = useRef<'win' | 'loss' | null>(null);

  useEffect(() => {
    try {
      const storedPortfolio = localStorage.getItem('aurum-portfolio');
      if (storedPortfolio) {
        const parsed = JSON.parse(storedPortfolio);
        if (parsed && typeof parsed.cash === 'number') {
          setPortfolio({
            entryPrice: null, slPrice: null, tpPrice: null, beActive: false,
            positionThreshold: null, positionBeTriggerPct: null, positionUsesNews: null,
            ...parsed,
            trades: backfillTradePnl(parsed.trades || []),
          });
          // Count consecutive losses from trade history
          const trades = parsed.trades || [];
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
        if (parsed.providerKey && PROVIDER_META[parsed.providerKey]) setProviderKey(parsed.providerKey);
        if (parsed.model) setModel(parsed.model);
        if (parsed.apiKey) {
          setApiKey(parsed.apiKey);
          setMathOnly(false);
        }
      }
      const storedHistory = localStorage.getItem('aurum-price-history');
      if (storedHistory) {
        const parsedHistory: any[] = JSON.parse(storedHistory);
        const isValidPricePointArray =
          Array.isArray(parsedHistory) &&
          parsedHistory.length > 0 &&
          parsedHistory.every((pt) => pt && typeof pt.t === 'number' && typeof pt.p === 'number' && !isNaN(pt.t) && !isNaN(pt.p));

        if (isValidPricePointArray) {
          setPriceHistory(parsedHistory as PricePoint[]);
          const last = parsedHistory[parsedHistory.length - 1];
          priceRef.current = last.p;
          setPrice(last.p);
          setDataSourceLabel('Resumed from saved session');
          resumedFromHistory.current = true;
        } else {
          localStorage.removeItem('aurum-price-history');
        }
      }
      const storedTf = localStorage.getItem('aurum-timeframe');
      if (storedTf && TIMEFRAMES.some((t) => t.key === storedTf)) setTimeframe(storedTf as TimeframeKey);
    } catch (e) {}
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-portfolio', JSON.stringify(portfolio));
  }, [portfolio, loaded]);

  useEffect(() => {
    historyRef.current = priceHistory;
  }, [priceHistory]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-llm-config', JSON.stringify({ providerKey, model, apiKey }));
  }, [providerKey, model, apiKey, loaded]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem('aurum-timeframe', timeframe);
  }, [timeframe, loaded]);

  useEffect(() => {
    if (!loaded || priceHistory.length === 0) return;
    localStorage.setItem('aurum-price-history', JSON.stringify(priceHistory));
  }, [priceHistory, loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (resumedFromHistory.current) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/history');
        const json = await res.json();
        if (!res.ok || !json.points?.length) throw new Error(json.error || 'no history');
        const points: PricePoint[] = json.points;
        if (cancelled) return;
        setPriceHistory(points);
        const last = points[points.length - 1];
        priceRef.current = last.p;
        setPrice(last.p);
        setDataSourceLabel('Real 1y history (GC=F daily) + simulated live ticks');
      } catch (e) {
        if (cancelled) return;
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 3000);
          const res2 = await fetch('https://api.metals.live/v1/spot/gold', { signal: controller.signal });
          clearTimeout(t);
          const json2 = await res2.json();
          const last2 = Array.isArray(json2) ? json2[json2.length - 1] : null;
          const seed = last2 ? Number(last2[1] || last2.price) : null;
          if (!cancelled && seed && seed > 100 && seed < 100000) {
            priceRef.current = seed;
            setPrice(seed);
            setDataSourceLabel('Live spot seed, simulated ticks (history unavailable)');
          } else throw new Error('bad seed');
        } catch (e2) {
          if (!cancelled) {
            priceRef.current = FALLBACK_PRICE;
            setPrice(FALLBACK_PRICE);
            setDataSourceLabel('Simulated (live feed unavailable)');
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [loaded]);

  const canUseNews = !mathOnly;

  const runNewsRefresh = useCallback(async () => {
    if (!canUseNews) return;
    setNewsLoading(true);
    setNewsErrorMsg('');
    try {
      const result = await fetchNewsAnalysis({ providerKey, apiKey, model });
      newsRef.current = result;
      setNews(result);
    } catch (e: any) {
      setNewsErrorMsg(e.message || 'Request failed');
    } finally {
      setNewsLoading(false);
    }
  }, [canUseNews, providerKey, apiKey, model]);

  useEffect(() => {
    if (!canUseNews) { newsRef.current = null; setNews(null); return; }
    runNewsRefresh();
    const id = setInterval(runNewsRefresh, 100000);
    return () => clearInterval(id);
  }, [runNewsRefresh, canUseNews]);

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
      const nextHistory = [...historyRef.current, { t: nowSec, p: nextPrice }].slice(-HISTORY_CAP);
      historyRef.current = nextHistory;
      setPriceHistory(nextHistory);

      const rawPrices = nextHistory.map((pt) => pt.p);
      const { ema12, ema26, rsi, atr, bbWidth, macd, macdSignal } = computeIndicators(rawPrices);

      if (botRunning) {
        const cur = portfolioRef.current;
        const preset = RISK_PRESETS[riskKey];

        // IMPROVED: Dynamic threshold adjustment based on losing streak
        let adjustedThreshold = preset.threshold;
        if (consecutiveLossesRef.current >= 3) {
          // Tighten up after 3+ losses — require stronger signals
          adjustedThreshold = Math.min(0.5, preset.threshold * (1 + consecutiveLossesRef.current * 0.15));
        }

        if (cur.oz > 0 && cur.entryPrice != null) {
          const posThreshold = cur.positionThreshold ?? preset.threshold;
          const posBeTriggerPct = cur.positionBeTriggerPct ?? preset.beTriggerPct;
          const posUsesNews = cur.positionUsesNews ?? canUseNews;

          if (cur.slPrice != null && nextPrice <= cur.slPrice) {
            const proceeds = cur.oz * nextPrice;
            const label = cur.beActive ? 'Breakeven stop hit' : 'Stop-loss hit';
            const pnl = (nextPrice - cur.entryPrice) * cur.oz;
            const pnlPct = ((nextPrice - cur.entryPrice) / cur.entryPrice) * 100;
            const trade = { id: Date.now(), ts: nowSec, time: new Date().toLocaleTimeString(), side: 'SELL', price: nextPrice, oz: cur.oz, value: proceeds, pnl, pnlPct, reasoning: label };
            EXECUTION_ADAPTER.placeOrder({ side: 'sell', units: cur.oz });
            portfolioRef.current = { ...cur, cash: cur.cash + proceeds, oz: 0, entryPrice: null, slPrice: null, tpPrice: null, beActive: false, positionThreshold: null, positionBeTriggerPct: null, positionUsesNews: null, trades: [trade, ...cur.trades].slice(0, 100) };
            setPortfolio(portfolioRef.current);
            // Track loss
            if (pnl < 0) {
              consecutiveLossesRef.current++;
              lastTradeResultRef.current = 'loss';
            } else {
              consecutiveLossesRef.current = 0;
              lastTradeResultRef.current = 'win';
            }
          } else if (cur.tpPrice != null && nextPrice >= cur.tpPrice) {
            const proceeds = cur.oz * nextPrice;
            const pnl = (nextPrice - cur.entryPrice) * cur.oz;
            const pnlPct = ((nextPrice - cur.entryPrice) / cur.entryPrice) * 100;
            const trade = { id: Date.now(), ts: nowSec, time: new Date().toLocaleTimeString(), side: 'SELL', price: nextPrice, oz: cur.oz, value: proceeds, pnl, pnlPct, reasoning: 'Take-profit hit' };
            EXECUTION_ADAPTER.placeOrder({ side: 'sell', units: cur.oz });
            portfolioRef.current = { ...cur, cash: cur.cash + proceeds, oz: 0, entryPrice: null, slPrice: null, tpPrice: null, beActive: false, positionThreshold: null, positionBeTriggerPct: null, positionUsesNews: null, trades: [trade, ...cur.trades].slice(0, 100) };
            setPortfolio(portfolioRef.current);
            consecutiveLossesRef.current = 0;
            lastTradeResultRef.current = 'win';
          } else {
            // Breakeven trigger — moved later (70-75% of TP distance)
            if (!cur.beActive && cur.tpPrice != null) {
              const beTriggerPrice = cur.entryPrice + (cur.tpPrice - cur.entryPrice) * posBeTriggerPct;
              if (nextPrice >= beTriggerPrice) {
                portfolioRef.current = { ...cur, slPrice: cur.entryPrice, beActive: true };
                setPortfolio(portfolioRef.current);
              }
            }
            // Signal-based exit
            const tech = technicalScore(nextPrice, ema12, ema26, rsi, macd, macdSignal, atr, bbWidth, rawPrices);
            const combined = posUsesNews ? (TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment) : tech;
            if (combined < -posThreshold) {
              const liveCur = portfolioRef.current;
              const proceeds = liveCur.oz * nextPrice;
              const reasoning = !posUsesNews
                ? `Downtrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (math-only)`
                : `${tech <= 0 ? 'Downtrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment < 0 ? 'negative' : 'cooling'}${newsRef.current?.key_driver ? ' (' + newsRef.current.key_driver + ')' : ''}`;
              const pnl = (nextPrice - liveCur.entryPrice!) * liveCur.oz;
              const pnlPct = ((nextPrice - liveCur.entryPrice!) / liveCur.entryPrice!) * 100;
              const trade = { id: Date.now(), ts: nowSec, time: new Date().toLocaleTimeString(), side: 'SELL', price: nextPrice, oz: liveCur.oz, value: proceeds, pnl, pnlPct, reasoning };
              EXECUTION_ADAPTER.placeOrder({ side: 'sell', units: liveCur.oz });
              portfolioRef.current = { ...liveCur, cash: liveCur.cash + proceeds, oz: 0, entryPrice: null, slPrice: null, tpPrice: null, beActive: false, positionThreshold: null, positionBeTriggerPct: null, positionUsesNews: null, trades: [trade, ...liveCur.trades].slice(0, 100) };
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
        } else if (cur.oz === 0 && cur.cash > 10) {
          // IMPROVED: Use volatility-adjusted position sizing
          const tech = technicalScore(nextPrice, ema12, ema26, rsi, macd, macdSignal, atr, bbWidth, rawPrices);
          const combined = canUseNews ? (TECH_WEIGHT * tech + NEWS_WEIGHT * sentiment) : tech;

          if (combined > adjustedThreshold) {
            const { spend, oz, actualSlPct } = calculatePositionSize(cur.cash, preset.positionPct, nextPrice, atr, preset.slPct);
            const slPrice = nextPrice * (1 - actualSlPct);
            const tpPrice = nextPrice * (1 + preset.tpPct);
            const reasoning = !canUseNews
              ? `Uptrend signal, RSI ${rsi ? rsi.toFixed(0) : '--'} (math-only)`
              : `${tech >= 0 ? 'Uptrend' : 'Mixed trend'}, RSI ${rsi ? rsi.toFixed(0) : '--'}, news ${sentiment >= 0 ? 'supportive' : 'cautious'}${newsRef.current?.key_driver ? ' (' + newsRef.current.key_driver + ')' : ''}`;
            const trade = { id: Date.now(), ts: nowSec, time: new Date().toLocaleTimeString(), side: 'BUY', price: nextPrice, oz, value: spend, reasoning: `${reasoning} · SL $${fmtUSD(slPrice)} / TP $${fmtUSD(tpPrice)}${atr ? ' · ATR $' + fmtUSD(atr) : ''}` };
            EXECUTION_ADAPTER.placeOrder({ side: 'buy', units: oz });
            portfolioRef.current = { ...cur, cash: cur.cash - spend, oz: cur.oz + oz, entryPrice: nextPrice, slPrice, tpPrice, beActive: false, positionThreshold: adjustedThreshold, positionBeTriggerPct: preset.beTriggerPct, positionUsesNews: canUseNews, trades: [trade, ...cur.trades].slice(0, 100) };
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

  const handleReset = () => {
    setBotRunning(false);
    const fresh: Portfolio = { cash: START_CASH, oz: 0, entryPrice: null, slPrice: null, tpPrice: null, beActive: false, positionThreshold: null, positionBeTriggerPct: null, positionUsesNews: null, trades: [] };
    setPortfolio(fresh);
    setEquityCurve([]);
    consecutiveLossesRef.current = 0;
    lastTradeResultRef.current = null;
    localStorage.setItem('aurum-portfolio', JSON.stringify(fresh));
  };

  const handleResetChart = () => {
    setPriceHistory([]);
    priceRef.current = null;
    setPrice(null);
    localStorage.removeItem('aurum-price-history');
    setDataSourceLabel('Seeding price feed...');
    resumedFromHistory.current = false;
  };

  const handleProviderChange = (key: string) => {
    setProviderKey(key);
    setModel(PROVIDER_META[key].defaultModel);
    setNews(null);
    newsRef.current = null;
  };

  const rawPrices = priceHistory.map((pt) => pt.p);
  const { ema12, ema26, rsi, atr, bbWidth, macd, macdSignal } = computeIndicators(rawPrices);
  const equityValue = price ? portfolio.cash + portfolio.oz * price : portfolio.cash;
  const pnl = equityValue - START_CASH;
  const pnlPct = (pnl / START_CASH) * 100;
  const biasColor = news?.bias === 'bullish' ? THEME.gain : news?.bias === 'bearish' ? THEME.loss : THEME.muted;
  const BiasIcon = news?.bias === 'bullish' ? TrendingUp : news?.bias === 'bearish' ? TrendingDown : Minus;
  const activeGroupSize = TIMEFRAMES.find((t) => t.key === timeframe)?.groupSize ?? 5;
  const candles = buildCandles(priceHistory, activeGroupSize);
  const activeProvider = PROVIDER_META[providerKey];
  const openPositionPnlPct = portfolio.oz > 0 && portfolio.entryPrice && price ? ((price - portfolio.entryPrice) / portfolio.entryPrice) * 100 : null;

  return (
    <div style={{ background: THEME.bg, color: THEME.text, fontFamily: FONT_SANS, padding: '24px', borderRadius: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: `1px solid ${THEME.hairline}`, paddingBottom: '16px', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <div style={{ fontFamily: FONT_SERIF, fontSize: '26px', letterSpacing: '0.02em', color: THEME.goldBright }}>AURUM</div>
          <div style={{ fontSize: '12px', color: THEME.muted, marginTop: '2px' }}>Paper-trading terminal &middot; XAU/USD &middot; {dataSourceLabel}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={() => setShowSettings((s) => !s)} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: showSettings ? THEME.panelAlt : 'transparent', color: THEME.muted, border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '6px 10px', cursor: 'pointer', fontSize: '12px' }}>
            <Settings size={13} /> LLM settings
          </button>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: botRunning ? THEME.gain : THEME.muted, display: 'inline-block' }} />
          <span style={{ fontSize: '12px', fontFamily: FONT_MONO, color: THEME.muted }}>{botRunning ? 'RUNNING' : 'PAUSED'}</span>
        </div>
      </div>

      {showSettings && (
        <div style={{ background: THEME.panelAlt, border: `1px solid ${THEME.hairline}`, borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px', fontSize: '12px', color: THEME.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            <KeyRound size={13} /> LLM provider
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '10px' }}>
            <div>
              <label style={{ fontSize: '11px', color: THEME.muted, display: 'block', marginBottom: '4px' }}>Provider</label>
              <select value={providerKey} onChange={(e) => handleProviderChange(e.target.value)} style={{ width: '100%', background: THEME.panel, color: THEME.text, border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '8px 10px', fontSize: '13px' }}>
                {Object.entries(PROVIDER_META).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '11px', color: THEME.muted, display: 'block', marginBottom: '4px' }}>Model</label>
              <input className="aurum-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder={activeProvider.defaultModel} style={{ width: '100%', background: THEME.panel, color: THEME.text, border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '8px 10px', fontSize: '13px', fontFamily: FONT_MONO, boxSizing: 'border-box' }} />
            </div>
          </div>
          <div style={{ fontSize: '11px', color: THEME.muted, marginBottom: '10px' }}>
            By default this app reads your key from the server environment (<code>{providerKey.toUpperCase()}_API_KEY</code> in <code>.env.local</code> or your Vercel project settings) — nothing is sent from the browser. Optional override below is sent to your own <code>/api/news</code> route only.
          </div>
          <div>
            <label style={{ fontSize: '11px', color: THEME.muted, display: 'block', marginBottom: '4px' }}>Optional: override API key for this browser</label>
            <input className="aurum-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Leave blank to use server env var" style={{ width: '100%', background: THEME.panel, color: THEME.text, border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '8px 10px', fontSize: '13px', fontFamily: FONT_MONO, boxSizing: 'border-box' }} />
          </div>
          {!activeProvider.supportsWebSearch && (
            <div style={{ fontSize: '11px', color: THEME.muted, marginTop: '10px', borderTop: `1px solid ${THEME.hairline}`, paddingTop: '10px' }}>
              {activeProvider.label} isn't wired for live web search here, so its "news" read is a general-knowledge estimate, not live headlines.
            </div>
          )}
          {newsErrorMsg && <div style={{ fontSize: '11px', color: THEME.loss, marginTop: '10px' }}>{newsErrorMsg}</div>}
        </div>
      )}

      <div style={{ background: THEME.panelAlt, border: `1px solid ${THEME.hairline}`, borderRadius: '8px', padding: '10px 14px', fontSize: '12px', color: THEME.muted, marginBottom: '20px' }}>
        Simulated execution only &mdash; no real funds or brokerage connected. Not financial advice; the bot's signals can be wrong.
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => setBotRunning((r) => !r)} disabled={price === null} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: botRunning ? THEME.panelAlt : THEME.gold, color: botRunning ? THEME.text : '#1A1508', border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '8px 16px', fontFamily: FONT_SANS, fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>
          {botRunning ? <Pause size={14} /> : <Play size={14} />}
          {botRunning ? 'Pause bot' : 'Start bot'}
        </button>
        <button onClick={handleReset} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'transparent', color: THEME.muted, border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '8px 16px', fontFamily: FONT_SANS, fontSize: '13px', cursor: 'pointer' }}>
          <RotateCcw size={14} /> Reset portfolio
        </button>
        <button onClick={handleResetChart} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'transparent', color: THEME.muted, border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '8px 16px', fontFamily: FONT_SANS, fontSize: '13px', cursor: 'pointer' }} title="Clear saved chart history and reseed from real historical data">
          <RotateCcw size={14} /> Reset chart
        </button>
        <select value={riskKey} onChange={(e) => setRiskKey(e.target.value)} style={{ background: THEME.panelAlt, color: THEME.text, border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '8px 12px', fontFamily: FONT_SANS, fontSize: '13px' }}>
          {Object.entries(RISK_PRESETS).map(([k, v]) => (
            <option key={k} value={k}>{v.label} risk</option>
          ))}
        </select>
        <button onClick={() => setMathOnly((m) => !m)} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: mathOnly ? THEME.gold : 'transparent', color: mathOnly ? '#1A1508' : THEME.muted, border: `1px solid ${THEME.hairline}`, borderRadius: '6px', padding: '8px 16px', fontFamily: FONT_SANS, fontSize: '13px', cursor: 'pointer' }} title="Skip the LLM news call entirely and trade on improved technical signals only">
          <Calculator size={14} /> {mathOnly ? 'Math-only mode' : 'Use LLM news'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        {[
          { label: 'Portfolio value', value: `$${fmtUSD(equityValue)}` },
          { label: 'Cash', value: `$${fmtUSD(portfolio.cash)}` },
          { label: 'Gold held', value: `${portfolio.oz.toFixed(4)} oz` },
          { label: 'P&L', value: `${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))}`, color: pnl >= 0 ? THEME.gain : THEME.loss, sub: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` },
        ].map((m) => (
          <div key={m.label} style={{ background: THEME.panel, border: `1px solid ${THEME.hairline}`, borderRadius: '8px', padding: '12px 14px' }}>
            <div style={{ fontSize: '11px', color: THEME.muted, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{m.label}</div>
            <div style={{ fontFamily: FONT_SERIF, fontSize: '22px', color: m.color || THEME.text }}>{m.value}</div>
            {m.sub && <div style={{ fontFamily: FONT_MONO, fontSize: '11px', color: m.color || THEME.muted }}>{m.sub}</div>}
          </div>
        ))}
      </div>

      {portfolio.oz > 0 && portfolio.entryPrice && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', background: THEME.panelAlt, border: `1px solid ${THEME.gold}`, borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', flexWrap: 'wrap' }}>
          <span style={{ fontFamily: FONT_MONO, color: THEME.gold, fontWeight: 600 }}>OPEN POSITION</span>
          <span style={{ color: THEME.muted }}>Long {portfolio.oz.toFixed(4)} oz @ ${fmtUSD(portfolio.entryPrice)}</span>
          {openPositionPnlPct != null && (
            <span style={{ fontFamily: FONT_MONO, color: openPositionPnlPct >= 0 ? THEME.gain : THEME.loss }}>
              {openPositionPnlPct >= 0 ? '+' : ''}{openPositionPnlPct.toFixed(2)}%
            </span>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: portfolio.beActive ? THEME.muted : THEME.loss, fontFamily: FONT_MONO }}>
            <Shield size={12} /> SL ${fmtUSD(portfolio.slPrice)}{portfolio.beActive && ' (BE)'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: THEME.gain, fontFamily: FONT_MONO }}>
            <Target size={12} /> TP ${fmtUSD(portfolio.tpPrice)}
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: !canUseNews ? '1fr' : 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: '16px', marginBottom: '16px' }}>
        <div style={{ background: THEME.panel, border: `1px solid ${THEME.hairline}`, borderRadius: '8px', padding: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', color: THEME.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Spot price</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: '13px', color: THEME.goldBright }}>${price ? fmtUSD(price) : '--'}</span>
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
          <div style={{ display: 'flex', gap: '16px', marginTop: '10px', fontFamily: FONT_MONO, fontSize: '11px', color: THEME.muted, flexWrap: 'wrap' }}>
            <span>EMA12 {ema12 ? `$${fmtUSD(ema12)}` : '--'}</span>
            <span>EMA26 {ema26 ? `$${fmtUSD(ema26)}` : '--'}</span>
            <span>RSI14 {rsi ? rsi.toFixed(1) : '--'}</span>
            <span>ATR14 {atr ? `$${fmtUSD(atr)}` : '--'}</span>
            <span>MACD {macd != null ? (macd > 0 ? '+' : '') + fmtUSD(macd, 3) : '--'}</span>
            <span>BBW {bbWidth != null ? bbWidth.toFixed(2) + '%' : '--'}</span>
          </div>
        </div>

        {canUseNews && (
          <div style={{ background: THEME.panel, border: `1px solid ${THEME.hairline}`, borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span style={{ fontSize: '12px', color: THEME.muted, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Newspaper size={13} /> News &amp; macro &middot; {activeProvider.label}
              </span>
              <button onClick={runNewsRefresh} disabled={newsLoading} style={{ background: 'transparent', border: 'none', color: THEME.muted, cursor: 'pointer', display: 'flex' }}>
                {newsLoading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
            {newsLoading && !news && <div style={{ fontSize: '12px', color: THEME.muted }}>Analyzing latest gold news...</div>}
            {newsErrorMsg && !news && <div style={{ fontSize: '12px', color: THEME.loss }}>{newsErrorMsg}</div>}
            {news && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                  <BiasIcon size={14} color={biasColor} />
                  <span style={{ fontFamily: FONT_MONO, fontSize: '12px', color: biasColor, textTransform: 'uppercase' }}>{news.bias}</span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: '11px', color: THEME.muted }}>score {news.sentiment_score.toFixed(2)}</span>
                </div>
                <p style={{ fontSize: '13px', lineHeight: 1.5, margin: '0 0 10px' }}>{news.summary}</p>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', borderTop: `1px solid ${THEME.hairline}`, paddingTop: '10px' }}>
                  <Landmark size={13} color={THEME.muted} style={{ marginTop: '2px', flexShrink: 0 }} />
                  <p style={{ fontSize: '12px', color: THEME.muted, lineHeight: 1.5, margin: 0 }}>{news.key_driver}</p>
                </div>
                <div style={{ fontSize: '10px', color: THEME.muted, marginTop: '10px' }}>Updated {new Date(news.ts).toLocaleTimeString()} {!news.usedWebSearch && '· general-knowledge estimate, not live search'}</div>
              </>
            )}
          </div>
        )}
      </div>

      <div style={{ background: THEME.panel, border: `1px solid ${THEME.hairline}`, borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
        <div style={{ fontSize: '12px', color: THEME.muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>Equity curve</div>
        <div style={{ height: '110px' }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityCurve}>
              <XAxis dataKey="t" hide />
              <YAxis domain={['auto', 'auto']} tick={{ fill: THEME.muted, fontSize: 10 }} width={50} />
              <Tooltip contentStyle={{ background: THEME.panelAlt, border: `1px solid ${THEME.hairline}`, fontSize: '12px' }} labelStyle={{ display: 'none' }} formatter={(v: any) => [`$${fmtUSD(v)}`, 'Value']} />
              <Area type="monotone" dataKey="value" stroke={THEME.gold} fill={THEME.gold} fillOpacity={0.12} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ background: THEME.panel, border: `1px solid ${THEME.hairline}`, borderRadius: '8px', padding: '14px' }}>
        <div style={{ fontSize: '12px', color: THEME.muted, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '10px' }}>Trade ledger</div>
        {portfolio.trades.length === 0 && <div style={{ fontSize: '12px', color: THEME.muted }}>No trades yet. Start the bot to begin the simulation.</div>}
        <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
          {portfolio.trades.map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${THEME.hairline}`, gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: '11px', padding: '2px 8px', borderRadius: '3px', background: t.side === 'BUY' ? 'rgba(91,146,121,0.15)' : 'rgba(181,83,60,0.15)', color: t.side === 'BUY' ? THEME.gain : THEME.loss, flexShrink: 0 }}>{t.side}</span>
                <span style={{ fontSize: '12px', color: THEME.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.reasoning}</span>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: '12px' }}>{t.oz.toFixed(4)} oz @ ${fmtUSD(t.price)}</div>
                {typeof t.pnl === 'number' && (
                  <div style={{ fontFamily: FONT_MONO, fontSize: '11px', color: t.pnl >= 0 ? THEME.gain : THEME.loss }}>
                    {t.pnl >= 0 ? '+' : '-'}${fmtUSD(Math.abs(t.pnl))} ({t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%)
                  </div>
                )}
                <div style={{ fontFamily: FONT_MONO, fontSize: '10px', color: THEME.muted }}>{t.time}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}