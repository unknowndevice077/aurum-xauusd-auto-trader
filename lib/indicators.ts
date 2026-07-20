export function smaSeriesFull(prices: number[], period: number) {
  const out: (number | null)[] = new Array(prices.length).fill(null);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) {
    sum += prices[i];
    if (i >= period) sum -= prices[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(prices: number[], period: number): (number | null)[] {
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

// Wilder's RSI with proper smoothing (RMA/SMMA)
export function wilderRsi(prices: number[], period: number = 14): (number | null)[] {
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

// ATR (Average True Range) for volatility-based sizing
export function atrSeries(prices: number[], period: number = 14): (number | null)[] {
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

// Bollinger Band width for volatility regime detection
export function bollingerWidth(
  prices: number[],
  period: number = 20,
  stdDev: number = 2
): { upper: (number | null)[]; lower: (number | null)[]; width: (number | null)[] } {
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

export type IndicatorBundle = {
  ema12: number | null;
  ema26: number | null;
  rsi: number | null;
  atr: number | null;
  bbWidth: number | null;
  macd: number | null;
  macdSignal: number | null;
};

export function computeIndicators(prices: number[]): IndicatorBundle {
  if (prices.length < 50) {
    return {
      ema12: null,
      ema26: null,
      rsi: null,
      atr: null,
      bbWidth: null,
      macd: null,
      macdSignal: null,
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

// Graduated scoring with multiple factors
export function technicalScore(
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

// Volatility-adjusted position sizing
export function calculatePositionSize(
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
