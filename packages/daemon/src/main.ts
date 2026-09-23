/**
 * The daemon: one per machine, bound to 127.0.0.1 on a random free port.
 *
 * It writes `{port, pid, token}` to `%LOCALAPPDATA%/EmilsDeepSeekHarness/daemon.json`,
 * readable by the user only. The CLI starts it on first use.
 */

import fs from 'node:fs';
import {
  DEFAULT_BASE_URL,
  daemonFile,
  harnessHome,
  loadHarnessConfig,
  runsDbFile,
  writePrivateJson,
} from '@emilswork/harness-core';
import { Auth, newToken } from './auth.js';
import { defaultUiDir, startServer } from './server.js';
import { Store } from './store.js';
import { Supervisor } from './supervisor.js';

async function main(): Promise<void> {
  fs.mkdirSync(harnessHome(), { recursive: true });
  const config = loadHarnessConfig();
  const store = new Store(runsDbFile());
  const interrupted = store.markRunningAsInterrupted();
  if (interrupted > 0) {
    process.stdout.write(`dsh: ${interrupted} run(s) left running by a crash are now interrupted\n`);
  }

  const token = newToken();
  const auth = new Auth(0, token);
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
    auth,
    ...(config.prices ? { prices: config.prices } : {}),
    uiDir: defaultUiDir(),
    onStop: shutdown,
  });

  writePrivateJson(daemonFile(), {
    port: server.port,
    pid: process.pid,
    token,
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
