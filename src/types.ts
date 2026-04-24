// Shared types for the safety module.
// Any sport-specific bet request maps onto BetRequest before safety checks.

export interface BetRequest {
  sport: string;          // 'MLB' | 'NBA' | 'NHL' | ...
  ticker: string;         // Kalshi market ticker (e.g. "KXMLBGAME-...")
  side: 'yes' | 'no';
  priceCents: number;     // 1-99, what you'd pay per contract
  contracts: number;      // quantity
  modelProb: number;      // 0-1, model's claimed win probability
  expectedEV?: number;    // optional: model's claimed expected value in $
  reason?: string;        // free-form audit note
}

export interface Position {
  sport: string;
  ticker: string;
  contracts: number;
  entryPriceCents: number;
  currentValueDollars: number;  // mark-to-market
  costBasisDollars: number;
}

export interface SafetyDecision {
  allowed: boolean;
  mode: 'paper' | 'live' | 'blocked';
  reason: string;             // human-readable, always populated
  violatedRules: string[];    // which specific rules blocked (empty when allowed)
  cappedContracts?: number;   // if allowed, may be < requested (caps applied)
}

export interface SafetyConfig {
  // Hard caps — no configuration can raise these above these values without
  // editing source code.
  HARD_MAX_BET_DOLLARS: number;           // absolute max per single bet
  HARD_MAX_DAILY_EXPOSURE_DOLLARS: number; // max sum of new bets per day
  HARD_MAX_OPEN_POSITIONS: number;         // max concurrent open positions
  HARD_MAX_DAILY_LOSS_DOLLARS: number;     // halt new bets after this much daily realized loss
  HARD_MIN_EDGE: number;                   // 0.05 = 5%, reject sub-edge bets regardless of Kelly
  PAPER_TRADE_DAYS_REQUIRED: number;       // days of paper trading before live allowed
  HARD_STOP_LOSS_PCT: number;              // 0.20 = auto-exit position at 20% loss

  // Soft defaults (configurable via env, still capped by HARD_ values above)
  softMaxBetDollars: number;
  softMaxDailyExposureDollars: number;
  softMaxOpenPositions: number;
}

export interface KillSwitchStatus {
  active: boolean;
  reason: string;
  triggeredAt?: string;
  triggeredBy?: string;
}
