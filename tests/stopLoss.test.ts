import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkStopLoss, triggerPaperStopLoss } from '../src/stopLoss.js';
import { recordPaperBet, loadPaperState } from '../src/paperTradeGate.js';
import type { BetRequest, PaperBetRecord } from '../src/types.js';
import type { PaperBetRecord as PBR } from '../src/paperTradeGate.js';

const TEST_DIR = resolve(process.cwd(), 'safety-state', 'test-sl');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeBet(overrides: Partial<PBR> = {}): PBR {
  return {
    ticker: 'T-1', sport: 'MLB', side: 'yes',
    priceCents: 60, contracts: 2, modelProb: 0.70,
    placedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('checkStopLoss', () => {
  it('triggers at 20% loss on YES side', () => {
    // Bought YES at 60¢, 2 contracts → cost $1.20
    // Current YES at 48¢ → value = $0.96 → -20% exactly
    const r = checkStopLoss(makeBet(), 48);
    expect(r.triggered).toBe(true);
    expect(r.pctChange).toBeCloseTo(-0.20, 2);
  });

  it('does NOT trigger just below threshold', () => {
    // At 49¢, value = $0.98, change = -18.3% (within threshold)
    const r = checkStopLoss(makeBet(), 49);
    expect(r.triggered).toBe(false);
  });

  it('triggers harder at deeper loss', () => {
    // At 30¢, change = -50%
    const r = checkStopLoss(makeBet(), 30);
    expect(r.triggered).toBe(true);
    expect(r.pctChange).toBeCloseTo(-0.50, 2);
  });

  it('handles NO side correctly', () => {
    // Bought NO at 40¢, 2 contracts → cost $0.80
    // Current YES 70¢ → current NO 30¢ → value = $0.60 → -25%
    const r = checkStopLoss(makeBet({ side: 'no', priceCents: 40, contracts: 2 }), 70);
    expect(r.triggered).toBe(true);
    expect(r.pctChange).toBeCloseTo(-0.25, 2);
  });

  it('never triggers on a settled bet', () => {
    const r = checkStopLoss(makeBet({ settledAt: new Date().toISOString() }), 10);
    expect(r.triggered).toBe(false);
  });

  it('rejects invalid market prices', () => {
    expect(checkStopLoss(makeBet(), -1).triggered).toBe(false);
    expect(checkStopLoss(makeBet(), 150).triggered).toBe(false);
  });

  it('allows custom stop-loss threshold override', () => {
    // At 55¢, YES bet at 60¢ → change ~ -8.3%
    // With 10% threshold: not triggered
    // With 5% threshold: triggered
    expect(checkStopLoss(makeBet(), 55, 0.10).triggered).toBe(false);
    expect(checkStopLoss(makeBet(), 55, 0.05).triggered).toBe(true);
  });
});

describe('triggerPaperStopLoss', () => {
  it('settles with partial loss matching mark-to-market', async () => {
    const req: BetRequest = {
      sport: 'MLB', ticker: 'T-1', side: 'yes',
      priceCents: 60, contracts: 2, modelProb: 0.70,
    };
    recordPaperBet('MLB', req, TEST_DIR);

    // Current price 40¢ → -33% loss → triggered
    // Mark-to-market: $0.80, cost $1.20, pnl = -$0.40
    const settled = await triggerPaperStopLoss('MLB', 'T-1', 40, 0.20, TEST_DIR);
    expect(settled).not.toBeNull();
    expect(settled!.outcome).toBe('loss');
    expect(settled!.pnlDollars).toBeCloseTo(-0.40, 2);
  });

  it('returns null when threshold not met', async () => {
    const req: BetRequest = {
      sport: 'MLB', ticker: 'T-1', side: 'yes',
      priceCents: 60, contracts: 2, modelProb: 0.70,
    };
    recordPaperBet('MLB', req, TEST_DIR);
    const settled = await triggerPaperStopLoss('MLB', 'T-1', 55, 0.20, TEST_DIR);
    expect(settled).toBeNull();

    // State should be unchanged
    const state = loadPaperState('MLB', TEST_DIR);
    expect(state.bets[0]!.settledAt).toBeUndefined();
  });

  it('returns null when no matching open bet', async () => {
    const settled = await triggerPaperStopLoss('MLB', 'NOPE', 10, 0.20, TEST_DIR);
    expect(settled).toBeNull();
  });
});
