import { getDailySummary, getDryRunDuration, loadPaperState, type DailySummary } from './paperTradeGate.js';
import { sendSafetyAlert } from './alerts.js';

/** Returns yesterday's date in YYYY-MM-DD UTC format. */
export function yesterdayUTC(now = new Date()): string {
  const y = new Date(now.getTime() - 86400000);
  return y.toISOString().slice(0, 10);
}

/** Builds a human-readable summary of yesterday's paper results for one sport.
 *  Returns null if the sport has no bets settled on that date (caller can
 *  decide whether to send a "no activity" note or skip). */
export function buildSummary(
  sport: string,
  date: string,
  dir?: string,
): {
  summary: DailySummary;
  durationDays: number;
  state: { totalBets: number; liveActive: boolean };
} {
  const summary = getDailySummary(sport, date, dir);
  const durationDays = getDryRunDuration(sport, dir);
  const state = loadPaperState(sport, dir);
  return {
    summary,
    durationDays,
    state: {
      totalBets: state.bets.length,
      liveActive: !!state.liveActivatedIso,
    },
  };
}

/** Sends yesterday's dry-run summary to Discord. Safe to call daily via cron.
 *  Always sends — "No bets settled yesterday" is still useful signal. */
export async function sendDailyDryRunSummary(
  sport: string,
  opts: { date?: string; dir?: string } = {},
): Promise<boolean> {
  const date = opts.date ?? yesterdayUTC();
  const { summary, durationDays, state } = buildSummary(sport, date, opts.dir);

  const totalGraded = summary.wins + summary.losses;
  const accPct = totalGraded > 0 ? (summary.accuracy * 100).toFixed(1) + '%' : '—';
  const pnlStr = summary.pnlDollars >= 0
    ? `+$${summary.pnlDollars.toFixed(2)}`
    : `−$${Math.abs(summary.pnlDollars).toFixed(2)}`;

  const pnlColor = summary.pnlDollars > 0 ? 0x2ECC71
                 : summary.pnlDollars < 0 ? 0xE74C3C
                 : 0x95A5A6;

  const modeLine = state.liveActive
    ? '🟢 Live mode active'
    : '🧪 Paper mode (no real bets)';

  const fields = [
    { name: 'Yesterday W–L', value: `**${summary.wins}–${summary.losses}${summary.pushes > 0 ? ` (${summary.pushes} push)` : ''}**`, inline: true },
    { name: 'Accuracy', value: accPct, inline: true },
    { name: 'Paper P&L', value: pnlStr, inline: true },
    { name: 'Bets settled', value: String(summary.total), inline: true },
    { name: 'Dry-run duration', value: `${durationDays.toFixed(1)} days`, inline: true },
    { name: 'Total paper bets', value: String(state.totalBets), inline: true },
  ];

  return sendSafetyAlert({
    title: `Kalshi Safety daily summary — ${sport} — ${date}`,
    description: `${modeLine}\n\nAll bets shown below are **paper / dry-run**. No real money is at risk until the 30-day paper period completes and live mode is explicitly activated.`,
    color: pnlColor,
    fields,
    sport,
  });
}

/** Convenience: send a summary for every sport that has a paper state file.
 *  Useful for one nightly cron across all sports. */
export async function sendAllDailyDryRunSummaries(
  sports: string[],
  opts: { date?: string; dir?: string } = {},
): Promise<{ sport: string; sent: boolean }[]> {
  const results: { sport: string; sent: boolean }[] = [];
  for (const sport of sports) {
    const sent = await sendDailyDryRunSummary(sport, opts);
    results.push({ sport, sent });
  }
  return results;
}
