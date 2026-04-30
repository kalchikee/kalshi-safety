// Position monitor — scans open positions for 20% stop-losses
// and 50% take-profits. Runs every 2 minutes for a fixed shift duration
// (default 5 hours). Three shifts per day cover 1 PM – 4 AM ET; see
// monitor.yml. Owns both paper and live stop-loss / take-profit execution.

import 'dotenv/config';
import { getMarket, sellPosition, PAPER_TRADING } from '../kalshiApi.js';
import { triggerPaperStopLoss } from '../../stopLoss.js';
import { triggerPaperTakeProfit } from '../../takeProfit.js';
import { loadPaperState, setPaperBetClosingProb } from '../../paperTradeGate.js';
import { getOpenLiveBets, updateLiveBet } from '../liveBets.js';
import { HARD_LIMITS } from '../../config.js';
import { sendStopLossAlert } from '../discord.js';
import { DRY_RUN_SPORTS } from '../../allSports.js';

const INTERVAL_MS = parseInt(process.env.KALSHI_MONITOR_INTERVAL_MS ?? '120000', 10);

// Duration-based exit. Replaces the old MONITOR_EXIT_HOUR check, which had a
// midnight wraparound bug: for the late-night shift starting at 11 PM ET
// with EXIT_HOUR=4 (4 AM ET next day), `currentHour >= EXIT_HOUR` would be
// `23 >= 4 = true` and the monitor would exit immediately. Computing a
// target timestamp at start eliminates timezone math entirely.
const SHIFT_DURATION_MINUTES = parseInt(process.env.MONITOR_DURATION_MINUTES ?? '300', 10);
const SHIFT_START_MS = Date.now();
const SHIFT_EXIT_MS = SHIFT_START_MS + SHIFT_DURATION_MINUTES * 60 * 1000;

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(
    JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }),
  );
}

function shouldExit(): boolean {
  return Date.now() >= SHIFT_EXIT_MS;
}

async function scanPaperStopLosses(): Promise<void> {
  for (const sport of DRY_RUN_SPORTS) {
    const state = loadPaperState(sport);
    const open = state.bets.filter((b) => !b.settledAt);
    for (const bet of open) {
      try {
        const market = await getMarket(bet.ticker);
        if (!market) continue;

        // CLV tracking: record the current market mid for OUR side. The
        // last value written here before the market settles = our closing
        // line. (Once the market is finalized, this stops getting updated
        // because the bet transitions to settledAt and the setter ignores
        // settled bets.)
        const ourBid = bet.side === 'yes' ? market.yes_bid : market.no_bid;
        const ourAsk = bet.side === 'yes' ? market.yes_ask : market.no_ask;
        if (ourBid > 0 && ourAsk > 0 && ourAsk < 100) {
          const midProb = (ourBid + ourAsk) / 2 / 100;
          setPaperBetClosingProb(sport, bet.ticker, midProb);
        }

        // triggerPaperStopLoss and triggerPaperTakeProfit both take the YES-side
        // price and internally invert for NO bets. Only one fires per tick: if
        // stop-loss settles the bet, the take-profit call finds no open bet.
        const yesPrice = market.yes_bid;
        if (yesPrice <= 0 || yesPrice >= 100) continue;
        await triggerPaperStopLoss(sport, bet.ticker, yesPrice);
        await triggerPaperTakeProfit(sport, bet.ticker, yesPrice);
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

      // CLV tracking: record current mid for OUR side onto the live bet.
      const ourAsk = bet.side === 'yes' ? market.yes_ask : market.no_ask;
      if (ourAsk > 0 && ourAsk < 100) {
        const midProb = (currentBid + ourAsk) / 2 / 100;
        if (Number.isFinite(midProb) && midProb > 0 && midProb < 1) {
          updateLiveBet(bet.ticker, { closingMarketProb: midProb });
        }
      }

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
      } else if (pctChange >= HARD_LIMITS.HARD_TAKE_PROFIT_PCT) {
        // Take-profit: sell at current bid, lock the gain
        await sellPosition(bet.ticker, bet.side, bet.contracts, currentBid);
        const pnl = currentValue - bet.costBasisDollars;
        updateLiveBet(bet.ticker, {
          settledAt: new Date().toISOString(),
          outcome: 'win',
          exitPriceCents: currentBid,
          pnlDollars: pnl,
        });
        log('info', 'live take-profit triggered', {
          sport: bet.sport, ticker: bet.ticker, pctChange: (pctChange * 100).toFixed(1) + '%',
        });
      }
    } catch (err) {
      log('error', 'live monitor check failed', { ticker: bet.ticker, err: String(err) });
    }
  }
}

export async function runMonitor(): Promise<void> {
  log('info', 'monitor starting', {
    interval: INTERVAL_MS,
    durationMinutes: SHIFT_DURATION_MINUTES,
    exitAt: new Date(SHIFT_EXIT_MS).toISOString(),
    paper: PAPER_TRADING,
  });

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
