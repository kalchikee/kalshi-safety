import type { PaperBetRecord } from './paperTradeGate.js';
import { loadPaperState, settlePaperBet } from './paperTradeGate.js';
import { HARD_LIMITS } from './config.js';
import { sendSafetyAlert } from './alerts.js';

export interface StopLossCheckResult {
  triggered: boolean;
  costBasisDollars: number;
  currentValueDollars: number;
  pctChange: number;         // negative = losing
  reason: string;
}

/** Check a single paper bet against the stop-loss threshold given the
 *  current market YES price for the ticker.
 *
 *  Math (YES side):
 *    cost_basis = priceCents/100 × contracts
 *    current_value = currentPriceCents/100 × contracts
 *    pct_change = (current_value - cost_basis) / cost_basis
 *    triggered when pct_change <= -HARD_STOP_LOSS_PCT
 *
 *  For NO-side bets, we invert: cost_basis uses priceCents directly
 *  (what we paid per NO contract), current_value uses (100 - currentPriceCents)/100. */
export function checkStopLoss(
  bet: PaperBetRecord,
  currentYesPriceCents: number,
  stopLossPct: number = HARD_LIMITS.HARD_STOP_LOSS_PCT,
): StopLossCheckResult {
  if (bet.settledAt) {
    return {
      triggered: false, costBasisDollars: 0, currentValueDollars: 0, pctChange: 0,
      reason: 'bet already settled',
    };
  }
  if (currentYesPriceCents < 0 || currentYesPriceCents > 100) {
    return {
      triggered: false, costBasisDollars: 0, currentValueDollars: 0, pctChange: 0,
      reason: `invalid market price: ${currentYesPriceCents}`,
    };
  }

  const costPerContract = bet.priceCents / 100;
  const costBasis = costPerContract * bet.contracts;

  // Current mark-to-market value of OUR position
  //   YES bet: current value = currentYesPriceCents
  //   NO bet:  current value = 100 - currentYesPriceCents (market price of NO)
  const effectivePriceCents = bet.side === 'yes'
    ? currentYesPriceCents
    : 100 - currentYesPriceCents;
  const currentValue = (effectivePriceCents / 100) * bet.contracts;

  const pctChange = (currentValue - costBasis) / costBasis;
  const triggered = pctChange <= -Math.abs(stopLossPct);

  return {
    triggered,
    costBasisDollars: Math.round(costBasis * 100) / 100,
    currentValueDollars: Math.round(currentValue * 100) / 100,
    pctChange: Math.round(pctChange * 10000) / 10000,
    reason: triggered
      ? `stop-loss triggered: ${(pctChange * 100).toFixed(1)}% below entry (threshold: -${(stopLossPct * 100).toFixed(0)}%)`
      : `within stop-loss: ${(pctChange * 100).toFixed(1)}%`,
  };
}

/** If a paper bet has hit the stop-loss threshold, settle it at the current
 *  mark-to-market with a 'loss' outcome and alert to Discord. Returns the
 *  settled record if triggered, null otherwise. */
export async function triggerPaperStopLoss(
  sport: string,
  ticker: string,
  currentYesPriceCents: number,
  stopLossPct: number = HARD_LIMITS.HARD_STOP_LOSS_PCT,
  dir?: string,
): Promise<PaperBetRecord | null> {
  const state = loadPaperState(sport, dir);
  const bet = [...state.bets].reverse().find(b => b.ticker === ticker && !b.settledAt);
  if (!bet) return null;

  const check = checkStopLoss(bet, currentYesPriceCents, stopLossPct);
  if (!check.triggered) return null;

  // Partial loss = currentValue - costBasis (negative number)
  const partialPnl = check.currentValueDollars - check.costBasisDollars;
  const settled = settlePaperBet(sport, ticker, 'loss', dir, partialPnl);

  if (settled) {
    await sendSafetyAlert({
      title: 'Paper stop-loss triggered',
      description: `Auto-exit on ${ticker} — ${check.reason}`,
      color: 0xE67E22,
      fields: [
        { name: 'Cost basis', value: `$${check.costBasisDollars.toFixed(2)}`, inline: true },
        { name: 'Current value', value: `$${check.currentValueDollars.toFixed(2)}`, inline: true },
        { name: 'Paper loss', value: `$${partialPnl.toFixed(2)}`, inline: true },
        { name: 'Contracts', value: String(bet.contracts), inline: true },
        { name: 'Entry price', value: `${bet.priceCents}¢`, inline: true },
        { name: 'Exit price', value: `${currentYesPriceCents}¢`, inline: true },
      ],
      sport,
    });
  }
  return settled;
}

/** Batch-check all open paper bets for a sport. Caller supplies a price
 *  map { ticker: currentYesPriceCents }. Returns stop-loss triggers. */
export async function scanForPaperStopLosses(
  sport: string,
  currentPriceMap: Record<string, number>,
  stopLossPct: number = HARD_LIMITS.HARD_STOP_LOSS_PCT,
  dir?: string,
): Promise<PaperBetRecord[]> {
  const state = loadPaperState(sport, dir);
  const openBets = state.bets.filter(b => !b.settledAt);
  const triggered: PaperBetRecord[] = [];

  for (const bet of openBets) {
    const price = currentPriceMap[bet.ticker];
    if (price === undefined) continue;  // no price data — skip
    const settled = await triggerPaperStopLoss(sport, bet.ticker, price, stopLossPct, dir);
    if (settled) triggered.push(settled);
  }
  return triggered;
}
