import type { SafetyConfig } from './types.js';

// HARD_ constants are the upper bounds that ANY configuration must respect.
// Changing these requires editing source code + code review. They CANNOT be
// loosened via environment variables.
//
// These are deliberately conservative. Raise them only after sustained paper
// profitability and explicit user authorization.
export const HARD_LIMITS = {
  HARD_MAX_BET_DOLLARS: 10,                   // per-bet cap (was 25)
  HARD_MAX_DAILY_EXPOSURE_DOLLARS: 75,         // daily new-bet exposure cap (was 100)
  HARD_MAX_OPEN_POSITIONS: 10,
  HARD_MAX_DAILY_LOSS_DOLLARS: 50,
  HARD_MIN_EDGE: 0.05,
  PAPER_TRADE_DAYS_REQUIRED: 30,
  // Stop-loss: auto-exit any position that loses this fraction of its cost
  HARD_STOP_LOSS_PCT: 0.20,
  // Take-profit: auto-exit any position that has gained this fraction of its cost.
  // Locks gains before variance can give them back. Matches the stop-loss in spirit.
  HARD_TAKE_PROFIT_PCT: 0.50,
  // Per-game correlated-exposure cap: don't stack more than this many dollars
  // across positions tied to the same underlying gameId.
  HARD_MAX_PER_GAME_DOLLARS: 15,
} as const;

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

/** Load runtime config. Soft limits are clamped to HARD_ ceilings — you
 *  cannot configure a softMaxBetDollars above HARD_MAX_BET_DOLLARS. */
export function loadConfig(): SafetyConfig {
  const softMaxBet = Math.min(
    envNum('KALSHI_MAX_BET_DOLLARS', 10),
    HARD_LIMITS.HARD_MAX_BET_DOLLARS,
  );
  const softMaxDaily = Math.min(
    envNum('KALSHI_MAX_DAILY_EXPOSURE_DOLLARS', 75),
    HARD_LIMITS.HARD_MAX_DAILY_EXPOSURE_DOLLARS,
  );
  const softMaxPositions = Math.min(
    Math.floor(envNum('KALSHI_MAX_OPEN_POSITIONS', 5)),
    HARD_LIMITS.HARD_MAX_OPEN_POSITIONS,
  );

  return {
    ...HARD_LIMITS,
    softMaxBetDollars: softMaxBet,
    softMaxDailyExposureDollars: softMaxDaily,
    softMaxOpenPositions: softMaxPositions,
  };
}
