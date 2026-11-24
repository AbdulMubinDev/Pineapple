// The ONLY module allowed to touch the network (enforced by eslint no-restricted-imports/globals).

export const ALLOWED_HOSTS: readonly string[] = ['fapi.binance.com', 'fstream.binance.com'];

export class EgressBlockedError extends Error {
  constructor(public readonly url: string) {
    super(`Outbound request blocked (host not on allowlist): ${url}`);
    this.name = 'EgressBlockedError';
  }
}

function assertAllowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressBlockedError(url);
  }
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new EgressBlockedError(url);
  }
  return parsed;
}

function rawGet(parsed: URL, opts: { timeoutMs?: number }): Promise<Response> {
  return fetch(parsed, {
    method: 'GET',
    // A redirect could leave the allowlist; fail instead of following it.
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
}

/**
 * GET a public endpoint and return status, headers and the parsed JSON body (null when the body is not JSON),
 * without throwing on non-2xx so callers can read rate-limit headers on a 429. Same allowlist as httpGetJson.
 */
export async function httpGet(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const res = await rawGet(assertAllowed(url), opts);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

/** GET a public JSON endpoint. Throws EgressBlockedError before any socket opens for non-allowlisted hosts. */
export async function httpGetJson<T>(url: string, opts: { timeoutMs?: number } = {}): Promise<T> {
  const parsed = assertAllowed(url);
  const res = await rawGet(parsed, opts);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${parsed.hostname}${parsed.pathname}`);
  }
  return (await res.json()) as T;
}
