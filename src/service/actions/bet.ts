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
import { placeOrder, PAPER_TRADING, MIN_BALANCE_DOLLARS } from '../kalshiApi.js';
import { checkAccountBalance } from '../balanceCheck.js';
import { recordLiveBet, getOpenLiveBets } from '../liveBets.js';
import { sendBetsPlacedSummary, type PlacedBetDisplay } from '../discord.js';

const BET_SIZE_DOLLARS = parseFloat(process.env.KALSHI_BET_SIZE ?? '1');
const MIN_MODEL_PROB   = parseFloat(process.env.KALSHI_MIN_PROB ?? '0.65');
const MAX_BET_DOLLARS  = parseFloat(process.env.KALSHI_MAX_BET_DOLLARS ?? '10');

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

    if (markets.size === 0) {
      for (const pick of file.picks) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: 'no Kalshi markets found',
        });
      }
      continue;
    }

    for (const pick of file.picks) {
      if (pick.modelProb < MIN_MODEL_PROB) {
        skipped.push({
          sport: file.sport,
          matchup: `${pick.away} @ ${pick.home}`,
          reason: `modelProb ${(pick.modelProb * 100).toFixed(1)}% < ${(MIN_MODEL_PROB * 100).toFixed(0)}% floor`,
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

      // Kelly-lite sizing: floor at BET_SIZE_DOLLARS, capped at MAX_BET_DOLLARS.
      const contracts = Math.max(
        1,
        Math.round(Math.min(MAX_BET_DOLLARS, BET_SIZE_DOLLARS) / (resolved.entryPriceCents / 100)),
      );

      const req: BetRequest = {
        sport: file.sport as DryRunSport,
        ticker: resolved.ticker,
        side: resolved.side,
        priceCents: resolved.entryPriceCents,
        contracts,
        modelProb: pick.modelProb,
        reason: `${file.sport} pick ${pick.pickedTeam} @ ${(pick.modelProb * 100).toFixed(1)}%`,
      };

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
}

const dateArg = process.argv[2] ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
runBetAction(dateArg).catch((err) => {
  log('error', 'bet action failed', { err: String(err) });
  process.exit(1);
});
