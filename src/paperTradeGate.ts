import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// Every sport starts in PAPER mode. To graduate to live, the sport must
// accumulate N days of paper trading with a record of paper bets stored
// at safety-state/paper-start-<sport>.json. This file is auto-created on
// the first call and tracks when paper trading began.
//
// Even if KALSHI_PAPER_TRADING=false is set, the gate overrides it until
// the minimum period has elapsed.

export interface PaperState {
  sport: string;
  paperStartIso: string;       // ISO datetime when paper trading began
  liveActivatedIso?: string;   // set once user explicitly activates live
  paperBetCount: number;       // count of paper bets placed (sanity)
}

const DEFAULT_DIR = resolve(process.cwd(), 'safety-state');

function statePath(sport: string, dir = DEFAULT_DIR): string {
  return resolve(dir, `paper-${sport.toLowerCase()}.json`);
}

export function loadPaperState(sport: string, dir = DEFAULT_DIR): PaperState {
  const path = statePath(sport, dir);
  if (!existsSync(path)) {
    const initial: PaperState = {
      sport,
      paperStartIso: new Date().toISOString(),
      paperBetCount: 0,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PaperState;
  } catch {
    // Corrupted state → reset conservatively (start paper clock from NOW)
    const reset: PaperState = {
      sport,
      paperStartIso: new Date().toISOString(),
      paperBetCount: 0,
    };
    writeFileSync(path, JSON.stringify(reset, null, 2));
    return reset;
  }
}

export function recordPaperBet(sport: string, dir = DEFAULT_DIR): void {
  const state = loadPaperState(sport, dir);
  state.paperBetCount += 1;
  writeFileSync(statePath(sport, dir), JSON.stringify(state, null, 2));
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
  const paperStart = new Date(state.paperStartIso).getTime();
  const now = Date.now();
  const daysElapsed = (now - paperStart) / 86400000;
  if (daysElapsed < minDays) {
    return {
      eligible: false,
      reason: `paper period not met: ${daysElapsed.toFixed(1)}/${minDays} days elapsed`,
    };
  }
  if (state.paperBetCount < 10) {
    return {
      eligible: false,
      reason: `insufficient paper bet history: ${state.paperBetCount} bets (need ≥ 10)`,
    };
  }
  return { eligible: true, reason: 'paper period satisfied' };
}

/** User-facing: explicitly activate live mode for a sport. Still subject
 *  to paper-period and bet-count gates. */
export function activateLive(sport: string, dir = DEFAULT_DIR): void {
  const state = loadPaperState(sport, dir);
  state.liveActivatedIso = new Date().toISOString();
  writeFileSync(statePath(sport, dir), JSON.stringify(state, null, 2));
}
