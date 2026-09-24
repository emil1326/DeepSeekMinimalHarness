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
  DEFAULT_LIMITS,
  DeepSeekClient,
  Sandbox,
  SandboxRefusal,
  readApiKey,
  realPath,
  writeTranscript,
  type RunEventBody,
  type RunLimits,
  type RunStatus,
  type Speaker,
} from '@emilswork/harness-core';
import { runAgentLoop, type LoopControl } from './loop.js';
import { isGitWorktree, snapshotChanges, strayChanges } from './stray.js';
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
/**
 * The limits in force, mutated in place.
 *
 * The loop reads this object on every turn, so a `limits` message from the
 * daemon takes effect on the next model call rather than the next run. It starts
 * from the task's own limits and is handed over as `control.limits` in `start`.
 */
const limits: RunLimits = { ...DEFAULT_LIMITS };

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
    return;
  }
  if (raw.type === 'limits') {
    // Mutated in place, because the loop holds this object and reads it on every
    // turn. Replacing it would leave the loop reading the old numbers.
    Object.assign(limits, raw.limits);
    return;
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
      // The project's own commands, which become tools, and the environment
      // they run in. Both came from the workspace and were resolved once, when
      // the task was read, so nothing here has to know what they mean.
      commands: config.config.commands,
      env: config.config.env,
      soft: config.config.soft,
    });
    running = sandbox;

    // Taken before the agent makes a single call, so the report at the end can
    // tell what this run did from what was already there. See `reportStray`.
    const baseline = snapshotChanges(root);

    // The task's own limits, into the live object the loop reads.
    Object.assign(limits, config.config.limits);

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
      // The live object, so a grant that arrives mid-run is picked up.
      limits,
    };

    emit({ type: 'status', status: 'running' });
    const result = await runAgentLoop(
      {
        sandbox,
        client,
        config: config.config,
        emit,
        ...(config.prices ? { prices: config.prices } : {}),
        ...(config.resume ? { resume: config.resume } : {}),
        // Written as the run goes, so a run that stops at a limit can be
        // carried on from exactly where it got to, with its prefix intact and
        // therefore with the prompt cache still hitting.
        onTranscript: (messages) => writeTranscript(config.runId, messages),
      },
      control,
    );
    reportStray(root, sandbox, baseline);
    tellThenExit(result.status, result.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tellThenExit('failed', null, message);
  } finally {
    sandbox?.killChecks();
    running = undefined;
  }
}

/**
 * Anything changed since this run started, reported however it got changed.
 *
 * The baseline is the whole point of the split. Without it, a second run in a
 * worktree already holding a first run's work reported every one of the first
 * run's files as a change this run made: true, and useless, and it buried the
 * one file that this run really did touch on the wrong side of a line.
 */
function reportStray(root: string, sandbox: Sandbox, baseline: Iterable<string>): void {
  const stray = strayChanges(root, sandbox.allow, { soft: sandbox.soft, baseline });
  if (stray.failure !== null) {
    // Said out loud rather than passed over. "Could not tell" and "nothing
    // stray" are different answers, and reporting the second when the first is
    // true is how the loudest control in the harness used to lie on a dirty
    // worktree.
    emit({
      type: 'error',
      message: `could not check for stray changes: ${stray.failure}`,
    });
    return;
  }
  if (stray.files.length > 0) emit({ type: 'stray', files: stray.files });
  if (stray.offPlan.length > 0) emit({ type: 'offPlan', files: stray.offPlan });
  if (stray.preExisting.length > 0) {
    // Not a complaint. A reader comparing this run's diff against a list of
    // changes needs to know which of them were somebody else's.
    emit({
      type: 'message',
      by: 'system',
      text: `${stray.preExisting.length} file(s) were already changed before this run started, so they are left out of the report: ${stray.preExisting.join(', ')}`,
    });
  }
}
