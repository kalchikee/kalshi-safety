// $5 cash-balance kill switch for live mode.
// Paper mode skips this check — there is no real balance to deplete.

import { getBalance, MIN_BALANCE_DOLLARS, PAPER_TRADING } from './kalshiApi.js';

export interface BalanceCheckResult {
  ok: boolean;
  balanceDollars: number;
  reason?: string;
}

export async function checkAccountBalance(): Promise<BalanceCheckResult> {
  if (PAPER_TRADING) {
    return { ok: true, balanceDollars: Number.POSITIVE_INFINITY };
  }
  try {
    const bal = await getBalance();
    const dollars = bal.balance / 100;
    if (dollars <= MIN_BALANCE_DOLLARS) {
      return {
        ok: false,
        balanceDollars: dollars,
        reason: `account balance $${dollars.toFixed(2)} ≤ $${MIN_BALANCE_DOLLARS.toFixed(2)} minimum — bets halted`,
      };
    }
    return { ok: true, balanceDollars: dollars };
  } catch (err) {
    return {
      ok: false,
      balanceDollars: 0,
      reason: `balance fetch failed: ${String(err)} — bets halted (fail-closed)`,
    };
  }
}
