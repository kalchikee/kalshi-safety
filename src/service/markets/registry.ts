// Central registry: sport → resolver.
// Unsupported sports return null from getResolver — their picks are skipped.

import type { DryRunSport } from '../../allSports.js';
import type { SportResolver } from './types.js';
import { mlbResolver } from './mlb.js';
import { makeLenientResolver } from './discovery.js';

// The lenient resolver tries a list of candidate Kalshi ticker prefixes per
// sport (see CANDIDATE_PREFIXES in discovery.ts) and matches by team-name
// substring. MLB keeps its own dedicated resolver since the pattern is
// mature and includes an alternates map (e.g. SFG → SF).
const RESOLVERS: Partial<Record<DryRunSport, SportResolver>> = {
  MLB:            mlbResolver,
  NBA:            makeLenientResolver('NBA'),
  NFL:            makeLenientResolver('NFL'),
  NHL:            makeLenientResolver('NHL'),
  NCAAM:          makeLenientResolver('NCAAM'),
  NCAAF:          makeLenientResolver('NCAAF'),
  NCAAW:          makeLenientResolver('NCAAW'),
  MLS:            makeLenientResolver('MLS'),
  EPL:            makeLenientResolver('EPL'),
  WNBA:           makeLenientResolver('WNBA'),
  MARCH_MADNESS:  makeLenientResolver('MARCH_MADNESS'),
  UFC:            makeLenientResolver('UFC'),
  F1:             makeLenientResolver('F1'),
  TENNIS:         makeLenientResolver('TENNIS'),
  // PARLAY is handled specially in bet.ts — legs come with explicit tickers.
  // PREDICT has no GitHub repo and no Kalshi mapping yet.
};

export function getResolver(sport: DryRunSport): SportResolver | null {
  return RESOLVERS[sport] ?? null;
}

export function supportedSports(): DryRunSport[] {
  return Object.keys(RESOLVERS) as DryRunSport[];
}
