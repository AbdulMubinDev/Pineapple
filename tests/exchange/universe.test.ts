import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildUniverse } from '../../src/exchange/universe.js';

const info: unknown = JSON.parse(readFileSync('tests/fixtures/exchangeInfo.json', 'utf8'));

describe('buildUniverse', () => {
  it('keeps only active USDT coin perpetuals, sorted by symbol', () => {
    const { pairs, excluded } = buildUniverse(info);
    expect(pairs.map((p) => p.symbol)).toEqual([
      '1000PEPEUSDT', 'ADAUSDT', 'AVAXUSDT', 'BNBUSDT', 'BTCUSDT', 'DOGEUSDT',
      'ETHUSDT', 'LINKUSDT', 'SOLUSDT', 'SUIUSDT', 'TRXUSDT', 'XRPUSDT',
    ]);
    const reason = (s: string) => excluded.find((e) => e.symbol === s)?.reason;
    expect(reason('XAUUSDT')).toBe('not_perpetual'); // TRADIFI_PERPETUAL
    expect(reason('OMGUSDT')).toBe('not_trading'); // SETTLING
    expect(reason('ETHBTC')).toBe('not_usdt');
    expect(reason('BTCUSDC')).toBe('not_usdt');
    expect(reason('BTCDOMUSDT')).toBe('not_coin'); // INDEX
    expect(reason('PREDICTUSDT')).toBe('not_coin'); // PREMARKET
    expect(new Set(excluded.map((e) => e.reason))).toEqual(
      new Set(['not_perpetual', 'not_trading', 'not_usdt', 'not_coin']),
    );
    expect(pairs.length + excluded.length).toBe(27);
  });

  it('rules come from the filters', () => {
    const { pairs } = buildUniverse(info);
    const btc = pairs.find((p) => p.symbol === 'BTCUSDT')!;
    expect(btc.rules.symbol).toBe('BTCUSDT');
    expect(btc.rules.tickSize).toBe(0.1);
    expect(btc.rules.stepSize).toBe(0.001);
    expect(btc.rules.minNotional).toBe(50);
    expect(btc.onboardDate).toBe(1567965300000);
    for (const p of pairs) {
      expect(p.rules.leverageEstimated).toBe(true);
      expect(p.rules.maxLeverage).toBe(20);
      expect(p.rules.bracketsEstimated).toBe(true);
      expect(p.rules.brackets).toEqual([{ notionalCap: Infinity, maintMarginRate: 0.01, maintAmount: 0 }]);
    }
  });

  it('falls back to LOT_SIZE when MARKET_LOT_SIZE is absent', () => {
    const { pairs } = buildUniverse({
      symbols: [
        {
          symbol: 'XUSDT', contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', underlyingType: 'COIN',
          onboardDate: 1,
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.01' },
            { filterType: 'LOT_SIZE', stepSize: '0.5' },
            { filterType: 'MIN_NOTIONAL', notional: '5' },
          ],
        },
      ],
    });
    expect(pairs[0]!.rules.stepSize).toBe(0.5);
  });

  it('MARKET_LOT_SIZE wins over LOT_SIZE when they differ', () => {
    const { pairs } = buildUniverse({
      symbols: [mk('XUSDT', { filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.5' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.25' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ] })],
    });
    expect(pairs[0]!.rules.stepSize).toBe(0.25);
  });

  it('excludes a symbol with a missing or non-positive filter without dropping the others', () => {
    const good = [
      { filterType: 'PRICE_FILTER', tickSize: '0.01' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '1' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ];
    const { pairs, excluded } = buildUniverse({
      symbols: [
        mk('AUSDT', { filters: good }),
        mk('NOPRICEUSDT', { filters: good.filter((f) => f.filterType !== 'PRICE_FILTER') }),
        mk('ZEROSTEPUSDT', { filters: good.map((f) => (f.stepSize ? { ...f, stepSize: '0' } : f)) }),
        mk('EMPTYTICKUSDT', { filters: good.map((f) => (f.tickSize ? { ...f, tickSize: '' } : f)) }),
        mk('ZUSDT', { filters: good }),
      ],
    });
    expect(pairs.map((p) => p.symbol)).toEqual(['AUSDT', 'ZUSDT']);
    expect(excluded).toEqual([
      { symbol: 'NOPRICEUSDT', reason: 'bad_filters:tickSize=missing' },
      { symbol: 'ZEROSTEPUSDT', reason: 'bad_filters:stepSize="0"' },
      { symbol: 'EMPTYTICKUSDT', reason: 'bad_filters:tickSize=""' },
    ]);
  });

  it('uses an empty symbol, not the string undefined, when the symbol is missing', () => {
    const { excluded } = buildUniverse({ symbols: [{ contractType: 'CURRENT_QUARTER' }] });
    expect(excluded).toEqual([{ symbol: '', reason: 'not_perpetual' }]);
  });
});

function mk(symbol: string, extra: Record<string, unknown>) {
  return { symbol, contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', underlyingType: 'COIN', onboardDate: 1, ...extra };
}
