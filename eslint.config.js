// Flat config shared by all workspace packages. Each package may add its own
// overrides on top via its own eslint.config.js.
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.pnpm-store/**',
      '**/*.config.js',
      '**/*.config.cjs',
      '**/*.config.mjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow underscore-prefixed args/vars to be intentionally unused. The
      // codebase uses this for required-by-signature-but-unread params on
      // fixture clients and stub implementations.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  prettier,
];
