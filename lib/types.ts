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
  // Cash actually committed to the open position. At 1x leverage this
  // equals oz * entryPrice (today's cash-settled behavior); under leverage
  // it's the smaller margin amount. Stored (not recomputed) so closing the
  // position returns exactly what was set aside plus/minus P&L, rather than
  // the position's full notional value — crediting the full notional back
  // against a margin-only debit would fabricate money out of the leverage.
  marginUsed: number | null;
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
  spend: number; // margin committed — what actually leaves cash, not the position's full notional under leverage
  oz: number;
  actualSlPct: number;
  notional: number; // oz * price — the position's real exposure size, for display/transparency
  liqPrice: number; // price at which this position's margin would be fully consumed by losses (long-only); the effective stop-loss can never sit looser than this
};