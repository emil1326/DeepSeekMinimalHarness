import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  emptyTotals,
  isTerminal,
  metricsVersionOf,
  type PriceTable,
  type ResolvedRunConfig,
  type RunEvent,
  type RunEventBody,
  type RunStatus,
  type RunTotals,
} from '@emilswork/harness-core';
import type { ModelStats, RunDetail, RunSummary } from './protocol.js';

/**
 * A metrics event's `call` as it comes back out of the database.
 *
 * Loose by design: these objects were written by an older build of the harness
 * and nothing rewrites them, so a field may be absent, `null`, a number, or —
 * for `model` — a string.
 */
export type StoredCall = Record<string, number | string | null>;

type Db = InstanceType<typeof Database>;

interface RunRow {
  id: string;
  name: string;
  status: string;
  config_json: string;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  detail: string | null;
  summary: string | null;
  turns: number;
  detached: number;
  totals_json: string | null;
}

interface EventRow {
  seq: number;
  run_id: string;
  at: string;
  type: string;
  payload_json: string;
}

/**
 * Runs and their event logs.
 *
 * The event log is append-only and is the only copy of the truth: the chat
 * view, the CLI stream, `dsh logs` and a resume after a restart are all just
 * readers of this one list.
 */
export class Store {
  private readonly db: Db;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        detail TEXT,
        summary TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        detached INTEGER NOT NULL DEFAULT 0,
        totals_json TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** A run left `running` by a crash is not running any more, and says so. */
  markRunningAsInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', ended_at = ?,
           detail = coalesce(detail, 'the daemon stopped while this run was going')
         WHERE status IN ('queued', 'running', 'waiting')`,
      )
      .run(new Date().toISOString());
    return result.changes;
  }

  createRun(input: {
    id: string;
    name: string;
    config: ResolvedRunConfig;
    detached: boolean;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, name, status, config_json, created_at, detached, totals_json)
         VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        JSON.stringify(input.config),
        input.createdAt,
        input.detached ? 1 : 0,
        JSON.stringify(emptyTotals()),
      );
  }

  appendEvent(runId: string, body: RunEventBody, at: string): RunEvent {
    const inserted = this.db
      .prepare('INSERT INTO events (run_id, at, type, payload_json) VALUES (?, ?, ?, ?)')
      .run(runId, at, body.type, JSON.stringify(body));
    return { seq: Number(inserted.lastInsertRowid), runId, at, ...body } as RunEvent;
  }

  eventsAfter(runId: string, after: number, limit = 5000): RunEvent[] {
    const rows = this.db
      .prepare(
        'SELECT seq, run_id, at, type, payload_json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .all(runId, after, limit) as EventRow[];
    return rows.map(
      (row) =>
        ({
          seq: row.seq,
          runId: row.run_id,
          at: row.at,
          ...(JSON.parse(row.payload_json) as RunEventBody),
        }) as RunEvent,
    );
  }

  setStatus(
    runId: string,
    status: RunStatus,
    patch: { detail?: string | null; summary?: string | null; turns?: number; totals?: RunTotals } = {},
  ): void {
    const existing = this.row(runId);
    if (existing === null) return;
    const startedAt =
      existing.started_at ?? (status === 'running' || status === 'waiting' ? new Date().toISOString() : null);
    this.db
      .prepare(
        `UPDATE runs SET status = ?, started_at = ?, ended_at = ?, detail = ?, summary = ?,
           turns = ?, totals_json = ? WHERE id = ?`,
      )
      .run(
        status,
        startedAt,
        isTerminal(status) ? new Date().toISOString() : null,
        patch.detail !== undefined ? patch.detail : existing.detail,
        patch.summary !== undefined ? patch.summary : existing.summary,
        patch.turns ?? existing.turns,
        JSON.stringify(patch.totals ?? parseTotals(existing.totals_json)),
        runId,
      );
  }

  detail(runId: string, text: string | null): void {
    this.db.prepare('UPDATE runs SET detail = ? WHERE id = ?').run(text, runId);
  }

  /**
   * Keep a running run's progress in the row, not just in the supervisor.
   *
   * Found live: `list`, `show` and the UI read the row, and the row was only
   * written when a `status` event arrived. A normal run emits `status: running`
   * once at the start and nothing again until it ends, so a run that was 44
   * turns deep and 200,000 prompt tokens in still reported 0 turns and 0 tokens
   * to every one of those readers, and reported the real figures only once it
   * had finished and there was nothing left to watch.
   *
   * Called once per turn from the metrics event, so the cost is one small UPDATE
   * per model call, against a model call that takes most of a second.
   */
  progress(runId: string, turns: number, totals: RunTotals): void {
    this.db
      .prepare('UPDATE runs SET turns = ?, totals_json = ? WHERE id = ?')
      .run(turns, JSON.stringify(totals), runId);
  }

  getRun(runId: string): RunDetail | null {
    const row = this.row(runId);
    if (row === null) return null;
    return toDetail(row, 0);
  }

  listRuns(owners: (runId: string) => number): RunSummary[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as RunRow[];
    return rows.map((row) => toDetail(row, owners(row.id)));
  }

  /**
   * Every metrics event, oldest first, as it was stored.
   *
   * `call` is typed loosely on purpose. It is read back out of JSON that an
   * older build wrote, so a field can be missing, `null`, or — for `model` — a
   * string, and the old type said `number | null` throughout, which `model`
   * never satisfied. `summarise` treats anything it cannot recognise as absent.
   */
  allMetrics(): { model: string; call: StoredCall; runId: string }[] {
    const rows = this.db
      .prepare("SELECT run_id, payload_json FROM events WHERE type = 'metrics' ORDER BY seq")
      .all() as { run_id: string; payload_json: string }[];
    return rows.map((row) => {
      const body = JSON.parse(row.payload_json) as { call: StoredCall };
      return { model: String(body.call.model ?? 'unknown'), call: body.call, runId: row.run_id };
    });
  }

  countRuns(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
    return row.n;
  }

  private row(runId: string): RunRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row ?? null;
  }
}

function parseTotals(json: string | null): RunTotals {
  if (json === null) return emptyTotals();
  try {
    // `timedCalls` arrived after the first runs were written, so a stored total
    // from before it reads as zero rather than a hole in the type.
    return { ...emptyTotals(), ...(JSON.parse(json) as Partial<RunTotals>) };
  } catch {
    return emptyTotals();
  }
}

function toDetail(row: RunRow, owners: number): RunDetail {
  return {
    id: row.id,
    name: row.name,
    status: row.status as RunStatus,
    model: (JSON.parse(row.config_json) as ResolvedRunConfig).model,
    worktree: (JSON.parse(row.config_json) as ResolvedRunConfig).worktree,
    turns: row.turns,
    totals: parseTotals(row.totals_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    detail: row.detail,
    detached: row.detached === 1,
    owners,
    config: JSON.parse(row.config_json) as ResolvedRunConfig,
    summary: row.summary,
  };
}

interface Accumulator {
  model: string;
  metricsVersion: number;
  calls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  ttftSum: number;
  ttftCount: number;
  generationSum: number;
  generationCount: number;
  endToEndSum: number;
  endToEndCount: number;
  costUsd: number | null;
}

export function summarise(
  metrics: ReturnType<Store['allMetrics']>,
  prices: PriceTable | undefined,
): ModelStats[] {
  const byModel = new Map<string, Accumulator>();
  // Anything that is not a number counts as nothing. A stored row is JSON from
  // an older build, so a field can be missing or the wrong shape, and one bad
  // row must not turn a whole column into a NaN or a string.
  const number = (value: number | string | null | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;

  for (const { model, call } of metrics) {
    // Grouped by model *and* method. A run recorded before the decode figure was
    // fixed carries a number computed a different way, and averaging it with a
    // correct one produces a figure that describes neither. Splitting the row is
    // the honest option: the two are visible side by side, and nothing is hidden
    // or silently dropped.
    const version = metricsVersionOf(call);
    const key = `${model}\u0000${version}`;
    const current = byModel.get(key) ?? {
      model,
      metricsVersion: version,
      calls: 0,
      promptTokens: 0,
      cacheHitTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      ttftSum: 0,
      ttftCount: 0,
      generationSum: 0,
      generationCount: 0,
      endToEndSum: 0,
      endToEndCount: 0,
      costUsd: null,
    };
    current.calls += 1;
    current.promptTokens += number(call.promptTokens);
    current.cacheHitTokens += number(call.cacheHitTokens);
    current.completionTokens += number(call.completionTokens);
    // Runs recorded before the reasoning channel was read have no field for it,
    // so this reads zero rather than turning the total into a NaN.
    current.reasoningTokens += number(call.reasoningTokens);
    if (typeof call.timeToFirstTokenMs === 'number') {
      current.ttftSum += call.timeToFirstTokenMs;
      current.ttftCount += 1;
    }
    if (typeof call.generationTokensPerSecond === 'number') {
      current.generationSum += call.generationTokensPerSecond;
      current.generationCount += 1;
    }
    if (typeof call.endToEndTokensPerSecond === 'number') {
      current.endToEndSum += call.endToEndTokensPerSecond;
      current.endToEndCount += 1;
    }
    const price = prices?.[model];
    if (price !== undefined) {
      const billed = Math.max(0, number(call.promptTokens) - number(call.cacheHitTokens));
      const cost =
        (billed * price.inputPerMillion +
          number(call.cacheHitTokens) * (price.cacheHitPerMillion ?? price.inputPerMillion) +
          number(call.completionTokens) * price.outputPerMillion) /
        1_000_000;
      current.costUsd = (current.costUsd ?? 0) + cost;
    }
    byModel.set(key, current);
  }

  const average = (sum: number, count: number): number | null =>
    count === 0 ? null : Math.round((sum / count) * 10) / 10;

  // Newest method first within a model, then by name, so the table's order is
  // the same whichever way the rows came out of the database.
  return [...byModel.values()]
    .sort((a, b) => a.model.localeCompare(b.model) || b.metricsVersion - a.metricsVersion)
    .map((entry) => ({
      model: entry.model,
      metricsVersion: entry.metricsVersion,
      calls: entry.calls,
      promptTokens: entry.promptTokens,
      cacheHitTokens: entry.cacheHitTokens,
      completionTokens: entry.completionTokens,
      reasoningTokens: entry.reasoningTokens,
      timeToFirstTokenMs: average(entry.ttftSum, entry.ttftCount),
      generationTokensPerSecond: average(entry.generationSum, entry.generationCount),
      endToEndTokensPerSecond: average(entry.endToEndSum, entry.endToEndCount),
      costUsd: entry.costUsd === null ? null : Math.round(entry.costUsd * 1e6) / 1e6,
    }));
}
