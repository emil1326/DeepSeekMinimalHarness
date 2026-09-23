import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  emptyTotals,
  isTerminal,
  killTree,
  loadRunConfig,
  readApiKey,
  type PriceTable,
  type RunEvent,
  type RunStatus,
  type RunTotals,
  type Speaker,
} from '@emilswork/harness-core';
import type { DaemonToWorker, WorkerToDaemon } from '@emilswork/harness-worker';
import { workerEntry } from '@emilswork/harness-worker';
import type { Store } from './store.js';
import type { RunDetail } from './protocol.js';

export function newRunId(): string {
  return `run-${randomBytes(4).toString('hex')}`;
}

interface RunState {
  child: ChildProcess | null;
  owners: number;
  totals: RunTotals;
  turns: number;
  cancelled: boolean;
  /** Question ids waiting for an answer. */
  pending: string[];
  killTimer: NodeJS.Timeout | null;
  swapTimer: NodeJS.Timeout | null;
  graceTimer: NodeJS.Timeout | null;
  stderr: string;
}

export interface SupervisorOptions {
  store: Store;
  baseUrl: string;
  prices?: PriceTable;
  /** Overridden in tests so a fork can be watched from outside. */
  workerScript?: string;
  /** A run nobody ever attaches to is dropped rather than left queued for ever. */
  unattachedGraceMs?: number;
  /** How long the worker gets to cancel itself before the tree is killed. */
  swapMs?: number;
}

export class Supervisor {
  /** Set by whoever is serving the API; called for every event and every change. */
  onEvent: ((event: RunEvent) => void) | undefined;
  onRunChange: ((runId: string) => void) | undefined;

  private readonly store: Store;
  private readonly options: SupervisorOptions;
  private readonly states = new Map<string, RunState>();

  constructor(options: SupervisorOptions) {
    this.store = options.store;
    this.options = options;
  }

  /** The task is read and validated here, and stored with the run exactly as used. */
  createRun(taskPath: string, detached: boolean): RunDetail {
    // Fail before the fork when there is no key, with something readable.
    readApiKey();
    const config = loadRunConfig(taskPath);
    const id = newRunId();
    const createdAt = new Date().toISOString();
    this.store.createRun({ id, name: config.name, config, detached, createdAt });
    this.states.set(id, freshState());
    this.append(id, { type: 'status', status: 'queued' }, createdAt);
    if (detached) {
      this.start(id);
    } else {
      const state = this.states.get(id);
      if (state !== undefined) {
        state.graceTimer = setTimeout(() => {
          this.cancel(id, 'nothing ever attached to this run');
        }, this.options.unattachedGraceMs ?? 60_000);
      }
    }
    const detail = this.store.getRun(id);
    if (detail === null) throw new Error(`the run ${id} vanished as it was created`);
    return { ...detail, owners: this.ownersOf(id) };
  }

  start(runId: string): void {
    const state = this.states.get(runId);
    if (state === undefined || state.child !== null) return;
    const detail = this.store.getRun(runId);
    if (detail === null || isTerminal(detail.status)) return;

    if (state.graceTimer !== null) {
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }

    const child = fork(this.options.workerScript ?? workerEntry(), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: process.env,
      windowsHide: true,
    });
    state.child = child;

