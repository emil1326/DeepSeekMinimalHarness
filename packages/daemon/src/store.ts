import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  DEFAULT_LIMITS,
  costOf,
  emptyTotals,
  isTerminal,
  mergeStats,
  metricsVersionOf,
  priceFor,
  round,
  TIMING_BUCKETS,
  byTotal,
  timing,
  type PriceTable,
  type ResolvedRunConfig,
  type RunEvent,
  type RunEventBody,
  type RunLimits,
  type RunStatus,
  type RunTotals,
  type TimingSnapshot,
  type TimingStat,
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
  /** Whether the work landed. Null until somebody says so. See `Store.tag`. */
  tag: string | null;
  tag_note: string | null;
  tagged_at: string | null;
  tag_lines_added: number | null;
  tag_lines_removed: number | null;
}

/** What an orchestrator says happened to a run's work, after its own gate. */
export const RUN_TAGS = ['landed', 'fixed', 'dropped'] as const;
export type RunTag = (typeof RUN_TAGS)[number];

/** One row of "did any of this work", grouped by what the run was. */
export interface OutcomeStats {
  model: string;
  /** The profile's file name, which is what a person calls the project's setup. */
  profile: string;
  runs: number;
  finished: number;
  stoppedAtLimit: number;
  failed: number;
  /** Tagged, by what the tag said. Untagged runs are in none of these. */
  landed: number;
  fixed: number;
  dropped: number;
  /** What every run in this row cost together, tagged or not. */
  costUsd: number | null;
  /**
   * Lines added by the runs that landed **as they were**.
   *
   * Only `landed`, deliberately. A run tagged `fixed` needed a human to finish
   * it, so its lines are not the harness's output, and counting them would make
   * the figure flatter itself.
   */
  landedLinesAdded: number;
  /**
   * Cost per line that landed untouched. Null when nothing did.
   *
   * The only cost figure that says anything. Tokens and turns are inputs; this
   * is what came out, and it is the number to compare two models, two prompts
   * or two budgets with.
   */
  costPerLandedLine: number | null;
}

interface EventRow {
  seq: number;
  run_id: string;
  at: string;
  type: string;
  payload_json: string;
}

interface TimingRow {
  run_id: string;
  name: string;
  count: number;
  total_ms: number;
  min_ms: number;
  max_ms: number;
  bytes: number;
  histogram_json: string;
  at: string;
}

/**
 * A stored readings row as a stat.
 *
 * Forgiving on purpose, the same way `StoredCall` is: these rows were written by
 * whichever build was running at the time, and a row with a shorter ladder in it
 * than this build has must not read as a run that was fast. The histogram is
 * padded with zeroes or truncated to the current number of buckets, so merging
 * stays a straight addition.
 */
