import type { Candle, FundingEvent, Timeframe } from '../core/types.js';
import { fetchFundingHistory, fetchKlines } from '../data/binance-rest.js';
import { httpGetJson } from '../net/http.js';
import type { ExchangeClient, PairInfo, Ticker24h } from './client.js';
import { buildUniverse } from './universe.js';

const BASE = 'https://fapi.binance.com';
const DEFAULT_FUNDING_HOURS = 8;

interface RawTicker {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
}
interface RawFundingInfo {
  symbol: string;
  fundingIntervalHours?: number;
}

/** Binance USDT-M futures client, public endpoints only. Streams arrive in Task 3. */
export class BinanceClient implements ExchangeClient {
  async pairs(): Promise<PairInfo[]> {
    const info = await httpGetJson<unknown>(`${BASE}/fapi/v1/exchangeInfo`, { timeoutMs: 30_000 });
    return buildUniverse(info).pairs;
  }

  async tickers24h(): Promise<Ticker24h[]> {
    const raw = await httpGetJson<RawTicker[]>(`${BASE}/fapi/v1/ticker/24hr`, { timeoutMs: 30_000 });
    return raw.map((t) => ({ symbol: t.symbol, quoteVolume: Number(t.quoteVolume), lastPrice: Number(t.lastPrice) }));
  }

  klines(symbol: string, tf: Timeframe, fromMs: number, toMs: number): Promise<Candle[]> {
    return fetchKlines(symbol, tf, fromMs, toMs);
  }

  fundingHistory(symbol: string, fromMs: number, toMs: number): Promise<FundingEvent[]> {
    return fetchFundingHistory(symbol, fromMs, toMs);
  }

  async fundingIntervalHours(): Promise<Map<string, number>> {
    const raw = await httpGetJson<RawFundingInfo[]>(`${BASE}/fapi/v1/fundingInfo`);
    const out = new Map<string, number>();
    for (const r of raw) {
      out.set(r.symbol, Number.isFinite(r.fundingIntervalHours) && r.fundingIntervalHours! > 0 ? r.fundingIntervalHours! : DEFAULT_FUNDING_HOURS);
    }
    return out;
  }

  stream(): { close(): void } {
    throw new Error('not implemented');
  }
}
