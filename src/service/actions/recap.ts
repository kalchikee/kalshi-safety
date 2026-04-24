// Daily recap — runs at 4 AM CST (10 UTC) the morning after games finished.
// Settles any open markets that resolved overnight, then posts the recap
// Discord message summarizing all bets placed for the prior date.

import 'dotenv/config';
import { getMarket, PAPER_TRADING } from '../kalshiApi.js';
import { loadPaperState, settlePaperBet } from '../../paperTradeGate.js';
import { DRY_RUN_SPORTS } from '../../allSports.js';
import { loadLiveState, saveLiveState } from '../liveBets.js';
import { sendRecap, type RecapBet } from '../discord.js';
import { sendAggregateDailySummary } from '../../dailySummary.js';
import { appendEquityPoint, loadEquity, renderSparkline, checkDrawdown } from '../../equityCurve.js';

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(
    JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }),
  );
}

/** The "recap date" — games played yesterday, since we run at 4 AM CST. */
function recapDate(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 12); // 4 AM CST ≈ 10 UTC → 12h back lands squarely on prior day
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function settleOpenPaperBets(date: string): Promise<RecapBet[]> {
  const out: RecapBet[] = [];
  for (const sport of DRY_RUN_SPORTS) {
    const state = loadPaperState(sport);
    for (const bet of state.bets) {
      if (bet.settledAt) {
        // Include any bet settled in the last 36h (covers the window between
        // last recap and now). We can't filter precisely on date because the
        // settlement date lives in the Kalshi market's UTC timestamp.
        const settledAge = Date.now() - new Date(bet.settledAt).getTime();
        if (settledAge > 36 * 3600 * 1000) continue;
        // A 'loss' with P&L less negative than full cost means a stop-loss exit
        const fullLoss = -(bet.priceCents * bet.contracts / 100);
        const stopped = bet.outcome === 'loss' && (bet.pnlDollars ?? 0) > fullLoss + 0.01;
        out.push({
          sport,
          matchup: bet.ticker,
          pick: `${bet.side.toUpperCase()} @ ${bet.priceCents}¢ ×${bet.contracts}`,
          outcome: bet.outcome === 'win' ? 'win' : stopped ? 'stopped' : 'loss',
          pnlDollars: bet.pnlDollars ?? 0,
        });
        continue;
      }
      if (bet.settledAt) continue;
      // Not yet settled — try to settle if market finalized
      try {
        const market = await getMarket(bet.ticker);
        if (!market) continue;
        if (market.status === 'finalized' || market.result) {
          const won =
            (market.result === 'yes' && bet.side === 'yes') ||
            (market.result === 'no' && bet.side === 'no');
          settlePaperBet(sport, bet.ticker, won ? 'win' : 'loss');
          const entry = bet.priceCents * bet.contracts / 100;
          const payout = won ? bet.contracts : 0;
          out.push({
            sport,
            matchup: bet.ticker,
            pick: `${bet.side.toUpperCase()} @ ${bet.priceCents}¢ ×${bet.contracts}`,
            outcome: won ? 'win' : 'loss',
            pnlDollars: payout - entry,
          });
        }
      } catch (err) {
        log('warn', 'paper settle fetch failed', { sport, ticker: bet.ticker, err: String(err) });
      }
    }
  }
  return out;
}

async function settleOpenLiveBets(date: string): Promise<RecapBet[]> {
  const out: RecapBet[] = [];
  const state = loadLiveState();
  for (const bet of state.bets) {
    if (bet.settledAt) {
      if (bet.settledAt.startsWith(date)) {
        out.push({
          sport: bet.sport,
          matchup: bet.ticker,
          pick: `${bet.side.toUpperCase()} @ ${bet.priceCents}¢ ×${bet.contracts}`,
          outcome: bet.outcome ?? 'loss',
          pnlDollars: bet.pnlDollars ?? 0,
        });
      }
      continue;
    }
    try {
      const market = await getMarket(bet.ticker);
      if (!market) continue;
      if (market.status === 'finalized' || market.result) {
        const won =
          (market.result === 'yes' && bet.side === 'yes') ||
          (market.result === 'no' && bet.side === 'no');
        const payout = won ? bet.contracts : 0;
        const pnl = payout - bet.costBasisDollars;
        bet.settledAt = new Date().toISOString();
        bet.outcome = won ? 'win' : 'loss';
        bet.pnlDollars = pnl;
        out.push({
          sport: bet.sport,
          matchup: bet.ticker,
          pick: `${bet.side.toUpperCase()} @ ${bet.priceCents}¢ ×${bet.contracts}`,
          outcome: won ? 'win' : 'loss',
          pnlDollars: pnl,
        });
      }
    } catch (err) {
      log('warn', 'live settle fetch failed', { ticker: bet.ticker, err: String(err) });
    }
  }
  saveLiveState(state);
  return out;
}

export async function runRecap(date: string): Promise<void> {
  const mode: 'paper' | 'live' = PAPER_TRADING ? 'paper' : 'live';
  log('info', 'recap starting', { date, mode });

  const bets = PAPER_TRADING ? await settleOpenPaperBets(date) : await settleOpenLiveBets(date);

  // Snapshot equity curve after settlements land
  const point = appendEquityPoint(date);
  const series = loadEquity();
  const equity = {
    cumulativePnl: point.cumulativePnl,
    todaysPnl: point.todaysPnl,
    totalSettledBets: point.totalSettledBets,
    sparkline: renderSparkline(series.points),
    days: series.points.length,
  };

  // Fire a separate drawdown alert if we've dropped ≥ threshold from peak
  try {
    await checkDrawdown(series);
  } catch (err) {
    log('warn', 'drawdown check failed', { err: String(err) });
  }

  await sendRecap(date, bets, mode, equity);
  // Also post the paper-only aggregate summary (30-day dry run W/L across all sports).
  if (PAPER_TRADING) {
    try {
      await sendAggregateDailySummary([...DRY_RUN_SPORTS], { date });
    } catch (err) {
      log('warn', 'aggregate dry-run summary failed', { err: String(err) });
    }
  }

  log('info', 'recap complete', { date, bets: bets.length });
}

const arg = process.argv[2] ?? recapDate();
runRecap(arg).catch((err) => {
  log('error', 'recap failed', { err: String(err) });
  process.exit(1);
});
