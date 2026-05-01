// Sport auto-suspension based on sustained miscalibration.
//
// The KALSHI_DEMOTED_SPORTS env var clamps a sport's bets to floor size —
// good but still bleeds slowly when the model is fundamentally broken.
// Auto-suspension is the harder kill switch: if a sport stays >= 7pp
// miscalibrated for 30+ settled bets across 7+ calendar days, stop
// placing bets for that sport entirely until manually unlocked.
//
// State file: safety-state/suspended-sports.json
//   {
//     "sports": {
//       "MLB": {
//         "since":             "2026-05-04T10:00:00Z",
//         "settledBetsAtSuspend": 32,
//         "miscalAtSuspend":   0.12,
//         "reason":            "..."
//       }
//     },
//     "manualOverrides": {
//       "NBA": "force-unsuspend"   // user-edited; bypasses auto-suspend
//     }
//   }
//
// To unsuspend: edit `manualOverrides[sport] = 'force-unsuspend'` in the
// JSON, or delete the entry from `sports` entirely. The file is committed
// to safety-state which is cached across workflow runs.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from './atomic.js';
import { computeCalibration } from './calibration.js';
import { loadPaperState } from './paperTradeGate.js';
import { sendSafetyAlert } from './alerts.js';
import type { DryRunSport } from './allSports.js';

const SUSPEND_MIN_SAMPLE = 30;
const SUSPEND_MISCAL_THRESHOLD = 0.07;
const SUSPEND_MIN_DAYS = 7;

interface SuspensionRecord {
  since: string;
  settledBetsAtSuspend: number;
  miscalAtSuspend: number;
  reason: string;
}

export interface SuspensionState {
  sports: Record<string, SuspensionRecord>;
  manualOverrides: Record<string, 'force-unsuspend'>;
}

function suspendPath(stateDir: string): string {
  return join(stateDir, 'suspended-sports.json');
}

export function loadSuspensions(stateDir = 'safety-state'): SuspensionState {
  const f = suspendPath(stateDir);
  if (!existsSync(f)) return { sports: {}, manualOverrides: {} };
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8')) as SuspensionState;
    if (!raw.sports) raw.sports = {};
    if (!raw.manualOverrides) raw.manualOverrides = {};
    return raw;
  } catch {
    return { sports: {}, manualOverrides: {} };
  }
}

function saveSuspensions(state: SuspensionState, stateDir = 'safety-state'): void {
  atomicWriteFile(suspendPath(stateDir), JSON.stringify(state, null, 2));
}

/** Returns true if the sport is currently auto-suspended. Manual
 *  `force-unsuspend` overrides any auto-suspension on a per-sport basis. */
export function isSuspended(sport: DryRunSport, stateDir?: string): boolean {
  const state = loadSuspensions(stateDir);
  if (state.manualOverrides[sport] === 'force-unsuspend') return false;
  return state.sports[sport] !== undefined;
}

/** Re-evaluate every sport's calibration; suspend any that meet the
 *  threshold (≥30 settled, ≥7pp miscal, ≥7 days of data). Returns the
 *  list of newly-suspended sports so the caller can alert. */
export async function evaluateAndSuspend(
  sports: readonly DryRunSport[],
  stateDir = 'safety-state',
): Promise<DryRunSport[]> {
  const state = loadSuspensions(stateDir);
  const newlySuspended: DryRunSport[] = [];

  for (const sport of sports) {
    if (state.sports[sport]) continue;             // already suspended
    if (state.manualOverrides[sport] === 'force-unsuspend') continue;

    const calib = computeCalibration(sport);
    if (calib.settledBets < SUSPEND_MIN_SAMPLE) continue;
    if (calib.miscalibrationPP < SUSPEND_MISCAL_THRESHOLD) continue;

    // Time-based gate: require the data to span ≥7 days. Prevents
    // suspending a sport on a 30-bet single-day blowup.
    const paperState = loadPaperState(sport, stateDir);
    const settledTs = paperState.bets
      .filter((b) => b.settledAt && (b.outcome === 'win' || b.outcome === 'loss'))
      .map((b) => new Date(b.settledAt!).getTime())
      .sort((a, b) => a - b);
    if (settledTs.length < 2) continue;
    const spanMs = settledTs[settledTs.length - 1]! - settledTs[0]!;
    if (spanMs < SUSPEND_MIN_DAYS * 24 * 3600 * 1000) continue;

    const reason = (
      `${sport} declared ${(calib.avgDeclaredProb * 100).toFixed(1)}% confidence ` +
      `but actual hit rate was ${(calib.actualHitRate * 100).toFixed(1)}% over ` +
      `${calib.settledBets} settled bets across ${(spanMs / 86400000).toFixed(0)} days. ` +
      `Miscalibration ${(calib.miscalibrationPP * 100).toFixed(1)}pp exceeds the ` +
      `${(SUSPEND_MISCAL_THRESHOLD * 100).toFixed(0)}pp auto-suspend threshold.`
    );

    state.sports[sport] = {
      since: new Date().toISOString(),
      settledBetsAtSuspend: calib.settledBets,
      miscalAtSuspend: calib.miscalibrationPP,
      reason,
    };
    newlySuspended.push(sport);

    // Alert loud — this is a state change that affects what the bot does.
    try {
      await sendSafetyAlert({
        title: `🛑 Sport AUTO-SUSPENDED: ${sport}`,
        description: reason +
          '\n\nNo new bets will be placed on this sport until you commit a manual ' +
          'unsuspend. Edit `safety-state/suspended-sports.json` and set ' +
          `\`manualOverrides.${sport} = "force-unsuspend"\`, or delete the entry from \`sports\`.`,
        color: 0xC0392B,
        sport,
      });
    } catch { /* alert failure should never prevent the suspension itself */ }
  }

  if (newlySuspended.length > 0) saveSuspensions(state, stateDir);
  return newlySuspended;
}
