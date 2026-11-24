import { afterEach, describe, expect, it, vi } from 'vitest';
import { EgressBlockedError } from '../../src/net/http.js';
import { openSocket } from '../../src/net/ws.js';

class FakeSocket extends EventTarget {
  static made: FakeSocket[] = [];
  closed = false;
  constructor(public readonly url: string) {
    super();
    FakeSocket.made.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.made = [];
});

const noop = { onMessage: () => undefined, onOpen: () => undefined, onClose: () => undefined };

describe('openSocket', () => {
  it.each(['wss://example.com/stream', 'ws://fstream.binance.com/stream', 'wss://fapi.binance.com/ws', 'https://fstream.binance.com/x', 'not a url'])(
    'ws rejects non-allowlisted host: %s',
    (url) => {
      vi.stubGlobal('WebSocket', FakeSocket);
      expect(() => openSocket(url, noop)).toThrow(EgressBlockedError);
      expect(FakeSocket.made).toHaveLength(0);
    },
  );

  it('opens wss://fstream.binance.com and wires open, message, close', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const seen: string[] = [];
    const sock = openSocket('wss://fstream.binance.com/stream?streams=btcusdt@kline_15m', {
      onOpen: () => seen.push('open'),
      onMessage: (d) => seen.push(`msg:${d}`),
      onClose: (code) => seen.push(`close:${code}`),
    });
    const ws = FakeSocket.made[0]!;
    expect(ws.url).toBe('wss://fstream.binance.com/stream?streams=btcusdt@kline_15m');
    ws.dispatchEvent(new Event('open'));
    ws.dispatchEvent(new MessageEvent('message', { data: '{"a":1}' }));
    ws.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([123, 125]).buffer }));
    ws.dispatchEvent(new Event('error'));
    ws.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }));
    expect(seen).toEqual(['open', 'msg:{"a":1}', 'msg:{}', 'close:1006']);
    sock.close();
    expect(ws.closed).toBe(true);
  });

  it('sets binaryType to arraybuffer so binary frames decode synchronously', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    openSocket('wss://fstream.binance.com/ws/x', noop);
    expect((FakeSocket.made[0] as unknown as { binaryType: string }).binaryType).toBe('arraybuffer');
  });
});
