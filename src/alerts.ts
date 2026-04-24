import fetch from 'node-fetch';

// All safety events fire a Discord alert to KALSHI_SAFETY_DISCORD_URL.
// This is a SEPARATE channel from prediction webhooks — only safety-relevant
// events land here (kill switch activations, cap violations, reconciliation
// mismatches, halts).

const DEFAULT_COLOR = 0xE74C3C; // red

export interface SafetyAlert {
  title: string;
  description: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  color?: number;
  sport?: string;
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
      footer: { text: `Kalshi Safety · ${alert.sport ?? 'system'}` },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.error(`[safety] Discord returned ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[safety] Discord alert failed:', err);
    return false;
  }
}
