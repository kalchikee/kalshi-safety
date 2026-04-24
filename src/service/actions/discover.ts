// Run-once diagnostic: scans today's open Kalshi markets and prints a
// histogram of unique ticker prefixes, so we can verify CANDIDATE_PREFIXES
// in discovery.ts matches reality.
//
// Usage: node --loader ts-node/esm src/service/actions/discover.ts

import 'dotenv/config';
import fetch from 'node-fetch';
import { createPrivateKey, createSign, constants as cryptoConstants } from 'crypto';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PREFIX = '/trade-api/v2';

function headers(method: string, path: string): Record<string, string> {
  const keyId = process.env.KALSHI_API_KEY_ID!;
  let pem = (process.env.KALSHI_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').replace(/^"|"$/g, '');
  const key = createPrivateKey(pem);
  const ts = String(Date.now());
  const sig = createSign('RSA-SHA256');
  sig.update(ts + method + API_PREFIX + path, 'utf8');
  const signature = sig.sign({ key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    'Content-Type': 'application/json',
  };
}

interface Market { ticker: string; title?: string; status: string; }

async function fetchAllOpen(): Promise<Market[]> {
  const out: Market[] = [];
  let cursor: string | undefined;
  let pages = 0;
  while (pages < 20) {
    pages++;
    const url = new URL(BASE_URL + '/markets');
    url.searchParams.set('limit', '200');
    url.searchParams.set('status', 'open');
    if (cursor) url.searchParams.set('cursor', cursor);
    const r = await fetch(url.toString(), { headers: headers('GET', '/markets') });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    const d = (await r.json()) as { markets: Market[]; cursor?: string };
    out.push(...(d.markets ?? []));
    cursor = d.cursor;
    if (!cursor || (d.markets ?? []).length === 0) break;
  }
  return out;
}

function prefixOf(ticker: string, depth = 2): string {
  return ticker.split('-').slice(0, depth).join('-');
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  console.log(`Fetching all open Kalshi markets …`);
  const markets = await fetchAllOpen();
  console.log(`Total open markets: ${markets.length}`);

  const counts = new Map<string, number>();
  for (const m of markets) {
    const key = prefixOf(m.ticker);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\nTicker-prefix histogram (top 40):');
  for (const [prefix, count] of sorted.slice(0, 40)) {
    console.log(`  ${String(count).padStart(5)}  ${prefix}`);
  }

  console.log('\nSearch hints — top 5 KX-prefixed sport groups:');
  const sportKeywords = ['MLB', 'NBA', 'NFL', 'NHL', 'NCAAM', 'NCAAF', 'NCAAW', 'MLS', 'EPL', 'WNBA', 'UFC', 'F1', 'TENNIS', 'ATP', 'WTA'];
  for (const kw of sportKeywords) {
    const matches = sorted.filter(([p]) => p.toUpperCase().includes(kw));
    if (matches.length > 0) {
      const top = matches.slice(0, 3).map(([p, c]) => `${p} (${c})`).join(', ');
      console.log(`  ${kw.padEnd(6)} → ${top}`);
    }
  }
}

main().catch((err) => {
  console.error('discovery failed:', err);
  process.exit(1);
});
