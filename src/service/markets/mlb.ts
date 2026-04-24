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
      if (!entry || entry <= 0) continue;

      return {
        ticker,
        market,
        side,
        entryPriceCents: entry,
        modelProb: pick.modelProb,
        pick,
      };
    }
    return null;
  },
};
