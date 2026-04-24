// Central registry: sport → resolver.
// Unsupported sports return null from getResolver — their picks are skipped.

import type { DryRunSport } from '../../allSports.js';
import type { SportResolver } from './types.js';
import { mlbResolver } from './mlb.js';
import { makeGameWinnerResolver } from './generic.js';

// Sports with standard game-winner Kalshi markets (KX<SPORT>GAME pattern).
// The ticker prefix is best-guess and should be verified against live
// Kalshi data when that sport first goes active.
const RESOLVERS: Partial<Record<DryRunSport, SportResolver>> = {
  MLB:            mlbResolver,
  NBA:            makeGameWinnerResolver('KXNBAGAME'),
  NFL:            makeGameWinnerResolver('KXNFLGAME'),
  NHL:            makeGameWinnerResolver('KXNHLGAME'),
  NCAAM:          makeGameWinnerResolver('KXNCAAMGAME'),
  NCAAF:          makeGameWinnerResolver('KXNCAAFGAME'),
  NCAAW:          makeGameWinnerResolver('KXNCAAWGAME'),
  MLS:            makeGameWinnerResolver('KXMLSGAME'),
  EPL:            makeGameWinnerResolver('KXEPLGAME'),
  WNBA:           makeGameWinnerResolver('KXWNBAGAME'),
  MARCH_MADNESS:  makeGameWinnerResolver('KXNCAAMGAME'),
  // The following don't have simple game-winner markets — resolvers TBD:
  //   UFC, F1, TENNIS, PARLAY, PREDICT
};

export function getResolver(sport: DryRunSport): SportResolver | null {
  return RESOLVERS[sport] ?? null;
}

export function supportedSports(): DryRunSport[] {
  return Object.keys(RESOLVERS) as DryRunSport[];
}
