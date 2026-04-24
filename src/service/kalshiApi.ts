// Kalshi REST API client — auth (RSA-PSS), markets, orders, balance, positions.
// Owned by kalshi-safety since it is the only service that places real orders.

import { createPrivateKey, createSign, constants as cryptoConstants, type KeyObject } from 'crypto';
import fetch from 'node-fetch';
import { withRetry } from '../retry.js';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PREFIX = '/trade-api/v2';

function getKeyId(): string {
  const id = process.env.KALSHI_API_KEY_ID;
  if (!id) throw new Error('KALSHI_API_KEY_ID not set');
  return id;
}

function getPrivateKey(): KeyObject {
  let pem = process.env.KALSHI_PRIVATE_KEY ?? '';
  pem = pem.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
  if (!pem) throw new Error('KALSHI_PRIVATE_KEY not set');
  return createPrivateKey(pem);
}

export const PAPER_TRADING = process.env.KALSHI_PAPER_TRADING !== 'false';
export const MIN_BALANCE_DOLLARS = parseFloat(process.env.KALSHI_MIN_BALANCE ?? '5');

function headers(method: string, path: string): Record<string, string> {
  const keyId = getKeyId();
  const privateKey = getPrivateKey();
  const ts = String(Date.now());
  const message = ts + method.toUpperCase() + API_PREFIX + path;
  const sig = createSign('RSA-SHA256');
  sig.update(message, 'utf8');
  const signature = sig.sign({
    key: privateKey,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function kGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  return withRetry(async () => {
    const url = new URL(BASE_URL + path);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url.toString(), { method: 'GET', headers: headers('GET', path) });
    if (!r.ok) throw new Error(`Kalshi GET ${path} ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  });
}

async function kPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return withRetry(async () => {
    const r = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: headers('POST', path),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Kalshi POST ${path} ${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  });
}

export interface KalshiMarket {
  ticker: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price?: number;
  volume?: number;
  close_time?: string;
  result?: string;
  event_ticker?: string;
}

function normalize(m: KalshiMarket): KalshiMarket {
  const c = (s?: string) => (s ? Math.round(parseFloat(s) * 100) : 0);
  return {
    ...m,
    yes_bid: c(m.yes_bid_dollars),
    yes_ask: c(m.yes_ask_dollars),
    no_bid: c(m.no_bid_dollars),
    no_ask: c(m.no_ask_dollars),
    last_price: c(m.last_price_dollars),
  };
}

export interface KalshiPosition {
  ticker: string;
  position_fp: string;
  market_exposure_dollars: string;
  realized_pnl_dollars: string;
  total_traded_dollars: string;
}

export interface KalshiBalance {
  balance: number;
  portfolio_value: number;
  updated_ts: number;
}

export interface KalshiOrderResp {
  order_id: string;
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  status: string;
  yes_price: number;
  no_price: number;
  count: number;
  filled_count: number;
}

export async function getBalance(): Promise<KalshiBalance> {
  return kGet<KalshiBalance>('/portfolio/balance');
}

export async function getPositions(): Promise<KalshiPosition[]> {
  const d = await kGet<{ market_positions: KalshiPosition[] }>('/portfolio/positions', {
    count_filter: 'position',
  });
  return d.market_positions ?? [];
}

export async function getMarket(ticker: string): Promise<KalshiMarket | null> {
  try {
    const d = await kGet<{ market: KalshiMarket }>(`/markets/${ticker}`);
    return normalize(d.market);
  } catch {
    return null;
  }
}

/**
 * Scan all open Kalshi markets for a given ticker-prefix (e.g. KXMLBGAME, KXNFLGAME).
 * Returns a Map of ticker → market.
 */
export async function scanMarkets(
  tickerPrefix: string,
  kalshiDate: string,
  excludeSubstrings: string[] = ['TOTAL'],
): Promise<Map<string, KalshiMarket>> {
  const out = new Map<string, KalshiMarket>();
  const found = new Set<string>();
  let cursor: string | undefined;
  let attempts = 0;

  while (attempts < 10) {
    attempts++;
    const params: Record<string, string> = { limit: '200', status: 'open' };
    if (cursor) params.cursor = cursor;
    const d = await kGet<{ markets: KalshiMarket[]; cursor?: string }>('/markets', params);
    const batch = d.markets ?? [];
    for (const m of batch) {
      const t = m.ticker ?? '';
      if (
        t.includes(kalshiDate) &&
        t.startsWith(tickerPrefix) &&
        !excludeSubstrings.some((x) => t.includes(x))
      ) {
        found.add(t);
      }
      const legs = ((m as unknown as Record<string, unknown>)['mve_selected_legs'] ?? []) as Array<{
        market_ticker?: string;
      }>;
      for (const leg of legs) {
        const lt = leg.market_ticker ?? '';
        if (
          lt.includes(kalshiDate) &&
          lt.startsWith(tickerPrefix) &&
          !excludeSubstrings.some((x) => lt.includes(x))
        ) {
          found.add(lt);
        }
      }
    }
    cursor = d.cursor;
    if (!cursor || batch.length === 0) break;
  }

  for (const t of found) {
    const m = await getMarket(t);
    if (m) out.set(t, m);
  }
  return out;
}

export async function placeOrder(
  ticker: string,
  side: 'yes' | 'no',
  priceCents: number,
  contracts: number,
): Promise<KalshiOrderResp> {
  const yesPrice = side === 'yes' ? priceCents : 100 - priceCents;
  const noPrice = 100 - yesPrice;
  if (PAPER_TRADING) {
    return {
      order_id: `paper-${Date.now()}`,
      ticker,
      action: 'buy',
      side,
      status: 'filled',
      yes_price: yesPrice,
      no_price: noPrice,
      count: contracts,
      filled_count: contracts,
    };
  }
  const d = await kPost<{ order: KalshiOrderResp }>('/portfolio/orders', {
    ticker,
    client_order_id: `ks-${Date.now()}`,
    type: 'limit',
    action: 'buy',
    side,
    count: contracts,
    yes_price: yesPrice,
    no_price: noPrice,
  });
  return d.order;
}

export async function sellPosition(
  ticker: string,
  side: 'yes' | 'no',
  contracts: number,
  minPriceCents = 1,
): Promise<KalshiOrderResp> {
  const yesSell = side === 'yes' ? minPriceCents : 100 - minPriceCents;
  if (PAPER_TRADING) {
    return {
      order_id: `paper-sell-${Date.now()}`,
      ticker,
      action: 'sell',
      side,
      status: 'filled',
      yes_price: yesSell,
      no_price: 100 - yesSell,
      count: contracts,
      filled_count: contracts,
    };
  }
  const d = await kPost<{ order: KalshiOrderResp }>('/portfolio/orders', {
    ticker,
    client_order_id: `ks-sell-${Date.now()}`,
    type: 'limit',
    action: 'sell',
    side,
    count: contracts,
    yes_price: yesSell,
    no_price: 100 - yesSell,
  });
  return d.order;
}

/** "26APR24" style date used in Kalshi game tickers. */
export function toKalshiDate(isoDate?: string): string {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const d = isoDate ? new Date(isoDate + 'T12:00:00') : new Date();
  return `${String(d.getFullYear()).slice(2)}${months[d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
}
