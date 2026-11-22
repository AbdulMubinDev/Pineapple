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

/** GET a public JSON endpoint. Throws EgressBlockedError before any socket opens for non-allowlisted hosts. */
export async function httpGetJson<T>(url: string, opts: { timeoutMs?: number } = {}): Promise<T> {
  const parsed = assertAllowed(url);
  const res = await fetch(parsed, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${parsed.hostname}${parsed.pathname}`);
  }
  return (await res.json()) as T;
}
