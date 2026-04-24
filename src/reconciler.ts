import type { Position } from './types.js';
import { sendSafetyAlert } from './alerts.js';

export interface ReconcileResult {
  matched: boolean;
  onlyInExpected: Position[];    // DB thinks we have these, but Kalshi doesn't
  onlyInActual: Position[];      // Kalshi has these, but DB doesn't know
  mismatchedContracts: Array<{ expected: Position; actual: Position }>;
  mismatchedValue: number;       // total $ divergence
}

/** Compares the sport module's DB state ("expected") with Kalshi's
 *  authoritative positions ("actual"). Used by a reconciliation cron job
 *  or by the bet engine as a pre-flight sanity check before sizing. */
export function reconcile(
  expected: Position[],
  actual: Position[],
): ReconcileResult {
  const expMap = new Map(expected.map(p => [p.ticker, p]));
  const actMap = new Map(actual.map(p => [p.ticker, p]));

  const onlyInExpected: Position[] = [];
  const onlyInActual: Position[] = [];
  const mismatched: ReconcileResult['mismatchedContracts'] = [];
  let mismatchedValue = 0;

  for (const [ticker, exp] of expMap) {
    const act = actMap.get(ticker);
    if (!act) {
      onlyInExpected.push(exp);
      mismatchedValue += Math.abs(exp.currentValueDollars);
    } else if (act.contracts !== exp.contracts) {
      mismatched.push({ expected: exp, actual: act });
      mismatchedValue += Math.abs(exp.currentValueDollars - act.currentValueDollars);
    }
  }
  for (const [ticker, act] of actMap) {
    if (!expMap.has(ticker)) {
      onlyInActual.push(act);
      mismatchedValue += Math.abs(act.currentValueDollars);
    }
  }

  return {
    matched: onlyInExpected.length === 0 && onlyInActual.length === 0 && mismatched.length === 0,
    onlyInExpected,
    onlyInActual,
    mismatchedContracts: mismatched,
    mismatchedValue,
  };
}

/** Alerts to Discord if reconciliation fails. Use as a post-hook on
 *  reconciliation runs. Tolerance = $ amount of divergence to ignore
 *  (for rounding / pending fills). */
export async function alertOnMismatch(
  sport: string,
  result: ReconcileResult,
  tolerance = 1.0,
): Promise<void> {
  if (result.matched || result.mismatchedValue < tolerance) return;

  const fields = [
    { name: 'Total divergence', value: `$${result.mismatchedValue.toFixed(2)}`, inline: true },
    { name: 'DB-only positions', value: String(result.onlyInExpected.length), inline: true },
    { name: 'Kalshi-only positions', value: String(result.onlyInActual.length), inline: true },
  ];
  if (result.onlyInExpected.length > 0) {
    fields.push({
      name: 'Positions in DB but not Kalshi',
      value: result.onlyInExpected.slice(0, 5).map(p => `${p.ticker} x${p.contracts}`).join('\n') || '—',
      inline: false,
    });
  }
  if (result.onlyInActual.length > 0) {
    fields.push({
      name: 'Positions in Kalshi but not DB',
      value: result.onlyInActual.slice(0, 5).map(p => `${p.ticker} x${p.contracts}`).join('\n') || '—',
      inline: false,
    });
  }
  await sendSafetyAlert({
    title: `Position reconciliation mismatch — ${sport}`,
    description: 'DB state and Kalshi state have diverged. Halt new bets until reconciled.',
    fields,
    sport,
  });
}
