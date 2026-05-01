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

import { DRY_RUN_SPORTS, type DryRunSport } from './allSports.js';
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

/** Compute per-sport calibration stats including raw measured numbers
 *  EVEN BELOW the auto-adjustment sample threshold. The floor is only
 *  lifted when settledBets >= MIN_SAMPLE (50), but the displayed numbers
 *  are real from the first settlement onward — useful for early detection
 *  of model miscalibration before 50 bets accumulate.
 *
 *  CRITICAL: excludes stop-loss exits from the W/L tally. A stop-loss
 *  closes a bet at -20% of cost BEFORE the underlying market settles —
 *  which means we never observe the true outcome. Counting those as
 *  model "losses" inflates miscalibration when the model isn't actually
 *  overconfident, just whipsawed by mid-game variance. We detect a
 *  stop-loss by `outcome === 'loss' && pnl > -fullCostBasis` (a true
 *  settlement loss has pnl exactly = -fullCostBasis). */
export function computeCalibration(sport: DryRunSport, stateDir?: string): CalibrationStats {
  const state = loadPaperState(sport, stateDir);
  const settled = state.bets.filter((b) => {
    if (!b.settledAt) return false;
    if (b.outcome !== 'win' && b.outcome !== 'loss') return false;
    // Stop-loss detection: true settlement loss has pnl ≈ -fullCostBasis;
    // a stop-loss exit has a less-negative pnl. Tolerance = 0.5¢.
    if (b.outcome === 'loss') {
      const fullLoss = -(b.priceCents * b.contracts) / 100;
      const stopped = (b.pnlDollars ?? fullLoss) > fullLoss + 0.005;
      if (stopped) return false;
    }
    return true;
  });

  // Always compute the raw stats — they're informative at any sample size.
  // Avoid div-by-zero on a sport with no settlements yet.
  const wins = settled.filter((b) => b.outcome === 'win').length;
  const actualHitRate = settled.length > 0 ? wins / settled.length : 0;
  const avgDeclaredProb = settled.length > 0
    ? settled.reduce((s, b) => s + b.modelProb, 0) / settled.length
    : 0;
  const miscalibrationPP = avgDeclaredProb - actualHitRate;

  // Floor adjustment is gated on sample size — small-sample noise shouldn't
  // be enough to lift a sport's floor, only sustained overconfidence.
  let lift = 0;
  if (settled.length >= MIN_SAMPLE && miscalibrationPP > OVERCONFIDENCE_THRESHOLD) {
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

/** Returns calibration for every sport that has at least one settled bet,
 *  sorted by miscalibration descending (worst-overconfident first). */
export function computeAllCalibration(stateDir?: string): CalibrationStats[] {
  const out: CalibrationStats[] = [];
  for (const sport of DRY_RUN_SPORTS) {
    const stats = computeCalibration(sport, stateDir);
    if (stats.settledBets > 0) out.push(stats);
  }
  // Worst-overconfident first (largest positive miscalibration). Negative
  // miscalibration = model underconfident = good but rare; sorts to bottom.
  return out.sort((a, b) => b.miscalibrationPP - a.miscalibrationPP);
}

/** Whether a sport's calibration data is significant enough to draw a
 *  conclusion. Below this we display the numbers but flag as "early". */
export const CALIBRATION_SIGNIFICANT_SAMPLES = 15;

// ─── Bucket calibration ───────────────────────────────────────────────────────
//
// The headline per-sport calibration averages declared vs actual hit rate
// across all bets. That hides WHERE in the prob range the model fails:
// a sport at +35pp miscal might be perfectly fine on 65-70% picks and
// catastrophic on 80-85% picks. The bucketed view splits each sport's
// settled bets into prob bins and reports per-bucket calibration so we
// can surgically demote "the 80%+ bets" without killing the whole sport.

export interface CalibrationBucket {
  bucketLabel: string;        // e.g. "70-75%"
  bucketLo: number;           // 0.70
  bucketHi: number;           // 0.75
  settledBets: number;
  wins: number;
  losses: number;
  avgDeclaredProb: number;
  actualHitRate: number;
  miscalibrationPP: number;   // declared - actual; >0 = overconfident
}

/** Default buckets covering the practical betting range. Anything <0.65
 *  shouldn't be placed (below the floor) so we start there. */
const DEFAULT_BUCKETS: Array<{ lo: number; hi: number; label: string }> = [
  { lo: 0.65, hi: 0.70, label: '65-70%' },
  { lo: 0.70, hi: 0.75, label: '70-75%' },
  { lo: 0.75, hi: 0.80, label: '75-80%' },
  { lo: 0.80, hi: 0.85, label: '80-85%' },
  { lo: 0.85, hi: 1.01, label: '85%+'  },
];

/** Bucketed calibration for one sport. Returns one row per bucket with
 *  at least 1 settled bet. Stop-loss exits are excluded (same logic as
 *  the headline computeCalibration). */
export function computeCalibrationByBucket(
  sport: DryRunSport,
  stateDir?: string,
): CalibrationBucket[] {
  const state = loadPaperState(sport, stateDir);
  const settled = state.bets.filter((b) => {
    if (!b.settledAt) return false;
    if (b.outcome !== 'win' && b.outcome !== 'loss') return false;
    if (b.outcome === 'loss') {
      const fullLoss = -(b.priceCents * b.contracts) / 100;
      const stopped = (b.pnlDollars ?? fullLoss) > fullLoss + 0.005;
      if (stopped) return false;
    }
    return true;
  });

  const out: CalibrationBucket[] = [];
  for (const b of DEFAULT_BUCKETS) {
    const inBucket = settled.filter((bet) => bet.modelProb >= b.lo && bet.modelProb < b.hi);
    if (inBucket.length === 0) continue;
    const wins = inBucket.filter((x) => x.outcome === 'win').length;
    const losses = inBucket.length - wins;
    const avgDeclared = inBucket.reduce((s, x) => s + x.modelProb, 0) / inBucket.length;
    const actual = wins / inBucket.length;
    out.push({
      bucketLabel: b.label,
      bucketLo: b.lo,
      bucketHi: b.hi,
      settledBets: inBucket.length,
      wins,
      losses,
      avgDeclaredProb: Math.round(avgDeclared * 1000) / 1000,
      actualHitRate: Math.round(actual * 1000) / 1000,
      miscalibrationPP: Math.round((avgDeclared - actual) * 1000) / 1000,
    });
  }
  return out;
}

/** Returns bucketed calibration for every sport that has at least one
 *  settled bet. Ordered by sport name for stable display. */
export function computeAllCalibrationByBucket(stateDir?: string): Array<{
  sport: string;
  buckets: CalibrationBucket[];
}> {
  const out: Array<{ sport: string; buckets: CalibrationBucket[] }> = [];
  for (const sport of DRY_RUN_SPORTS) {
    const buckets = computeCalibrationByBucket(sport, stateDir);
    if (buckets.length > 0) out.push({ sport, buckets });
  }
  return out;
}
