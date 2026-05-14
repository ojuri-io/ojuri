import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // RDA HTTP API. Override with VITE_RDA_URL at build time.
      // Use 127.0.0.1 by default because RDA's Fastify listener binds to
      // 0.0.0.0/IPv4; resolving `localhost` to ::1 on macOS yields
      // ECONNREFUSED. Setting agent:false forces a fresh socket so we
      // never accidentally reuse a stale IPv6 attempt.
      '/v1': {
        target: process.env.VITE_RDA_URL || 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/fia': {
        target: process.env.VITE_FIA_URL || 'http://127.0.0.1:9094',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/fia/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    css: false,
  },
});
