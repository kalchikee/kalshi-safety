// Position monitor — scans open positions for 20% stop-losses.
// Runs every 2 minutes in two shifts (see monitor.yml).
// Owns both paper and live stop-loss execution.

import 'dotenv/config';
import { getMarket, sellPosition, PAPER_TRADING } from '../kalshiApi.js';
import { triggerPaperStopLoss } from '../../stopLoss.js';
import { loadPaperState } from '../../paperTradeGate.js';
import { getOpenLiveBets, updateLiveBet } from '../liveBets.js';
import { HARD_LIMITS } from '../../config.js';
import { sendStopLossAlert } from '../discord.js';
import { DRY_RUN_SPORTS } from '../../allSports.js';

const INTERVAL_MS = parseInt(process.env.KALSHI_MONITOR_INTERVAL_MS ?? '120000', 10);
const EXIT_HOUR = parseInt(process.env.MONITOR_EXIT_HOUR ?? '23', 10);

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(
    JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }),
  );
}

function shouldExit(): boolean {
  const nowET = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', hour12: false,
  });
  const hour = parseInt(nowET, 10);
  return hour >= EXIT_HOUR;
}

async function scanPaperStopLosses(): Promise<void> {
  for (const sport of DRY_RUN_SPORTS) {
    const state = loadPaperState(sport);
    const open = state.bets.filter((b) => !b.settledAt);
    for (const bet of open) {
      try {
        const market = await getMarket(bet.ticker);
        if (!market) continue;
        // triggerPaperStopLoss takes the YES-side price and internally inverts for NO bets
        const yesPrice = market.yes_bid;
        if (yesPrice <= 0 || yesPrice >= 100) continue;
        await triggerPaperStopLoss(sport, bet.ticker, yesPrice);
      } catch (err) {
        log('error', 'paper monitor check failed', { sport, ticker: bet.ticker, err: String(err) });
      }
    }
  }
}

async function scanLiveStopLosses(): Promise<void> {
  const open = getOpenLiveBets();
  for (const bet of open) {
    try {
      const market = await getMarket(bet.ticker);
      if (!market) continue;
      const currentBid = bet.side === 'yes' ? market.yes_bid : market.no_bid;
      if (!currentBid || currentBid <= 0) continue;

      const currentValue = currentBid * bet.contracts / 100;
      const pctChange = (currentValue - bet.costBasisDollars) / bet.costBasisDollars;

      if (pctChange <= -HARD_LIMITS.HARD_STOP_LOSS_PCT) {
        await sellPosition(bet.ticker, bet.side, bet.contracts, currentBid);
        const pnl = currentValue - bet.costBasisDollars;
        updateLiveBet(bet.ticker, {
          settledAt: new Date().toISOString(),
          outcome: 'stopped',
          exitPriceCents: currentBid,
          pnlDollars: pnl,
        });
        await sendStopLossAlert({
          sport: bet.sport, ticker: bet.ticker, side: bet.side,
          entryPriceCents: bet.priceCents, currentPriceCents: currentBid,
          pctChange, pnlDollars: pnl,
        }, 'live');
        log('warn', 'live stop-loss triggered', {
          sport: bet.sport, ticker: bet.ticker, pctChange: (pctChange * 100).toFixed(1) + '%',
        });
      }
    } catch (err) {
      log('error', 'live monitor check failed', { ticker: bet.ticker, err: String(err) });
    }
  }
}

export async function runMonitor(): Promise<void> {
  log('info', 'monitor starting', { interval: INTERVAL_MS, exitHour: EXIT_HOUR, paper: PAPER_TRADING });

  while (!shouldExit()) {
    try {
      if (PAPER_TRADING) {
        await scanPaperStopLosses();
      } else {
        await scanLiveStopLosses();
      }
    } catch (err) {
      log('error', 'monitor loop error', { err: String(err) });
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  log('info', 'monitor exiting (shift end)');
}

runMonitor().catch((err) => {
  log('error', 'monitor failed', { err: String(err) });
  process.exit(1);
});
