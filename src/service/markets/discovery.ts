// Lenient resolver fallback + live ticker discovery.
//
// The generic resolver assumes `KX<SPORT>GAME` ticker prefixes. When that
// guess is wrong (as it was for NBA tonight), no markets match and the
// sport gets zero bets silently. This module lets a resolver fall back to:
//
//   1. Broad scan: pull Kalshi markets matching ANY of a candidate-prefix list
//      (e.g. ['KXNBAGAME', 'KXNBA', 'NBAGAME', 'KXBB']) for the date.
//   2. Title-based match: among whatever came back, pick the one whose title
//      or subtitle mentions both team codes.

import { scanMarkets, toKalshiDate, type KalshiMarket } from '../kalshiApi.js';
import type { Pick } from '../predictions.js';
import type { SportResolver, ResolvedBet } from './types.js';

/** Candidate prefixes per sport — tried in order. First-match wins. */
export const CANDIDATE_PREFIXES: Record<string, string[]> = {
  MLB:   ['KXMLBGAME', 'KXMLB'],
  NBA:   ['KXNBAGAME', 'KXNBA', 'KXNBAFINALS', 'NBAGAME'],
  NFL:   ['KXNFLGAME', 'KXNFL'],
  NHL:   ['KXNHLGAME', 'KXNHL', 'KXNHLPLAYOFF'],
  NCAAM: ['KXNCAAMGAME', 'KXNCAAM', 'KXMARCHMADNESS'],
  NCAAF: ['KXNCAAFGAME', 'KXCFB', 'KXCFBGAME', 'KXNCAAF'],
  NCAAW: ['KXNCAAWGAME', 'KXNCAAW'],
  MLS:   ['KXMLSGAME', 'KXMLS'],
  EPL:   ['KXEPLGAME', 'KXEPL', 'KXPL', 'KXPLGAME'],
  WNBA:  ['KXWNBAGAME', 'KXWNBA'],
  MARCH_MADNESS: ['KXNCAAMGAME', 'KXMARCHMADNESS', 'KXNCAAM'],
  UFC:   ['KXUFCFIGHT', 'KXUFC'],
  F1:    ['KXF1', 'KXFONE'],
  TENNIS: ['KXTENNIS', 'KXATP', 'KXWTA'],
};

export function makeLenientResolver(sport: string, normalizeTeam?: (t: string) => string): SportResolver {
  const prefixes = CANDIDATE_PREFIXES[sport] ?? [`KX${sport}GAME`];
  const tickerPrefix = prefixes[0]!;

  const norm = (t: string): string => {
    const up = t.toUpperCase();
    return normalizeTeam ? normalizeTeam(up) : up;
  };

  async function scan(date: string): Promise<Map<string, KalshiMarket>> {
    const kdate = toKalshiDate(date);
    for (const p of prefixes) {
      const m = await scanMarkets(p, kdate);
      if (m.size > 0) return m;
    }
    return new Map();
  }

  function resolve(pick: Pick, markets: Map<string, KalshiMarket>): ResolvedBet | null {
    const h = norm(pick.home);
    const a = norm(pick.away);

    for (const [ticker, market] of markets) {
      const up = ticker.toUpperCase();
      const title = (market.title ?? '').toUpperCase();
      const yesSub = (market.yes_sub_title ?? '').toUpperCase();
      const haystack = `${up} ${title} ${yesSub}`;

      if (!(haystack.includes(h) || haystack.includes(a))) continue;

      // Identify what YES represents
      let yesTeam: string | null = null;
      if (yesSub) {
        if (yesSub.includes(h)) yesTeam = pick.home;
        else if (yesSub.includes(a)) yesTeam = pick.away;
      }
      if (!yesTeam && title.includes('WILL')) {
        if (title.includes(a) && title.includes(h)) yesTeam = pick.away;
        else if (title.includes(h)) yesTeam = pick.home;
      }
      if (!yesTeam) {
        const parts = ticker.split('-');
        const tail = (parts[parts.length - 1] ?? '').replace(/\d+$/, '').toUpperCase();
        if (tail === h) yesTeam = pick.home;
        else if (tail === a) yesTeam = pick.away;
      }
      if (!yesTeam) continue;

      const pickedIsYes = norm(pick.pickedTeam) === norm(yesTeam);
      const side: 'yes' | 'no' = pickedIsYes ? 'yes' : 'no';
      const entry = side === 'yes' ? market.yes_ask : market.no_ask;
      if (!entry || entry <= 0 || entry >= 100) continue;

      return {
        ticker, market, side,
        entryPriceCents: entry,
        modelProb: pick.modelProb,
        pick,
      };
    }
    return null;
  }

  return {
    tickerPrefix,
    scanMarkets: scan,
    resolve,
  };
}
