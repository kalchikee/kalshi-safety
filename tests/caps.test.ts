import { describe, it, expect } from 'vitest';
import {
  applyBetSizeCap, checkDailyExposure, checkPositionCount,
  checkDailyLossHalt, checkMinEdge,
} from '../src/caps.js';
import { loadConfig, HARD_LIMITS } from '../src/config.js';
import type { BetRequest } from '../src/types.js';

const baseReq: BetRequest = {
  sport: 'TEST', ticker: 'T-1', side: 'yes',
  priceCents: 50, contracts: 1, modelProb: 0.75,
};

describe('applyBetSizeCap', () => {
  it('caps contracts to per-bet dollar limit ($10 hard)', () => {
    const cfg = loadConfig();
    const r = applyBetSizeCap({ ...baseReq, priceCents: 50, contracts: 100 }, cfg);
    // softMaxBetDollars default 10, @ $0.50 per contract → max 20 contracts
    expect(r.allowedContracts).toBeLessThanOrEqual(20);
    expect(r.allowedContracts).toBeGreaterThan(0);
  });

  it('caps to ~10 contracts at 99¢ price (hard $10 cap)', () => {
    const cfg = loadConfig();
    // $0.99 price, cap $10 → floor(10/0.99) = 10 allowed
    const r = applyBetSizeCap({ ...baseReq, priceCents: 99, contracts: 50 }, cfg);
    expect(r.allowedContracts).toBeLessThanOrEqual(10);
  });

  it('returns 0 on invalid inputs', () => {
    const cfg = loadConfig();
    expect(applyBetSizeCap({ ...baseReq, priceCents: 0 }, cfg).allowedContracts).toBe(0);
    expect(applyBetSizeCap({ ...baseReq, contracts: 0 }, cfg).allowedContracts).toBe(0);
    expect(applyBetSizeCap({ ...baseReq, contracts: -5 }, cfg).allowedContracts).toBe(0);
  });

  it('never allows size above HARD_MAX regardless of env override', () => {
    // Even if someone sets KALSHI_MAX_BET_DOLLARS=999, HARD_MAX wins
    process.env.KALSHI_MAX_BET_DOLLARS = '999';
    const cfg = loadConfig();
    expect(cfg.softMaxBetDollars).toBeLessThanOrEqual(HARD_LIMITS.HARD_MAX_BET_DOLLARS);
    delete process.env.KALSHI_MAX_BET_DOLLARS;
  });
});

describe('checkDailyExposure', () => {
  it('blocks when bet would push total above daily cap', () => {
    const cfg = loadConfig();
    const todaysDollars = cfg.softMaxDailyExposureDollars - 1;
    const r = checkDailyExposure(
      { ...baseReq, priceCents: 50, contracts: 10 }, // $5 bet
      todaysDollars, cfg,
    );
    expect(r.allowed).toBe(false);
  });

  it('allows when within budget', () => {
    const cfg = loadConfig();
    const r = checkDailyExposure(
      { ...baseReq, priceCents: 50, contracts: 2 }, // $1 bet
      0, cfg,
    );
    expect(r.allowed).toBe(true);
  });
});

describe('checkPositionCount', () => {
  it('blocks at cap', () => {
    const cfg = loadConfig();
    const positions = Array.from({ length: cfg.softMaxOpenPositions }, (_, i) => ({
      sport: 'T', ticker: `t-${i}`, contracts: 1,
      entryPriceCents: 50, currentValueDollars: 0.5, costBasisDollars: 0.5,
    }));
    expect(checkPositionCount(positions, cfg).allowed).toBe(false);
  });

  it('allows below cap', () => {
    const cfg = loadConfig();
    expect(checkPositionCount([], cfg).allowed).toBe(true);
  });
});

describe('checkDailyLossHalt', () => {
  it('blocks once realized loss exceeds cap', () => {
    const cfg = loadConfig();
    expect(checkDailyLossHalt(cfg.HARD_MAX_DAILY_LOSS_DOLLARS + 1, cfg).allowed).toBe(false);
  });

  it('allows below cap', () => {
    const cfg = loadConfig();
    expect(checkDailyLossHalt(0, cfg).allowed).toBe(true);
  });
});

describe('checkMinEdge', () => {
  it('rejects below 5% edge', () => {
    const cfg = loadConfig();
    // Model says 52%, market says 50% (price 50¢ YES) → edge = 2%
    const r = checkMinEdge({ ...baseReq, priceCents: 50, modelProb: 0.52 }, cfg);
    expect(r.allowed).toBe(false);
    expect(r.edge).toBeCloseTo(0.02, 2);
  });

  it('accepts above 5% edge', () => {
    const cfg = loadConfig();
    // Model says 60%, market says 50% → edge = 10%
    const r = checkMinEdge({ ...baseReq, priceCents: 50, modelProb: 0.60 }, cfg);
    expect(r.allowed).toBe(true);
    expect(r.edge).toBeCloseTo(0.10, 2);
  });

  it('handles NO bets with the same convention as YES (priceCents = ask of OUR side)', () => {
    const cfg = loadConfig();
    // priceCents = 30 means we pay 30¢ for our NO contract → market implies
    // P(NO wins) = 30%. modelProb 0.80 → edge = 0.80 - 0.30 = 0.50.
    const r = checkMinEdge({ ...baseReq, side: 'no', priceCents: 30, modelProb: 0.80 }, cfg);
    expect(r.allowed).toBe(true);
    expect(r.edge).toBeCloseTo(0.50, 2);
  });

  it('rejects a NO bet where the market already prices our side higher than the model', () => {
    // Regression test for the pre-2026-04-30 bug: marketProb was computed
    // as `1 - priceCents/100` for NO bets, which inflated the apparent
    // edge by 1 - 2×marketProb on every NO trade. With the bug, this
    // case computed edge = 0.60 - (1 - 0.60) = 0.20 and ALLOWED. With
    // the fix, edge = 0.60 - 0.60 = 0 and it's correctly REJECTED.
    const cfg = loadConfig();
    const r = checkMinEdge({ ...baseReq, side: 'no', priceCents: 60, modelProb: 0.60 }, cfg);
    expect(r.allowed).toBe(false);
    expect(r.edge).toBeCloseTo(0, 2);
  });
});
