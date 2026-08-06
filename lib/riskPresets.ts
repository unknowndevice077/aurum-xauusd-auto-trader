// Shared risk presets — used by the live bot, the always-on server bot, and
// the backtest engine so all three never drift apart.
//
// Position size used to be auto-derived from a "% of capital" baked into
// each preset, further scaled down by an account-size tier (a $10 account
// traded smaller % than a $10,000 one). Both were removed: % risk is
// mathematically identical regardless of account size, so the tier system
// only ever throttled small accounts without changing their odds — it just
// made growth feel (and be) slower without a way to override it. Position
// size is now a direct, user-set lot size in oz, independent of capital and
// independent of which preset is chosen. Presets now only govern entry
// selectivity and risk/reward shape.
export type RiskPreset = {
  label: string;
  threshold: number;
  slPct: number;
  tpPct: number;
  beTriggerPct: number;
};

export const RISK_PRESETS: Record<string, RiskPreset> = {
  conservative: {
    label: 'Conservative',
    threshold: 0.3,
    slPct: 0.008,
    tpPct: 0.024,
    beTriggerPct: 0.75,
  },
  balanced: {
    label: 'Balanced',
    threshold: 0.22,
    slPct: 0.012,
    tpPct: 0.036,
    beTriggerPct: 0.7,
  },
  aggressive: {
    label: 'Aggressive',
    threshold: 0.15,
    slPct: 0.02,
    tpPct: 0.06,
    beTriggerPct: 0.65,
  },
};

export type RiskPresetKey = keyof typeof RISK_PRESETS;

export const DEFAULT_START_CASH_FALLBACK = 10000;

// A single-trade sanity rail — not an account-size feature, just prevents a
// single position from spending literally 100% of cash. Applies equally
// regardless of capital.
export const RESERVE_FLOOR_PCT = 0.05;

// Sensible starting point for the lot-size input; users are expected to
// adjust it to their own capital (e.g. a $10 account probably wants
// something like 0.001 oz, not this default).
export const DEFAULT_LOT_OZ = 0.05;

// Leverage: at 1x, buying `lotOz` requires paying its full notional value
// (lotOz * price) in cash — at gold's price that puts even a modest lot
// out of reach for a small account, silently shrinking every trade down to
// whatever fits regardless of the lot size configured. Real gold CFD/forex
// brokers instead require only a fraction of the notional as margin. 1x
// (off) preserves today's cash-settled behavior exactly; raising it lets a
// small account actually trade the lot size it configured. Capped well
// below what real brokers sometimes offer (up to 1:200+) — higher leverage
// means a smaller adverse move wipes the margin backing a position, and
// this is a paper-trading educational tool, not a venue for teaching
// unrealistic risk-taking.
export const DEFAULT_LEVERAGE = 1;
export const MAX_LEVERAGE = 20;
