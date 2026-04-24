// Generic game-winner resolver — used by sports whose Kalshi tickers follow
// the same KX<SPORT>GAME-<DATE>-<TEAM> pattern as MLB (NBA, NFL, NHL, NCAA*, MLS, EPL).
//
// Each sport provides its own team-code mapping. If a sport diverges, it gets
// its own resolver instead.

import { scanMarkets, toKalshiDate, type KalshiMarket } from '../kalshiApi.js';
import type { Pick } from '../predictions.js';
import type { SportResolver, ResolvedBet } from './types.js';

export function makeGameWinnerResolver(
  tickerPrefix: string,
  teamCodeMap?: Record<string, string>,
): SportResolver {
  const normalize = (t: string): string => {
    const up = t.toUpperCase();
    return teamCodeMap?.[up] ?? up;
  };

  const parseYes = (m: KalshiMarket, home: string, away: string): string | null => {
    const h = normalize(home);
    const a = normalize(away);
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
  };

  return {
    tickerPrefix,

    async scanMarkets(date: string): Promise<Map<string, KalshiMarket>> {
      return scanMarkets(tickerPrefix, toKalshiDate(date));
    },

    resolve(pick: Pick, markets: Map<string, KalshiMarket>): ResolvedBet | null {
      const h = normalize(pick.home);
      const a = normalize(pick.away);
      for (const [ticker, market] of markets) {
        const up = ticker.toUpperCase();
        if (!(up.includes(h) || up.includes(a))) continue;
        const yesTeam = parseYes(market, pick.home, pick.away);
        if (!yesTeam) continue;
        const pickedIsYes =
          pick.pickedTeam.toUpperCase() === yesTeam.toUpperCase() ||
          normalize(pick.pickedTeam) === normalize(yesTeam);
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
}
