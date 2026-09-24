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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMITS,
  DeepSeekClient,
  Sandbox,
  SandboxRefusal,
  checkPassed,
  describeCause,
  dataDir,
  readApiKey,
  realPath,
  relNorm,
  timing,
  writePrivateText,
  writeTranscript,
  type RunEventBody,
  type RunLimits,
  type RunStatus,
  type Speaker,
} from '@emilswork/harness-core';
import { runAgentLoop, type LoopControl } from './loop.js';
import { isGitWorktree, snapshotChanges, strayChanges } from './stray.js';
import type { DaemonToWorker, WorkerStart, WorkerToDaemon } from './protocol.js';

function send(message: WorkerToDaemon, landed?: (error: Error | null) => void): void {
  // `process.send` is **undefined** once the channel to the daemon is gone, not a
  // function that throws. So every `send` after a disconnect is a silent no-op,
  // which is how a worker can run to the end of a run and say nothing about it.
  if (process.send === undefined || !process.connected) {
    landed?.(new Error('the channel to the daemon is gone'));
    return;
  }
  // `undefined` for the handle and the options, because the callback is the only
  // one of the three this needs and the signature puts it last.
  process.send(message, undefined, undefined, landed);
}

/**
 * The daemon stamps the sequence number and the run id; this adds the time.
 *
 * Timed, because this is the harness's own IPC and a tool result is a string of
 * up to 8000 characters that is serialised, copied across a pipe and parsed on
 * the other side on every single call. If a run's overhead is anywhere, it is
 * here, and nothing else in the harness could show it.
 */
function emit(body: RunEventBody): void {
  timing.measure('worker.emit', () => send({ type: 'event', body, at: new Date().toISOString() }));
}

/**
 * The stopwatch's readings, handed to the daemon.
 *
 * Cumulative, so the daemon replaces this run's rows rather than adding to
 * them. Called at every turn boundary and once more before the run says it is
 * done, because the last flush is the one that would be lost to a kill.
 */
function flushTimings(): void {
  send({ type: 'timings', snapshot: timing.snapshot() });
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
  // Before `done`, because the daemon may stop the worker the moment it sees
  // one and the readings of a cancelled run are the interesting ones.
  flushTimings();

  /** Out, once. The second caller is whichever of the two paths below loses. */
  const leave = (code: number): void => process.exit(code);

  // `process.exit` discards whatever is still queued on the IPC channel, and this
  // used to say `done` and then exit 30 ms later — a delay that is usually enough
  // and was never anything more than a guess. The callback fires when the write
  // has actually landed, so there is nothing left to guess about.
  send({ type: 'done', status, summary }, (error) => leave(error === null ? 0 : 1));

  // Nothing waits for ever: a channel that never calls back would hang the worker,
  // which is worse than a message that did not make it.
  setTimeout(() => leave(0), 1000);
}

async function start(config: WorkerStart): Promise<void> {
  send({ type: 'ready', pid: process.pid, runId: config.runId });

  let sandbox: Sandbox | undefined;
  try {
    const root = realPath(config.config.worktree);
    if (!fs.existsSync(path.join(root, '.git')) || !isGitWorktree(root)) {
      throw new SandboxRefusal('the sandbox must be a git worktree, so every change it makes is a diff');
    }
    Sandbox.assertOutsideOrProtected(config.config.profile, root, 'the profile');
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

    const built = timing.measure(
      'worker.setup.sandbox',
      () =>
        new Sandbox({
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
        }),
    );
    sandbox = built;
    running = sandbox;

    // Taken before the agent makes a single call, so the report at the end can
    // tell what this run did from what was already there. See `reportStray`.
    // A continuation's own start is its parent's end, so what the parent wrote
    // is this run's work and not something that was already there.
    const inherited = new Set((config.inherited ?? []).map((file) => relNorm(file)));
    const baseline = timing
      .measure('worker.setup.baseline', () => snapshotChanges(root))
      .filter((file) => !inherited.has(relNorm(file)));

    await timing.measureAsync('worker.setup.workspace', () => runSetup(built, config));

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
        // The readings, once per turn and once before the exit, so that a run
        // stopped by a kill still reports the turns it managed.
        flushTimings,
        // So a run that asks a question nobody is watching does not spend its
        // whole allowance waiting for an answer that is not coming.
        onQuestion: (id, question) => {
          const onAsk = config.config.onAsk;
          if (onAsk === null || sandbox === undefined) return;
          sandbox.notify(onAsk.run, `${question}\n`, {
            DSH_RUN: config.runId,
            DSH_QUESTION: id,
          });
        },
      },
      control,
    );
    reportStray(root, sandbox, baseline);
    if (result.cause !== undefined) {
      // On the terminal status, where a launcher already looks, rather than in
      // a separate event it would have to know to watch for.
      emit({
        type: 'status',
        status: result.status,
        cause: result.cause,
        detail: describeCause(result.cause),
      });
    }
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
 * The project's setup steps, run once per worktree rather than once per run.
 *
 * The case that prompted it: a project whose routing tests all failed for a
 * missing DLL unless one crate had been built first, which is a `cargo build
 * -p x` and not something a task file should have to know. Once per worktree
 * because it is a property of the tree, not of the run, and the marker file is
 * how that is remembered across runs and across restarts.
 *
 * A step that fails does not stop the run. It is announced, and the agent gets
 * to work in a tree where something is missing, which is very often recoverable
 * — and a harness that refused to start would be trading a likely success for a
 * certain failure.
 */
async function runSetup(sandbox: Sandbox, config: WorkerStart): Promise<void> {
  const steps = config.config.setup;
  if (steps.length === 0) return;
  const marker = setupMarker(config.config.worktree, steps);
  if (fs.existsSync(marker)) return;

  emit({ type: 'status', status: 'running', detail: `setup: ${steps.length} step(s)` });
  for (const step of steps) {
    const argv = step.run;
    const output = await sandbox.run(argv, (step.timeoutSeconds ?? 300) * 1000);
    if (!checkPassed(output)) {
      emit({
        type: 'error',
        message: `setup step \`${argv.join(' ')}\` did not pass, so the worktree may not be ready:\n${output.slice(0, 2000)}`,
      });
    }
  }
  // Written only after every step has been attempted, so a setup that failed
  // half way is retried by the next run rather than being remembered as done.
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    writePrivateText(marker, `${new Date().toISOString()}\n`);
  } catch {
    /* best effort: a missing marker costs a repeated setup, not a lost run */
  }
}

/**
 * Where the record of "this worktree has been set up" lives.
 *
 * Keyed by the worktree *and* the steps, so editing the steps re-runs them, and
 * so two worktrees of one project are set up independently. In the harness's own
 * directory rather than the worktree: it must not turn up in the run's own diff.
 */
function setupMarker(worktree: string, steps: unknown): string {
  const key = createHash('sha256').update(worktree).update(JSON.stringify(steps)).digest('hex');
  return path.join(dataDir(), 'setup', `${key.slice(0, 16)}.done`);
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
  // A `git status -uall` over the whole worktree, at the end of every run and
  // after the model has stopped billing: it costs nothing but time, and this is
  // the only place that time is visible.
  const stray = timing.measure('worker.stray.report', () =>
    strayChanges(root, sandbox.allow, { soft: sandbox.soft, baseline }),
  );
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
