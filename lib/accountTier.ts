// ─── Account-Size-Aware Risk Tiering ────────────────────────────────────────
// Percentage-based sizing behaves identically in relative terms whether the
// account is $10 or $10,000 — but a tiny account has zero room for error:
// there's no "add more funds" lever, rounding/dust matters, and a single
// bad sequence can wipe it out with no chance to recover. A large account
// can instead lean on the law of large numbers — enough independent trades
// smooths variance, so it can afford to be slightly less selective.
//
// This tier system scales three things by starting capital: how much of
// the account a single trade is allowed to risk, how selective the entry
// signal has to be, and how much cash always stays untouched as a reserve
// so the bot can never fully zero itself out on one move.

export type AccountTier = {
  name: 'Micro' | 'Small' | 'Standard' | 'Large';
  description: string;
  positionCapMultiplier: number; // scales the risk preset's positionPct
  thresholdBump: number; // added to the entry threshold — higher = more selective
  reserveFloorPct: number; // fraction of starting cash that's never risked
};

const TIERS: (AccountTier & { minCash: number })[] = [
  {
    name: 'Micro',
    minCash: 0,
    description: 'Under $100 — capital preservation first. Smaller bets, pickier entries, bigger cash cushion.',
    positionCapMultiplier: 0.6,
    thresholdBump: 0.08,
    reserveFloorPct: 0.15,
  },
  {
    name: 'Small',
    minCash: 100,
    description: '$100–$1,000 — still conservative, but less defensive than a micro account.',
    positionCapMultiplier: 0.8,
    thresholdBump: 0.04,
    reserveFloorPct: 0.08,
  },
  {
    name: 'Standard',
    minCash: 1_000,
    description: '$1,000–$50,000 — the risk preset’s numbers apply as-is.',
    positionCapMultiplier: 1,
    thresholdBump: 0,
    reserveFloorPct: 0.02,
  },
  {
    name: 'Large',
    minCash: 50_000,
    description: 'Over $50,000 — enough trade volume for variance to average out, so entries can be marginally less strict.',
    positionCapMultiplier: 1,
    thresholdBump: -0.02,
    reserveFloorPct: 0.01,
  },
];

export function getAccountTier(startCash: number): AccountTier {
  let match = TIERS[0];
  for (const t of TIERS) {
    if (startCash >= t.minCash) match = t;
  }
  const { minCash: _minCash, ...tier } = match;
  return tier;
}
