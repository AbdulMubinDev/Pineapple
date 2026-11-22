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

  it('rejects global fetch outside src/net/http.ts', async () => {
    const msgs = await lint("export const x = fetch('https://fapi.binance.com');\n", 'src/data/fixture-bad.ts');
    expect(msgs.some((m) => m.ruleId === 'no-restricted-globals')).toBe(true);
  });

  it('allows the same imports inside src/net/http.ts', async () => {
    const msgs = await lint(
      "import https from 'node:https';\nexport const x = [https, fetch];\n",
      'src/net/http.ts',
    );
    expect(msgs.filter((m) => m.severity === 2)).toEqual([]);
  });
});
