import { fileURLToPath } from 'node:url';
export { runAgentLoop, type LoopControl, type LoopOptions, type LoopResult } from './loop.js';
export { isGitWorktree, strayChanges } from './stray.js';
export type { DaemonToWorker, EmittedEvent, WorkerStart, WorkerToDaemon } from './protocol.js';

/** Where the daemon forks the worker from. */
export function workerEntry(): string {
  return fileURLToPath(new URL('./main.js', import.meta.url));
}
