import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadPaperState, isLiveEligible, activateLive, recordPaperBet,
  settlePaperBet, getDailySummary, getDryRunDuration,
} from '../src/paperTradeGate.js';
import type { BetRequest } from '../src/types.js';

const TEST_DIR = resolve(process.cwd(), 'safety-state', 'test-gate');

const baseReq: BetRequest = {
  sport: 'MLB', ticker: 'MLB-T1', side: 'yes',
  priceCents: 60, contracts: 2, modelProb: 0.70,
};

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('paperTradeGate', () => {
  it('initializes new sport in paper mode with empty bet list', () => {
    const state = loadPaperState('MLB', TEST_DIR);
    expect(state.sport).toBe('MLB');
    expect(state.liveActivatedIso).toBeUndefined();
    expect(state.bets).toEqual([]);
  });

  it('blocks live mode until explicit activation', () => {
    loadPaperState('MLB', TEST_DIR);
    const r = isLiveEligible('MLB', 30, TEST_DIR);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not activated/i);
  });

  it('blocks live mode even after activation if paper period not met', () => {
    loadPaperState('MLB', TEST_DIR);
    activateLive('MLB', TEST_DIR);
    const r = isLiveEligible('MLB', 30, TEST_DIR);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/paper period/i);
  });

  it('blocks live mode if bet count too low', () => {
    const path = resolve(TEST_DIR, 'paper-mlb.json');
    const fakeOld = new Date(Date.now() - 40 * 86400000).toISOString();
    writeFileSync(path, JSON.stringify({
      sport: 'MLB',
      paperStartIso: fakeOld,
      liveActivatedIso: new Date().toISOString(),
      bets: [{ ticker: 't1', sport: 'MLB', side: 'yes', priceCents: 50, contracts: 1, modelProb: 0.6, placedAt: new Date().toISOString() }],
    }));
    const r = isLiveEligible('MLB', 30, TEST_DIR);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/insufficient paper bet history/i);
  });

  it('allows live mode once all conditions met', () => {
    const path = resolve(TEST_DIR, 'paper-mlb.json');
    const fakeOld = new Date(Date.now() - 40 * 86400000).toISOString();
    const bets = Array.from({ length: 20 }, (_, i) => ({
      ticker: `t${i}`, sport: 'MLB', side: 'yes' as const, priceCents: 50,
      contracts: 1, modelProb: 0.6, placedAt: new Date().toISOString(),
    }));
    writeFileSync(path, JSON.stringify({
      sport: 'MLB',
      paperStartIso: fakeOld,
      liveActivatedIso: new Date().toISOString(),
      bets,
    }));
    const r = isLiveEligible('MLB', 30, TEST_DIR);
    expect(r.eligible).toBe(true);
  });

  it('recordPaperBet appends a full record', () => {
    const rec = recordPaperBet('MLB', baseReq, TEST_DIR);
    expect(rec.ticker).toBe('MLB-T1');
    expect(rec.contracts).toBe(2);
    expect(rec.placedAt).toBeDefined();
    const state = loadPaperState('MLB', TEST_DIR);
    expect(state.bets.length).toBe(1);
  });

  it('settlePaperBet computes win P&L correctly (YES bet at 60¢, wins)', () => {
    recordPaperBet('MLB', baseReq, TEST_DIR);
    const settled = settlePaperBet('MLB', 'MLB-T1', 'win', TEST_DIR);
    expect(settled).not.toBeNull();
    // 2 contracts, 60¢ each → profit per winning contract = $0.40 → total +$0.80
    expect(settled!.pnlDollars).toBeCloseTo(0.80, 2);
    expect(settled!.outcome).toBe('win');
  });

  it('settlePaperBet computes loss P&L correctly', () => {
    recordPaperBet('MLB', baseReq, TEST_DIR);
    const settled = settlePaperBet('MLB', 'MLB-T1', 'loss', TEST_DIR);
    // 2 contracts × 60¢ = $1.20 cost lost
    expect(settled!.pnlDollars).toBeCloseTo(-1.20, 2);
  });

  it('settlePaperBet returns null when no matching bet', () => {
    const r = settlePaperBet('MLB', 'NO-SUCH-TICKER', 'win', TEST_DIR);
    expect(r).toBeNull();
  });

  it('getDailySummary returns zero on empty day', () => {
    const r = getDailySummary('MLB', '2026-01-01', TEST_DIR);
    expect(r.total).toBe(0);
    expect(r.wins).toBe(0);
    expect(r.pnlDollars).toBe(0);
    expect(r.accuracy).toBe(0);
  });

  it('getDailySummary aggregates correctly after settlements', () => {
    recordPaperBet('MLB', { ...baseReq, ticker: 'A' }, TEST_DIR);
    recordPaperBet('MLB', { ...baseReq, ticker: 'B' }, TEST_DIR);
    recordPaperBet('MLB', { ...baseReq, ticker: 'C' }, TEST_DIR);
    settlePaperBet('MLB', 'A', 'win', TEST_DIR);
    settlePaperBet('MLB', 'B', 'win', TEST_DIR);
    settlePaperBet('MLB', 'C', 'loss', TEST_DIR);

    const today = new Date().toISOString().slice(0, 10);
    const r = getDailySummary('MLB', today, TEST_DIR);
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(1);
    expect(r.total).toBe(3);
    expect(r.accuracy).toBeCloseTo(2 / 3, 2);
    // 2 wins × $0.80 profit − 1 loss × $1.20 = $1.60 − $1.20 = $0.40
    expect(r.pnlDollars).toBeCloseTo(0.40, 2);
  });

  it('getDryRunDuration returns fractional days since paperStart', () => {
    const path = resolve(TEST_DIR, 'paper-mlb.json');
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    writeFileSync(path, JSON.stringify({
      sport: 'MLB', paperStartIso: tenDaysAgo, bets: [],
    }));
    const dur = getDryRunDuration('MLB', TEST_DIR);
    expect(dur).toBeGreaterThan(9.9);
    expect(dur).toBeLessThan(10.1);
  });

  it('recovers gracefully from corrupted state file', () => {
    const path = resolve(TEST_DIR, 'paper-mlb.json');
    writeFileSync(path, 'not valid json {{{');
    const state = loadPaperState('MLB', TEST_DIR);
    expect(state.bets).toEqual([]);
    expect(state.sport).toBe('MLB');
  });

  it('backward-compat: loads old format with paperBetCount as empty bets', () => {
    const path = resolve(TEST_DIR, 'paper-mlb.json');
    writeFileSync(path, JSON.stringify({
      sport: 'MLB',
      paperStartIso: new Date().toISOString(),
      paperBetCount: 5,
    }));
    const state = loadPaperState('MLB', TEST_DIR);
    expect(state.bets).toEqual([]); // old format has no bets array
  });
});
