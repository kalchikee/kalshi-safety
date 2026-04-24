// Persistent record of live bets — stored as JSON under safety-state/.
// Separate from paperTradeGate state so we never confuse live $ with paper.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteFile } from '../atomic.js';
import type { DryRunSport } from '../allSports.js';

export interface LiveBetRecord {
  sport: DryRunSport;
  ticker: string;
  side: 'yes' | 'no';
  priceCents: number;
  contracts: number;
  costBasisDollars: number;
  modelProb: number;
  orderId: string;
  placedAt: string;
  settledAt?: string;
  outcome?: 'win' | 'loss' | 'stopped';
  exitPriceCents?: number;
  pnlDollars?: number;
}

export interface LiveState {
  bets: LiveBetRecord[];
}

function stateFile(stateDir: string): string {
  return join(stateDir, 'live-bets.json');
}

export function loadLiveState(stateDir = 'safety-state'): LiveState {
  const f = stateFile(stateDir);
  if (!existsSync(f)) return { bets: [] };
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as LiveState;
  } catch {
    return { bets: [] };
  }
}

export function saveLiveState(state: LiveState, stateDir = 'safety-state'): void {
  atomicWriteFile(stateFile(stateDir), JSON.stringify(state, null, 2));
}

export function recordLiveBet(bet: LiveBetRecord, stateDir = 'safety-state'): void {
  const state = loadLiveState(stateDir);
  state.bets.push(bet);
  saveLiveState(state, stateDir);
}

export function updateLiveBet(
  ticker: string,
  patch: Partial<LiveBetRecord>,
  stateDir = 'safety-state',
): void {
  const state = loadLiveState(stateDir);
  const idx = state.bets.findIndex((b) => b.ticker === ticker && !b.settledAt);
  if (idx === -1) return;
  const existing = state.bets[idx]!;
  state.bets[idx] = { ...existing, ...patch };
  saveLiveState(state, stateDir);
}

export function getOpenLiveBets(stateDir = 'safety-state'): LiveBetRecord[] {
  return loadLiveState(stateDir).bets.filter((b) => !b.settledAt);
}
