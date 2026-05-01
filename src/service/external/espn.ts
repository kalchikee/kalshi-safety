// ESPN scoreboard client — fetches the public, unauthenticated scoreboard
// endpoints for major sports and extracts ESPN's win-probability estimates
// (when available) keyed by `${away}@${home}` matchup.
//
// Used as a second-source consensus filter alongside our own model:
// when our pick says >=70% but ESPN says <50% on the same side, the
// market is probably more right than our small-sample model.
//
// ESPN's free API is undocumented but stable. Endpoints follow the
// pattern: `https://site.api.espn.com/apis/site/v2/sports/<group>/<league>/scoreboard?dates=YYYYMMDD`
// The `events[].competitions[0].competitors[]` array has team abbrev +
// score. The win-probability lives in `events[].competitions[0].predictor`
// when ESPN's analytics service has filed a prediction (not always).

import fetch from 'node-fetch';
import type { DryRunSport } from '../../allSports.js';

interface EspnTeamProb {
  /** ESPN home win probability, 0-1. undefined when ESPN hasn't filed
   *  a prediction (e.g. very early in season, low-coverage games). */
  homeProb?: number;
  awayProb?: number;
  /** When the game starts. Useful for dedup of doubleheaders. */
  startUtcIso?: string;
}

export interface EspnScoreboard {
  /** Map keyed by `${away}@${home}` (uppercase team abbrevs). */
  byMatchup: Map<string, EspnTeamProb>;
  /** True if the scoreboard fetch succeeded; false if the API errored. */
  ok: boolean;
}

const SPORT_TO_ESPN: Partial<Record<DryRunSport, { group: string; league: string }>> = {
  MLB:  { group: 'baseball',   league: 'mlb' },
  NBA:  { group: 'basketball', league: 'nba' },
  NHL:  { group: 'hockey',     league: 'nhl' },
  NFL:  { group: 'football',   league: 'nfl' },
  NCAAM:{ group: 'basketball', league: 'mens-college-basketball' },
  NCAAF:{ group: 'football',   league: 'college-football' },
  NCAAW:{ group: 'basketball', league: 'womens-college-basketball' },
  WNBA: { group: 'basketball', league: 'wnba' },
};

interface EspnEvent {
  date?: string;
  competitions?: Array<{
    competitors?: Array<{
      homeAway?: 'home' | 'away';
      team?: { abbreviation?: string };
    }>;
    predictor?: {
      homeTeam?: { gameProjection?: string };
      awayTeam?: { gameProjection?: string };
    };
  }>;
}

interface EspnScoreboardResp {
  events?: EspnEvent[];
}

/** Fetch ESPN's scoreboard for a sport on a date and extract win-prob
 *  estimates keyed by matchup. Returns `ok: false` on network failure
 *  so callers can distinguish "ESPN unreachable" from "ESPN has no data
 *  for this game" (the latter just means the matchup isn't in the map). */
export async function fetchEspnScoreboard(
  sport: DryRunSport,
  isoDate: string,
): Promise<EspnScoreboard> {
  const cfg = SPORT_TO_ESPN[sport];
  if (!cfg) return { byMatchup: new Map(), ok: true };  // unsupported sport — no-op
  const yyyymmdd = isoDate.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.group}/${cfg.league}/scoreboard?dates=${yyyymmdd}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { byMatchup: new Map(), ok: false };
    const data = (await r.json()) as EspnScoreboardResp;
    const out = new Map<string, EspnTeamProb>();
    for (const ev of data.events ?? []) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find((c) => c.homeAway === 'home')?.team?.abbreviation;
      const away = comp.competitors?.find((c) => c.homeAway === 'away')?.team?.abbreviation;
      if (!home || !away) continue;
      const homeProj = comp.predictor?.homeTeam?.gameProjection;
      const awayProj = comp.predictor?.awayTeam?.gameProjection;
      const homeProb = homeProj !== undefined ? parseFloat(homeProj) / 100 : undefined;
      const awayProb = awayProj !== undefined ? parseFloat(awayProj) / 100 : undefined;
      out.set(`${away.toUpperCase()}@${home.toUpperCase()}`, {
        homeProb: homeProb !== undefined && Number.isFinite(homeProb) && homeProb > 0 && homeProb < 1 ? homeProb : undefined,
        awayProb: awayProb !== undefined && Number.isFinite(awayProb) && awayProb > 0 && awayProb < 1 ? awayProb : undefined,
        startUtcIso: ev.date,
      });
    }
    return { byMatchup: out, ok: true };
  } catch {
    return { byMatchup: new Map(), ok: false };
  }
}

/** ESPN's prob for OUR pick (the side we're backing). Returns undefined
 *  when ESPN didn't file a prediction for this matchup. */
export function espnProbForPick(
  scoreboard: EspnScoreboard,
  away: string,
  home: string,
  pickedSide: 'home' | 'away',
): number | undefined {
  const game = scoreboard.byMatchup.get(`${away.toUpperCase()}@${home.toUpperCase()}`);
  if (!game) return undefined;
  return pickedSide === 'home' ? game.homeProb : game.awayProb;
}
