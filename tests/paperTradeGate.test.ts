import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPaperState, isLiveEligible, activateLive, recordPaperBet } from '../src/paperTradeGate.js';

const TEST_DIR = resolve(process.cwd(), 'safety-state', 'test-gate');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('paperTradeGate', () => {
  it('initializes new sport in paper mode', () => {
    const state = loadPaperState('MLB', TEST_DIR);
    expect(state.sport).toBe('MLB');
    expect(state.liveActivatedIso).toBeUndefined();
    expect(state.paperBetCount).toBe(0);
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

  it('blocks live mode if paper bet count is too low', () => {
    // Simulate state where paperStart was long ago but no paper bets
    const path = resolve(TEST_DIR, 'paper-mlb.json');
    const fakeOld = new Date(Date.now() - 40 * 86400000).toISOString();
    writeFileSync(path, JSON.stringify({
      sport: 'MLB',
      paperStartIso: fakeOld,
      liveActivatedIso: new Date().toISOString(),
      paperBetCount: 2,
    }));
    const r = isLiveEligible('MLB', 30, TEST_DIR);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/insufficient paper bet history/i);
  });

  it('allows live mode once all conditions met', () => {
    const path = resolve(TEST_DIR, 'paper-mlb.json');
    const fakeOld = new Date(Date.now() - 40 * 86400000).toISOString();
    writeFileSync(path, JSON.stringify({
      sport: 'MLB',
      paperStartIso: fakeOld,
      liveActivatedIso: new Date().toISOString(),
      paperBetCount: 20,
    }));
    const r = isLiveEligible('MLB', 30, TEST_DIR);
    expect(r.eligible).toBe(true);
  });

  it('recordPaperBet increments count', () => {
    recordPaperBet('MLB', TEST_DIR);
    recordPaperBet('MLB', TEST_DIR);
    const state = loadPaperState('MLB', TEST_DIR);
    expect(state.paperBetCount).toBe(2);
  });

  it('recovers gracefully from corrupted state file', () => {
    const path = resolve(TEST_DIR, 'paper-mlb.json');
    writeFileSync(path, 'not valid json {{{');
    const state = loadPaperState('MLB', TEST_DIR);
    expect(state.paperBetCount).toBe(0);
    expect(state.sport).toBe('MLB');
  });
});
