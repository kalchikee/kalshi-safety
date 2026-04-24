import type { BetRequest, Position, SafetyDecision } from './types.js';
import { loadConfig, HARD_LIMITS } from './config.js';
import { isKillSwitchActive } from './killSwitch.js';
import { loadPaperState, recordPaperBet, isLiveEligible, activateLive } from './paperTradeGate.js';
import {
  applyBetSizeCap, checkDailyExposure, checkPositionCount,
  checkDailyLossHalt, checkMinEdge,
} from './caps.js';
import { reconcile, alertOnMismatch } from './reconciler.js';
import { sendSafetyAlert } from './alerts.js';

export { isKillSwitchActive } from './killSwitch.js';
export {
  loadPaperState, recordPaperBet, settlePaperBet,
  isLiveEligible, activateLive,
  getDailySummary, getDryRunDuration, getBetsSettledOnDate,
} from './paperTradeGate.js';
export type { PaperBetRecord, PaperState, DailySummary } from './paperTradeGate.js';
export {
  sendDailyDryRunSummary, sendAllDailyDryRunSummaries,
  sendAggregateDailySummary, buildSummary, yesterdayUTC,
} from './dailySummary.js';
export {
  checkStopLoss, triggerPaperStopLoss, scanForPaperStopLosses,
} from './stopLoss.js';
export type { StopLossCheckResult } from './stopLoss.js';
export { DRY_RUN_SPORTS } from './allSports.js';
export type { DryRunSport } from './allSports.js';
export { reconcile, alertOnMismatch } from './reconciler.js';
export { sendSafetyAlert } from './alerts.js';
export { loadConfig, HARD_LIMITS } from './config.js';
export type {
  BetRequest, Position, SafetyDecision, SafetyConfig, KillSwitchStatus,
} from './types.js';

export interface CheckBetContext {
  /** Caller provides today's new-bet dollars already placed. */
  todayDollarsPlaced: number;
  /** Caller provides list of currently-open positions. */
  openPositions: Position[];
  /** Today's realized losses (positive number). */
  todayRealizedLoss: number;
  /** True if the sport is requesting live mode. False or omitted = paper. */
  requestLive?: boolean;
  /** Override safety-state directory (for tests). */
  stateDir?: string;
}

/**
 * The single entry point every sport must call BEFORE placing any bet.
 *
 * - If the decision is `blocked`, DO NOT place the bet. Period.
 * - If the decision is `paper`, record the paper trade but DO NOT send
 *   an order to Kalshi.
 * - If the decision is `live`, place the bet with `cappedContracts` — which
 *   may be less than requested.
 *
 * Fail-closed: ANY unexpected error during checks is treated as `blocked`.
 * If you can't reach the safety module, you can't bet.
 */
export async function checkBet(
  req: BetRequest,
  ctx: CheckBetContext,
): Promise<SafetyDecision> {
  try {
    const cfg = loadConfig();
    const violated: string[] = [];

    // 1. Kill switch — absolute override
    const kill = isKillSwitchActive();
    if (kill.active) {
      await sendSafetyAlert({
        title: 'Bet blocked: kill switch active',
        description: `Kill switch triggered: ${kill.reason}. All bets halted until clear.`,
        sport: req.sport,
      });
      return {
        allowed: false,
        mode: 'blocked',
        reason: `KILL SWITCH: ${kill.reason}`,
        violatedRules: ['KILL_SWITCH'],
      };
    }

    // 2. Input sanity
    if (req.priceCents < 1 || req.priceCents > 99) {
      return {
        allowed: false,
        mode: 'blocked',
        reason: `invalid price: ${req.priceCents}¢ (must be 1-99)`,
        violatedRules: ['INVALID_PRICE'],
      };
    }
    if (req.modelProb < 0 || req.modelProb > 1 || !Number.isFinite(req.modelProb)) {
      return {
        allowed: false,
        mode: 'blocked',
        reason: `invalid modelProb: ${req.modelProb}`,
        violatedRules: ['INVALID_PROB'],
      };
    }

    // 3. Min-edge gate — reject sub-edge bets even if Kelly said yes
    const edge = checkMinEdge(req, cfg);
    if (!edge.allowed) violated.push('MIN_EDGE');

    // 4. Daily loss halt
    const lossCheck = checkDailyLossHalt(ctx.todayRealizedLoss, cfg);
    if (!lossCheck.allowed) violated.push('DAILY_LOSS_HALT');

    // 5. Open position count
    const posCheck = checkPositionCount(ctx.openPositions, cfg);
    if (!posCheck.allowed) violated.push('MAX_OPEN_POSITIONS');

    // 6. Daily exposure
    const expCheck = checkDailyExposure(req, ctx.todayDollarsPlaced, cfg);
    if (!expCheck.allowed) violated.push('DAILY_EXPOSURE');

    // 7. Per-bet size cap (contracts may be reduced, not just rejected)
    const sizeCheck = applyBetSizeCap(req, cfg);
    if (sizeCheck.allowedContracts === 0) violated.push('PER_BET_CAP');

    if (violated.length > 0) {
      const reason = [
        !edge.allowed ? edge.reason : null,
        !lossCheck.allowed ? lossCheck.reason : null,
        !posCheck.allowed ? posCheck.reason : null,
        !expCheck.allowed ? expCheck.reason : null,
        sizeCheck.allowedContracts === 0 ? sizeCheck.reason : null,
      ].filter(Boolean).join('; ');
      return {
        allowed: false,
        mode: 'blocked',
        reason: reason || 'safety check failed',
        violatedRules: violated,
      };
    }

    // 8. Paper vs live decision
    const paperEligibility = isLiveEligible(req.sport, cfg.PAPER_TRADE_DAYS_REQUIRED, ctx.stateDir);
    if (ctx.requestLive && !paperEligibility.eligible) {
      // User asked for live but sport not ready — fall back to paper, not block
      return {
        allowed: true,
        mode: 'paper',
        reason: `paper mode (live not eligible: ${paperEligibility.reason})`,
        violatedRules: [],
        cappedContracts: sizeCheck.allowedContracts,
      };
    }

    if (ctx.requestLive && paperEligibility.eligible) {
      return {
        allowed: true,
        mode: 'live',
        reason: 'passed all safety checks',
        violatedRules: [],
        cappedContracts: sizeCheck.allowedContracts,
      };
    }

    // Default: paper mode
    return {
      allowed: true,
      mode: 'paper',
      reason: 'paper mode (requestLive not set)',
      violatedRules: [],
      cappedContracts: sizeCheck.allowedContracts,
    };
  } catch (err) {
    // Fail-closed on ANY unexpected error
    try {
      await sendSafetyAlert({
        title: 'checkBet threw unexpectedly — bet blocked',
        description: String(err),
        sport: req.sport,
      });
    } catch { /* alert failure should not throw */ }
    return {
      allowed: false,
      mode: 'blocked',
      reason: `safety check error: ${String(err)}`,
      violatedRules: ['INTERNAL_ERROR'],
    };
  }
}
