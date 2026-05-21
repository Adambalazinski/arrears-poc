import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/__tests__/**/*.spec.ts'],
    globals: false,
    reporters: ['default'],
    // Several specs hit the same local Postgres rows (Tenancy.id is a global
    // primary key, so two files inserting the same id race). Run files
    // serially in one worker — slightly slower but deterministic.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    // Redirects DATABASE_URL to a dedicated arrears_poc_test DB before any
    // spec runs — keeps `pnpm dev` and `pnpm test` from sharing state.
    globalSetup: ['./test-setup/global-setup.ts'],
  },
  resolve: {
    alias: {
      'shared-canonical': path.resolve(__dirname, '../shared/canonical/src/index.ts'),
    },
  },
});
