import { afterEach, describe, expect, it, vi } from 'vitest';
import { EgressBlockedError, httpGet, httpGetJson, NetworkError } from '../../src/net/http.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('httpGet', () => {
  it('returns status and headers, including on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ msg: 'slow down' }), { status: 429, headers: { 'X-MBX-USED-WEIGHT-1M': '2400' } }),
    );
    const res = await httpGet('https://fapi.binance.com/fapi/v1/exchangeInfo');
    expect(res.status).toBe(429);
    expect(res.headers.get('X-MBX-USED-WEIGHT-1M')).toBe('2400');
    expect(res.body).toEqual({ msg: 'slow down' });
  });

  it('returns a null body when the response is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502 }));
    const res = await httpGet('https://fapi.binance.com/x');
    expect(res.status).toBe(502);
    expect(res.body).toBeNull();
  });

  it('allows only the allowlist', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await httpGet('https://fstream.binance.com/x');
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(httpGet('https://example.com/x')).rejects.toBeInstanceOf(EgressBlockedError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('passes redirect: error', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await httpGet('https://fapi.binance.com/x');
    expect(spy.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
  });
});

describe('NetworkError', () => {
  it('wraps a fetch-level failure (DNS, reset, redirect) and keeps the cause', async () => {
    const cause = new TypeError('fetch failed');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause);
    const err = await httpGet('https://fapi.binance.com/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).cause).toBe(cause);
    await expect(httpGetJson('https://fapi.binance.com/x')).rejects.toBeInstanceOf(NetworkError);
  });

  it('wraps a timeout or abort', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(httpGet('https://fapi.binance.com/x', { timeoutMs: 5 })).rejects.toBeInstanceOf(NetworkError);
  });

  it('wraps a connection lost while reading the body; a 200 that is not JSON is still a null body', async () => {
    const broken = new Response('{}', { status: 200 });
    vi.spyOn(broken, 'text').mockRejectedValue(new TypeError('terminated'));
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    await expect(httpGet('https://fapi.binance.com/x')).rejects.toBeInstanceOf(NetworkError);
    expect((await httpGet('https://fapi.binance.com/x')).body).toBeNull();
  });

  it('never wraps a blocked host', async () => {
    await expect(httpGet('https://example.com/x')).rejects.toBeInstanceOf(EgressBlockedError);
  });
});
