/**
 * A deep copy through JSON that refuses NaN / Infinity (JSON would silently turn them into null), for
 * saved state that must restore exactly.
 */
export function plainCopy<T>(x: T, what: string): T {
  return JSON.parse(
    JSON.stringify(x, (k, v: unknown) => {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${what}: ${k || 'value'} is ${v}, which JSON cannot hold`);
      return v;
    }),
  ) as T;
}
