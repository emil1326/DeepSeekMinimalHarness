import fs from 'node:fs';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
  daemonFile,
  delay,
  isAlive,
  type DaemonRecord,
  type FailureCause,
  type RunEvent,
  type RunStatus,
} from '@emilswork/harness-core';
import { daemonEntry, type RunDetail, type RunSummary } from '@emilswork/harness-daemon';
import type { RunReport } from '@emilswork/harness-core';

/** Nothing is running and nothing could be started. */
export class DaemonUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnreachable';
  }
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly problems: { path: string; message: string; file: string | null }[];
  constructor(
    status: number,
    message: string,
    problems: { path: string; message: string; file: string | null }[] = [],
  ) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.problems = problems;
  }
}

export function readDaemonRecord(): DaemonRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(daemonFile(), 'utf8')) as DaemonRecord;
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export class DaemonClient {
  constructor(private readonly record: DaemonRecord) {}

  get port(): number {
    return this.record.port;
  }

  get base(): string {
    return `http://127.0.0.1:${this.record.port}`;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.record.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new DaemonUnreachable(
        `the daemon on port ${this.record.port} did not answer: ${(error as Error).message}`,
      );
    }
    const text = await response.text();
    const parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    if (!response.ok) {
      throw new ApiFailure(
        response.status,
        String(parsed.error ?? `the daemon answered ${response.status}`),
        (parsed.problems as { path: string; message: string; file: string | null }[] | undefined) ?? [],
      );
    }
    return parsed as T;
  }

  health(): Promise<{ ok: boolean; pid: number; port: number }> {
    return this.json<{ ok: boolean; pid: number; port: number }>('GET', '/health');
  }

  /** A socket for a run's events. Attaching is what owns the run. */
  attach(runId: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${this.record.port}/runs/${runId}/attach`, {
      headers: { authorization: `Bearer ${this.record.token}` },
    });
  }

  notices(): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${this.record.port}/events`, {
      headers: { authorization: `Bearer ${this.record.token}` },
    });
  }

  events(runId: string, after = 0): Promise<{ events: RunEvent[] }> {
    return this.json<{ events: RunEvent[] }>('GET', `/runs/${runId}/events?after=${after}`);
  }

  run(runId: string): Promise<RunDetail> {
    return this.json<RunDetail>('GET', `/runs/${runId}`);
  }

  runs(): Promise<{ runs: RunSummary[] }> {
    return this.json<{ runs: RunSummary[] }>('GET', '/runs');
  }

  report(runId: string): Promise<{ report: RunReport }> {
    return this.json<{ report: RunReport }>('GET', `/runs/${runId}/report`);
  }

  /** Started automatically by the first CLI call if it is not running. */
  static async connect(): Promise<DaemonClient> {
    const existing = readDaemonRecord();
    if (existing !== null && (await responds(existing))) return new DaemonClient(existing);

    const before = existing?.pid;
    const child = spawn(process.execPath, [daemonEntry()], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    const waitMs = Number(process.env.DSH_DAEMON_TIMEOUT_MS ?? '20000');
    const deadline = Date.now() + (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 20_000);
    while (Date.now() < deadline) {
      await delay(200);
      const started = readDaemonRecord();
      if (started === null || started.pid === before) continue;
      if (await responds(started)) return new DaemonClient(started);
    }
    throw new DaemonUnreachable(
      `the daemon did not come up; start it by hand with \`dsh daemon start\` and read its output`,
    );
  }
}

async function responds(record: DaemonRecord): Promise<boolean> {
  if (record.pid !== 0 && !isAlive(record.pid)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/health`, {
      headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const EXIT_CODES: Record<RunStatus, number> = {
  finished: 0,
  failed: 1,
  cancelled: 2,
  stopped_at_limit: 3,
  interrupted: 1,
  running: 1,
  waiting: 1,
  queued: 1,
};

/**
 * The exit code for a run that failed for a reason worth stopping for.
 *
 * 6, because 0 to 5 are taken by the statuses and by a bad task file and an
 * unreachable daemon. It exists so an orchestrator can stop: a run that failed
 * because the account has no credit left or the key was refused will fail again
 * the same way, in a few seconds, for as long as somebody leaves the loop
 * running. Without a code of its own, that is indistinguishable from a run that
 * failed because the model answered badly, which very much is worth retrying.
 */
export const EXIT_PROVIDER_REFUSED = 6;

export function exitCodeFor(status: RunStatus, cause?: FailureCause): number {
  if (cause === 'provider_balance' || cause === 'provider_auth') return EXIT_PROVIDER_REFUSED;
  return EXIT_CODES[status] ?? 1;
}
