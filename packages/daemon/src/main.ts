/**
 * The daemon: one per harness home, bound to 127.0.0.1 on a fixed port.
 *
 * It writes `{port, pid, startedAt}` to `%LOCALAPPDATA%/EmilsDeepSeekHarness/daemon.json`,
 * readable by the user only. The CLI starts it on first use.
 *
 * "One per home" and not "one per machine" for one reason: `shutdownAll` kills
 * every run when the daemon goes down, so iterating on the harness would mean
 * killing whatever was in flight. The dev loop and this project's own runs each
 * get their own home because of that, not because of a design preference — see
 * `tools/dev.mjs`.
 *
 * No token, and no login. See `guard.ts`: a secret written to a file readable by
 * anything running as this user cannot defend against those programs, and the
 * one threat worth answering is a web page, which three request headers answer
 * better and for free.
 */

import fs from 'node:fs';
import {
  DEFAULT_BASE_URL,
  daemonFile,
  defaultDaemonPort,
  harnessHome,
  loadHarnessConfig,
  runsDbFile,
  uiHostnames,
  writePrivateJson,
} from '@emilswork/harness-core';
import { Guard } from './guard.js';
import { defaultUiDir, startServer } from './server.js';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';

async function main(): Promise<void> {
  fs.mkdirSync(harnessHome(), { recursive: true });
  const config = loadHarnessConfig();
  // The price table goes to the store as well, so a run recorded before the
  // harness knew any prices still shows what its calls cost rather than a dash.
  const store = new Store(runsDbFile(), config.prices);
  const interrupted = store.markRunningAsInterrupted();
  if (interrupted > 0) {
    process.stdout.write(`dsh: ${interrupted} run(s) left running by a crash are now interrupted\n`);
  }

  // `uiHostnames` is empty unless `config.json` names something, and the loopback
  // address and `localhost` are always allowed either way.
  const guard = new Guard(0, uiHostnames(config));
  const supervisor = new Supervisor({
    store,
    baseUrl: process.env.DSH_BASE_URL ?? config.deepseekBaseUrl ?? DEFAULT_BASE_URL,
    ...(config.prices ? { prices: config.prices } : {}),
  });

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    supervisor.shutdownAll();
    try {
      fs.rmSync(daemonFile(), { force: true });
    } catch {
      /* nothing to remove */
    }
    void server.close().then(() => {
      store.close();
      process.exit(0);
    });
  };

  const server = await startServer({
    store,
    supervisor,
    guard,
    // A fixed port for the real home so the URL is worth bookmarking, and a
    // random one for any other, so a dev or test home can run beside it. See
    // `defaultDaemonPort`.
    port: config.port ?? defaultDaemonPort(),
    ...(config.prices ? { prices: config.prices } : {}),
    uiDir: defaultUiDir(),
    onStop: shutdown,
  });

  writePrivateJson(daemonFile(), {
    port: server.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  process.stdout.write(`dsh daemon listening on 127.0.0.1:${server.port} (pid ${process.pid})\n`);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

main().catch((error: Error) => {
  process.stderr.write(`dsh daemon could not start: ${error.message}\n`);
  process.exit(1);
});
