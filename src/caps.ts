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
  // GameIds follow the convention `<sport>-<date>-<away>-<home>` (e.g.
  // `mlb-2026-04-24-PHI-ATL`). The last two dash-segments are team codes
  // ≥2 chars long. Kalshi tickers for that game include both codes
  // (e.g. `KXMLBGAME-26APR241915PHIATL-ATL`). We consider two positions
  // correlated if they mention BOTH team codes in their ticker.
  const segments = gameId.split('-').filter((s) => /^[A-Za-z]{2,5}$/.test(s));
  const teamCodes = segments.slice(-2).map((s) => s.toUpperCase());
  const correlated = teamCodes.length < 2
    ? []
    : openPositions.filter((p) => {
        const up = p.ticker.toUpperCase();
        return teamCodes.every((code) => up.includes(code));
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

/** Rolling 7-day exposure cap — sums the cost basis of every paper bet
 *  placed in the last 7 days across all sports. Prevents over-trading
 *  during heavy weeks (e.g. NCAA tournament) while still allowing the
 *  per-day cap to burst on a single big day. */
export function checkWeeklyExposure(
  req: BetRequest,
  weeklyDollarsPlaced: number,
  cfg: SafetyConfig,
): { allowed: boolean; reason: string; remainingDollars: number } {
  const thisBet = (req.priceCents / 100) * req.contracts;
  const remaining = cfg.HARD_MAX_WEEKLY_EXPOSURE_DOLLARS - weeklyDollarsPlaced;
  if (thisBet > remaining) {
    return {
      allowed: false,
      reason: `bet $${thisBet.toFixed(2)} would exceed remaining 7-day budget $${remaining.toFixed(2)} of $${cfg.HARD_MAX_WEEKLY_EXPOSURE_DOLLARS} (placed $${weeklyDollarsPlaced.toFixed(2)} in last 7d)`,
      remainingDollars: remaining,
    };
  }
  return {
    allowed: true,
    reason: `7-day budget remaining $${remaining.toFixed(2)}`,
    remainingDollars: remaining,
  };
}

/** Per-sport daily-exposure cap — no more than N dollars on any single sport
 *  per day. Forces diversification across the day's sports. */
export function checkPerSportDaily(
  req: BetRequest,
  sportDollarsToday: number,
  cfg: SafetyConfig,
): { allowed: boolean; reason: string } {
  const thisBet = (req.priceCents / 100) * req.contracts;
  const projected = sportDollarsToday + thisBet;
  if (projected > cfg.HARD_MAX_PER_SPORT_DAILY_DOLLARS) {
    return {
      allowed: false,
      reason: `${req.sport} daily cap: $${projected.toFixed(2)} > $${cfg.HARD_MAX_PER_SPORT_DAILY_DOLLARS}`,
    };
  }
  return {
    allowed: true,
    reason: `${req.sport} daily exposure $${projected.toFixed(2)} of $${cfg.HARD_MAX_PER_SPORT_DAILY_DOLLARS}`,
  };
}

/** Per-day bet count cap. */
export function checkDailyBetCount(
  betsPlacedToday: number,
  cfg: SafetyConfig,
): { allowed: boolean; reason: string } {
  if (betsPlacedToday >= cfg.HARD_MAX_BETS_PER_DAY) {
    return {
      allowed: false,
      reason: `already placed ${betsPlacedToday} of ${cfg.HARD_MAX_BETS_PER_DAY} daily bet limit`,
    };
  }
  return {
    allowed: true,
    reason: `${betsPlacedToday}/${cfg.HARD_MAX_BETS_PER_DAY} bets today`,
  };
}

/** Market liquidity check: spread too wide or volume zero → skip. */
export function checkLiquidity(
  yesBid: number,
  yesAsk: number,
  noBid: number,
  noAsk: number,
  side: 'yes' | 'no',
  volume: number | undefined,
  cfg: SafetyConfig,
): { allowed: boolean; reason: string } {
  const ask = side === 'yes' ? yesAsk : noAsk;
  const bid = side === 'yes' ? yesBid : noBid;
  if (!ask || ask <= 0 || ask >= 100) {
    return { allowed: false, reason: `${side.toUpperCase()} ask ${ask}¢ is invalid` };
  }
  if (!bid || bid <= 0) {
    return { allowed: false, reason: `${side.toUpperCase()} bid is 0 — no exit liquidity` };
  }
  const spreadPct = (ask - bid) / ask;
  if (spreadPct > cfg.HARD_MAX_SPREAD_PCT) {
    return {
      allowed: false,
      reason: `spread ${(spreadPct * 100).toFixed(1)}% (${bid}¢/${ask}¢) > ${(cfg.HARD_MAX_SPREAD_PCT * 100).toFixed(0)}% cap — market too thin`,
    };
  }
  if (volume !== undefined && volume === 0) {
    return { allowed: false, reason: 'market has 0 volume — illiquid' };
  }
  return { allowed: true, reason: `liquid (spread ${(spreadPct * 100).toFixed(1)}%, vol ${volume ?? '?'})` };
}

/** Vegas-disagreement filter — if our model and Vegas (typically the most
 *  efficient market) disagree by more than `maxDisagreement` percentage
 *  points, skip the bet. Vegas has billions in capital pricing these
 *  outcomes; when our model's view differs by 10pp+, we are far more
 *  likely to be wrong than they are. Skips one in three bets but
 *  preserves the ones with real edge. */
export function checkVegasAgreement(
  modelProb: number,
  vegasProb: number | undefined | null,
  maxDisagreementPp: number = 10,
): { allowed: boolean; reason: string } {
  if (vegasProb === undefined || vegasProb === null || vegasProb <= 0 || vegasProb >= 1) {
    return { allowed: true, reason: 'no Vegas line — skipping check' };
  }
  const diffPp = Math.abs(modelProb - vegasProb) * 100;
  if (diffPp > maxDisagreementPp) {
    return {
      allowed: false,
      reason: `model ${(modelProb * 100).toFixed(1)}% diverges ${diffPp.toFixed(1)}pp from Vegas ${(vegasProb * 100).toFixed(1)}% (>${maxDisagreementPp}pp limit)`,
    };
  }
  return {
    allowed: true,
    reason: `model/Vegas agree within ${diffPp.toFixed(1)}pp`,
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
