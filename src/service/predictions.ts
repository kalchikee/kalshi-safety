// Fetches today's predictions JSON from each sport's GitHub repo.
// Sport repos commit predictions/YYYY-MM-DD.json on their morning workflow.
// This module reads them over the raw.githubusercontent.com URL.

import fetch from 'node-fetch';
import type { DryRunSport } from '../allSports.js';

export interface Pick {
  gameId: string;
  home: string;
  away: string;
  startTime?: string;
  pickedTeam: string;
  pickedSide: 'home' | 'away';
  modelProb: number;
  vegasProb?: number;
  edge?: number;
  confidenceTier?: string;
  extra?: Record<string, unknown>;
}

export interface PredictionsFile {
  sport: DryRunSport;
  date: string;
  generatedAt: string;
  picks: Pick[];
}

export interface SportSource {
  sport: DryRunSport;
  /** e.g. "kalchikee/mlb-oracle" */
  repo: string;
  /** Branch — "master" or "main" */
  branch: string;
  /** Path to predictions folder; the file name is `<date>.json` */
  predictionsPath: string;
}

/** Built-in mapping — actual GitHub repo + branch per sport. */
export const DEFAULT_SOURCES: SportSource[] = [
  { sport: 'MLB',           repo: 'kalchikee/MLBKalchi',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NBA',           repo: 'kalchikee/nba-oracle',           branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NFL',           repo: 'Kalchikee/nfl-oracle',           branch: 'main',   predictionsPath: 'predictions' },
  { sport: 'NHL',           repo: 'kalchikee/nhl-oracle',           branch: 'main',   predictionsPath: 'predictions' },
  { sport: 'EPL',           repo: 'kalchikee/EPL',                  branch: 'main',   predictionsPath: 'predictions' },
  { sport: 'MLS',           repo: 'kalchikee/kalshi-mls-oracle',    branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NCAAM',         repo: 'kalchikee/ncaam-oracle',         branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NCAAF',         repo: 'kalchikee/ncaaf-oracle',         branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NCAAW',         repo: 'kalchikee/ncaaw-oracle',         branch: 'master', predictionsPath: 'predictions' },
  { sport: 'UFC',           repo: 'kalchikee/ufc-oracle',           branch: 'master', predictionsPath: 'predictions' },
  { sport: 'WNBA',          repo: 'kalchikee/wnba-oracle',          branch: 'master', predictionsPath: 'predictions' },
  { sport: 'F1',            repo: 'kalchikee/f1-oracle',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'TENNIS',        repo: 'kalchikee/grand-slams-oracle',   branch: 'master', predictionsPath: 'predictions' },
  { sport: 'MARCH_MADNESS', repo: 'kalchikee/march-madness-oracle', branch: 'master', predictionsPath: 'predictions' },
  { sport: 'PARLAY',        repo: 'kalchikee/parlay-picks',         branch: 'master', predictionsPath: 'predictions' },
  // Predict Picks is local-only — no GitHub repo, skipped.
];

export async function fetchPredictionsForSport(
  source: SportSource,
  date: string,
): Promise<PredictionsFile | null> {
  const url = `https://raw.githubusercontent.com/${source.repo}/${source.branch}/${source.predictionsPath}/${date}.json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return (await r.json()) as PredictionsFile;
  } catch {
    return null;
  }
}

export async function fetchAllPredictions(
  date: string,
  sources: SportSource[] = DEFAULT_SOURCES,
): Promise<PredictionsFile[]> {
  const results = await Promise.all(
    sources.map((s) => fetchPredictionsForSport(s, date).then((f) => ({ source: s, file: f }))),
  );
  return results
    .filter((r) => r.file !== null && r.file.picks.length > 0)
    .map((r) => r.file!);
}
