// Paper equity curve — records cumulative paper P&L per day across all sports
// and renders a simple ASCII sparkline in the daily recap embed.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DRY_RUN_SPORTS } from './allSports.js';
import { loadPaperState } from './paperTradeGate.js';

interface EquityPoint {
  date: string;
  cumulativePnl: number;
  todaysPnl: number;
  settledBetsToday: number;
  totalSettledBets: number;
}

interface EquitySeries {
  points: EquityPoint[];
}

function stateFile(stateDir: string): string {
  return join(stateDir, 'equity-curve.json');
}

export function loadEquity(stateDir = 'safety-state'): EquitySeries {
  const f = stateFile(stateDir);
  if (!existsSync(f)) return { points: [] };
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as EquitySeries;
  } catch {
    return { points: [] };
  }
}

function saveEquity(series: EquitySeries, stateDir = 'safety-state'): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile(stateDir), JSON.stringify(series, null, 2));
}

/** Call from the recap action AFTER settlements are processed. Totals up
 *  all paper bets across all sports, diffs against the prior cumulative
 *  P&L to get today's P&L, and appends a point. Idempotent per date. */
export function appendEquityPoint(asOfDate: string, stateDir = 'safety-state'): EquityPoint {
  const series = loadEquity(stateDir);

  let cumulativePnl = 0;
  let totalSettledBets = 0;
  for (const sport of DRY_RUN_SPORTS) {
    const state = loadPaperState(sport);
    for (const bet of state.bets) {
      if (bet.settledAt && typeof bet.pnlDollars === 'number') {
        cumulativePnl += bet.pnlDollars;
        totalSettledBets++;
      }
    }
  }

  const priorCumulative = series.points.length > 0
    ? series.points[series.points.length - 1]!.cumulativePnl
    : 0;
  const priorSettled = series.points.length > 0
    ? series.points[series.points.length - 1]!.totalSettledBets
    : 0;
  const todaysPnl = cumulativePnl - priorCumulative;
  const settledBetsToday = totalSettledBets - priorSettled;

  const point: EquityPoint = {
    date: asOfDate,
    cumulativePnl: Math.round(cumulativePnl * 100) / 100,
    todaysPnl: Math.round(todaysPnl * 100) / 100,
    settledBetsToday,
    totalSettledBets,
  };

  // Replace existing point for same date; otherwise append
  const existing = series.points.findIndex((p) => p.date === asOfDate);
  if (existing >= 0) series.points[existing] = point;
  else series.points.push(point);

  saveEquity(series, stateDir);
  return point;
}

/** Render an ASCII sparkline over the most recent N points. */
export function renderSparkline(points: EquityPoint[], limit = 30): string {
  if (points.length === 0) return '—';
  const recent = points.slice(-limit);
  const values = recent.map((p) => p.cumulativePnl);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const levels = '▁▂▃▄▅▆▇█';
  const chars = values
    .map((v) => levels[Math.min(levels.length - 1, Math.floor(((v - min) / range) * (levels.length - 1)))])
    .join('');
  return chars;
}
