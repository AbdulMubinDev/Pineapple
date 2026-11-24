import type { PairInfo } from './client.js';

interface RawFilter {
  filterType?: string;
  tickSize?: string;
  stepSize?: string;
  notional?: string;
}

interface RawSymbol {
  symbol?: string;
  contractType?: string;
  status?: string;
  quoteAsset?: string;
  underlyingType?: string;
  onboardDate?: number;
  filters?: RawFilter[];
}

function exclusionReason(s: RawSymbol): string | null {
  if (s.contractType !== 'PERPETUAL') return 'not_perpetual';
  if (s.status !== 'TRADING') return 'not_trading';
  if (s.quoteAsset !== 'USDT') return 'not_usdt';
  if (s.underlyingType !== 'COIN') return 'not_coin';
  return null;
}

function num(v: string | undefined, what: string, symbol: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) throw new Error(`exchangeInfo: ${symbol} is missing ${what}`);
  return n;
}

function toPair(s: RawSymbol): PairInfo {
  const symbol = s.symbol as string;
  const filters = s.filters ?? [];
  const find = (t: string) => filters.find((f) => f.filterType === t);
  const lot = find('MARKET_LOT_SIZE') ?? find('LOT_SIZE');
  return {
    symbol,
    onboardDate: num(String(s.onboardDate), 'onboardDate', symbol),
    rules: {
      symbol,
      tickSize: num(find('PRICE_FILTER')?.tickSize, 'PRICE_FILTER.tickSize', symbol),
      stepSize: num(lot?.stepSize, 'MARKET_LOT_SIZE/LOT_SIZE.stepSize', symbol),
      minNotional: num(find('MIN_NOTIONAL')?.notional, 'MIN_NOTIONAL.notional', symbol),
      // No public leverage-bracket source: use conservative estimates and flag them.
      maxLeverage: 20,
      leverageEstimated: true,
      brackets: [{ notionalCap: Infinity, maintMarginRate: 0.01, maintAmount: 0 }],
      bracketsEstimated: true,
    },
  };
}

/** Active USDT-margined coin perpetuals from a /fapi/v1/exchangeInfo response, sorted by symbol. */
export function buildUniverse(exchangeInfo: unknown): {
  pairs: PairInfo[];
  excluded: { symbol: string; reason: string }[];
} {
  const symbols = (exchangeInfo as { symbols?: RawSymbol[] } | null)?.symbols;
  if (!Array.isArray(symbols)) throw new Error('exchangeInfo: missing symbols array');
  const pairs: PairInfo[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  for (const s of symbols) {
    const reason = exclusionReason(s);
    if (reason) excluded.push({ symbol: String(s.symbol), reason });
    else pairs.push(toPair(s));
  }
  pairs.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { pairs, excluded };
}
