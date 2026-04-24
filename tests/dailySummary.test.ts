import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSummary, yesterdayUTC } from '../src/dailySummary.js';
import { recordPaperBet, settlePaperBet } from '../src/paperTradeGate.js';
import type { BetRequest } from '../src/types.js';

const TEST_DIR = resolve(process.cwd(), 'safety-state', 'test-daily');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('dailySummary', () => {
  it('yesterdayUTC returns yesterday in YYYY-MM-DD', () => {
    const now = new Date('2026-04-24T10:00:00Z');
    expect(yesterdayUTC(now)).toBe('2026-04-23');
  });

  it('buildSummary returns duration and empty summary for new sport', () => {
    const { summary, durationDays, state } = buildSummary('MLB', '2026-04-24', TEST_DIR);
    expect(summary.total).toBe(0);
    expect(summary.wins).toBe(0);
    expect(durationDays).toBeGreaterThanOrEqual(0);
    expect(durationDays).toBeLessThan(0.01); // just started
    expect(state.totalBets).toBe(0);
    expect(state.liveActive).toBe(false);
  });

  it('buildSummary aggregates settled bets from today', () => {
    const req: BetRequest = {
      sport: 'MLB', ticker: 'A', side: 'yes',
      priceCents: 60, contracts: 1, modelProb: 0.7,
    };
    recordPaperBet('MLB', req, TEST_DIR);
    recordPaperBet('MLB', { ...req, ticker: 'B' }, TEST_DIR);
    settlePaperBet('MLB', 'A', 'win', TEST_DIR);
    settlePaperBet('MLB', 'B', 'loss', TEST_DIR);

    const today = new Date().toISOString().slice(0, 10);
    const { summary, state } = buildSummary('MLB', today, TEST_DIR);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.total).toBe(2);
    expect(state.totalBets).toBe(2);
  });
});
