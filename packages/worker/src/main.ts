/**
 * One agent, one process.
 *
 * The daemon forks this, hands it the resolved config over IPC, and gets events
 * back the same way. A crash here cannot take the daemon down, and cancelling
 * is a process-tree kill rather than hoping a promise chain unwinds.
 *
 * The key is never sent over IPC: this reads `~/.deepseek/api_key` itself, and
 * never logs it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeepSeekClient,
  Sandbox,
  SandboxRefusal,
  readApiKey,
  realPath,
  type RunEventBody,
  type RunStatus,
  type Speaker,
} from '@emilswork/harness-core';
import { runAgentLoop, type LoopControl } from './loop.js';
import { isGitWorktree, strayChanges } from './stray.js';
import type { DaemonToWorker, WorkerStart, WorkerToDaemon } from './protocol.js';

function send(message: WorkerToDaemon): void {
  process.send?.(message);
}

/** The daemon stamps the sequence number and the run id; this adds the time. */
function emit(body: RunEventBody): void {
  send({ type: 'event', body, at: new Date().toISOString() });
}

const controller = new AbortController();
const queued: { text: string; by: Speaker }[] = [];
const waiting = new Map<string, (answer: { text: string; by: Speaker } | null) => void>();
let cancelReason: string | null = null;
/** Set once the sandbox exists, so a cancel can kill the checks it started. */
let running: Sandbox | undefined;

function cancel(reason: string): void {
  if (cancelReason !== null) return;
  cancelReason = reason;
  controller.abort();
  // A check process may be minutes into its run; it dies now, not when the
  // model call happens to unwind.
  running?.killChecks();
  for (const [, resolve] of waiting) resolve(null);
  waiting.clear();
}

process.on('disconnect', () => {
  // The daemon is gone. Nothing of this run may outlive it.
  tellThenExit('cancelled', null, 'the daemon went away');
});

process.on('message', (raw: DaemonToWorker) => {
  if (raw.type === 'start') return void start(raw);
  if (raw.type === 'message') {
    queued.push({ text: raw.text, by: raw.by });
    return;
  }
  if (raw.type === 'answer') {
    const resolve = waiting.get(raw.id);
    if (resolve) {
      waiting.delete(raw.id);
      resolve({ text: raw.text, by: raw.by });
    }
    return;
  }
  if (raw.type === 'cancel') {
    cancel(raw.reason);
  }
});

let exiting = false;
function tellThenExit(status: RunStatus, summary: string | null, detail?: string): void {
  if (exiting) return;
  exiting = true;
  if (detail !== undefined) emit({ type: 'error', message: detail });
  send({ type: 'done', status, summary });
  setTimeout(() => process.exit(0), 30);
}

async function start(config: WorkerStart): Promise<void> {
  send({ type: 'ready', pid: process.pid, runId: config.runId });

  let sandbox: Sandbox | undefined;
  try {
    const root = realPath(config.config.worktree);
    if (!fs.existsSync(path.join(root, '.git')) || !isGitWorktree(root)) {
      throw new SandboxRefusal('the sandbox must be a git worktree, so every change it makes is a diff');
    }
    Sandbox.assertOutsideSandbox(config.config.profile, root, 'the profile');
    Sandbox.assertOutsideSandbox(fileURLToPath(import.meta.url), root, 'the harness');
    try {
      Sandbox.assertOutsideSandbox(
        fileURLToPath(import.meta.resolve('@emilswork/harness-core')),
        root,
        'the harness',
      );
    } catch {
      /* the worker entry above is the load-bearing one */
    }

    sandbox = new Sandbox({
      root,
      allow: config.config.allow,
      profile: config.config.resolvedProfile,
      checkNames: config.config.checks,
    });
    running = sandbox;

    const client = new DeepSeekClient({
      apiKey: readApiKey(),
      baseUrl: config.baseUrl,
    });

    const control: LoopControl = {
      signal: controller.signal,
      takeMessages: () => queued.splice(0, queued.length),
      waitForAnswer: (id, timeoutMs, signal) =>
        new Promise((resolve) => {
          const finish = (answer: { text: string; by: Speaker } | null): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            waiting.delete(id);
            resolve(answer);
          };
          const timer = setTimeout(() => finish(null), timeoutMs);
          const onAbort = (): void => finish(null);
          signal.addEventListener('abort', onAbort, { once: true });
          waiting.set(id, finish);
        }),
    };

    emit({ type: 'status', status: 'running' });
    const result = await runAgentLoop(
      { sandbox, client, config: config.config, emit, ...(config.price ? { price: config.price } : {}) },
      control,
    );
    reportStray(root, sandbox);
    tellThenExit(result.status, result.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tellThenExit('failed', null, message);
  } finally {
    sandbox?.killChecks();
    running = undefined;
  }
}

/** Anything changed outside the allowed files is reported, whatever caused it. */
function reportStray(root: string, sandbox: Sandbox): void {
  const stray = strayChanges(root, sandbox.allow);
  if (stray.length > 0) emit({ type: 'stray', files: stray });
}
