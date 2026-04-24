// Per-sport confidence calibration.
//
// After each sport has accumulated enough paper settlements, compare the
// model's predicted probabilities to actual hit rates. If a sport is
// systematically over-confident (e.g. 65%-declared bets win only 55%),
// raise its floor above the default. If a sport is well-calibrated, keep
// the default.
//
// Minimum sample size before adjustment: 50 settled bets.
// Adjustment step: +0.05 at a time, max +0.15 above default.

import type { DryRunSport } from './allSports.js';
import { loadPaperState } from './paperTradeGate.js';

const DEFAULT_FLOOR = parseFloat(process.env.KALSHI_MIN_PROB ?? '0.65');
const MIN_SAMPLE = 50;
const OVERCONFIDENCE_THRESHOLD = 0.07; // if model is off by 7+ pp, raise floor
const STEP = 0.05;
const MAX_LIFT = 0.15;

export interface CalibrationStats {
  sport: string;
  settledBets: number;
  avgDeclaredProb: number;
  actualHitRate: number;
  miscalibrationPP: number;
  currentFloor: number;
  adjustedFloor: number;
}

export function getPerSportFloor(sport: DryRunSport, stateDir?: string): number {
  const stats = computeCalibration(sport, stateDir);
  return stats.adjustedFloor;
}

export function computeCalibration(sport: DryRunSport, stateDir?: string): CalibrationStats {
  const state = loadPaperState(sport, stateDir);
  const settled = state.bets.filter((b) => b.settledAt && (b.outcome === 'win' || b.outcome === 'loss'));

  if (settled.length < MIN_SAMPLE) {
    return {
      sport,
      settledBets: settled.length,
      avgDeclaredProb: 0,
      actualHitRate: 0,
      miscalibrationPP: 0,
      currentFloor: DEFAULT_FLOOR,
      adjustedFloor: DEFAULT_FLOOR,
    };
  }

  const wins = settled.filter((b) => b.outcome === 'win').length;
  const actualHitRate = wins / settled.length;
  const avgDeclaredProb =
    settled.reduce((s, b) => s + b.modelProb, 0) / settled.length;
  const miscalibrationPP = avgDeclaredProb - actualHitRate;

  let lift = 0;
  if (miscalibrationPP > OVERCONFIDENCE_THRESHOLD) {
    // How many STEPs above threshold we are
    const over = miscalibrationPP - OVERCONFIDENCE_THRESHOLD;
    lift = Math.min(MAX_LIFT, Math.ceil(over / STEP) * STEP);
  }
  const adjustedFloor = Math.min(0.95, DEFAULT_FLOOR + lift);

  return {
    sport,
    settledBets: settled.length,
    avgDeclaredProb: Math.round(avgDeclaredProb * 1000) / 1000,
    actualHitRate: Math.round(actualHitRate * 1000) / 1000,
    miscalibrationPP: Math.round(miscalibrationPP * 1000) / 1000,
    currentFloor: DEFAULT_FLOOR,
    adjustedFloor,
  };
}
