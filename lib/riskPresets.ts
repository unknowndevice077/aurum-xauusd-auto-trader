// Shared risk presets — used by both the live bot and the backtest engine so
// the two never drift apart.
export type RiskPreset = {
  label: string;
  threshold: number;
  positionPct: number;
  slPct: number;
  tpPct: number;
  beTriggerPct: number;
};

export const RISK_PRESETS: Record<string, RiskPreset> = {
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

export type RiskPresetKey = keyof typeof RISK_PRESETS;

export const DEFAULT_START_CASH_FALLBACK = 10000;
