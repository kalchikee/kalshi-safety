// Late-news scraper for sports lineup / scratch / inactive changes.
//
// Why: per public research (4AM Club, Kalshi quants), the largest
// documented retail edge on Kalshi sports is reacting to late lineup
// changes BEFORE the market reprices. NBA inactives drop ~30 min before
// tip; MLB lineups post ~3 hours pre-game; NHL scratches at warmup.
//
// What this module does:
//   1. Read each sport's paper-state for OPEN bets whose game starts soon.
//   2. For each, fetch the latest known lineup / inactive list from the
//      sport's free official API.
//   3. Compare against the prediction's input assumptions stored in
//      bet.modelProb (proxy for "the model assumed everyone was healthy").
//   4. If a meaningful change is detected (probable pitcher swapped, star
//      player ruled out), log + alert.
//
// First implementation: MLB only, using the MLB Stats API. The infra is
// generic — adding NBA / NHL is a matter of writing each sport's own
// fetch+compare function and registering it in `INACTIVE_CHECKERS`.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';
import { loadPaperState, type PaperBetRecord } from '../paperTradeGate.js';
import { sendSafetyAlert } from '../alerts.js';
import { atomicWriteFile } from '../atomic.js';
import { DRY_RUN_SPORTS, type DryRunSport } from '../allSports.js';

interface InactiveAlert {
  sport: string;
  ticker: string;
  matchup: string;
  changeType: 'pitcher_change' | 'pitcher_tbd' | 'lineup_unavailable' | 'unknown_status';
  detail: string;
}

/** Source of truth for "is this game still in its expected pre-game state?"
 *  Each sport has its own implementation; missing sports just no-op. */
type InactiveChecker = (bet: PaperBetRecord) => Promise<InactiveAlert | null>;

// ─── MLB ──────────────────────────────────────────────────────────────────────

interface MLBGame {
  gamePk: number;
  status?: { abstractGameState?: string; detailedState?: string };
  teams?: {
    home?: { team?: { abbreviation?: string }; probablePitcher?: { id: number; fullName: string } };
    away?: { team?: { abbreviation?: string }; probablePitcher?: { id: number; fullName: string } };
  };
}

/** Extract the MLB Kalshi date code (e.g. "26APR30") from a ticker like
 *  "KXMLBGAME-26APR302005NYYTEX-NYY" and return "2026-04-30" ISO. */
export function mlbIsoDateFromTicker(ticker: string): string | null {
  const m = ticker.match(/KXMLBGAME-(\d\d)([A-Z]{3})(\d\d)/);
  if (!m) return null;
  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  };
  const yy = m[1]!;
  const mon = months[m[2]!];
  const dd = m[3]!;
  if (!mon) return null;
  return `20${yy}-${mon}-${dd}`;
}

// MLB Stats API and Kalshi mostly agree on team codes, but two diverge:
//   AZ (Stats / sometimes Kalshi)  ↔ ARI (canonical)
//   ATH (Stats post-relocation)    ↔ OAK (canonical Kalshi)
// We use a single set of aliases (declared below near MLB_KALSHI_CODES)
// to normalize whichever variant we see down to one canonical form.

/** Pull MLB schedule for a given date and return all games keyed by
 *  abbreviated matchup ("PHI@ATL" → MLBGame). Throws on network / parse
 *  failure — DO NOT swallow, because an empty Map is semantically
 *  "the API responded but the game isn't there" (worth alerting on).
 *  An exception means "the API was unreachable" (don't alert; log
 *  warn at the caller). These are different events.
 *
 *  IMPORTANT: hydrates BOTH `probablePitcher` AND `team`. Without the
 *  `team` hydrate, the team object lacks the `abbreviation` field and
 *  every game falls through with `${undefined}@${undefined}` keys,
 *  making the map useless for lookup — every real game then triggers
 *  a false "unknown_status" alert on every open bet. */
