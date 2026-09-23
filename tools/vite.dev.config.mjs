/**
 * The UI's dev server, used by `npm run dev` and by nothing else.
 *
 * `packages/ui/vite.config.ts` is the build: it writes the UI into the daemon's
 * `dist/public`, and the daemon serves it. This one is the loop. It serves the
 * sources itself, with HMR, and forwards the API to the daemon.
 *
 * The proxy has to do two things the browser cannot do for itself:
 *
 *   - `changeOrigin` rewrites `Host` to `127.0.0.1:<daemon port>`. The daemon
 *     only answers its own host, which is what stops another program on the
 *     machine from using it.
 *   - `headers.origin` rewrites `Origin` the same way. The daemon refuses a
 *     foreign origin, and from here the UI's origin is `localhost:5173`, which is
 *     foreign. This is the one place a dev server is allowed to speak for the
 *     daemon, which is exactly why it lives here rather than in the config that
 *     ships.
 *
 * A stale `Origin` is not a hypothetical: without that header the daemon answers
 * 403 and the UI logs in and then sees nothing.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemonPort = process.env.DSH_DEV_DAEMON_PORT;
const uiPort = Number(process.env.DSH_DEV_UI_PORT ?? 5173);

if (daemonPort === undefined || daemonPort === '') {
  throw new Error('DSH_DEV_DAEMON_PORT is not set; start this through `npm run dev` instead');
}

const target = `http://127.0.0.1:${daemonPort}`;

/** Every API route, forwarded with the headers the daemon insists on. */
const toDaemon = () => ({
  target,
  changeOrigin: true,
  headers: { origin: target },
});

export default defineConfig({
  root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
  plugins: [react()],
  server: {
    port: uiPort,
    // A different port would not be the one `loginUrl` hands out.
    strictPort: true,
    proxy: {
      // The WebSocket routes carry the live view, so they need `ws`.
      '/events': { ...toDaemon(), ws: true },
      '/runs': { ...toDaemon(), ws: true },
      '/health': toDaemon(),
      '/stats': toDaemon(),
      '/daemon': toDaemon(),
      // `/ui/ticket` and `/ui/session`: the one-time login, and the cookie it sets.
      '/ui': toDaemon(),
    },
  },
});
