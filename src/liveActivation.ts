// Live activation requires BOTH of these signals:
//   1. env var KALSHI_PAPER_TRADING=false   (explicit opt-in at deploy time)
//   2. committed file `live-activation.json` at repo root with:
//        { "activated": true, "activatedAt": "<ISO>", "reviewedBy": "<name>" }
//
// The file must be committed — env vars alone aren't enough. This forces a
// visible PR + approval before any real money can flow.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface LiveActivation {
  activated: boolean;
  activatedAt?: string;
  reviewedBy?: string;
}

export function readLiveActivation(
  repoRoot = process.cwd(),
): LiveActivation {
  const f = join(repoRoot, 'live-activation.json');
  if (!existsSync(f)) return { activated: false };
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as LiveActivation;
  } catch {
    return { activated: false };
  }
}

export function isLiveAllowed(): boolean {
  if (process.env.KALSHI_PAPER_TRADING !== 'false') return false;
  return readLiveActivation().activated === true;
}
