import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'shared-canonical': path.resolve(__dirname, '../shared/canonical/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Everything under /api proxies to the NestJS backend.
      // The backend mounts routes at the root (e.g. /health), so we strip the
      // /api prefix here.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
