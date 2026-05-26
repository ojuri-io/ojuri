import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Load `frontend/.env*` files so VITE_* targets are picked up at
// dev-server start time, not just at build. Without `loadEnv` the
// dev proxy uses only `process.env.*` from the shell — which silently
// gets the host-side defaults below even when the operator has set
// the docker targets in frontend/.env.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') };

  // Helpful 502 page when a proxy upstream is unreachable so the
  // browser doesn't see a bare "500 Internal Server Error" with no
  // explanation of which target was unreachable.
  const onProxyError = (label, target) => (err, _req, res) => {
    // eslint-disable-next-line no-console
    console.warn(`[vite proxy] ${label} target ${target} unreachable: ${err.message}`);
    if (res && !res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: false,
          message: `Upstream ${label} not reachable at ${target}. ` +
            `If you're running the docker stack, set VITE_RDA_URL=http://localhost ` +
            `(and VITE_FIA_URL=http://localhost/fia) in frontend/.env.`,
        })
      );
    }
  };

  const rdaTarget = env.VITE_RDA_URL || 'http://127.0.0.1:3000';
  const fiaTarget = env.VITE_FIA_URL || 'http://127.0.0.1:9094';
  const mlaTarget = env.VITE_MLA_URL || 'http://127.0.0.1:9095';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        // RDA HTTP API. Override with VITE_RDA_URL.
        // Default is 127.0.0.1 (host-side `npm run start:dev`) because
        // RDA's Fastify listener binds to 0.0.0.0/IPv4 and `localhost`
        // on macOS resolves to ::1, yielding ECONNREFUSED. For the
        // docker-stack quickstart, set VITE_RDA_URL=http://localhost
        // — see frontend/.env.example.
        '/v1': {
          target: rdaTarget,
          changeOrigin: true,
          configure: (proxy) => proxy.on('error', onProxyError('RDA', rdaTarget)),
        },
        '/fia': {
          target: fiaTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/fia/, ''),
          configure: (proxy) => proxy.on('error', onProxyError('FIA', fiaTarget)),
        },
        // MLA admin endpoints (drift config + manual retrain). Strip the
        // /mla prefix so the upstream sees /v1/admin/* like RDA does.
        '/mla': {
          target: mlaTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/mla/, ''),
          configure: (proxy) => proxy.on('error', onProxyError('MLA', mlaTarget)),
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.js'],
      css: false,
    },
  };
});
