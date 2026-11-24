// WebSocket egress. Same allowlist discipline as http.ts: only wss://fstream.binance.com (public market streams).
import { EgressBlockedError } from './http.js';

export const WS_ALLOWED_HOSTS: readonly string[] = ['fstream.binance.com'];

export interface SocketHandlers {
  onMessage(data: string): void;
  onOpen(): void;
  onClose(code: number): void;
}

function assertAllowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressBlockedError(url);
  }
  if (parsed.protocol !== 'wss:' || !WS_ALLOWED_HOSTS.includes(parsed.hostname)) throw new EgressBlockedError(url);
  return parsed;
}

const decoder = new TextDecoder();

/**
 * Open a WebSocket on the global `WebSocket`. Throws EgressBlockedError before any socket opens for anything but
 * wss://fstream.binance.com. The WebSocket handshake never follows redirects, so the allowlist cannot be left that way.
 * Pings are answered by the runtime. Errors are not reported separately: a close (with its code) always follows.
 */
export function openSocket(url: string, h: SocketHandlers): { close(): void } {
  const parsed = assertAllowed(url);
  const ws = new WebSocket(parsed.href);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => h.onOpen());
  ws.addEventListener('message', (ev: MessageEvent) => {
    const d: unknown = ev.data;
    if (typeof d === 'string') h.onMessage(d);
    else if (d instanceof ArrayBuffer) h.onMessage(decoder.decode(d));
  });
  ws.addEventListener('error', () => undefined);
  ws.addEventListener('close', (ev: CloseEvent) => h.onClose(ev.code));
  return { close: () => ws.close() };
}