    child.on('message', (raw: WorkerToDaemon) => this.onWorkerMessage(runId, raw));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      state.stderr = `${state.stderr}${text}`.slice(-4000);
    });
    child.on('error', (error) => {
      this.append(runId, { type: 'error', message: `the worker failed: ${error.message}` }, now());
      this.finish(runId, 'failed', { detail: error.message });
    });
    child.on('exit', (code, signal) => {
      const current = this.states.get(runId);
      if (current === undefined || current.child !== child) return;
      current.child = null;
      const detailNow = this.store.getRun(runId);
      if (detailNow !== null && isTerminal(detailNow.status)) return;
      const why = current.cancelled
        ? 'cancelled'
        : `the worker stopped without finishing (code ${code ?? 'none'}, signal ${signal ?? 'none'})`;
      if (!current.cancelled) {
        this.append(
          runId,
          { type: 'error', message: `${why}\n${current.stderr.slice(-1000)}`.trim() },
          now(),
        );
      }
      this.finish(runId, current.cancelled ? 'cancelled' : 'failed', { detail: why });
    });

    const message: DaemonToWorker = {
      type: 'start',
      runId,
      config: detail.config,
      baseUrl: this.options.baseUrl,
      ...(this.options.prices?.[detail.config.model]
        ? { price: this.options.prices[detail.config.model] }
        : {}),
    };
    child.send(message);
  }

  private onWorkerMessage(runId: string, raw: WorkerToDaemon): void {
    const state = this.states.get(runId);
    if (state === undefined) return;
    if (raw.type === 'ready') return;

    if (raw.type === 'event') {
      const body = raw.body;
      this.append(runId, body, raw.at);
      if (body.type === 'turn.start') state.turns = Math.max(state.turns, body.turn);
      if (body.type === 'metrics') {
        state.totals = body.totals;
        // Written through to the row as well as kept in hand, so a reader of the
        // row sees progress while the run is still going. See `Store.progress`.
        this.store.progress(runId, state.turns, state.totals);
        this.onRunChange?.(runId);
      }
      if (body.type === 'question') state.pending.push(body.id);
      if (body.type === 'answer') state.pending = state.pending.filter((id) => id !== body.id);
      if (body.type === 'stray') {
        this.store.detail(runId, `STRAY CHANGES OUTSIDE THE ALLOWED FILES: ${body.files.join(', ')}`);
      }
      return;
    }

    if (raw.type === 'done') {
      this.finish(runId, raw.status, raw.summary === null ? {} : { summary: raw.summary });
      return;
    }

    if (raw.type === 'fatal') {
      this.append(runId, { type: 'error', message: raw.message }, now());
      this.finish(runId, 'failed', { detail: raw.message });
    }
  }

  private append(runId: string, body: Parameters<Store['appendEvent']>[1], at: string): RunEvent {
    const event = this.store.appendEvent(runId, body, at);
    if (body.type === 'status') {
      const state = this.states.get(runId);
      this.store.setStatus(runId, body.status, {
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        ...(state ? { totals: state.totals, turns: state.turns } : {}),
      });
      this.onRunChange?.(runId);
    }
    this.onEvent?.(event);
    return event;
  }

  private finish(
    runId: string,
    status: RunStatus,
    patch: { detail?: string; summary?: string | null } = {},
  ): void {
    const state = this.states.get(runId);
    if (state !== undefined) {
      if (state.killTimer !== null) clearTimeout(state.killTimer);
      if (state.swapTimer !== null) clearTimeout(state.swapTimer);
      if (state.graceTimer !== null) clearTimeout(state.graceTimer);
      this.states.delete(runId);
    }
    const before = this.store.getRun(runId);
    if (before !== null && isTerminal(before.status)) return;
    // The event log always ends with a terminal status, so every reader of it
    // (the CLI stream, the UI, `dsh logs`) can tell a finished run from a
    // connection that just went quiet.
    this.append(
      runId,
      { type: 'status', status, ...(patch.detail !== undefined ? { detail: patch.detail } : {}) },
      now(),
    );
    if (patch.summary !== undefined || state !== undefined) {
      this.store.setStatus(runId, status, {
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(state !== undefined ? { totals: state.totals, turns: state.turns } : {}),
      });
    }
  }

  /** Abort the model call, kill the worker, kill every check process, and say cancelled. */
  cancel(runId: string, reason: string): void {
    const state = this.states.get(runId);
    const detail = this.store.getRun(runId);
    if (detail === null) return;
    if (detail !== null && isTerminal(detail.status)) return;
    if (state === undefined) {
      this.store.setStatus(runId, 'cancelled', { detail: `cancelled: ${reason}` });
      this.onRunChange?.(runId);
      return;
    }

    state.cancelled = true;
    if (state.graceTimer !== null) {
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }
    if (state.child !== null) {
      const pid = state.child.pid ?? -1;
      try {
        state.child.send({ type: 'cancel', reason } satisfies DaemonToWorker);
      } catch {
        /* it is already gone */
      }
      // The worker aborts the model call and kills its own checks. If it has
      // not managed it in this long, the whole tree goes, checks included.
      state.killTimer = setTimeout(() => killTree(pid), this.options.swapMs ?? 750);
    }
    state.swapTimer = setTimeout(
      () => this.finish(runId, 'cancelled', { detail: `cancelled: ${reason}` }),
      2000,
    );
    this.append(
      runId,
      { type: 'status', status: 'cancelled', detail: `cancelled: ${reason}` },
      new Date().toISOString(),
    );
  }

  sendMessage(runId: string, text: string, by: Speaker): void {
    const state = this.states.get(runId);
    const detail = this.store.getRun(runId);
    if (detail === null) throw new Error(`no run called ${runId}`);
    // Recorded now so the UI shows it at once; the worker delivers it at the
    // next turn boundary and does not record it twice.
    this.append(runId, { type: 'message', by, text }, new Date().toISOString());
    if (state?.child != null) {
      state.child.send({ type: 'message', text, by } satisfies DaemonToWorker);
    }
  }

  answer(runId: string, id: string | undefined, text: string, by: Speaker): string {
    const state = this.states.get(runId);
    const questionId = id ?? state?.pending[state.pending.length - 1];
    if (questionId === undefined) throw new Error(`run ${runId} is not waiting on a question`);
    if (state?.child != null) {
      state.child.send({ type: 'answer', id: questionId, text, by } satisfies DaemonToWorker);
    }
    return questionId;
  }

  pendingQuestion(runId: string): string | null {
    const state = this.states.get(runId);
    return state?.pending[state.pending.length - 1] ?? null;
  }

  ownerAttached(runId: string): void {
    const state = this.states.get(runId);
    if (state === undefined) return;
    state.owners += 1;
    if (state.graceTimer !== null) {
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }
    this.start(runId);
    this.onRunChange?.(runId);
  }

  ownerLost(runId: string): void {
    const state = this.states.get(runId);
    if (state === undefined) return;
    state.owners = Math.max(0, state.owners - 1);
    this.onRunChange?.(runId);
    const detail = this.store.getRun(runId);
    if (detail === null || isTerminal(detail.status)) return;
    // The run's lifetime is tied to the connection that owns it.
    if (state.owners === 0 && !detail.detached) {
      this.cancel(runId, 'the connection that owned this run went away');
    }
  }

  ownersOf(runId: string): number {
    return this.states.get(runId)?.owners ?? 0;
  }

  isLive(runId: string): boolean {
    return this.states.has(runId);
  }

  liveRunIds(): string[] {
    return [...this.states.keys()];
  }

  /** Nothing survives the daemon going down. */
  shutdownAll(reason = 'the daemon stopped'): void {
    for (const runId of [...this.states.keys()]) {
      const state = this.states.get(runId);
      if (state?.child?.pid != null) killTree(state.child.pid);
      state?.child?.kill();
      this.finish(runId, 'cancelled', { detail: `cancelled: ${reason}` });
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

function freshState(): RunState {
  return {
    child: null,
    owners: 0,
    totals: emptyTotals(),
    turns: 0,
    cancelled: false,
    pending: [],
    killTimer: null,
    swapTimer: null,
    graceTimer: null,
    stderr: '',
  };
}
