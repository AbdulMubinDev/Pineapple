import tseslint from 'typescript-eslint';

// Network egress is confined to src/net/http.ts (which also enforces the host allowlist).
const restrictedModules = ['undici', 'ws', 'http', 'https', 'net', 'node:http', 'node:https', 'node:net'];

export default tseslint.config(
  { ignores: ['node_modules/**', 'data/**', 'results/**', 'dist/**', '.claude/**', '.superpowers/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: restrictedModules.map((name) => ({
            name,
            message: 'Network access is only allowed in src/net/http.ts (outbound allowlist).',
          })),
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use httpGetJson from src/net/http.ts.' },
        { name: 'WebSocket', message: 'Network access is only allowed in src/net/http.ts.' },
      ],
    },
  },
  {
    files: ['src/net/http.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
    },
  },
);
