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

/** A symbol that passed the filters but whose rules cannot be built; it is excluded, not fatal. */
class BadFilters extends Error {}

/** A strictly positive finite number from a string or number, or BadFilters naming the field. */
function positive(v: unknown, what: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new BadFilters(`${what}=${JSON.stringify(v) ?? 'missing'}`);
  return n;
}

function toPair(s: RawSymbol, symbol: string): PairInfo {
  const filters = Array.isArray(s.filters) ? s.filters : [];
  const find = (t: string) => filters.find((f) => f?.filterType === t);
  const lot = find('MARKET_LOT_SIZE') ?? find('LOT_SIZE');
  return {
    symbol,
    onboardDate: positive(s.onboardDate, 'onboardDate'),
    rules: {
      symbol,
      tickSize: positive(find('PRICE_FILTER')?.tickSize, 'tickSize'),
      stepSize: positive(lot?.stepSize, 'stepSize'),
      minNotional: positive(find('MIN_NOTIONAL')?.notional, 'minNotional'),
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
    const symbol = typeof s?.symbol === 'string' ? s.symbol : '';
    const reason = s ? exclusionReason(s) : 'malformed';
    if (reason) {
      excluded.push({ symbol, reason });
      continue;
    }
    try {
      pairs.push(toPair(s, symbol));
    } catch (e) {
      if (!(e instanceof BadFilters)) throw e;
      excluded.push({ symbol, reason: `bad_filters:${e.message}` });
    }
  }
  pairs.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { pairs, excluded };
}
