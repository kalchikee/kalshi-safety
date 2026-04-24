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

/** Built-in mapping — extend by editing here or via ENV. */
export const DEFAULT_SOURCES: SportSource[] = [
  { sport: 'MLB',            repo: 'kalchikee/MLB',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NBA',            repo: 'kalchikee/NBA',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NFL',            repo: 'kalchikee/NFL',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NHL',            repo: 'kalchikee/NHL',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'EPL',            repo: 'kalchikee/EPL',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'MLS',            repo: 'kalchikee/MLS',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NCAAM',          repo: 'kalchikee/NCAAM',          branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NCAAF',          repo: 'kalchikee/NCAAF',          branch: 'master', predictionsPath: 'predictions' },
  { sport: 'NCAAW',          repo: 'kalchikee/NCAAW',          branch: 'master', predictionsPath: 'predictions' },
  { sport: 'UFC',            repo: 'kalchikee/UFC',            branch: 'master', predictionsPath: 'predictions' },
  { sport: 'WNBA',           repo: 'kalchikee/WNBA',           branch: 'master', predictionsPath: 'predictions' },
  { sport: 'F1',             repo: 'kalchikee/F1',             branch: 'master', predictionsPath: 'predictions' },
  { sport: 'TENNIS',         repo: 'kalchikee/Grand-Slams',    branch: 'master', predictionsPath: 'predictions' },
  { sport: 'MARCH_MADNESS',  repo: 'kalchikee/March-Madness',  branch: 'master', predictionsPath: 'predictions' },
  { sport: 'PARLAY',         repo: 'kalchikee/Parlay-Pick',    branch: 'master', predictionsPath: 'predictions' },
  { sport: 'PREDICT',        repo: 'kalchikee/Predict-Picks',  branch: 'master', predictionsPath: 'predictions' },
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
