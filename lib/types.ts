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
  regime?: string; // market condition label at entry, used by the learning "brain"
};

export type Portfolio = {
  cash: number;
  oz: number;
  entryPrice: number | null;
  entryTs: number | null; // ms timestamp of entry — gates the min-hold period before a signal-based exit
  peakPrice: number | null; // highest price seen since entry — drives the trailing stop once armed
  slPrice: number | null;
  tpPrice: number | null;
  beActive: boolean;
  positionThreshold: number | null;
  positionBeTriggerPct: number | null;
  positionUsesNews: boolean | null;
  trades: Trade[];
};

export type NewsResult = {
  sentiment_score: number;
  confidence: number; // 0-1, how confident the model is in its own read
  bias: 'bullish' | 'bearish' | 'neutral';
  summary: string;
  key_driver: string;
  ts: number;
  providerLabel: string;
  usedWebSearch: boolean;
};

export type ProviderKey = 'anthropic' | 'openai' | 'xai';

export type ProviderMeta = {
  label: string;
  defaultModel: string;
  supportsWebSearch: boolean;
};

export type PositionSizeResult = {
  spend: number;
  oz: number;
  actualSlPct: number;
};