import { tfToMs } from '../core/timeframe.js';
import type { Candle, FundingEvent, Timeframe } from '../core/types.js';
import { httpGetJson } from '../net/http.js';

const BASE = 'https://fapi.binance.com';
const KLINE_PAGE = 1500;
const FUNDING_PAGE = 1000;
const PAGE_SLEEP_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// [openTime, open, high, low, close, volume, closeTime, ...]
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];
interface RawFunding {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice: string;
}

/**
 * Closed candles with openTime in [fromMs, toMs], oldest first. The still-forming bar is dropped.
 */
export async function fetchKlines(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]> {
  const step = tfToMs(tf);
  const out: Candle[] = [];
  let cursor = fromMs;
  let first = true;
  while (cursor <= toMs) {
    if (!first) await sleep(PAGE_SLEEP_MS);
    first = false;
    const url =
      `${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}` +
      `&startTime=${cursor}&endTime=${toMs}&limit=${KLINE_PAGE}`;
    const page = await httpGetJson<RawKline[]>(url);
    if (page.length === 0) break;
    const now = Date.now();
    for (const k of page) {
      if (k[6] >= now) continue; // closeTime in the future => bar still forming
      out.push({
        openTime: k[0],
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      });
    }
    const last = page[page.length - 1];
    if (!last) break;
    cursor = last[0] + step;
    if (page.length < KLINE_PAGE) break;
  }
  return out;
}

/** Funding events with fundingTime in [fromMs, toMs], oldest first. */
export async function fetchFundingHistory(symbol: string, fromMs: number, toMs: number): Promise<FundingEvent[]> {
  const out: FundingEvent[] = [];
  let cursor = fromMs;
  let first = true;
  while (cursor <= toMs) {
    if (!first) await sleep(PAGE_SLEEP_MS);
    first = false;
    const url =
      `${BASE}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}` +
      `&startTime=${cursor}&endTime=${toMs}&limit=${FUNDING_PAGE}`;
    const page = await httpGetJson<RawFunding[]>(url);
    if (page.length === 0) break;
    for (const f of page) {
      out.push({ time: f.fundingTime, rate: Number(f.fundingRate), markPrice: Number(f.markPrice) });
    }
    const last = page[page.length - 1];
    if (!last) break;
    cursor = last.fundingTime + 1;
    if (page.length < FUNDING_PAGE) break;
  }
  return out;
}
