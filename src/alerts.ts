import fetch from 'node-fetch';

// Two parallel Discord channels:
//   - sendSafetyAlert -> KALSHI_SAFETY_DISCORD_URL: system-level events only
//     (kill switch, sport auto-suspension, reconciliation mismatches, resolver
//     health, late-news inactives).
//   - sendPaperEvent -> KALSHI_PAPER_DISCORD_URL: paper-trading flow events
//     (stop-loss / take-profit triggers, daily dry-run summaries, equity
//     drawdown alerts). Falls back to the safety URL if the paper URL isn't
//     configured so nothing silently disappears.

const DEFAULT_COLOR = 0xE74C3C; // red
const PAPER_DEFAULT_COLOR = 0x3498DB; // blue — distinguishes paper-flow events

export interface SafetyAlert {
  title: string;
  description: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  color?: number;
  sport?: string;
}

async function postEmbed(url: string, payload: unknown, channel: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.error(`[${channel}] Discord returned ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${channel}] Discord alert failed:`, err);
    return false;
  }
}

export async function sendSafetyAlert(alert: SafetyAlert): Promise<boolean> {
  const url = process.env.KALSHI_SAFETY_DISCORD_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    // No webhook configured — log to stderr and return false but do NOT throw
    // (alert delivery failure should never block the decision it's about).
    console.error('[safety] No webhook URL configured; alert not sent:', alert.title);
    return false;
  }

  const payload = {
    embeds: [{
      title: `🚨 ${alert.title}`,
      description: alert.description,
      color: alert.color ?? DEFAULT_COLOR,
      fields: alert.fields,
      footer: { text: `Kalshi Picks · ${alert.sport ?? 'system'}` },
      timestamp: new Date().toISOString(),
    }],
  };

  return postEmbed(url, payload, 'safety');
}

export async function sendPaperEvent(alert: SafetyAlert): Promise<boolean> {
  const url = process.env.KALSHI_PAPER_DISCORD_URL
    || process.env.KALSHI_SAFETY_DISCORD_URL
    || process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.error('[paper] No webhook URL configured; alert not sent:', alert.title);
    return false;
  }

  const payload = {
    embeds: [{
      title: alert.title,
      description: alert.description,
      color: alert.color ?? PAPER_DEFAULT_COLOR,
      fields: alert.fields,
      footer: { text: `Kalshi Picks · ${alert.sport ?? 'paper'}` },
      timestamp: new Date().toISOString(),
    }],
  };

  return postEmbed(url, payload, 'paper');
}
