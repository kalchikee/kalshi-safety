// MLB resolver — matches MLB Oracle picks to Kalshi KXMLBGAME markets.

import { scanMarkets, toKalshiDate, type KalshiMarket } from '../kalshiApi.js';
import type { Pick } from '../predictions.js';
import type { SportResolver, ResolvedBet } from './types.js';

const MLB_TO_KALSHI: Record<string, string> = {
  ARI: 'ARI', ATL: 'ATL', BAL: 'BAL', BOS: 'BOS', CHC: 'CHC', CWS: 'CWS',
  CIN: 'CIN', CLE: 'CLE', COL: 'COL', DET: 'DET', HOU: 'HOU', KC:  'KC',
  LAA: 'LAA', LAD: 'LAD', MIA: 'MIA', MIL: 'MIL', MIN: 'MIN', NYM: 'NYM',
  NYY: 'NYY', OAK: 'OAK', PHI: 'PHI', PIT: 'PIT', SD:  'SD',  SF:  'SF',
  SEA: 'SEA', STL: 'STL', TB:  'TB',  TEX: 'TEX', TOR: 'TOR', WSH: 'WSH',
  SFG: 'SF',  SDP: 'SD',  KCR: 'KC',  TBR: 'TB',  WSN: 'WSH', CHW: 'CWS',
};

function k(abbr: string): string {
  return MLB_TO_KALSHI[abbr.toUpperCase()] ?? abbr.toUpperCase();
}

function parseYesTeam(m: KalshiMarket, home: string, away: string): string | null {
  const h = k(home);
  const a = k(away);
  const ys = (m.yes_sub_title ?? '').toUpperCase();
  if (ys) {
    if (ys.includes(h)) return home;
    if (ys.includes(a)) return away;
  }
  const title = (m.title ?? '').toUpperCase();
  if (title.includes('WILL')) {
    if (title.includes(a) && title.includes(h)) return away;
    if (title.includes(h)) return home;
  }
  const parts = m.ticker.split('-');
  const tailRaw = parts[parts.length - 1] ?? '';
  const tail = tailRaw.replace(/\d+$/, '').toUpperCase();
  if (tail === h) return home;
  if (tail === a) return away;
  return null;
}

export const mlbResolver: SportResolver = {
  tickerPrefix: 'KXMLBGAME',

  async scanMarkets(date: string): Promise<Map<string, KalshiMarket>> {
    return scanMarkets('KXMLBGAME', toKalshiDate(date));
  },

  resolve(pick: Pick, markets: Map<string, KalshiMarket>): ResolvedBet | null {
    const h = k(pick.home);
    const a = k(pick.away);

    // Kalshi lists each game as TWO twin tickers — one for each team winning.
    // We collect every candidate market that matches this game + team pair,
    // compute the cost to back the picked team from each, and return the
    // CHEAPEST one. This makes the resolver deterministic (insertion-order-
    // independent) and guarantees we always pay the lower of the twin-ask
    // prices for the same economic outcome.
    const candidates: ResolvedBet[] = [];

    for (const [ticker, market] of markets) {
      const up = ticker.toUpperCase();
      if (!(up.includes(h) || up.includes(a))) continue;

      const yesTeam = parseYesTeam(market, pick.home, pick.away);
      if (!yesTeam) continue;

      const pickedIsYes =
        (pick.pickedTeam.toUpperCase() === yesTeam.toUpperCase()) ||
        (k(pick.pickedTeam) === k(yesTeam));
      const side: 'yes' | 'no' = pickedIsYes ? 'yes' : 'no';
      const entry = side === 'yes' ? market.yes_ask : market.no_ask;
      if (!entry || entry <= 0 || entry >= 100) continue;

      candidates.push({
        ticker, market, side,
        entryPriceCents: entry,
        modelProb: pick.modelProb,
        pick,
      });
    }

    if (candidates.length === 0) return null;
    // Pick the cheapest way to back the same team. If prices tie, prefer the
    // ticker whose name ends in the picked team's code (so the ticker's
    // "natural" side matches our bet — easier to audit).
    candidates.sort((x, y) => {
      if (x.entryPriceCents !== y.entryPriceCents) return x.entryPriceCents - y.entryPriceCents;
      const xMatch = x.ticker.toUpperCase().endsWith(`-${k(pick.pickedTeam)}`) ? 0 : 1;
      const yMatch = y.ticker.toUpperCase().endsWith(`-${k(pick.pickedTeam)}`) ? 0 : 1;
      return xMatch - yMatch;
    });
    return candidates[0]!;
  },
};
