// Heartbeat — alert when any sport's predictions/ folder stops getting
// new commits while the sport is still in-season. Pre-heartbeat, four
// separate silent failures took 1-3 weeks to surface only because the
// user noticed the empty Discord embeds:
//   - UFC: UFCStats JS challenge (May → June 2026)
//   - F1: Jolpica 504s killed qualifying lookup
//   - EPL: fixture-fetcher hallucinated matchups
//   - MLB Vegas API: secret went empty in early May
//
// Every workflow returned exit 0 because the silent-failure path is
// "produce zero predictions, exit 0." This action queries the GitHub
// API for the most recent commit touching each sport's predictionsPath
// and posts a Discord alert (via the safety webhook) when any active
// sport hasn't produced predictions in N days.
//
// "Active" detection: a sport is considered active if its predictions
// folder has had any commit in the last ACTIVE_WINDOW_DAYS. That way
// off-season sports (NFL in July, NCAAM in June) don't alert. Sports
// that are mid-season but broken (the failure modes above) do.

import 'dotenv/config';
import fetch from 'node-fetch';
import { sendSafetyAlert } from '../../alerts.js';
import { DEFAULT_SOURCES, type SportSource } from '../predictions.js';

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra }));
}

// Sport is "active" if its predictions folder had a commit within this window.
// Wide enough to catch tennis (gaps between Slams) and UFC (gaps between PPVs)
// but not so wide that fully off-season sports trigger alerts.
const ACTIVE_WINDOW_DAYS = 35;
// Alert when an active sport hasn't produced predictions in this many days.
// 7d catches the real failure modes (UFC 16d dark, EPL 21d dark, MLB Vegas
// 50d dark) while staying quiet on weekly sports like F1 between races and
// UFC between fight cards (typical 7-day cadence).
const STALE_THRESHOLD_DAYS = 7;

interface Status {
  sport: string;
  repo: string;
  lastCommitDays: number | null;
  lastCommitDate: string | null;
  active: boolean;
  stale: boolean;
  error?: string;
}

async function checkRepoFreshness(src: SportSource): Promise<Status> {
  // GitHub commits API filtered by path returns the most recent commits
  // that touched anything inside predictionsPath. The first item is the
  // newest, which is what we want.
  const url =
    `https://api.github.com/repos/${src.repo}/commits` +
    `?path=${encodeURIComponent(src.predictionsPath)}` +
    `&sha=${encodeURIComponent(src.branch)}&per_page=1`;
  const headers: Record<string, string> = {
    'User-Agent': 'kalshi-safety-heartbeat/1.0',
    'Accept': 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) {
      return {
        sport: src.sport,
        repo: src.repo,
        lastCommitDays: null,
        lastCommitDate: null,
        active: false,
        stale: false,
        error: `HTTP ${resp.status}`,
      };
    }
    const commits = await resp.json() as Array<{ commit?: { committer?: { date?: string } } }>;
    const first = commits[0];
    const dateStr = first?.commit?.committer?.date;
    if (!dateStr) {
      return {
        sport: src.sport,
        repo: src.repo,
        lastCommitDays: null,
        lastCommitDate: null,
        active: false,
        stale: false,
        error: 'no commits returned',
      };
    }
    const last = new Date(dateStr);
    const ageMs = Date.now() - last.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const active = ageDays <= ACTIVE_WINDOW_DAYS;
    const stale = active && ageDays >= STALE_THRESHOLD_DAYS;
    return {
      sport: src.sport,
      repo: src.repo,
      lastCommitDays: Math.round(ageDays * 10) / 10,
      lastCommitDate: last.toISOString().slice(0, 10),
      active,
      stale,
    };
  } catch (err) {
    return {
      sport: src.sport,
      repo: src.repo,
      lastCommitDays: null,
      lastCommitDate: null,
      active: false,
      stale: false,
      error: String(err),
    };
  }
}

export async function runHeartbeat(): Promise<void> {
  log('info', 'Heartbeat starting', { sources: DEFAULT_SOURCES.length });
  const results: Status[] = [];
  for (const src of DEFAULT_SOURCES) {
    results.push(await checkRepoFreshness(src));
  }

  const stale = results.filter(r => r.stale);
  const errors = results.filter(r => r.error);

  log('info', 'Heartbeat complete', {
    checked: results.length,
    active: results.filter(r => r.active).length,
    stale: stale.length,
    errors: errors.length,
  });

  if (stale.length === 0 && errors.length === 0) {
    log('info', 'All active sport repos are fresh — no alert');
    return;
  }

  const fields = [];
  if (stale.length > 0) {
    fields.push({
      name: `🔴 Stale predictions (${stale.length})`,
      value: stale.map(r =>
        `**${r.sport}** (${r.repo}) — last commit ${r.lastCommitDays}d ago (${r.lastCommitDate})`
      ).join('\n'),
      inline: false,
    });
  }
  if (errors.length > 0) {
    fields.push({
      name: `⚠️ Could not check (${errors.length})`,
      value: errors.map(r => `**${r.sport}** — ${r.error}`).join('\n'),
      inline: false,
    });
  }

  await sendSafetyAlert({
    title: 'Sport prediction heartbeat — stale repos detected',
    description:
      `An in-season sport repo hasn't committed new predictions in ${STALE_THRESHOLD_DAYS}+ days. ` +
      'Check the workflow logs on the named repos for silent failures ' +
      '(data source blocked, API key revoked, parser broken, etc.).',
    color: 0xE67E22,
    fields,
  });
}

runHeartbeat()
  .then(() => process.exit(0))
  .catch((err) => {
    log('error', 'Heartbeat failed', { err: String(err) });
    process.exit(1);
  });
