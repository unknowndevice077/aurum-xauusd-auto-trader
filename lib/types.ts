export type PricePoint = { t: number; p: number };

export type Trade = {
  id: number;
  ts: number;
  time: string;
  side: 'BUY' | 'SELL';
  price: number;
  oz: number;
  value: number;
  reasoning: string;
  pnl?: number;
  pnlPct?: number;
};

export type Portfolio = {
  cash: number;
  oz: number;
  entryPrice: number | null;
  slPrice: number | null;
  tpPrice: number | null;
  beActive: boolean;
  positionThreshold: number | null;
  positionBeTriggerPct: number | null;
  positionUsesNews: boolean | null;
  trades: Trade[];
};

export type RiskPreset = {
  label: string;
  threshold: number;
  positionPct: number;
  slPct: number;
  tpPct: number;
  beTriggerPct: number;
};

export type NewsResult = {
  sentiment_score: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  key_driver: string;
  ts: number;
  providerLabel: string;
  usedWebSearch: boolean;
};