function rowOf(row: TimingRow): TimingStat {
  let histogram: number[] = new Array<number>(TIMING_BUCKETS).fill(0);
  try {
    const parsed = JSON.parse(row.histogram_json) as unknown;
    if (Array.isArray(parsed)) {
      histogram = new Array<number>(TIMING_BUCKETS)
        .fill(0)
        .map((_, index) => (Number(parsed[index]) || 0) as number);
    }
  } catch {
    /* an unreadable ladder reads as "somewhere at or below the maximum" */
  }
  return {
    name: row.name,
    count: row.count,
    totalMs: row.total_ms,
    minMs: row.min_ms,
    maxMs: row.max_ms,
    bytes: row.bytes,
    histogram,
  };
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
  private readonly prices: PriceTable | undefined;

  constructor(file: string, prices?: PriceTable) {
    this.prices = prices;
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
      -- One row per (run, name), replaced wholesale on every flush rather than
      -- appended to. The figures a worker sends are cumulative for its whole
      -- life, so a second flush that arrived as a second row would double every
      -- count, and a run watched live would appear to get slower the longer it
      -- ran.
      CREATE TABLE IF NOT EXISTS run_timings (
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        count INTEGER NOT NULL,
        total_ms REAL NOT NULL,
        min_ms REAL NOT NULL,
        max_ms REAL NOT NULL,
        bytes INTEGER NOT NULL,
        histogram_json TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (run_id, name)
      );
    `);
    this.migrate();
  }

  /**
   * Columns added after the first runs were written.
   *
   * `runs` has no migration mechanism and this is it, written once rather than
   * per run: a column that is not there is added, and nothing else happens. It
   * has to work that way because `runs.db` is somebody's history — dropping and
   * recreating the table would take every run with it, and there is no other copy
   * of the truth.
   *
   * `PRAGMA table_info` rather than `user_version`, because a database written
   * before this existed has version 0 and so does a new one, and there is no way
   * to tell them apart from the version alone.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.pragma('table_info(runs)') as { name: string }[]).map((column) => column.name),
    );
    // Whether the work landed. The one thing `dsh stats` could not say, and the
    // only measure of whether any of this is worth doing: 60% of runs stopping
    // at a limit and 60% of runs producing nothing worth keeping call for
    // opposite fixes, and the status column cannot tell them apart.
    const added: [string, string][] = [
      ['tag', 'TEXT'],
      ['tag_note', 'TEXT'],
      ['tagged_at', 'TEXT'],
      ['tag_lines_added', 'INTEGER'],
      ['tag_lines_removed', 'INTEGER'],
    ];
    for (const [name, type] of added) {
      if (columns.has(name)) continue;
      this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * A run left `running` by a crash is not running any more, and says so.
   *
   * The end time is the last event the run managed to write, not the moment the
   * daemon noticed it was gone. Those are hours apart when a daemon is restarted
   * the next morning, and using the second one made `dsh list` report 13,281
   * seconds for a run of a few minutes: the wall clock was measured from when
   * the run started to when somebody happened to look. A run's duration is a
   * fact about the run.
   */
  markRunningAsInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted',
           ended_at = coalesce(
             (SELECT max(at) FROM events WHERE events.run_id = runs.id),
             ended_at,
             ?
           ),
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
    // Every event, with the payload serialised into the row: a tool result is up
    // to 8000 characters and this is where it becomes a string and a WAL write.
    // Timed because nothing else in the harness would ever have shown it.
    return timing.measure('daemon.store.appendEvent', () => this.appendEventRow(runId, body, at));
  }

  private appendEventRow(runId: string, body: RunEventBody, at: string): RunEvent {
    const inserted = this.db
      .prepare('INSERT INTO events (run_id, at, type, payload_json) VALUES (?, ?, ?, ?)')
      .run(runId, at, body.type, JSON.stringify(body));
    return { seq: Number(inserted.lastInsertRowid), runId, at, ...body } as RunEvent;
  }

  /**
   * This run's readings, replacing whatever was there.
   *
   * A delete and an insert in one transaction rather than an upsert per name,
   * because a name that was measured and then was not (a tool that stopped being
   * called, a span behind a flag) has to disappear rather than linger with a
   * stale count. Both halves are cheap: dozens of rows, once per turn.
   */
  saveTimings(runId: string, snapshot: TimingSnapshot): void {
    timing.measure('daemon.store.saveTimings', () => {
      const insert = this.db.prepare(
        `INSERT INTO run_timings (run_id, name, count, total_ms, min_ms, max_ms, bytes, histogram_json, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const replace = this.db.transaction((rows: TimingStat[]) => {
        this.db.prepare('DELETE FROM run_timings WHERE run_id = ?').run(runId);
        for (const row of rows) {
          insert.run(
            runId,
            row.name,
            row.count,
            row.totalMs,
            row.minMs === Number.POSITIVE_INFINITY ? 0 : row.minMs,
            row.maxMs,
            row.bytes,
            JSON.stringify(row.histogram),
            snapshot.at,
          );
        }
      });
      replace(snapshot.entries);
    });
  }

  /** One run's readings, longest total first. `at` is null when there are none. */
  runTimings(runId: string): { entries: TimingStat[]; at: string | null } {
    return timing.measure('daemon.store.runTimings', () => {
      const rows = this.db.prepare('SELECT * FROM run_timings WHERE run_id = ?').all(runId) as TimingRow[];
      return {
        entries: byTotal(rows.map(rowOf)),
        at: rows[0]?.at ?? null,
      };
    });
  }

  /**
   * Every run's readings, added together per name.
   *
   * The histogram is what makes this exact rather than an average of averages: a
   * global p95 comes out of the summed buckets, so one run with a 400 ms
   * outlier is visible in the global tail rather than averaged away by twenty
   * runs that were fast.
   */
  allTimings(): TimingStat[] {
    return timing.measure('daemon.store.allTimings', () => {
      const rows = this.db.prepare('SELECT * FROM run_timings').all() as TimingRow[];
      return byTotal(mergeStats(rows.map(rowOf)));
    });
  }

  /**
   * How many runs have readings, and how long they all took, in milliseconds.
   *
   * The wall clock is the denominator a share of a run's time needs: "12 ms in
   * `compact`" says nothing until it can be read against the 90 seconds the run
   * spent doing anything at all. A run still going is counted up to now.
   */
  timingTotals(now = Date.now()): { runs: number; wallMs: number } {
    const distinct = this.db.prepare('SELECT count(DISTINCT run_id) AS runs FROM run_timings').get() as {
      runs: number;
    };
    const spans = this.db.prepare('SELECT started_at, ended_at, created_at FROM runs').all() as {
      started_at: string | null;
      ended_at: string | null;
      created_at: string;
    }[];
    let wallMs = 0;
    for (const span of spans) {
      const from = Date.parse(span.started_at ?? span.created_at);
      const to = span.ended_at === null ? now : Date.parse(span.ended_at);
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) wallMs += to - from;
    }
    return { runs: distinct.runs, wallMs };
  }

  eventsAfter(runId: string, after: number, limit = 5000): RunEvent[] {
    // A read of up to 5000 rows and one `JSON.parse` per row. It is what the
    // chat view, `dsh logs` and `dsh report` all read through, and a report asks
    // for every event a run ever wrote, so this is metres of JSON on a long run.
    return timing.measure(
      'daemon.store.eventsAfter',
      () => {
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
      },
      (events) => events.length,
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
   * Change a run's limits, and give the new ones back.
   *
   * Stored so that everything reading the run afterwards — `dsh show`, the
   * report, a continuation — quotes the limits it is actually working to rather
   * than the ones in the task file, which are now history.
   */
  setLimits(runId: string, patch: Partial<RunLimits>): RunLimits {
    const row = this.row(runId);
    if (row === null) throw new Error(`no run called ${runId}`);
    const config = JSON.parse(row.config_json) as ResolvedRunConfig;
    const limits = { ...config.limits, ...patch };
    config.limits = limits;
    this.db.prepare('UPDATE runs SET config_json = ? WHERE id = ?').run(JSON.stringify(config), runId);
    return limits;
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
    return toDetail(row, 0, this.runCosts().get(runId));
  }

  listRuns(owners: (runId: string) => number): RunSummary[] {
    const rows = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as RunRow[];
    // One map for the whole list rather than one query per row: the run list is
    // the view where a blank COST column next to `dsh stats`' dollars is most
    // obvious.
    const costs = this.runCosts();
    return rows.map((row) => toDetail(row, owners(row.id), costs.get(row.id)));
  }

  /**
   * What each run cost, from the prices in force now.
   *
   * Recomputed from the run's own recorded calls when its stored totals carry no
   * cost, rather than left blank. A run recorded before the harness knew any
   * prices has `costUsd: null` in its row for ever, because nothing rewrites
   * history — but the calls are all there, so the amount is knowable, and `stats`
   * has been reporting dollars for those same calls all along.
   *
   * A recorded cost is never overwritten. It was worked out with the prices in
   * force at the time, which is what the run was actually billed at.
   */
  private runCosts(): Map<string, number> {
    const costs = new Map<string, number>();
    for (const { model, call, runId } of this.allMetrics()) {
      const cost = costOf(priceFor(model, startedAtOf(call), this.prices), {
        promptTokens: asNumber(call.promptTokens),
        cacheHitTokens: asNumber(call.cacheHitTokens),
        completionTokens: asNumber(call.completionTokens),
      });
      if (cost !== null) costs.set(runId, (costs.get(runId) ?? 0) + cost);
    }
    return costs;
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

  /**
   * Say what happened to a run's work, after somebody's own gate.
   *
   * The lines are recorded here rather than computed at read time, and that is
   * deliberate: they are a fact about the run, taken from its own write calls,
   * and a run tagged in March has to keep saying the same thing in June.
   * `dsh tag` sends them; anything that omits them stores null rather than zero,
   * because "no lines" and "nobody counted" are different and only one of them
   * should drag an average down.
   */
  tag(
    runId: string,
    tag: RunTag,
    options: { note?: string; lines?: { added: number; removed: number } } = {},
  ): void {
    const result = this.db
      .prepare(
        `UPDATE runs SET tag = ?, tag_note = ?, tagged_at = ?,
           tag_lines_added = ?, tag_lines_removed = ? WHERE id = ?`,
      )
      .run(
        tag,
        options.note ?? null,
        new Date().toISOString(),
        options.lines?.added ?? null,
        options.lines?.removed ?? null,
        runId,
      );
    if (result.changes === 0) throw new Error(`no run called ${runId}`);
  }

  /**
   * Every run's outcome, grouped by model and profile.
   *
   * Grouped by both because they answer different questions and either alone is
   * misleading: the same model against two projects, or two models against one.
   * The profile is a file name, which is what a person calls the project's setup
   * — `esap.json` rather than `/home/.../profiles/esap.json`.
   */
  outcomes(): OutcomeStats[] {
    const rows = this.db
      .prepare(
        `SELECT config_json, status, tag, tag_lines_added, totals_json
           FROM runs ORDER BY created_at`,
      )
      .all() as {
      config_json: string;
      status: string;
      tag: string | null;
      tag_lines_added: number | null;
      totals_json: string | null;
    }[];

    const groups = new Map<string, OutcomeStats>();
    for (const row of rows) {
      let config: { model?: unknown; profile?: unknown } = {};
      try {
        config = JSON.parse(row.config_json) as typeof config;
      } catch {
        /* a row that will not parse is still a run, grouped as unknown */
      }
      const model = typeof config.model === 'string' ? config.model : 'unknown';
      const profile = typeof config.profile === 'string' ? path.basename(config.profile) : 'unknown';
      const key = `${model}\u0000${profile}`;
      const group = groups.get(key) ?? {
        model,
        profile,
        runs: 0,
        finished: 0,
        stoppedAtLimit: 0,
        failed: 0,
        landed: 0,
        fixed: 0,
        dropped: 0,
        costUsd: null,
        landedLinesAdded: 0,
        costPerLandedLine: null,
      };

      group.runs += 1;
      if (row.status === 'finished') group.finished += 1;
      else if (row.status === 'stopped_at_limit') group.stoppedAtLimit += 1;
      else if (row.status === 'failed' || row.status === 'interrupted') group.failed += 1;

      if (row.tag === 'landed' || row.tag === 'fixed' || row.tag === 'dropped') group[row.tag] += 1;
      if (row.tag === 'landed' && typeof row.tag_lines_added === 'number') {
        group.landedLinesAdded += row.tag_lines_added;
      }

      const totals = parseTotals(row.totals_json);
      if (totals.costUsd !== null) group.costUsd = (group.costUsd ?? 0) + totals.costUsd;
      groups.set(key, group);
    }

    return [...groups.values()]
      .map((group) => ({
        ...group,
        costUsd: group.costUsd === null ? null : round(group.costUsd, 6),
        // The whole point of the table. Null rather than zero when nothing
        // landed: zero would read as free, and free is a claim.
        costPerLandedLine:
          group.costUsd === null || group.landedLinesAdded === 0
            ? null
            : round(group.costUsd / group.landedLinesAdded, 6),
      }))
      .sort((a, b) => a.model.localeCompare(b.model) || a.profile.localeCompare(b.profile));
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

/**
 * A stored call's `startedAt`, or an empty string if it has none.
 *
 * `priceFor` reads an unreadable moment as peak, which is the estimate that is
 * too high rather than too low.
 */
function startedAtOf(call: StoredCall): string {
  return typeof call.startedAt === 'string' ? call.startedAt : '';
}

/**
 * A number from a stored row, or zero.
 *
 * A stored row is JSON from an older build, so a field can be missing or the
 * wrong shape, and one bad row must not turn a whole column into a NaN or a
 * string.
 */
function asNumber(value: number | string | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toDetail(row: RunRow, owners: number, cost: number | undefined): RunDetail {
  const config = JSON.parse(row.config_json) as ResolvedRunConfig;
  const totals = parseTotals(row.totals_json);
  return {
    id: row.id,
    name: row.name,
    status: row.status as RunStatus,
    model: config.model,
    worktree: config.worktree,
    turns: row.turns,
    totals: totals.costUsd !== null || cost === undefined ? totals : { ...totals, costUsd: round(cost, 6) },
    tag: row.tag === null ? null : (row.tag as RunTag),
    tagNote: row.tag_note,
    taggedAt: row.tagged_at,
    // Merged over the defaults, because a task file written before a limit
    // existed has no value for it and the row is read by a report that has to
    // quote a real number.
    limits: { ...DEFAULT_LIMITS, ...config.limits },
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    detail: row.detail,
    detached: row.detached === 1,
    owners,
    config,
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
    current.promptTokens += asNumber(call.promptTokens);
    current.cacheHitTokens += asNumber(call.cacheHitTokens);
    current.completionTokens += asNumber(call.completionTokens);
    // Runs recorded before the reasoning channel was read have no field for it,
    // so this reads zero rather than turning the total into a NaN.
    current.reasoningTokens += asNumber(call.reasoningTokens);
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
    // Priced at the moment the call was made, by the same rule the worker bills
    // by, so a total here adds up to what the runs themselves were told they had
    // spent rather than to a second, differently-computed figure.
    const cost = costOf(priceFor(model, startedAtOf(call), prices), {
      promptTokens: asNumber(call.promptTokens),
      cacheHitTokens: asNumber(call.cacheHitTokens),
      completionTokens: asNumber(call.completionTokens),
    });
    if (cost !== null) current.costUsd = (current.costUsd ?? 0) + cost;
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
