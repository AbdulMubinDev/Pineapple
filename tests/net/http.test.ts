import { afterEach, describe, expect, it, vi } from 'vitest';
import { EgressBlockedError, httpGetJson } from '../../src/net/http.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('httpGetJson', () => {
  it('rejects non-allowlisted host before any socket opens', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(httpGetJson('https://example.com/x')).rejects.toBeInstanceOf(EgressBlockedError);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('rejects lookalike hosts and non-https schemes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(httpGetJson('https://fapi.binance.com.evil.io/x')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(httpGetJson('https://evil.io/@fapi.binance.com')).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(httpGetJson('http://fapi.binance.com/x')).rejects.toBeInstanceOf(EgressBlockedError);
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('allows fapi.binance.com', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const out = await httpGetJson<{ ok: number }>('https://fapi.binance.com/fapi/v1/ping');
    expect(out).toEqual({ ok: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('allows fstream.binance.com', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    await httpGetJson('https://fstream.binance.com/x');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('throws on non-2xx responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 418 }));
    await expect(httpGetJson('https://fapi.binance.com/x')).rejects.toThrow(/418/);
  });
});

describe("httpGetJson redirects", () => {
  it("passes redirect: error so a redirect cannot leave the allowlist", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await httpGetJson("https://fapi.binance.com/x");
    expect(spy.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });
});
