// Mirror of stopLoss.ts but for the upside: auto-close when a position
// has gained enough that the reward:risk ratio to holding has flipped.

import type { PaperBetRecord } from './paperTradeGate.js';
import { loadPaperState, settlePaperBet } from './paperTradeGate.js';
import { HARD_LIMITS } from './config.js';
import { sendSafetyAlert } from './alerts.js';

export interface TakeProfitCheckResult {
  triggered: boolean;
  costBasisDollars: number;
  currentValueDollars: number;
  pctChange: number;
  reason: string;
}

export function checkTakeProfit(
  bet: PaperBetRecord,
  currentYesPriceCents: number,
  takeProfitPct: number = HARD_LIMITS.HARD_TAKE_PROFIT_PCT,
): TakeProfitCheckResult {
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
  const costBasis = (bet.priceCents / 100) * bet.contracts;
  const effectivePriceCents =
    bet.side === 'yes' ? currentYesPriceCents : 100 - currentYesPriceCents;
  const currentValue = (effectivePriceCents / 100) * bet.contracts;
  const pctChange = (currentValue - costBasis) / costBasis;
  const triggered = pctChange >= Math.abs(takeProfitPct);
  return {
    triggered,
    costBasisDollars: Math.round(costBasis * 100) / 100,
    currentValueDollars: Math.round(currentValue * 100) / 100,
    pctChange: Math.round(pctChange * 10000) / 10000,
    reason: triggered
      ? `take-profit triggered: +${(pctChange * 100).toFixed(1)}% above entry (threshold: +${(takeProfitPct * 100).toFixed(0)}%)`
      : `within take-profit window: ${(pctChange * 100).toFixed(1)}%`,
  };
}

export async function triggerPaperTakeProfit(
  sport: string,
  ticker: string,
  currentYesPriceCents: number,
  takeProfitPct: number = HARD_LIMITS.HARD_TAKE_PROFIT_PCT,
  dir?: string,
): Promise<PaperBetRecord | null> {
  const state = loadPaperState(sport, dir);
  const bet = [...state.bets].reverse().find((b) => b.ticker === ticker && !b.settledAt);
  if (!bet) return null;

  const check = checkTakeProfit(bet, currentYesPriceCents, takeProfitPct);
  if (!check.triggered) return null;

  // Lock partial gain as a WIN with explicit P&L (not waiting for settlement)
  const partialPnl = check.currentValueDollars - check.costBasisDollars;
  const settled = settlePaperBet(sport, ticker, 'win', dir, partialPnl);

  if (settled) {
    await sendSafetyAlert({
      title: 'Paper take-profit triggered',
      description: `Locked gains on ${ticker} — ${check.reason}`,
      color: 0x2ecc71,
      fields: [
        { name: 'Cost basis', value: `$${check.costBasisDollars.toFixed(2)}`, inline: true },
        { name: 'Current value', value: `$${check.currentValueDollars.toFixed(2)}`, inline: true },
        { name: 'Paper gain', value: `+$${partialPnl.toFixed(2)}`, inline: true },
        { name: 'Contracts', value: String(bet.contracts), inline: true },
        { name: 'Entry price', value: `${bet.priceCents}¢`, inline: true },
        { name: 'Exit price', value: `${currentYesPriceCents}¢`, inline: true },
      ],
      sport,
    });
  }
  return settled;
}

export async function scanForPaperTakeProfits(
  sport: string,
  currentPriceMap: Record<string, number>,
  takeProfitPct: number = HARD_LIMITS.HARD_TAKE_PROFIT_PCT,
  dir?: string,
): Promise<PaperBetRecord[]> {
  const state = loadPaperState(sport, dir);
  const openBets = state.bets.filter((b) => !b.settledAt);
  const triggered: PaperBetRecord[] = [];
  for (const bet of openBets) {
    const price = currentPriceMap[bet.ticker];
    if (price === undefined) continue;
    const settled = await triggerPaperTakeProfit(sport, bet.ticker, price, takeProfitPct, dir);
    if (settled) triggered.push(settled);
  }
  return triggered;
}
