import { fileURLToPath } from 'node:url';
export { Guard, type RequestHeaders } from './guard.js';
export { startServer, defaultUiDir, type HarnessServer, type ServerOptions } from './server.js';
export { RUN_TAGS, Store, summarise, type OutcomeStats, type RunTag } from './store.js';
export { Supervisor, newRunId, type SupervisorOptions } from './supervisor.js';
export * from './protocol.js';

/** Where the CLI forks the daemon from when it is not running. */
export function daemonEntry(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}
