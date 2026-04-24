// Discord summaries for the kalshi-safety service:
//  - bets placed today (posted after morning bet run)
//  - stop-loss triggered (posted by monitor)
//  - daily recap (posted by 4 AM recap job)
//
// All posted to KALSHI_SAFETY_DISCORD_URL.

import fetch from 'node-fetch';

interface EmbedField { name: string; value: string; inline?: boolean; }
interface Embed {
  title?: string; description?: string; color?: number;
  fields?: EmbedField[]; footer?: { text: string }; timestamp?: string;
}

async function post(embed: Embed): Promise<boolean> {
  const url = process.env.KALSHI_SAFETY_DISCORD_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
      signal: AbortSignal.timeout(10000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface PlacedBetDisplay {
  sport: string;
  matchup: string;
  pick: string;
  ticker: string;
  side: 'yes' | 'no';
  priceCents: number;
  contracts: number;
  costBasisDollars: number;
  modelProb: number;
  mode: 'paper' | 'live';
}

export async function sendBetsPlacedSummary(
  date: string,
  placed: PlacedBetDisplay[],
  skipped: Array<{ sport: string; matchup: string; reason: string }>,
  mode: 'paper' | 'live',
): Promise<boolean> {
  if (placed.length === 0 && skipped.length === 0) {
    return post({
      title: `Kalshi Picks · No bets today (${date})`,
      description: 'No predictions cleared the safety filters.',
      color: 0x95a5a6,
      footer: { text: `Kalshi Picks · ${mode.toUpperCase()}` },
      timestamp: new Date().toISOString(),
    });
  }

  const placedLines = placed.map((b) => {
    const dollars = `$${b.costBasisDollars.toFixed(2)}`;
    return `• **${b.sport}** ${b.matchup} → ${b.pick} @ ${b.priceCents}¢ · ${b.contracts}×${dollars} · model ${(b.modelProb * 100).toFixed(1)}%`;
  }).join('\n');

  const totalDollars = placed.reduce((s, b) => s + b.costBasisDollars, 0);
  const fields: EmbedField[] = [];
  if (placed.length > 0) {
    fields.push({
      name: `✅ Bets placed (${placed.length}) — $${totalDollars.toFixed(2)} total`,
      value: placedLines.slice(0, 1000) || '—',
    });
  }
  if (skipped.length > 0) {
    const skippedLines = skipped.slice(0, 10).map((s) => `• ${s.sport} ${s.matchup} — ${s.reason}`).join('\n');
    fields.push({
      name: `⏭️ Skipped (${skipped.length})`,
      value: skippedLines.slice(0, 1000),
    });
  }

  return post({
    title: `Kalshi Picks · Bets placed — ${date}`,
    description: mode === 'paper'
      ? '🧪 Paper trading — no real money at risk.'
      : '💰 Live trading.',
    color: placed.length > 0 ? 0x2ecc71 : 0x95a5a6,
    fields,
    footer: { text: `Kalshi Picks · ${mode.toUpperCase()}` },
    timestamp: new Date().toISOString(),
  });
}

export interface StopLossDisplay {
  sport: string;
  ticker: string;
  side: 'yes' | 'no';
  entryPriceCents: number;
  currentPriceCents: number;
  pctChange: number;
  pnlDollars: number;
}

export async function sendStopLossAlert(ev: StopLossDisplay, mode: 'paper' | 'live'): Promise<boolean> {
  return post({
    title: `🛑 Stop-loss triggered · ${ev.sport}`,
    description: `Position closed at ${(ev.pctChange * 100).toFixed(1)}% loss.`,
    color: 0xE67E22,
    fields: [
      { name: 'Ticker', value: ev.ticker, inline: true },
      { name: 'Side', value: ev.side.toUpperCase(), inline: true },
      { name: 'Entry → Now', value: `${ev.entryPriceCents}¢ → ${ev.currentPriceCents}¢`, inline: true },
      { name: 'P&L', value: `$${ev.pnlDollars.toFixed(2)}`, inline: true },
    ],
    footer: { text: `Kalshi Picks · ${mode.toUpperCase()}` },
    timestamp: new Date().toISOString(),
  });
}

export interface RecapBet {
  sport: string;
  matchup: string;
  pick: string;
  outcome: 'win' | 'loss' | 'stopped' | 'open';
  pnlDollars: number;
}

export async function sendRecap(
  date: string,
  bets: RecapBet[],
  mode: 'paper' | 'live',
): Promise<boolean> {
  const wins = bets.filter((b) => b.outcome === 'win').length;
  const losses = bets.filter((b) => b.outcome === 'loss' || b.outcome === 'stopped').length;
  const open = bets.filter((b) => b.outcome === 'open').length;
  const totalPnl = bets.reduce((s, b) => s + b.pnlDollars, 0);

  const lines = bets.slice(0, 25).map((b) => {
    const icon = b.outcome === 'win' ? '✅' : b.outcome === 'loss' ? '❌' : b.outcome === 'stopped' ? '🛑' : '⏳';
    return `${icon} **${b.sport}** ${b.matchup} → ${b.pick} · $${b.pnlDollars.toFixed(2)}`;
  }).join('\n');

  return post({
    title: `Kalshi Picks · Recap — ${date}`,
    description: bets.length === 0 ? 'No bets placed.' : undefined,
    color: totalPnl > 0 ? 0x27ae60 : totalPnl < 0 ? 0xe74c3c : 0x95a5a6,
    fields: [
      { name: 'Record', value: `${wins}W–${losses}L · ${open} open`, inline: true },
      { name: 'Net P&L', value: `$${totalPnl.toFixed(2)}`, inline: true },
      ...(bets.length > 0 ? [{ name: 'Bets', value: lines.slice(0, 1000) }] : []),
    ],
    footer: { text: `Kalshi Picks · ${mode.toUpperCase()}` },
    timestamp: new Date().toISOString(),
  });
}
