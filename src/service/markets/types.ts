// Per-sport market resolver interface.
// A resolver takes a pick + a prescanned set of Kalshi markets and returns
// the specific market + side to bet on (or null if no match / no value).

import type { KalshiMarket } from '../kalshiApi.js';
import type { Pick } from '../predictions.js';

export interface ResolvedBet {
  ticker: string;
  market: KalshiMarket;
  side: 'yes' | 'no';
  entryPriceCents: number;
  modelProb: number;
  pick: Pick;
}

export interface SportResolver {
  /** The Kalshi ticker prefix for game markets of this sport (e.g. "KXMLBGAME"). */
  tickerPrefix: string;
  /** Scan Kalshi for today's markets for this sport. */
  scanMarkets(date: string): Promise<Map<string, KalshiMarket>>;
  /** Given a pick and scanned markets, find the matching market + side. */
  resolve(pick: Pick, markets: Map<string, KalshiMarket>): ResolvedBet | null;
}
