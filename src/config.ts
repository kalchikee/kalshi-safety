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
  // Per-sport daily-exposure cap: prevents putting the whole day's budget on
  // one sport. Anti-concentration rule.
  HARD_MAX_PER_SPORT_DAILY_DOLLARS: 30,
  // Per-day bet-count cap: even if per-dollar caps allow more, cap the number
  // of total bets per day to avoid over-trading on noisy days.
  HARD_MAX_BETS_PER_DAY: 15,
  // Max spread (ask-bid) as a fraction of the ask. Wide spreads signal thin
  // liquidity — we pay too much on entry and too little on exit.
  HARD_MAX_SPREAD_PCT: 0.15,
  // Drawdown threshold (as a fraction of peak equity). Triggers Discord alert
  // when cumulative paper P&L drops below (peak × (1 - drawdown)).
  HARD_DRAWDOWN_ALERT_PCT: 0.10,
  // Rolling 7-day exposure cap. Sized to allow ~$57/day average across a week
  // while not blowing the budget on heavy days (e.g. NCAA tournament Saturdays
  // can have 16+ qualifying picks). Paired with the per-day $75 cap, this
  // prevents both same-day concentration and weekly over-trading.
  HARD_MAX_WEEKLY_EXPOSURE_DOLLARS: 400,
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
