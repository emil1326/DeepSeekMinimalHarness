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
 *     foreign origin, and the UI's own origin is whatever host the browser is
 *     on — `localhost:5173` or the name in `config.json` — which is foreign to
 *     the daemon either way. This is the one place a dev server is allowed to
 *     speak for the daemon, which is exactly why it lives here rather than in
 *     the config that ships.
 *
 * A stale `Origin` is not a hypothetical: without that header the daemon answers
 * 403 and the UI logs in and then sees nothing.
 *
 * Vite checks `Host` for itself before any of that, and only `localhost`, a
 * `*.localhost` name and an IP address pass by default. The name from
 * `config.json` therefore has to be listed here as well, or the browser gets
 * `Blocked request. This host is not allowed.` and never reaches the proxy.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemonPort = process.env.DSH_DEV_DAEMON_PORT;
const uiPort = Number(process.env.DSH_DEV_UI_PORT ?? 5173);
/** Passed down by the loop, which reads it out of the built core's config. */
const uiHost = (process.env.DSH_DEV_UI_HOST ?? 'localhost').toLowerCase();

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
    // IPv4 loopback, spelled out rather than left as `localhost`.
    //
    // `localhost` can resolve to `::1` and bind only that. The name in
    // `config.json` is pointed at `127.0.0.1` by a hosts file, so a browser
    // arriving under that name connects over IPv4 and would miss a server
    // listening on IPv6 only. Naming the address removes the question.
    host: '127.0.0.1',
    // A different port would not be the one the browser is told to open.
    strictPort: true,
    // The other half of the check Vite does for itself. Everything Vite allows
    // without being told stays allowed; this only adds the configured name.
    //
    // Lowercased above, and it has to be: Vite compares this against the `Host`
    // header character for character, and a browser sends that header
    // lowercased. A capital in here is a name that never matches, and the
    // symptom is `Blocked request` for a URL that looks perfectly correct.
    allowedHosts: [uiHost],
    proxy: {
      // The WebSocket routes carry the live view, so they need `ws`.
      '/events': { ...toDaemon(), ws: true },
      '/runs': { ...toDaemon(), ws: true },
      '/health': toDaemon(),
      '/stats': toDaemon(),
      '/daemon': toDaemon(),
    },
  },
});
