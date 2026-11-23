import tseslint from 'typescript-eslint';

// Network egress is confined to src/net/http.ts (which also enforces the host allowlist).
const restrictedModules = [
  'undici', 'ws', 'http', 'https', 'net', 'tls', 'http2', 'dgram', 'dns', 'child_process',
  'node:http', 'node:https', 'node:net', 'node:tls', 'node:http2', 'node:dgram', 'node:dns', 'node:child_process',
];

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
        ...['WebSocket', 'XMLHttpRequest', 'EventSource'].map((name) => ({ name, message: 'Network access is only allowed in src/net/http.ts.' })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'fetch', message: 'Use httpGetJson from src/net/http.ts.' },
      ],
    },
  },
  {
    files: ['src/net/http.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  },
);
