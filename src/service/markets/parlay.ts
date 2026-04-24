// Parlay resolver (split-into-legs).
//
// Parlay Pick emits ONE composite pick whose `extra.legs` carries the
// individual Kalshi tickers. Rather than trying to find a combined
// Kalshi parlay market (which may not exist), we split the composite into
// separate bets — one per leg — each gated independently by the safety
// rules. Wins/losses then appear as independent lines in the recap.

import { getMarket, type KalshiMarket } from '../kalshiApi.js';
import type { Pick } from '../predictions.js';
import type { ResolvedBet } from './types.js';

interface ParlayLeg {
  ticker?: string;
  title?: string;
  sport?: string;
  event?: string;
  mid?: number;
  /** Optional: explicit 'yes'/'no' if the parlay writer includes it. Default 'yes'. */
  side?: 'yes' | 'no';
}

/**
 * Expand a parlay composite pick into individual leg bets.
 * Each leg becomes its own ResolvedBet with the leg's ticker and market.
 * Rejects legs whose market is missing or whose ask is unusable.
 */
export async function resolveParlayLegs(pick: Pick): Promise<ResolvedBet[]> {
  const legs = ((pick.extra ?? {})['legs'] ?? []) as ParlayLeg[];
  if (!Array.isArray(legs) || legs.length === 0) return [];

  const out: ResolvedBet[] = [];
  for (const leg of legs) {
    if (!leg.ticker) continue;
    let market: KalshiMarket | null;
    try {
      market = await getMarket(leg.ticker);
    } catch {
      market = null;
    }
    if (!market) continue;

    const side: 'yes' | 'no' = leg.side ?? 'yes';
    const entry = side === 'yes' ? market.yes_ask : market.no_ask;
    if (!entry || entry <= 0 || entry >= 100) continue;

    // Per-leg modelProb comes from the leg's `mid` (Parlay Pick's midpoint
    // probability estimate). If not present, fall back to the composite.
    const modelProb = typeof leg.mid === 'number' && leg.mid > 0 ? leg.mid : pick.modelProb;

    // Synthetic per-leg pick — retains enough context that the caller can
    // record + display it as a stand-alone bet.
    const legPick: Pick = {
      gameId: `${pick.gameId}-leg-${leg.ticker}`,
      home: leg.event?.split(' @ ')[1] ?? leg.title ?? leg.ticker,
      away: leg.event?.split(' @ ')[0] ?? '—',
      pickedTeam: leg.title ?? leg.ticker,
      pickedSide: 'home',
      modelProb,
      extra: { origin: 'parlay-leg', parlayGameId: pick.gameId, legSport: leg.sport },
    };

    out.push({
      ticker: leg.ticker,
      market,
      side,
      entryPriceCents: entry,
      modelProb,
      pick: legPick,
    });
  }
  return out;
}
