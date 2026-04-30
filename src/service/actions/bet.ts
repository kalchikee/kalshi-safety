// Morning bet action (runs on kalshi-safety's bet.yml workflow).
//
// 1. Fetch today's predictions JSON from every sport's GitHub repo.
// 2. For each pick: resolve to a Kalshi market (ticker + side + price).
// 3. Run checkBet() — applies caps, kill switch, paper-vs-live gate.
// 4. In live mode only: check account balance ≥ $5 before placing any order.
// 5. Place the order (real or paper) and persist state.
// 6. Post one consolidated "Bets placed today" message to the Safety Discord.

import 'dotenv/config';
import { checkBet } from '../../index.js';
import type { BetRequest, Position } from '../../types.js';
import type { DryRunSport } from '../../allSports.js';
import { DRY_RUN_SPORTS } from '../../allSports.js';
import { recordPaperBet, loadPaperState } from '../../paperTradeGate.js';
import { fetchAllPredictions } from '../predictions.js';
import { getResolver, supportedSports } from '../markets/registry.js';
import { resolveParlayLegs } from '../markets/parlay.js';
import type { ResolvedBet } from '../markets/types.js';
import { placeOrder, MIN_BALANCE_DOLLARS } from '../kalshiApi.js';
import { checkAccountBalance } from '../balanceCheck.js';
import { recordLiveBet, getOpenLiveBets } from '../liveBets.js';
import { sendBetsPlacedSummary, type PlacedBetDisplay } from '../discord.js';
import { sendSafetyAlert } from '../../alerts.js';
import {
  checkGameExposure, checkLineAgreement, kellyContracts,
  checkPerSportDaily, checkDailyBetCount, checkLiquidity,
  checkVegasAgreement, checkWeeklyExposure, checkFeeDeathZone,
} from '../../caps.js';
import { loadConfig } from '../../config.js';
import { getPerSportFloor } from '../../calibration.js';
import { isLiveAllowed } from '../../liveActivation.js';

const BET_SIZE_DOLLARS = parseFloat(process.env.KALSHI_BET_SIZE ?? '1');
const DEFAULT_MIN_PROB = parseFloat(process.env.KALSHI_MIN_PROB ?? '0.65');
const MAX_BET_DOLLARS  = parseFloat(process.env.KALSHI_MAX_BET_DOLLARS ?? '10');
// Paper bankroll for Kelly sizing when no live balance is available
const PAPER_BANKROLL   = parseFloat(process.env.KALSHI_PAPER_BANKROLL ?? '100');
// Dry-run mode: runs every check, posts the Discord summary, but DOES NOT
// mutate paper state (no recordPaperBet / no recordLiveBet / no placeOrder).
// Use to preview "what would Kalshi Picks bet on" without committing bets.
const DRY_RUN = process.env.BET_DRY_RUN === 'true';

// High-conviction threshold: picks at or above this modelProb skip the
// line-agreement guard AND the HARD_MIN_EDGE check. The intent is that
// when our model has strong conviction (e.g. >=70%), we want to record
// the bet even if Kalshi has already priced the outcome at or above
// our number. We're explicitly choosing to test the model's calibration
// in those cases rather than only betting where we have an edge over
// the market. Other safety rails (caps, liquidity, kill switch, balance)
// still fire normally.
const HIGH_CONVICTION_THRESHOLD = parseFloat(
  process.env.KALSHI_HIGH_CONVICTION_THRESHOLD ?? '0.70',
);

// Maker-mode offset (cents). Instead of taking the ask, we subtract this
// many cents to enter as a maker (post a limit order one tick inside the
// spread). On Kalshi this:
//   - Saves the taker fee (`7¢ × C × (1−C)`, ~1.75¢ at 50¢ = 3.5% RT)
//   - Earns Liquidity Incentive Program rebates if size is meaningful
//   - Saves spread cost: 1¢ × N contracts per bet
//
// In paper mode we just record the bet at `ask − offset` and assume the
// market trades through (a 1¢ improvement fills inside ~1 minute on
// liquid game-winner markets near tip-off; this is a reasonable
// simulation but slightly optimistic).
//
// In LIVE mode we'd post a limit order at this price, poll status every
// 30s, and fall back to taker after MAKER_TIMEOUT_MIN — that wiring
// happens later when live keys are activated.
const MAKER_OFFSET_CENTS = parseInt(process.env.KALSHI_MAKER_OFFSET_CENTS ?? '1', 10);

