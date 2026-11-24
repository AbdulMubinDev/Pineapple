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
});
