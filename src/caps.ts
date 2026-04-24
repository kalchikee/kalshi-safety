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

/** Per-game correlated exposure cap — blocks stacking multiple positions on the
 *  same gameId. "Same game" bets are correlated — if the team loses, all legs
 *  lose. We cap total dollars tied to any one gameId.
 *
 *  Caller supplies the gameId on the request's `reason` field convention or
 *  via the explicit `gameId` argument. */
export function checkGameExposure(
  req: BetRequest,
  gameId: string | undefined,
  openPositions: Position[],
  cfg: SafetyConfig,
): { allowed: boolean; reason: string; currentExposure: number } {
  if (!gameId) {
    return { allowed: true, reason: 'no gameId to correlate', currentExposure: 0 };
  }
  // A Position carries the ticker; we derive the gameId from the position's
  // metadata at call site. For now we check by ticker prefix / substring match —
  // callers must keep gameId in the request.reason so we can pattern-match.
  const thisBetDollars = (req.priceCents / 100) * req.contracts;
  // Positions don't carry gameId today, but callers will pre-filter which
  // positions are correlated. To keep this function pure, we accept the caller
  // to pre-compute the list; but here we do a simple name-substring check.
  const correlated = openPositions.filter((p) => {
    // The ticker may contain the game id fragment (e.g. "26APR24PHI ATL" or "PHIATL").
    const frag = gameId.split('-').slice(2).join('').toUpperCase();
    return frag.length >= 3 && p.ticker.toUpperCase().includes(frag);
  });
  const currentExposure = correlated.reduce((s, p) => s + p.costBasisDollars, 0);
  const newTotal = currentExposure + thisBetDollars;
  if (newTotal > cfg.HARD_MAX_PER_GAME_DOLLARS) {
    return {
      allowed: false,
      reason: `game exposure would hit $${newTotal.toFixed(2)} (cap $${cfg.HARD_MAX_PER_GAME_DOLLARS}) across ${correlated.length} correlated positions`,
      currentExposure,
    };
  }
  return {
    allowed: true,
    reason: `game exposure $${newTotal.toFixed(2)} within $${cfg.HARD_MAX_PER_GAME_DOLLARS} cap`,
    currentExposure,
  };
}

/** Line-move check — if Kalshi's implied market probability has already drifted
 *  close to (or past) the model's estimate, there's no edge left to capture.
 *  Skip the bet with an informative reason. This is a cheap same-decision-time
 *  variant of a "line move since prediction" check. */
export function checkLineAgreement(
  req: BetRequest,
  agreementBand: number = 0.02,
): { allowed: boolean; reason: string } {
  const marketProb = req.side === 'yes' ? req.priceCents / 100 : 1 - req.priceCents / 100;
  if (marketProb >= req.modelProb - agreementBand) {
    return {
      allowed: false,
      reason: `market price (${(marketProb * 100).toFixed(1)}%) matches/exceeds model (${(req.modelProb * 100).toFixed(1)}%) — no edge left`,
    };
  }
  return { allowed: true, reason: `market ${(marketProb * 100).toFixed(1)}% < model ${(req.modelProb * 100).toFixed(1)}%` };
}

/** Kelly Criterion sizing — scales bet size by edge, capped at quarter-Kelly
 *  times bankroll. Returns recommended contract count, clamped to [1, maxCap]. */
export function kellyContracts(
  priceCents: number,
  modelProb: number,
  bankrollDollars: number,
  minBetDollars: number,
  maxBetDollars: number,
): number {
  if (priceCents <= 0 || priceCents >= 100) return 0;
  const p = modelProb;
  const b = (100 - priceCents) / priceCents;
  const kellyFraction = Math.max(0, (p * b - (1 - p)) / b);
  if (kellyFraction <= 0) return 0;
  const quarterKelly = kellyFraction * 0.25;
  const recommendedDollars = Math.min(
    maxBetDollars,
    Math.max(minBetDollars, quarterKelly * bankrollDollars),
  );
  const costPerContract = priceCents / 100;
  return Math.max(1, Math.round(recommendedDollars / costPerContract));
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