// Demoted sports: these have a known-broken probability calibration, so
// Kelly's edge math is unreliable on their picks. We still place the bets
// (to gather calibration data), but we clamp position size to the floor
// regardless of what Kelly says — preventing big losses from a misled
// Kelly while we wait for the model to be fixed or per-sport
// calibration (calibration.ts) to lift the floor automatically.
//
// Format: comma-separated DryRunSport codes. e.g. "MLB,NBA".
const DEMOTED_SPORTS = new Set(
  (process.env.KALSHI_DEMOTED_SPORTS ?? 'MLB')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
);

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() });
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line);
}

export async function runBetAction(date: string): Promise<void> {
  // Live requires BOTH env opt-in and live-activation.json committed in repo.
  const requestLive = isLiveAllowed();
  const mode: 'paper' | 'live' = requestLive ? 'live' : 'paper';
  log('info', 'bet action starting', { date, mode, requestLive, dryRun: DRY_RUN });

  // ── Live-only: hard-stop before fetching predictions if balance too low ──
  if (requestLive) {
    const bal = await checkAccountBalance();
    if (!bal.ok) {
      log('warn', 'balance check failed — halting bets', {
        balance: bal.balanceDollars, reason: bal.reason, min: MIN_BALANCE_DOLLARS,
      });
      await sendBetsPlacedSummary(date, [], [
        { sport: 'ALL', matchup: '—', reason: bal.reason ?? 'balance below minimum' },
      ], mode);
      return;
    }
    log('info', 'balance check passed', { balance: bal.balanceDollars });
  }

  // ── Fetch predictions from all sport repos ──
  const files = await fetchAllPredictions(date);
  log('info', 'predictions fetched', {
    sports: files.map((f) => f.sport),
    totalPicks: files.reduce((s, f) => s + f.picks.length, 0),
  });

  // ── Per-sport: scan Kalshi markets, decide bets ──
  const placed: PlacedBetDisplay[] = [];
  const skipped: Array<{ sport: string; matchup: string; reason: string }> = [];

  // Running totals for checkBet() context
  let todayDollars = 0;
  let betsPlaced = 0;
  const perSportDollars: Record<string, number> = {};

  // Rolling 7-day exposure: sum cost basis of every paper bet across every
  // sport in the last 7 days. Recomputed once per run (acceptable since
  // each bet incrementally raises this within the run too).
  const sevenDaysAgoMs = Date.now() - 7 * 24 * 3600 * 1000;
  let weeklyDollars = 0;
  for (const sport of DRY_RUN_SPORTS) {
    const state = loadPaperState(sport);
    for (const b of state.bets) {
      if (new Date(b.placedAt).getTime() >= sevenDaysAgoMs) {
        weeklyDollars += (b.priceCents / 100) * b.contracts;
      }
    }
  }
  log('info', '7-day exposure baseline', { weeklyDollars: weeklyDollars.toFixed(2) });
  const openPositions: Position[] = getOpenLiveBets().map((b) => ({
    sport: b.sport,
    ticker: b.ticker,
    contracts: b.contracts,
    entryPriceCents: b.priceCents,
    costBasisDollars: b.costBasisDollars,
    currentValueDollars: b.costBasisDollars,
  }));

  for (const file of files) {
    // Parlay gets special-cased — composite pick expands into individual legs,
    // each resolved by its explicit Kalshi ticker (no per-sport scan needed).
    if (file.sport === 'PARLAY') {
      for (const pick of file.picks) {
        const legs = await resolveParlayLegs(pick);
        if (legs.length === 0) {
          skipped.push({
            sport: 'PARLAY',
            matchup: `${pick.away} @ ${pick.home}`,
            reason: 'parlay has no resolvable legs',
          });
          continue;
        }
        for (const leg of legs) {
          // Apply maker-offset to each leg the same way as the main path
          const legBid = leg.side === 'yes' ? leg.market.yes_bid : leg.market.no_bid;
          const legAsk = leg.side === 'yes' ? leg.market.yes_ask : leg.market.no_ask;
          const legMaker = legAsk - MAKER_OFFSET_CENTS;
          if (legMaker > legBid && legMaker >= 2) {
            leg.entryPriceCents = legMaker;
          }
          await processResolvedBet(leg, 'PARLAY', pick, placed, skipped, openPositions, () => todayDollars, (d) => { todayDollars = d; }, mode);
        }
      }
      continue;
    }

    const resolver = getResolver(file.sport as DryRunSport);
    if (!resolver) {
      log('warn', 'no resolver for sport — skipping', { sport: file.sport });
      for (const pick of file.picks) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: 'no Kalshi resolver configured yet',
        });
      }
      continue;
    }

    let markets;
    try {
      markets = await resolver.scanMarkets(date);
    } catch (err) {
      log('error', 'market scan failed', { sport: file.sport, err: String(err) });
      for (const pick of file.picks) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: `market scan failed: ${String(err)}`,
        });
      }
      continue;
    }

    // Resolver health alert: picks emitted but 0 markets matched → resolver is broken
    if (markets.size === 0 && file.picks.length > 0) {
      await sendSafetyAlert({
        title: `Resolver health alert: ${file.sport}`,
        description: `${file.picks.length} picks emitted but 0 Kalshi markets matched. Resolver ticker prefix likely wrong.`,
        sport: file.sport,
        color: 0xE67E22,
      });
      for (const pick of file.picks) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: 'resolver found 0 markets (alerting)',
        });
      }
      continue;
    }

    // Per-sport calibrated floor — may be > DEFAULT_MIN_PROB after 50+ settlements
    const sportFloor = getPerSportFloor(file.sport as DryRunSport);

    for (const pick of file.picks) {
      if (pick.modelProb < sportFloor) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: `modelProb ${(pick.modelProb * 100).toFixed(1)}% < ${(sportFloor * 100).toFixed(0)}% ${sportFloor > DEFAULT_MIN_PROB ? 'calibrated' : 'default'} floor`,
        });
        continue;
      }

      const resolved = resolver.resolve(pick, markets);
      if (!resolved) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: 'no matching Kalshi market',
        });
        continue;
      }

      // Maker-mode pricing: replace the resolver's "ask" entry price with
      // a maker price one tick inside the spread. We require:
      //   - the maker price is still above the current bid (otherwise we'd
      //     just be at the back of the bid queue with no fill expectation);
      //   - the maker price is at least 2¢ (avoid degenerate fills at 1¢).
      // If the spread is so tight that ask − offset ≤ bid, fall back to
      // taking the ask (no improvement available).
      const sideBid = resolved.side === 'yes' ? resolved.market.yes_bid : resolved.market.no_bid;
      const sideAsk = resolved.side === 'yes' ? resolved.market.yes_ask : resolved.market.no_ask;
      const proposedMaker = sideAsk - MAKER_OFFSET_CENTS;
      if (proposedMaker > sideBid && proposedMaker >= 2) {
        resolved.entryPriceCents = proposedMaker;
      }

      const cfg = loadConfig();

      // Daily bet-count cap (before all other checks — even the best bet skipped
      // once we hit the max-bets-per-day ceiling)
      const countCheck = checkDailyBetCount(betsPlaced, cfg);
      if (!countCheck.allowed) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: countCheck.reason,
        });
        continue;
      }

      // Liquidity guard: spread too wide or volume zero → skip
      const liq = checkLiquidity(
        resolved.market.yes_bid, resolved.market.yes_ask,
        resolved.market.no_bid,  resolved.market.no_ask,
        resolved.side, resolved.market.volume, cfg,
      );
      if (!liq.allowed) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: liq.reason,
        });
        continue;
      }

      // Vegas-disagreement filter: if model and Vegas are >10pp apart,
      // Vegas is almost always more right. Skip the bet.
      const vegasCheck = checkVegasAgreement(pick.modelProb, pick.vegasProb);
      if (!vegasCheck.allowed) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: vegasCheck.reason,
        });
        continue;
      }

      // High-conviction picks (modelProb >= threshold) bypass both the
      // line-agreement and min-edge guards. We're explicitly opting into
      // tracking these bets even when Kalshi has already priced the outcome
      // at or above our number, so we can measure model calibration.
      const isHighConviction = pick.modelProb >= HIGH_CONVICTION_THRESHOLD;

      // Fee-death-zone filter: skip cheap longshots (<15¢) and skip
      // expensive favorites (>85¢) without strong edge. Bypassed for
      // high-conviction picks per the same policy as line-agreement.
      if (!isHighConviction) {
        const feeDraft: BetRequest = {
          sport: file.sport as DryRunSport,
          ticker: resolved.ticker, side: resolved.side,
          priceCents: resolved.entryPriceCents,
          contracts: 1,
          modelProb: pick.modelProb,
        };
        const feeCheck = checkFeeDeathZone(feeDraft);
        if (!feeCheck.allowed) {
          skipped.push({
            sport: file.sport,
            matchup: `${pick.away} @ ${pick.home}`,
            reason: feeCheck.reason,
          });
          continue;
        }
      }

      // Pre-bet line-move check — if the Kalshi ask already reflects the model's
      // view, the edge is gone. Skip rather than bet into a priced-in market.
      // Bypassed for high-conviction picks per user policy.
      if (!isHighConviction) {
        const draftReq: BetRequest = {
          sport: file.sport as DryRunSport,
          ticker: resolved.ticker, side: resolved.side,
          priceCents: resolved.entryPriceCents,
          contracts: 1,
          modelProb: pick.modelProb,
        };
        const lineCheck = checkLineAgreement(draftReq);
        if (!lineCheck.allowed) {
          skipped.push({
            sport: file.sport,
            matchup: `${pick.away} @ ${pick.home}`,
            reason: lineCheck.reason,
          });
          continue;
        }
      }

      // Kelly-criterion sizing — scales contracts with edge, capped at quarter-Kelly.
      // For high-conviction picks, Kelly's edge check is bypassed: we fall
      // back to BET_SIZE_DOLLARS as a minimum so the pick gets placed.
      const isDemoted = DEMOTED_SPORTS.has(file.sport);
      let contracts = kellyContracts(
        resolved.entryPriceCents,
        pick.modelProb,
        PAPER_BANKROLL,
        BET_SIZE_DOLLARS,
        MAX_BET_DOLLARS,
      );
      if (contracts === 0) {
        if (isHighConviction) {
          contracts = Math.max(
            1,
            Math.round(BET_SIZE_DOLLARS / (resolved.entryPriceCents / 100)),
          );
        } else {
          skipped.push({
            sport: file.sport,
            matchup: `${pick.away} @ ${pick.home}`,
            reason: 'Kelly returned 0 (no positive edge at current price)',
          });
          continue;
        }
      }
      // Demoted sport — clamp to floor size regardless of Kelly. The
      // probabilities the model reports are not trustworthy enough to
      // size up on. Comparable picks at the supposed 76% confidence
      // tier hit at 50% over the first 16 bets — Kelly amplifies that
      // miscalibration in the wrong direction.
      if (isDemoted) {
        const floorContracts = Math.max(
          1,
          Math.round(BET_SIZE_DOLLARS / (resolved.entryPriceCents / 100)),
        );
        if (contracts > floorContracts) {
          log('info', 'demoted sport — clamping size to floor', {
            sport: file.sport,
            kellyContracts: contracts,
            floorContracts,
          });
          contracts = floorContracts;
        }
      }

      const req: BetRequest = {
        sport: file.sport as DryRunSport,
        ticker: resolved.ticker,
        side: resolved.side,
        priceCents: resolved.entryPriceCents,
        contracts,
        modelProb: pick.modelProb,
        reason: `${file.sport} pick ${pick.pickedTeam} @ ${(pick.modelProb * 100).toFixed(1)}%`,
      };

      // Correlated-position guard: cap per-gameId exposure
      const gameExp = checkGameExposure(req, pick.gameId, openPositions, cfg);
      if (!gameExp.allowed) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: gameExp.reason,
        });
        continue;
      }

      // Per-sport daily exposure cap: diversify across sports
      const sportDaily = checkPerSportDaily(req, perSportDollars[file.sport] ?? 0, cfg);
      if (!sportDaily.allowed) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: sportDaily.reason,
        });
        continue;
      }

      // Rolling 7-day exposure cap
      const weeklyCheck = checkWeeklyExposure(req, weeklyDollars, cfg);
      if (!weeklyCheck.allowed) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: weeklyCheck.reason,
        });
        continue;
      }

      const decision = await checkBet(req, {
        todayDollarsPlaced: todayDollars,
        openPositions,
        todayRealizedLoss: 0,
        requestLive,
        bypassMinEdge: isHighConviction,
      });

      if (!decision.allowed) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: decision.reason ?? 'blocked by safety',
        });
        continue;
      }

      const execContracts = decision.cappedContracts ?? contracts;
      const costBasis = (execContracts * resolved.entryPriceCents) / 100;

      if (decision.mode === 'paper') {
        if (!DRY_RUN) recordPaperBet(file.sport as DryRunSport, { ...req, contracts: execContracts });
        placed.push({
          sport: file.sport, matchup: `${pick.away} @ ${pick.home}`,
          pick: pick.pickedTeam,
          ticker: resolved.ticker, side: resolved.side,
          priceCents: resolved.entryPriceCents, contracts: execContracts,
          costBasisDollars: costBasis, modelProb: pick.modelProb, mode: 'paper',
        });
        todayDollars += costBasis;
        betsPlaced++;
        perSportDollars[file.sport] = (perSportDollars[file.sport] ?? 0) + costBasis;
        weeklyDollars += costBasis;
        log('info', DRY_RUN ? 'paper bet (DRY RUN — not recorded)' : 'paper bet recorded', {
          sport: file.sport, ticker: resolved.ticker, contracts: execContracts,
        });
        continue;
      }

      // LIVE path
      try {
        const order = DRY_RUN
          ? { order_id: `dryrun-${Date.now()}` }
          : await placeOrder(resolved.ticker, resolved.side, resolved.entryPriceCents, execContracts);
        if (!DRY_RUN) {
          recordLiveBet({
            sport: file.sport as DryRunSport,
            ticker: resolved.ticker,
            side: resolved.side,
            priceCents: resolved.entryPriceCents,
            contracts: execContracts,
            costBasisDollars: costBasis,
            modelProb: pick.modelProb,
            orderId: order.order_id,
            placedAt: new Date().toISOString(),
          });
        }
        openPositions.push({
          sport: file.sport as DryRunSport,
          ticker: resolved.ticker,
          contracts: execContracts,
          entryPriceCents: resolved.entryPriceCents,
          costBasisDollars: costBasis,
          currentValueDollars: costBasis,
        });
        todayDollars += costBasis;
        betsPlaced++;
        perSportDollars[file.sport] = (perSportDollars[file.sport] ?? 0) + costBasis;
        weeklyDollars += costBasis;
        placed.push({
          sport: file.sport, matchup: `${pick.away} @ ${pick.home}`,
          pick: pick.pickedTeam,
          ticker: resolved.ticker, side: resolved.side,
          priceCents: resolved.entryPriceCents, contracts: execContracts,
          costBasisDollars: costBasis, modelProb: pick.modelProb, mode: 'live',
        });
        log('info', DRY_RUN ? 'live bet (DRY RUN — not placed)' : 'live bet placed', {
          sport: file.sport, ticker: resolved.ticker, orderId: order.order_id,
        });
      } catch (err) {
        skipped.push({
          sport: file.sport, matchup: `${pick.away} @ ${pick.home}`,
          reason: `order failed: ${String(err)}`,
        });
        log('error', 'placeOrder failed', { sport: file.sport, ticker: resolved.ticker, err: String(err) });
      }
    }
  }

  // Dump every skip reason to the run log so "why was X not bet on?"
  // questions can be answered from the run log alone — no Discord required.
  for (const s of skipped) {
    log('info', 'pick skipped', { sport: s.sport, matchup: s.matchup, reason: s.reason });
  }

  await sendBetsPlacedSummary(date, placed, skipped, mode, DRY_RUN);
  log('info', 'bet action complete', {
    placed: placed.length,
    skipped: skipped.length,
    supportedSports: supportedSports(),
  });

  // ── Helper used by the parlay path ────────────────────────────────────────
  async function processResolvedBet(
    resolved: ResolvedBet,
    sport: DryRunSport,
    originalPick: { gameId: string; home: string; away: string; pickedTeam: string; modelProb: number },
    _placed: PlacedBetDisplay[],
    _skipped: Array<{ sport: string; matchup: string; reason: string }>,
    _openPositions: Position[],
    getTodayDollars: () => number,
    setTodayDollars: (d: number) => void,
    _mode: 'paper' | 'live',
  ): Promise<void> {
    const matchup = `${originalPick.away} @ ${originalPick.home}`;
    const cfg = loadConfig();

    // Same gates as the main pick loop — parlay legs are bets too
    const countCheck = checkDailyBetCount(betsPlaced, cfg);
    if (!countCheck.allowed) {
      _skipped.push({ sport, matchup, reason: countCheck.reason });
      return;
    }
    const liq = checkLiquidity(
      resolved.market.yes_bid, resolved.market.yes_ask,
      resolved.market.no_bid,  resolved.market.no_ask,
      resolved.side, resolved.market.volume, cfg,
    );
    if (!liq.allowed) {
      _skipped.push({ sport, matchup, reason: liq.reason });
      return;
    }
    const lineCheck = checkLineAgreement({
      sport, ticker: resolved.ticker, side: resolved.side,
      priceCents: resolved.entryPriceCents, contracts: 1,
      modelProb: resolved.modelProb,
    });
    if (!lineCheck.allowed) {
      _skipped.push({ sport, matchup, reason: lineCheck.reason });
      return;
    }

    // Fee death zone — same rule as main path; we always apply it for
    // parlay legs (no high-conviction bypass per leg).
    const feeCheck = checkFeeDeathZone({
      sport, ticker: resolved.ticker, side: resolved.side,
      priceCents: resolved.entryPriceCents, contracts: 1,
      modelProb: resolved.modelProb,
    });
    if (!feeCheck.allowed) {
      _skipped.push({ sport, matchup, reason: feeCheck.reason });
      return;
    }

    const isHighConviction = resolved.modelProb >= HIGH_CONVICTION_THRESHOLD;
    const isDemoted = DEMOTED_SPORTS.has(sport);
    let contracts = kellyContracts(
      resolved.entryPriceCents,
      resolved.modelProb,
      PAPER_BANKROLL,
      BET_SIZE_DOLLARS,
      MAX_BET_DOLLARS,
    );
    if (contracts === 0) {
      if (isHighConviction) {
        contracts = Math.max(
          1,
          Math.round(BET_SIZE_DOLLARS / (resolved.entryPriceCents / 100)),
        );
      } else {
        _skipped.push({ sport, matchup, reason: 'Kelly returned 0 (no edge)' });
        return;
      }
    }
    if (isDemoted) {
      const floorContracts = Math.max(
        1,
        Math.round(BET_SIZE_DOLLARS / (resolved.entryPriceCents / 100)),
      );
      if (contracts > floorContracts) contracts = floorContracts;
    }

    const req: BetRequest = {
      sport, ticker: resolved.ticker, side: resolved.side,
      priceCents: resolved.entryPriceCents, contracts,
      modelProb: resolved.modelProb,
      reason: `${sport} parlay leg ${originalPick.pickedTeam}`,
    };

    const gameExp = checkGameExposure(req, resolved.pick.gameId, _openPositions, cfg);
    if (!gameExp.allowed) {
      _skipped.push({ sport, matchup, reason: gameExp.reason });
      return;
    }

    const sportDaily = checkPerSportDaily(req, perSportDollars[sport] ?? 0, cfg);
    if (!sportDaily.allowed) {
      _skipped.push({ sport, matchup, reason: sportDaily.reason });
      return;
    }

    const weeklyCheck = checkWeeklyExposure(req, weeklyDollars, cfg);
    if (!weeklyCheck.allowed) {
      _skipped.push({ sport, matchup, reason: weeklyCheck.reason });
      return;
    }

    const decision = await checkBet(req, {
      todayDollarsPlaced: getTodayDollars(),
      openPositions: _openPositions,
      todayRealizedLoss: 0,
      requestLive,
      bypassMinEdge: isHighConviction,
    });
    if (!decision.allowed) {
      _skipped.push({ sport, matchup, reason: decision.reason ?? 'blocked by safety' });
      return;
    }

    const execContracts = decision.cappedContracts ?? contracts;
    const costBasis = (execContracts * resolved.entryPriceCents) / 100;

    if (decision.mode === 'paper') {
      if (!DRY_RUN) recordPaperBet(sport, { ...req, contracts: execContracts });
      _placed.push({
        sport, matchup, pick: originalPick.pickedTeam,
        ticker: resolved.ticker, side: resolved.side,
        priceCents: resolved.entryPriceCents, contracts: execContracts,
        costBasisDollars: costBasis, modelProb: resolved.modelProb, mode: 'paper',
      });
      setTodayDollars(getTodayDollars() + costBasis);
      betsPlaced++;
      perSportDollars[sport] = (perSportDollars[sport] ?? 0) + costBasis;
      weeklyDollars += costBasis;
      log('info', DRY_RUN ? 'parlay leg paper bet (DRY RUN)' : 'parlay leg paper bet recorded', { sport, ticker: resolved.ticker });
    } else {
      try {
        const order = DRY_RUN
          ? { order_id: `dryrun-${Date.now()}` }
          : await placeOrder(resolved.ticker, resolved.side, resolved.entryPriceCents, execContracts);
        if (!DRY_RUN) {
          recordLiveBet({
            sport, ticker: resolved.ticker, side: resolved.side,
            priceCents: resolved.entryPriceCents, contracts: execContracts,
            costBasisDollars: costBasis, modelProb: resolved.modelProb,
            orderId: order.order_id, placedAt: new Date().toISOString(),
          });
        }
        _openPositions.push({
          sport, ticker: resolved.ticker, contracts: execContracts,
          entryPriceCents: resolved.entryPriceCents,
          costBasisDollars: costBasis, currentValueDollars: costBasis,
        });
        setTodayDollars(getTodayDollars() + costBasis);
        betsPlaced++;
        perSportDollars[sport] = (perSportDollars[sport] ?? 0) + costBasis;
      weeklyDollars += costBasis;
        _placed.push({
          sport, matchup, pick: originalPick.pickedTeam,
          ticker: resolved.ticker, side: resolved.side,
          priceCents: resolved.entryPriceCents, contracts: execContracts,
          costBasisDollars: costBasis, modelProb: resolved.modelProb, mode: 'live',
        });
      } catch (err) {
        _skipped.push({ sport, matchup, reason: `order failed: ${String(err)}` });
      }
    }
  }
}

const dateArg = process.argv[2] ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
runBetAction(dateArg).catch((err) => {
  log('error', 'bet action failed', { err: String(err) });
  process.exit(1);
});
