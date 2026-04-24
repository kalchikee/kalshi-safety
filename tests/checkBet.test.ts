import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkBet } from '../src/index.js';
import type { BetRequest, CheckBetContext } from '../src/types.js';

const TEST_DIR = resolve(process.cwd(), 'safety-state', 'test-checkbet');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  delete process.env.KALSHI_KILL_SWITCH;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

const baseReq: BetRequest = {
  sport: 'MLB', ticker: 'MLB-T1', side: 'yes',
  priceCents: 50, contracts: 2, modelProb: 0.70,
};
const baseCtx: CheckBetContext = {
  todayDollarsPlaced: 0,
  openPositions: [],
  todayRealizedLoss: 0,
  stateDir: TEST_DIR,
};

describe('checkBet', () => {
  it('blocks immediately when kill switch is active', async () => {
    process.env.KALSHI_KILL_SWITCH = '1';
    const d = await checkBet(baseReq, baseCtx);
    expect(d.allowed).toBe(false);
    expect(d.mode).toBe('blocked');
    expect(d.violatedRules).toContain('KILL_SWITCH');
  });

  it('defaults to paper mode when requestLive is not set', async () => {
    const d = await checkBet(baseReq, baseCtx);
    expect(d.allowed).toBe(true);
    expect(d.mode).toBe('paper');
  });

  it('falls back to paper when requesting live but paper period not met', async () => {
    const d = await checkBet(baseReq, { ...baseCtx, requestLive: true });
    expect(d.allowed).toBe(true);
    expect(d.mode).toBe('paper');
    expect(d.reason).toMatch(/paper/i);
  });

  it('rejects bets with insufficient edge', async () => {
    const lowEdge = { ...baseReq, modelProb: 0.51 }; // market 50%, model 51% = 1% edge
    const d = await checkBet(lowEdge, baseCtx);
    expect(d.allowed).toBe(false);
    expect(d.violatedRules).toContain('MIN_EDGE');
  });

  it('rejects invalid prices', async () => {
    const d = await checkBet({ ...baseReq, priceCents: 0 }, baseCtx);
    expect(d.allowed).toBe(false);
    expect(d.violatedRules).toContain('INVALID_PRICE');
  });

  it('rejects invalid model probabilities', async () => {
    const d = await checkBet({ ...baseReq, modelProb: 1.5 }, baseCtx);
    expect(d.allowed).toBe(false);
    expect(d.violatedRules).toContain('INVALID_PROB');
  });

  it('rejects NaN/Inf model probabilities', async () => {
    const d = await checkBet({ ...baseReq, modelProb: NaN }, baseCtx);
    expect(d.allowed).toBe(false);
    expect(d.violatedRules).toContain('INVALID_PROB');
  });

  it('caps bets that exceed per-bet size', async () => {
    // Request 100 contracts at 50¢ = $50 → should cap to softMax (default $10 → 20 contracts)
    const d = await checkBet({ ...baseReq, contracts: 100, modelProb: 0.70 }, baseCtx);
    if (d.allowed) {
      expect(d.cappedContracts).toBeLessThanOrEqual(20);
      expect(d.cappedContracts).toBeGreaterThan(0);
    } else {
      // Could also be rejected by daily-exposure check instead
      expect(d.violatedRules.length).toBeGreaterThan(0);
    }
  });

  it('rejects when open positions exceed cap', async () => {
    const positions = Array.from({ length: 10 }, (_, i) => ({
      sport: 'MLB', ticker: `t${i}`, contracts: 1,
      entryPriceCents: 50, currentValueDollars: 0.5, costBasisDollars: 0.5,
    }));
    const d = await checkBet(baseReq, { ...baseCtx, openPositions: positions });
    expect(d.allowed).toBe(false);
    expect(d.violatedRules).toContain('MAX_OPEN_POSITIONS');
  });

  it('rejects when daily loss limit hit', async () => {
    const d = await checkBet(baseReq, { ...baseCtx, todayRealizedLoss: 100 });
    expect(d.allowed).toBe(false);
    expect(d.violatedRules).toContain('DAILY_LOSS_HALT');
  });
});
