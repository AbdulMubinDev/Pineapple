import { FUNDING_WEIGHT, klineWeight } from '../exchange/budget.js';
import { tfToMs } from '../core/timeframe.js';
import type { Candle, FundingEvent, Timeframe } from '../core/types.js';

const KLINE_PAGE = 1500;
const FUNDING_PAGE = 1000;
const BASE = 'https://fapi.binance.com';

/** Fetches one JSON page. Callers route this through a RestBudget; `weight` is what the call costs. */
export type JsonGetter = (url: string, weight: number) => Promise<unknown>;
export interface PageDeps {
  getJson: JsonGetter;
  now: () => number;
}

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
 * The page `limit` is sized to the bars still wanted, so a short tail costs a small weight.
 */
export async function fetchKlines(symbol: string, tf: Timeframe, fromMs: number, toMs: number, deps: PageDeps): Promise<Candle[]> {
  const step = tfToMs(tf);
  const out: Candle[] = [];
  let cursor = fromMs;
  while (cursor <= toMs) {
    const limit = Math.max(1, Math.min(KLINE_PAGE, Math.floor((toMs - cursor) / step) + 1));
    const url =
      `${BASE}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}` +
      `&startTime=${cursor}&endTime=${toMs}&limit=${limit}`;
    const page = (await deps.getJson(url, klineWeight(limit))) as RawKline[];
    if (!Array.isArray(page) || page.length === 0) break;
    const now = deps.now();
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
    if (page.length < limit) break;
  }
  return out;
}

/** Funding events with fundingTime in [fromMs, toMs], oldest first. */
export async function fetchFundingHistory(symbol: string, fromMs: number, toMs: number, deps: PageDeps): Promise<FundingEvent[]> {
  const out: FundingEvent[] = [];
  let cursor = fromMs;
  while (cursor <= toMs) {
    const url =
      `${BASE}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}` +
      `&startTime=${cursor}&endTime=${toMs}&limit=${FUNDING_PAGE}`;
    const page = (await deps.getJson(url, FUNDING_WEIGHT)) as RawFunding[];
    if (!Array.isArray(page) || page.length === 0) break;
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
