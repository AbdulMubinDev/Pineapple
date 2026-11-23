import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(code: string, filePath: string) {
  const [res] = await eslint.lintText(code, { filePath });
  return res?.messages ?? [];
}

describe('restricted imports', () => {
  it('rejects node:https outside src/net/http.ts', async () => {
    const msgs = await lint("import https from 'node:https';\nexport const x = https;\n", 'src/data/fixture-bad.ts');
    expect(msgs.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it.each(['node:http', 'node:net', 'undici', 'ws'])('rejects %s', async (mod) => {
    const msgs = await lint(`import m from '${mod}';\nexport const x = m;\n`, 'src/core/fixture-bad.ts');
    expect(msgs.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it.each(['node:tls', 'tls', 'node:http2', 'http2', 'node:dgram', 'dgram', 'node:dns', 'dns', 'node:child_process', 'child_process'])(
    'rejects %s (hardening)',
    async (mod) => {
      const msgs = await lint(`import m from '${mod}';\nexport const x = m;\n`, 'src/core/fixture-bad.ts');
      expect(msgs.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
    },
  );

  it('rejects global fetch outside src/net/http.ts', async () => {
    const msgs = await lint("export const x = fetch('https://fapi.binance.com');\n", 'src/data/fixture-bad.ts');
    expect(msgs.some((m) => m.ruleId === 'no-restricted-globals')).toBe(true);
  });

  it('rejects globalThis.fetch outside src/net/http.ts', async () => {
    const msgs = await lint("export const x = globalThis.fetch('https://fapi.binance.com');\n", 'src/data/fixture-bad.ts');
    expect(msgs.some((m) => m.ruleId === 'no-restricted-properties')).toBe(true);
  });

  it.each(['XMLHttpRequest', 'EventSource', 'WebSocket'])('rejects global %s', async (name) => {
    const msgs = await lint(`export const x = new ${name}('https://fapi.binance.com');\n`, 'src/data/fixture-bad.ts');
    expect(msgs.some((m) => m.ruleId === 'no-restricted-globals')).toBe(true);
  });

  it('allows the same imports inside src/net/http.ts', async () => {
    const msgs = await lint(
      "import https from 'node:https';\nexport const x = [https, fetch, globalThis.fetch];\n",
      'src/net/http.ts',
    );
    expect(msgs.filter((m) => m.severity === 2)).toEqual([]);
  });
});
