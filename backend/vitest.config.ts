import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/__tests__/**/*.spec.ts'],
    globals: false,
    reporters: ['default'],
  },
  resolve: {
    alias: {
      'shared-canonical': path.resolve(__dirname, '../shared/canonical/src/index.ts'),
    },
  },
});
