// Late-news scan entry — runs every 10 min during pre-game windows.
// Loads safety-state, checks each open bet's sport-specific late-info
// source (MLB Stats API, NBA injury report, etc.), and posts Discord
// alerts on detected changes (probable-pitcher swap, scratch, etc.).

import 'dotenv/config';
import { scanInactives } from '../inactives.js';

function log(msg: string, extra: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg, ...extra, ts: new Date().toISOString() }));
}

(async () => {
  log('inactives scan starting');
  const { checked, alerts } = await scanInactives();
  log('inactives scan complete', {
    checked,
    alerts: alerts.length,
    types: alerts.map((a) => a.changeType),
  });
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ msg: 'inactives scan failed', err: String(err) }));
  process.exit(1);
});
