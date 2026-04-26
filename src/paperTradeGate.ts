import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFile } from './atomic.js';
import type { BetRequest } from './types.js';

// Every sport starts in PAPER mode. To graduate to live, the sport must
// accumulate N days of paper trading with a record of paper bets stored
// at safety-state/paper-<sport>.json. This file is auto-created on
// the first call and tracks when paper trading began.

export interface PaperBetRecord {
  /** Kalshi market ticker */
  ticker: string;
  /** Sport that placed the bet */
  sport: string;
  /** 'yes' or 'no' side of the contract */
  side: 'yes' | 'no';
  /** Price paid per contract, in cents (1-99) */
  priceCents: number;
  /** Number of contracts in the paper bet */
  contracts: number;
  /** Model's claimed win probability at placement time */
  modelProb: number;
  /** ISO timestamp of placement */
  placedAt: string;
  /** ISO timestamp of settlement (undefined if still open) */
  settledAt?: string;
  /** Outcome after settlement */
  outcome?: 'win' | 'loss' | 'push';
  /** P&L in dollars (positive = profit, negative = loss) */
  pnlDollars?: number;
  /** Closing-line value tracking (populated at settle time):
   *  closing market mid-price for OUR side, expressed as a probability
   *  (0-1). CLV (in pp) = closingMarketProb - (priceCents/100). Positive
   *  CLV across many bets is the strongest signal that the model has
   *  real edge over Kalshi pricing. */
  closingMarketProb?: number;
}

export interface PaperState {
  sport: string;
  /** ISO datetime when paper trading began */
  paperStartIso: string;
  /** ISO datetime when user explicitly activated live mode */
  liveActivatedIso?: string;
  /** All paper bets placed, most recent last */
  bets: PaperBetRecord[];
}

const DEFAULT_DIR = resolve(process.cwd(), 'safety-state');

function statePath(sport: string, dir = DEFAULT_DIR): string {
  return resolve(dir, `paper-${sport.toLowerCase()}.json`);
}

function writeState(state: PaperState, dir = DEFAULT_DIR): void {
  atomicWriteFile(statePath(state.sport, dir), JSON.stringify(state, null, 2));
}

export function loadPaperState(sport: string, dir = DEFAULT_DIR): PaperState {
  const path = statePath(sport, dir);
  if (!existsSync(path)) {
    const initial: PaperState = {
      sport,
      paperStartIso: new Date().toISOString(),
      bets: [],
    };
    writeState(initial, dir);
    return initial;
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    // Backward compatibility: older state used paperBetCount instead of bets[]
    if (raw.bets === undefined) {
      raw.bets = [];
    }
    return raw as PaperState;
  } catch {
    // Corrupted state → reset conservatively (start paper clock from NOW)
    const reset: PaperState = {
      sport,
      paperStartIso: new Date().toISOString(),
      bets: [],
    };
    writeState(reset, dir);
    return reset;
  }
}

/** Records a paper bet at placement time. Call after `checkBet` returns
 *  `mode: 'paper'`. Returns the stored record. */
export function recordPaperBet(
  sport: string,
  req: BetRequest,
  dir = DEFAULT_DIR,
): PaperBetRecord {
  const state = loadPaperState(sport, dir);
  const record: PaperBetRecord = {
    ticker: req.ticker,
    sport,
    side: req.side,
    priceCents: req.priceCents,
    contracts: req.contracts,
    modelProb: req.modelProb,
    placedAt: new Date().toISOString(),
  };
  state.bets.push(record);
  writeState(state, dir);
  return record;
}

/** Records the settlement of a paper bet. If no matching bet exists, this
 *  is a no-op (logged). Matches by ticker + most recent unsettled bet.
 *  P&L is computed automatically from priceCents + contracts + outcome
 *  if not explicitly provided. */
export function settlePaperBet(
  sport: string,
  ticker: string,
  outcome: 'win' | 'loss' | 'push',
  dir = DEFAULT_DIR,
  explicitPnl?: number,
): PaperBetRecord | null {
  const state = loadPaperState(sport, dir);
  // Find most recent unsettled bet on this ticker
  const idx = [...state.bets].reverse().findIndex(
    b => b.ticker === ticker && !b.settledAt,
  );
  if (idx < 0) return null;
  const realIdx = state.bets.length - 1 - idx;
  const bet = state.bets[realIdx];
  if (!bet) return null;

  bet.settledAt = new Date().toISOString();
  bet.outcome = outcome;

  if (explicitPnl !== undefined) {
    bet.pnlDollars = explicitPnl;
  } else {
    // Kalshi: winning YES pays $1/contract, losing pays $0, push returns cost
    const costPerContract = bet.priceCents / 100;
    const totalCost = costPerContract * bet.contracts;
    if (outcome === 'win') {
      bet.pnlDollars = bet.contracts * (1 - costPerContract);  // profit per winning contract
    } else if (outcome === 'loss') {
      bet.pnlDollars = -totalCost;
    } else {
      bet.pnlDollars = 0;
    }
  }
  writeState(state, dir);
  return bet;
}

