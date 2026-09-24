import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerEntry } from '@emilswork/harness-worker';
export { Guard, type RequestHeaders } from './guard.js';
export { startServer, defaultUiDir, type HarnessServer, type ServerOptions } from './server.js';
export { RUN_TAGS, Store, summarise, type OutcomeStats, type RunTag } from './store.js';
export { Supervisor, newRunId, type SupervisorOptions } from './supervisor.js';
export * from './protocol.js';

/** Where the CLI forks the daemon from when it is not running. */
export function daemonEntry(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}

/**
 * When the code a run would use was last built: the newest `.js` under the
 * daemon's, the worker's and core's `dist`.
 *
 * The daemon runs from memory and forks each worker from disk, so after an
 * `npm run build` a long-lived daemon speaks the old protocol to a new worker.
 * That failed as "the worker stopped without finishing", with nothing saying
 * why, and it took forking the worker by hand to see it. The daemon writes this
 * into `daemon.json` when it starts and the CLI compares it on every connect.
 * Modification times rather than a hash: the question is only "has anything
 * been rebuilt since", and a stat of a few dozen files answers it for free.
 */
export function buildStamp(dirs: readonly string[] = codeDirs()): string {
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ts)$/.test(entry.name)) newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  for (const dir of dirs) walk(dir);
  return String(Math.floor(newest));
}

/** Where the daemon, the worker and core are loaded from: `dist` once built, `src` under the tests. */
function codeDirs(): string[] {
  return [
    path.dirname(daemonEntry()),
    path.dirname(workerEntry()),
    path.dirname(fileURLToPath(import.meta.resolve('@emilswork/harness-core'))),
  ];
}