async function fetchMlbSchedule(isoDate: string): Promise<Map<string, MLBGame>> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${isoDate}&hydrate=probablePitcher,team`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`MLB schedule HTTP ${r.status}`);
  const d = (await r.json()) as { dates?: Array<{ games?: MLBGame[] }> };
  const out = new Map<string, MLBGame>();
  for (const day of d.dates ?? []) {
    for (const g of day.games ?? []) {
      const homeRaw = g.teams?.home?.team?.abbreviation;
      const awayRaw = g.teams?.away?.team?.abbreviation;
      if (!homeRaw || !awayRaw) continue;
      // Translate to Kalshi codes so lookup matches our ticker-derived keys
      const home = normalizeKalshiCode(homeRaw);
      const away = normalizeKalshiCode(awayRaw);
      out.set(`${away}@${home}`, g);
    }
  }
  return out;
}

/** Kalshi MLB team codes — superset of the MLB Stats API codes. Used to
 *  validate ticker parses since 2-letter codes (KC, SD, SF, TB) make a
 *  pure-regex split ambiguous: greedy regex on "KCCWS" yields "KCC@WS"
 *  not "KC@CWS". Validating against this set catches the right split. */
const MLB_KALSHI_CODES = new Set([
  'ARI', 'ATL', 'BAL', 'BOS', 'CHC', 'CWS', 'CIN', 'CLE', 'COL', 'DET',
  'HOU', 'KC',  'LAA', 'LAD', 'MIA', 'MIL', 'MIN', 'NYM', 'NYY', 'OAK',
  'PHI', 'PIT', 'SD',  'SF',  'SEA', 'STL', 'TB',  'TEX', 'TOR', 'WSH',
  // Variants that appear in real Kalshi tickers (alongside the canonicals
  // above). Today's ARI@CHC game was listed as KXMLBGAME-...AZCHC-CHC, so
  // strict validation against the canonical-only set silently rejected
  // the ticker and the inactives checker never ran on it.
  'AZ',   // alias for ARI (also matches MLB Stats's modern abbreviation)
  'ATH',  // alias for OAK (Athletics post-relocation; Stats updated)
]);

// Bidirectional alias map. When a ticker uses an alias (AZ, ATH) we
// normalize to the canonical (ARI, OAK) so downstream lookups work
// consistently regardless of which variant Kalshi posts on a given day.
const KALSHI_CODE_ALIASES: Record<string, string> = {
  AZ:  'ARI',
  ATH: 'OAK',
};

function normalizeKalshiCode(code: string): string {
  return KALSHI_CODE_ALIASES[code] ?? code;
}

/** Exported for direct testing. */
export const _testHooks = { MLB_KALSHI_CODES };

/** Extract team codes from the MLB ticker tail. The Kalshi format is:
 *    KXMLBGAME-{YY}{Mon}{DD}{HHMM}{AWAY}{HOME}-{TEAM}
 *  e.g. "KXMLBGAME-26APR272210MIALAD-MIA" → MIA + LAD.
 *
 *  Tries 2/3-letter splits and returns the first one where BOTH halves are
 *  recognized Kalshi team codes. Handles 2-letter codes (KC, SD, SF, TB)
 *  that ambiguous greedy/lazy regex would mis-parse:
 *    "KCCWS" → 2+3 split = "KC" + "CWS" ✓
 *    "MIALAD" → 3+3 split = "MIA" + "LAD" ✓ */
export function mlbTeamsFromTicker(ticker: string): { away: string; home: string } | null {
  // Match the YYMonDD + HHMM (4-digit time) prefix, then capture the
  // contiguous letters that follow before the trailing -TEAM segment.
  const m = ticker.match(/-\d{2}[A-Z]{3}\d{2}\d{4}([A-Z]+)-/);
  if (!m) return null;
  const teamPair = m[1]!;
  for (let awayLen = 2; awayLen <= 3; awayLen++) {
    const away = teamPair.slice(0, awayLen);
    const home = teamPair.slice(awayLen);
    if (MLB_KALSHI_CODES.has(away) && MLB_KALSHI_CODES.has(home)) {
      // Normalize aliases (AZ → ARI, ATH → OAK) so downstream schedule
      // lookups always use a single canonical code per team.
      return { away: normalizeKalshiCode(away), home: normalizeKalshiCode(home) };
    }
  }
  return null;
}

const checkMLB: InactiveChecker = async (bet) => {
  const isoDate = mlbIsoDateFromTicker(bet.ticker);
  const teams = mlbTeamsFromTicker(bet.ticker);
  if (!isoDate || !teams) {
    // Unparseable ticker — not actionable, skip silently.
    return null;
  }
  let schedule: Map<string, MLBGame>;
  try {
    schedule = await fetchMlbSchedule(isoDate);
  } catch (err) {
    // API unreachable. Log via console (the action wraps console.log into
    // structured JSON), but DO NOT alert — would spam every open bet.
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      msg: 'MLB schedule fetch failed — skipping inactive check this round',
      ticker: bet.ticker, err: String(err),
    }));
    return null;
  }
  const matchupKey = `${teams.away}@${teams.home}`;
  const game = schedule.get(matchupKey);
  if (!game) {
    // Game not visible in MLB Stats — could be cancelled. Worth alerting.
    return {
      sport: 'MLB',
      ticker: bet.ticker,
      matchup: matchupKey,
      changeType: 'unknown_status',
      detail: `MLB Stats API has no game today matching ${matchupKey} — possibly postponed or rained out`,
    };
  }
  const homeSP = game.teams?.home?.probablePitcher?.fullName ?? null;
  const awaySP = game.teams?.away?.probablePitcher?.fullName ?? null;
  if (!homeSP || !awaySP) {
    // Pitcher dropped to TBD — model's prediction depends on probable
    // pitcher, so this invalidates the assumption.
    return {
      sport: 'MLB',
      ticker: bet.ticker,
      matchup: matchupKey,
      changeType: 'pitcher_tbd',
      detail: `Probable pitcher missing: home=${homeSP ?? 'TBD'} away=${awaySP ?? 'TBD'}. Model assumed both starters set.`,
    };
  }
  return null;
};

// ─── Registry ─────────────────────────────────────────────────────────────────

const INACTIVE_CHECKERS: Partial<Record<DryRunSport, InactiveChecker>> = {
  MLB: checkMLB,
  // Add NBA / NHL / NCAA here as we wire each sport's API.
};

// ─── Discord dedup state ──────────────────────────────────────────────────────
//
// The scanner runs every 30 min during pre-game windows. If a condition
// persists (e.g. a starting pitcher stays TBD for two hours), we'd alert
// every fire — 4+ Discord messages for the same fact. We track which
// (ticker, changeType) pairs we've already alerted on for the current
// game-date and suppress repeats.

interface DedupState {
  alerted: Record<string, string>;  // key = `${ticker}|${changeType}|${gameDate}` → ISO ts of first alert
}

function dedupPath(stateDir: string): string {
  return join(stateDir, 'inactives-alerted.json');
}

function loadDedup(stateDir = 'safety-state'): DedupState {
  const f = dedupPath(stateDir);
  if (!existsSync(f)) return { alerted: {} };
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as DedupState;
  } catch {
    return { alerted: {} };
  }
}

function saveDedup(state: DedupState, stateDir = 'safety-state'): void {
  // Auto-prune entries older than 3 days to keep the file small.
  const threeDaysAgoMs = Date.now() - 3 * 24 * 3600 * 1000;
  const filtered: DedupState = { alerted: {} };
  for (const [key, ts] of Object.entries(state.alerted)) {
    if (new Date(ts).getTime() >= threeDaysAgoMs) filtered.alerted[key] = ts;
  }
  atomicWriteFile(dedupPath(stateDir), JSON.stringify(filtered, null, 2));
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function scanInactives(): Promise<{ checked: number; alerts: InactiveAlert[] }> {
  let checked = 0;
  const alerts: InactiveAlert[] = [];
  const dedup = loadDedup();
  for (const sport of DRY_RUN_SPORTS) {
    const checker = INACTIVE_CHECKERS[sport];
    if (!checker) continue;
    const state = loadPaperState(sport);
    const open = state.bets.filter((b) => !b.settledAt);
    for (const bet of open) {
      checked++;
      try {
        const alert = await checker(bet);
        if (alert) {
          // Dedup key: same condition on same ticker shouldn't spam.
          // Game-date is included so a recurring matchup on a later day
          // gets a fresh alert.
          const gameDate = mlbIsoDateFromTicker(alert.ticker) ?? alert.ticker.slice(0, 16);
          const dedupKey = `${alert.ticker}|${alert.changeType}|${gameDate}`;
          if (dedup.alerted[dedupKey]) continue;  // already alerted
          dedup.alerted[dedupKey] = new Date().toISOString();
          alerts.push(alert);
          await sendSafetyAlert({
            title: `Late-news alert: ${alert.changeType.replace(/_/g, ' ')} on ${alert.sport}`,
            description: alert.detail,
            sport: alert.sport,
            color: 0xE67E22,
            fields: [
              { name: 'Matchup', value: alert.matchup, inline: true },
              { name: 'Ticker',  value: alert.ticker,  inline: false },
            ],
          });
        }
      } catch {
        /* per-bet failure shouldn't stop the rest of the scan */
      }
    }
  }
  // Persist dedup state (any new alerts) and auto-prune entries > 3d old.
  if (alerts.length > 0) saveDedup(dedup);
  return { checked, alerts };
}
