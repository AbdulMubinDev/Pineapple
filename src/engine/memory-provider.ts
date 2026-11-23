// In-memory PineTS data source. PineTS only ever sees candles we hold: the chart timeframe as given,
// and higher timeframes (request.security) aggregated from those same candles. No network: this
// module imports types only from pinets, and nothing else ever hands PineTS a networked provider.
import type { IProvider, ISymbolInfo, Kline } from 'pinets';
import type { Candle, Timeframe } from '../core/types.js';
import { tfToMs } from '../core/timeframe.js';

/** Raised by MemoryProvider (and shown to the user) for a request.security call on another symbol. */
export const OTHER_SYMBOL_MESSAGE = 'request.security on another symbol is not supported in v1';

const MIN = 60_000;
const DAY = 86_400_000;

/** PineTS / TradingView timeframe string for our chart timeframe. */
export function pineTimeframe(tf: Timeframe): string {
  return tf === '1d' ? 'D' : String(tfToMs(tf) / MIN);
}

type Period = { kind: 'ms'; ms: number } | { kind: 'week' } | { kind: 'month' };

/** A TradingView timeframe string ("240", "4H", "D", "1D", "W", "M", "3D", ...) as a bucketing rule. */
function periodOf(timeframe: string): Period | null {
  const m = /^(\d*)([SHDWM]?)$/.exec(String(timeframe).toUpperCase());
  if (!m) return null;
  const n = m[1] === '' ? 1 : Number(m[1]);
  if (!(n > 0)) return null;
  switch (m[2]) {
    case '':
      return { kind: 'ms', ms: n * MIN };
    case 'S':
      return { kind: 'ms', ms: n * 1000 };
    case 'H':
      return { kind: 'ms', ms: n * 60 * MIN };
    case 'D':
      return { kind: 'ms', ms: n * DAY };
    case 'W':
      return n === 1 ? { kind: 'week' } : null;
    case 'M':
      return n === 1 ? { kind: 'month' } : null;
    default:
      return null;
  }
}

/** Open time of the bucket holding `t` (UTC; weeks start Monday 00:00 as on Binance and TradingView). */
function bucketOpen(t: number, p: Period): number {
  if (p.kind === 'ms') return Math.floor(t / p.ms) * p.ms;
  if (p.kind === 'week') {
    const monday = 4 * DAY; // 1970-01-05 was a Monday
    return Math.floor((t - monday) / (7 * DAY)) * 7 * DAY + monday;
  }
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function bucketClose(open: number, p: Period): number {
  if (p.kind === 'ms') return open + p.ms;
  if (p.kind === 'week') return open + 7 * DAY;
  const d = new Date(open);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Candles of a higher timeframe built from `candles`. The last bucket may be developing (built from
 * the bars seen so far), which is what TradingView shows on a realtime bar.
 */
export function aggregateCandles(candles: Candle[], timeframe: string): Candle[] {
  const p = periodOf(timeframe);
  if (!p) throw new Error(`unsupported timeframe ${timeframe}`);
  const out: Candle[] = [];
  for (const c of candles) {
    const open = bucketOpen(c.openTime, p);
    const last = out[out.length - 1];
    if (last && last.openTime === open) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ openTime: open, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
  }
  return out;
}

export function toKline(c: Candle, closeTime: number): Kline {
  return {
    openTime: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    closeTime,
    quoteAssetVolume: 0,
    numberOfTrades: 0,
    takerBuyBaseAssetVolume: 0,
    takerBuyQuoteAssetVolume: 0,
    ignore: 0,
  };
}

/** Symbol facts for a Binance USDT-M perpetual, as PineTS's syminfo.* reads them. */
export function perpSymbolInfo(symbol: string, syminfo: { mintick: number; qtyStep: number }): ISymbolInfo {
  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  return {
    ticker: `${symbol}.P`,
    tickerid: `BINANCE:${symbol}.P`,
    prefix: 'BINANCE',
    root: symbol,
    description: `${symbol} Perpetual`,
    type: 'crypto',
    basecurrency: base,
    currency: 'USDT',
    timezone: 'Etc/UTC',
    session: '24x7',
    mintick: syminfo.mintick,
    minmove: 1,
    pricescale: Math.round(1 / syminfo.mintick),
    pointvalue: 1,
    mincontract: syminfo.qtyStep,
  } as unknown as ISymbolInfo;
}

/**
 * Serves the chart candles for the chart timeframe and aggregates any higher timeframe from them.
 * A lower timeframe than the chart cannot be served and throws.
 */
export class MemoryProvider implements IProvider {
  protected readonly candles: Candle[];
  private readonly chartMs: number;
  private readonly cache = new Map<string, Kline[]>();

  constructor(
    candles: Candle[],
    readonly chartTf: Timeframe,
    private readonly info: ISymbolInfo,
  ) {
    this.candles = candles.slice();
    this.chartMs = tfToMs(chartTf);
  }

  /** Grows the data (bar-by-bar use): higher-timeframe candles are rebuilt on the next request. */
  push(c: Candle): void {
    this.candles.push(c);
    this.cache.clear();
  }

  private series(timeframe: string): Kline[] {
    const key = String(timeframe).toUpperCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = periodOf(key);
    if (!p) throw new Error(`MemoryProvider has no ${timeframe} data`);
    let rows: Kline[];
    if (p.kind === 'ms' && p.ms === this.chartMs) {
      rows = this.candles.map((c) => toKline(c, c.openTime + this.chartMs));
    } else {
      if (p.kind === 'ms' && (p.ms < this.chartMs || p.ms % this.chartMs !== 0)) {
        throw new Error(`MemoryProvider cannot build ${timeframe} candles from ${this.chartTf} candles`);
      }
      rows = aggregateCandles(this.candles, key).map((c) => toKline(c, bucketClose(c.openTime, p)));
    }
    this.cache.set(key, rows);
    return rows;
  }

  /** Whether a request.security symbol is the chart's own (syminfo.tickerid, bare, BINANCE:SYM or BINANCE:SYM.P). */
  private isChartSymbol(tickerId: string): boolean {
    const root = String((this.info as unknown as { root?: string }).root ?? '').toUpperCase();
    const id = String(tickerId).toUpperCase().replace(/^BINANCE:/, '').replace(/\.P$/, '');
    return root !== '' && id === root;
  }

  async getMarketData(tickerId: string, timeframe: string, limit?: number, sDate?: number, eDate?: number): Promise<Kline[]> {
    if (!this.isChartSymbol(tickerId)) throw new Error(OTHER_SYMBOL_MESSAGE);
    let rows = this.series(timeframe).filter(
      (k) => (sDate === undefined || k.openTime >= sDate) && (eDate === undefined || k.openTime < eDate),
    );
    if (limit && limit > 0) rows = rows.slice(-limit);
    return rows.map((k) => ({ ...k }));
  }

  async getSymbolInfo(): Promise<ISymbolInfo> {
    return this.info;
  }

  configure(): void {}
}
