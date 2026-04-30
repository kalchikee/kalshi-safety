// Diagnostic dump: walks every sport's paper-state file and prints a full
// ledger of placed bets, settlement outcomes, P&L, and CLV per bet.
// Run via workflow_dispatch on the recap workflow's path setup.

import 'dotenv/config';
import { loadPaperState } from '../../paperTradeGate.js';
import { DRY_RUN_SPORTS } from '../../allSports.js';

interface Row {
  sport: string;
  ticker: string;
  side: string;
  priceCents: number;
  contracts: number;
  costBasis: number;
  modelProb: number;
  placedAt: string;
  settledAt: string | undefined;
  outcome: string | undefined;
  pnl: number | undefined;
  closingProb: number | undefined;
}

function clvPp(b: { priceCents: number; closingMarketProb?: number }): number | null {
  if (typeof b.closingMarketProb !== 'number') return null;
  return (b.closingMarketProb - b.priceCents / 100) * 100;
}

const allRows: Row[] = [];
for (const sport of DRY_RUN_SPORTS) {
  const state = loadPaperState(sport);
  for (const b of state.bets) {
    allRows.push({
      sport,
      ticker: b.ticker,
      side: b.side,
      priceCents: b.priceCents,
      contracts: b.contracts,
      costBasis: Math.round((b.priceCents * b.contracts) / 100 * 100) / 100,
      modelProb: b.modelProb,
      placedAt: b.placedAt,
      settledAt: b.settledAt,
      outcome: b.outcome,
      pnl: b.pnlDollars,
      closingProb: b.closingMarketProb,
    });
  }
}

allRows.sort((a, b) => a.placedAt.localeCompare(b.placedAt));

console.log('=== ALL PAPER BETS ===');
console.log('placedAt              sport   ticker                                       side  $entry  ×  cost   model%  outcome   pnl     CLV');
for (const r of allRows) {
  const date = r.placedAt.slice(0, 16);
  const tickerShort = r.ticker.length > 38 ? r.ticker.slice(0, 35) + '...' : r.ticker.padEnd(38);
  const cost = `$${r.costBasis.toFixed(2)}`.padStart(7);
  const modelPct = `${(r.modelProb * 100).toFixed(1)}%`.padStart(7);
  const outcome = (r.outcome ?? 'open').padEnd(8);
  const pnl = r.pnl !== undefined ? `${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)}` : '—';
  const clv = clvPp(r);
  const clvStr = clv !== null ? `${clv >= 0 ? '+' : ''}${clv.toFixed(1)}pp` : '—';
  console.log(
    `${date}   ${r.sport.padEnd(6)} ${tickerShort}  ${r.side.padEnd(4)}  ${r.priceCents.toString().padStart(2)}¢  ×${r.contracts.toString().padStart(3)} ${cost}  ${modelPct}   ${outcome}  ${pnl.padStart(8)}  ${clvStr.padStart(8)}`,
  );
}

// Summary stats
const settled = allRows.filter((r) => r.settledAt);
const wins = settled.filter((r) => r.outcome === 'win').length;
const losses = settled.filter((r) => r.outcome === 'loss' || r.outcome === 'stopped').length;
const open = allRows.length - settled.length;
const totalCost = allRows.reduce((s, r) => s + r.costBasis, 0);
const totalPnl = allRows.reduce((s, r) => s + (r.pnl ?? 0), 0);
const settledCost = settled.reduce((s, r) => s + r.costBasis, 0);
const settledPnl = settled.reduce((s, r) => s + (r.pnl ?? 0), 0);
const roi = settledCost > 0 ? (settledPnl / settledCost) * 100 : 0;

const clvValues = allRows.map(clvPp).filter((v): v is number => v !== null);
const meanClv = clvValues.length > 0 ? clvValues.reduce((s, v) => s + v, 0) / clvValues.length : 0;
const positiveClv = clvValues.filter((v) => v > 0).length;

console.log('');
console.log('=== SUMMARY ===');
console.log(`Total bets:           ${allRows.length}`);
console.log(`Settled:              ${settled.length}  (${wins}W ${losses}L)`);
console.log(`Open:                 ${open}`);
console.log(`Total cost basis:     $${totalCost.toFixed(2)}`);
console.log(`Settled cost basis:   $${settledCost.toFixed(2)}`);
console.log(`Settled P&L:          $${settledPnl.toFixed(2)}`);
console.log(`Settled ROI:          ${roi.toFixed(1)}%`);
console.log(`Total P&L (incl open mark): $${totalPnl.toFixed(2)}`);
console.log(`CLV samples:          ${clvValues.length}`);
console.log(`Mean CLV:             ${meanClv >= 0 ? '+' : ''}${meanClv.toFixed(2)} pp`);
console.log(`Positive CLV:         ${positiveClv}/${clvValues.length}`);

// Per-sport breakdown
console.log('');
console.log('=== PER-SPORT BREAKDOWN ===');
console.log('sport    bets   W   L  open    cost     pnl    roi%   meanCLV');
for (const sport of DRY_RUN_SPORTS) {
  const rows = allRows.filter((r) => r.sport === sport);
  if (rows.length === 0) continue;
  const w = rows.filter((r) => r.outcome === 'win').length;
  const l = rows.filter((r) => r.outcome === 'loss' || r.outcome === 'stopped').length;
  const o = rows.filter((r) => !r.settledAt).length;
  const c = rows.reduce((s, r) => s + r.costBasis, 0);
  const p = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const sportSettledCost = rows.filter((r) => r.settledAt).reduce((s, r) => s + r.costBasis, 0);
  const r = sportSettledCost > 0 ? (p / sportSettledCost) * 100 : 0;
  const sportClv = rows.map(clvPp).filter((v): v is number => v !== null);
  const mc = sportClv.length > 0 ? sportClv.reduce((s, v) => s + v, 0) / sportClv.length : 0;
  console.log(
    `${sport.padEnd(8)} ${rows.length.toString().padStart(4)} ${w.toString().padStart(3)} ${l.toString().padStart(3)} ${o.toString().padStart(4)}  $${c.toFixed(2).padStart(6)}  ${p >= 0 ? '+' : ''}$${p.toFixed(2).padStart(5)}  ${r.toFixed(1).padStart(5)}%  ${mc >= 0 ? '+' : ''}${mc.toFixed(2).padStart(5)}pp`,
  );
}
