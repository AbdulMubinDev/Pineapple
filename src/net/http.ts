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

/**
 * The request never produced a complete reply: DNS, connection refused or reset, a refused redirect, an abort or a
 * timeout, before or while the body was read. Says nothing about the request itself (`cause` holds the original error).
 */
export class NetworkError extends Error {
  constructor(
    public readonly url: string,
    cause: unknown,
  ) {
    super(`network error for ${url}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'NetworkError';
  }
}

async function rawGet(parsed: URL, opts: { timeoutMs?: number }): Promise<Response> {
  try {
    return await fetch(parsed, {
      method: 'GET',
      // A redirect could leave the allowlist; fail instead of following it.
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new NetworkError(`${parsed.hostname}${parsed.pathname}`, e);
  }
}

/** The whole body as text; a connection lost (or timed out) mid-body is a NetworkError. */
async function readText(res: Response, parsed: URL): Promise<string> {
  try {
    return await res.text();
  } catch (e) {
    throw new NetworkError(`${parsed.hostname}${parsed.pathname}`, e);
  }
}

/**
 * GET a public endpoint and return status, headers and the parsed JSON body (null when the body is not JSON),
 * without throwing on non-2xx so callers can read rate-limit headers on a 429. Same allowlist as httpGetJson.
 */
export async function httpGet(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const parsed = assertAllowed(url);
  const res = await rawGet(parsed, opts);
  const text = await readText(res, parsed);
  let body: unknown = null;
  try {
    body = JSON.parse(text);
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
  return JSON.parse(await readText(res, parsed)) as T;
}
