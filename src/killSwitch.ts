import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { KillSwitchStatus } from './types.js';

// The kill switch can be activated in TWO ways:
//   1. File: create ./safety-state/KILL (content: reason + timestamp)
//   2. Env:  set KALSHI_KILL_SWITCH=1 (immediate, per-run)
//
// Either triggers a hard stop — no new bets placed by ANY sport module.
// File-based kill survives across workflow runs; env-based is per-invocation.
//
// Intentionally synchronous: any async-failure in the kill check would
// default to "NOT active" which is unsafe. Sync fs calls always return.

const DEFAULT_KILL_FILE = resolve(process.cwd(), 'safety-state', 'KILL');

export function isKillSwitchActive(killFile = DEFAULT_KILL_FILE): KillSwitchStatus {
  // 1. Env var check
  const envKill = process.env.KALSHI_KILL_SWITCH;
  if (envKill && envKill !== '0' && envKill.toLowerCase() !== 'false') {
    return {
      active: true,
      reason: `env KALSHI_KILL_SWITCH=${envKill}`,
      triggeredAt: new Date().toISOString(),
      triggeredBy: 'environment',
    };
  }

  // 2. File check
  if (existsSync(killFile)) {
    try {
      const content = readFileSync(killFile, 'utf-8').trim();
      const firstLine = content.split('\n')[0] || 'kill file present';
      return {
        active: true,
        reason: firstLine,
        triggeredAt: new Date().toISOString(),
        triggeredBy: 'file',
      };
    } catch {
      // If we can't read the file but it exists, still treat as active
      return {
        active: true,
        reason: 'kill file present (unreadable)',
        triggeredAt: new Date().toISOString(),
        triggeredBy: 'file',
      };
    }
  }

  return { active: false, reason: 'not active' };
}
