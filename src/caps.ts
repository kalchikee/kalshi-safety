import type { BetRequest, Position, SafetyConfig } from './types.js';

/** Per-bet cap — clamp requested contracts down if bet size exceeds limits.
 *  Returns the capped contract count (may be less than requested).
 *  If even 1 contract exceeds the cap, returns 0 (reject entirely). */
export function applyBetSizeCap(
  req: BetRequest,
  cfg: SafetyConfig,
): { allowedContracts: number; reason: string } {
  const costPerContract = req.priceCents / 100;
  if (costPerContract <= 0) {
    return { allowedContracts: 0, reason: 'invalid price: must be > 0' };
  }
  if (!Number.isFinite(req.contracts) || req.contracts < 1) {
    return { allowedContracts: 0, reason: 'invalid contract count' };
  }

  const hardMaxContracts = Math.floor(cfg.HARD_MAX_BET_DOLLARS / costPerContract);
  const softMaxContracts = Math.floor(cfg.softMaxBetDollars / costPerContract);
  const effectiveCap = Math.min(hardMaxContracts, softMaxContracts);

  if (effectiveCap < 1) {
    return {
      allowedContracts: 0,
      reason: `single contract ($${costPerContract.toFixed(2)}) exceeds per-bet cap ($${cfg.softMaxBetDollars})`,
    };
  }
  const capped = Math.min(req.contracts, effectiveCap);
  if (capped < req.contracts) {
    return {
      allowedContracts: capped,
      reason: `capped from ${req.contracts} to ${capped} contracts by $${cfg.softMaxBetDollars} per-bet limit`,
    };
  }
  return { allowedContracts: capped, reason: 'within per-bet cap' };
}

/** Daily exposure cap — rejects bet if today's new-bet dollars + this bet
 *  exceeds the daily limit. Caller passes in today's already-placed bets. */
export function checkDailyExposure(
  req: BetRequest,
  todaysDollars: number,
  cfg: SafetyConfig,
): { allowed: boolean; reason: string; remainingDollars: number } {
  const thisBetDollars = (req.priceCents / 100) * req.contracts;
  const hardRemaining = cfg.HARD_MAX_DAILY_EXPOSURE_DOLLARS - todaysDollars;
  const softRemaining = cfg.softMaxDailyExposureDollars - todaysDollars;
  const remaining = Math.min(hardRemaining, softRemaining);

  if (thisBetDollars > remaining) {
    return {
      allowed: false,
      reason: `bet ($${thisBetDollars.toFixed(2)}) exceeds remaining daily budget ($${remaining.toFixed(2)} of $${cfg.softMaxDailyExposureDollars}); today's total: $${todaysDollars.toFixed(2)})`,
      remainingDollars: remaining,
    };
  }
  return {
    allowed: true,
    reason: `within daily budget (remaining: $${remaining.toFixed(2)})`,
    remainingDollars: remaining,
  };
}

/** Position count cap — rejects if opening this bet would exceed max concurrent positions. */
export function checkPositionCount(
  openPositions: Position[],
  cfg: SafetyConfig,
): { allowed: boolean; reason: string } {
  const n = openPositions.length;
  const cap = Math.min(cfg.HARD_MAX_OPEN_POSITIONS, cfg.softMaxOpenPositions);
  if (n >= cap) {
    return {
      allowed: false,
      reason: `already at ${n}/${cap} open positions; cannot open another until one settles`,
    };
  }
  return { allowed: true, reason: `${n}/${cap} positions open` };
}

/** Daily loss halt — if realized losses today exceed the threshold, stop. */
export function checkDailyLossHalt(
  realizedLossDollarsToday: number,
  cfg: SafetyConfig,
): { allowed: boolean; reason: string } {
  if (realizedLossDollarsToday >= cfg.HARD_MAX_DAILY_LOSS_DOLLARS) {
    return {
      allowed: false,
      reason: `daily loss halt: $${realizedLossDollarsToday.toFixed(2)} realized losses exceeds $${cfg.HARD_MAX_DAILY_LOSS_DOLLARS} cap`,
    };
  }
  return {
    allowed: true,
    reason: `within daily loss budget ($${realizedLossDollarsToday.toFixed(2)} / $${cfg.HARD_MAX_DAILY_LOSS_DOLLARS})`,
  };
}

/** Edge check — ensures the model's prob gives the required min edge over market. */
export function checkMinEdge(
  req: BetRequest,
  cfg: SafetyConfig,
): { allowed: boolean; reason: string; edge: number } {
  // Kalshi YES price in dollars = implied market probability
  const marketProb = req.side === 'yes' ? req.priceCents / 100 : 1 - req.priceCents / 100;
  const edge = req.modelProb - marketProb;
  if (edge < cfg.HARD_MIN_EDGE) {
    return {
      allowed: false,
      reason: `edge ${(edge * 100).toFixed(1)}% below required ${(cfg.HARD_MIN_EDGE * 100).toFixed(0)}%`,
      edge,
    };
  }
  return {
    allowed: true,
    reason: `edge ${(edge * 100).toFixed(1)}% meets minimum`,
    edge,
  };
}