/** Set the closing-market probability for the most recently settled paper
 *  bet on a ticker. Used by the recap to record CLV after settlement. */
export function setPaperBetClosingProb(
  sport: string,
  ticker: string,
  closingProb: number,
  dir = DEFAULT_DIR,
): void {
  const state = loadPaperState(sport, dir);
  // Find most recent settled bet on this ticker
  const idx = [...state.bets].reverse().findIndex(
    (b) => b.ticker === ticker && b.settledAt,
  );
  if (idx < 0) return;
  const realIdx = state.bets.length - 1 - idx;
  state.bets[realIdx]!.closingMarketProb = closingProb;
  writeState(state, dir);
}

/** Returns paper bets settled during a given calendar date (YYYY-MM-DD in UTC). */
export function getBetsSettledOnDate(
  sport: string,
  date: string,
  dir = DEFAULT_DIR,
): PaperBetRecord[] {
  const state = loadPaperState(sport, dir);
  return state.bets.filter(b => b.settledAt?.startsWith(date));
}

export interface DailySummary {
  sport: string;
  date: string;
  total: number;
  wins: number;
  losses: number;
  pushes: number;
  pnlDollars: number;
  accuracy: number;   // wins / (wins + losses), 0 if no settled bets
}

export function getDailySummary(
  sport: string,
  date: string,
  dir = DEFAULT_DIR,
): DailySummary {
  const bets = getBetsSettledOnDate(sport, date, dir);
  const wins = bets.filter(b => b.outcome === 'win').length;
  const losses = bets.filter(b => b.outcome === 'loss').length;
  const pushes = bets.filter(b => b.outcome === 'push').length;
  const pnl = bets.reduce((sum, b) => sum + (b.pnlDollars ?? 0), 0);
  const graded = wins + losses;
  return {
    sport,
    date,
    total: bets.length,
    wins,
    losses,
    pushes,
    pnlDollars: Math.round(pnl * 100) / 100,
    accuracy: graded > 0 ? wins / graded : 0,
  };
}

/** Returns days since paper trading started (fractional). */
export function getDryRunDuration(sport: string, dir = DEFAULT_DIR): number {
  const state = loadPaperState(sport, dir);
  const start = new Date(state.paperStartIso).getTime();
  const now = Date.now();
  const days = (now - start) / 86400000;
  return Math.round(days * 100) / 100;
}

/** Returns whether this sport is eligible for live mode.
 *  Requires:
 *    1. paperStartIso ≥ minDays ago
 *    2. liveActivatedIso explicitly set (user-authorized via activateLive)
 *    3. At least 10 paper bets on record (sanity — ensures paper mode actually ran)
 */
export function isLiveEligible(
  sport: string,
  minDays: number,
  dir = DEFAULT_DIR,
): { eligible: boolean; reason: string } {
  const state = loadPaperState(sport, dir);
  if (!state.liveActivatedIso) {
    return { eligible: false, reason: `live mode not activated for ${sport} (run activateLive to enable)` };
  }
  const daysElapsed = getDryRunDuration(sport, dir);
  if (daysElapsed < minDays) {
    return {
      eligible: false,
      reason: `paper period not met: ${daysElapsed.toFixed(1)}/${minDays} days elapsed`,
    };
  }
  if (state.bets.length < 10) {
    return {
      eligible: false,
      reason: `insufficient paper bet history: ${state.bets.length} bets (need ≥ 10)`,
    };
  }
  return { eligible: true, reason: 'paper period satisfied' };
}

/** User-facing: explicitly activate live mode for a sport. Still subject
 *  to paper-period and bet-count gates. */
export function activateLive(sport: string, dir = DEFAULT_DIR): void {
  const state = loadPaperState(sport, dir);
  state.liveActivatedIso = new Date().toISOString();
  writeState(state, dir);
}
