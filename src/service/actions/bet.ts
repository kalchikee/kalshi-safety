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
import { recordPaperBet } from '../../paperTradeGate.js';
import { fetchAllPredictions } from '../predictions.js';
import { getResolver, supportedSports } from '../markets/registry.js';
import { resolveParlayLegs } from '../markets/parlay.js';
import type { ResolvedBet } from '../markets/types.js';
import { placeOrder, PAPER_TRADING, MIN_BALANCE_DOLLARS } from '../kalshiApi.js';
import { checkAccountBalance } from '../balanceCheck.js';
import { recordLiveBet, getOpenLiveBets } from '../liveBets.js';
import { sendBetsPlacedSummary, type PlacedBetDisplay } from '../discord.js';
import { sendSafetyAlert } from '../../alerts.js';
import { checkGameExposure, checkLineAgreement, kellyContracts } from '../../caps.js';
import { loadConfig } from '../../config.js';
import { getPerSportFloor } from '../../calibration.js';

const BET_SIZE_DOLLARS = parseFloat(process.env.KALSHI_BET_SIZE ?? '1');
const DEFAULT_MIN_PROB = parseFloat(process.env.KALSHI_MIN_PROB ?? '0.65');
const MAX_BET_DOLLARS  = parseFloat(process.env.KALSHI_MAX_BET_DOLLARS ?? '10');
// Paper bankroll for Kelly sizing when no live balance is available
const PAPER_BANKROLL   = parseFloat(process.env.KALSHI_PAPER_BANKROLL ?? '100');

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() });
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line);
}

export async function runBetAction(date: string): Promise<void> {
  const mode: 'paper' | 'live' = PAPER_TRADING ? 'paper' : 'live';
  log('info', 'bet action starting', { date, mode });

  // ── Live-only: hard-stop before fetching predictions if balance too low ──
  if (!PAPER_TRADING) {
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

      // Pre-bet line-move check — if the Kalshi ask already reflects the model's
      // view, the edge is gone. Skip rather than bet into a priced-in market.
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

      // Kelly-criterion sizing — scales contracts with edge, capped at quarter-Kelly
      const contracts = kellyContracts(
        resolved.entryPriceCents,
        pick.modelProb,
        PAPER_BANKROLL,
        BET_SIZE_DOLLARS,
        MAX_BET_DOLLARS,
      );
      if (contracts === 0) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: 'Kelly returned 0 (no positive edge at current price)',
        });
        continue;
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
      const cfg = loadConfig();
      const gameExp = checkGameExposure(req, pick.gameId, openPositions, cfg);
      if (!gameExp.allowed) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: gameExp.reason,
        });
        continue;
      }

      const decision = await checkBet(req, {
        todayDollarsPlaced: todayDollars,
        openPositions,
        todayRealizedLoss: 0,
        requestLive: !PAPER_TRADING,
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
        recordPaperBet(file.sport as DryRunSport, { ...req, contracts: execContracts });
        placed.push({
          sport: file.sport, matchup: `${pick.away} @ ${pick.home}`,
          pick: `${pick.pickedTeam} ${resolved.side.toUpperCase()}`,
          ticker: resolved.ticker, side: resolved.side,
          priceCents: resolved.entryPriceCents, contracts: execContracts,
          costBasisDollars: costBasis, modelProb: pick.modelProb, mode: 'paper',
        });
        todayDollars += costBasis;
        log('info', 'paper bet recorded', { sport: file.sport, ticker: resolved.ticker, contracts: execContracts });
        continue;
      }

      // LIVE path
      try {
        const order = await placeOrder(resolved.ticker, resolved.side, resolved.entryPriceCents, execContracts);
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
        openPositions.push({
          sport: file.sport as DryRunSport,
          ticker: resolved.ticker,
          contracts: execContracts,
          entryPriceCents: resolved.entryPriceCents,
          costBasisDollars: costBasis,
          currentValueDollars: costBasis,
        });
        todayDollars += costBasis;
        placed.push({
          sport: file.sport, matchup: `${pick.away} @ ${pick.home}`,
          pick: `${pick.pickedTeam} ${resolved.side.toUpperCase()}`,
          ticker: resolved.ticker, side: resolved.side,
          priceCents: resolved.entryPriceCents, contracts: execContracts,
          costBasisDollars: costBasis, modelProb: pick.modelProb, mode: 'live',
        });
        log('info', 'live bet placed', { sport: file.sport, ticker: resolved.ticker, orderId: order.order_id });
      } catch (err) {
        skipped.push({
          sport: file.sport, matchup: `${pick.away} @ ${pick.home}`,
          reason: `order failed: ${String(err)}`,
        });
        log('error', 'placeOrder failed', { sport: file.sport, ticker: resolved.ticker, err: String(err) });
      }
    }
  }

  await sendBetsPlacedSummary(date, placed, skipped, mode);
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

    const contracts = kellyContracts(
      resolved.entryPriceCents,
      resolved.modelProb,
      PAPER_BANKROLL,
      BET_SIZE_DOLLARS,
      MAX_BET_DOLLARS,
    );
    if (contracts === 0) {
      _skipped.push({ sport, matchup, reason: 'Kelly returned 0 (no edge)' });
      return;
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

    const decision = await checkBet(req, {
      todayDollarsPlaced: getTodayDollars(),
      openPositions: _openPositions,
      todayRealizedLoss: 0,
      requestLive: !PAPER_TRADING,
    });
    if (!decision.allowed) {
      _skipped.push({ sport, matchup, reason: decision.reason ?? 'blocked by safety' });
      return;
    }

    const execContracts = decision.cappedContracts ?? contracts;
    const costBasis = (execContracts * resolved.entryPriceCents) / 100;

    if (decision.mode === 'paper') {
      recordPaperBet(sport, { ...req, contracts: execContracts });
      _placed.push({
        sport, matchup, pick: `${originalPick.pickedTeam} ${resolved.side.toUpperCase()}`,
        ticker: resolved.ticker, side: resolved.side,
        priceCents: resolved.entryPriceCents, contracts: execContracts,
        costBasisDollars: costBasis, modelProb: resolved.modelProb, mode: 'paper',
      });
      setTodayDollars(getTodayDollars() + costBasis);
      log('info', 'parlay leg paper bet recorded', { sport, ticker: resolved.ticker });
    } else {
      try {
        const order = await placeOrder(resolved.ticker, resolved.side, resolved.entryPriceCents, execContracts);
        recordLiveBet({
          sport, ticker: resolved.ticker, side: resolved.side,
          priceCents: resolved.entryPriceCents, contracts: execContracts,
          costBasisDollars: costBasis, modelProb: resolved.modelProb,
          orderId: order.order_id, placedAt: new Date().toISOString(),
        });
        _openPositions.push({
          sport, ticker: resolved.ticker, contracts: execContracts,
          entryPriceCents: resolved.entryPriceCents,
          costBasisDollars: costBasis, currentValueDollars: costBasis,
        });
        setTodayDollars(getTodayDollars() + costBasis);
        _placed.push({
          sport, matchup, pick: `${originalPick.pickedTeam} ${resolved.side.toUpperCase()}`,
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
