import { describe, expect, it } from 'vitest';
import { BinanceClient } from '../../src/exchange/binance.js';

function fakeSocket() {
  const made: { url: string; h: { onMessage(d: string): void; onOpen(): void; onClose(code: number): void }; closed: boolean }[] = [];
  const openSocket = (url: string, h: (typeof made)[number]['h']) => {
    const s = { url, h, closed: false };
    made.push(s);
    return { close: () => void (s.closed = true) };
  };
  return { made, openSocket };
}

describe('BinanceClient.stream', () => {
  it('opens one combined stream and forwards parsed envelopes and state', () => {
    const { made, openSocket } = fakeSocket();
    const client = new BinanceClient({ openSocket });
    const msgs: unknown[] = [];
    const states: string[] = [];
    const sub = client.stream(['btcusdt@kline_4h', '!ticker@arr', '!markPrice@arr@1s'], (m) => msgs.push(m), (s) => states.push(s));
    expect(made[0]!.url).toBe('wss://fstream.binance.com/market/stream?streams=btcusdt@kline_4h/!ticker@arr/!markPrice@arr@1s');
    made[0]!.h.onOpen();
    made[0]!.h.onMessage('{"stream":"!ticker@arr","data":[]}');
    made[0]!.h.onMessage('not json'); // dropped and counted
    expect(msgs).toEqual([{ stream: '!ticker@arr', data: [] }]);
    expect(client.skipped.streamMessages).toBe(1);
    made[0]!.h.onClose(1006);
    made[0]!.h.onClose(1006);
    expect(states).toEqual(['open', 'closed']);
    sub.close();
    expect(made[0]!.closed).toBe(false); // already closed by the server: nothing to close
  });

  it('close() is silent: no closed state and no messages afterwards', () => {
    const { made, openSocket } = fakeSocket();
    const client = new BinanceClient({ openSocket });
    const states: string[] = [];
    const msgs: unknown[] = [];
    const sub = client.stream(['a@kline_1h'], (m) => msgs.push(m), (s) => states.push(s));
    made[0]!.h.onOpen();
    sub.close();
    made[0]!.h.onMessage('{"stream":"a@kline_1h","data":{}}');
    made[0]!.h.onClose(1000);
    expect(made[0]!.closed).toBe(true);
    expect(states).toEqual(['open']);
    expect(msgs).toEqual([]);
  });
});
