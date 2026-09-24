/**
 * The shapes the daemon sends.
 *
 * Mirrored here on purpose rather than imported: `@emilswork/harness-daemon`
 * pulls in `better-sqlite3` and node builtins, and none of that belongs in a
 * browser bundle. `packages/daemon/src/protocol.ts` is the source of truth.
 */

export type RunStatus =
  'queued' | 'running' | 'waiting' | 'finished' | 'failed' | 'cancelled' | 'interrupted' | 'stopped_at_limit';

export const TERMINAL: RunStatus[] = ['finished', 'failed', 'cancelled', 'interrupted', 'stopped_at_limit'];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

export type Speaker = 'agent' | 'claude' | 'emil' | 'system';

export interface CallMetrics {
  model: string;
  startedAt: string;
  durationMs: number;
  timeToFirstTokenMs: number | null;
  streamingMs: number | null;
  largestGapMs: number;
  /** Which measurement method produced the speed figures. See core's `METRICS_VERSION`. */
  metricsVersion: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  /** Of `completionTokens`, how many were thinking rather than answer. */
  reasoningTokens: number;
  /** Decode only, and null when the stream did not span enough to measure one. */
  generationTokensPerSecond: number | null;
  /** Output tokens over the whole call. The honest headline number. */
  endToEndTokensPerSecond: number | null;
}

export interface RunTotals {
  calls: number;
  timedCalls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  /**
   * Prompt cache misses plus output: what the run is actually charged for.
   *
   * This is what `limits.totalTokens` counts, so it is what the UI divides by to
   * show how much room is left.
   */
  billedTokens: number;
  reasoningTokens: number;
  timeToFirstTokenMs: number | null;
  generationTokensPerSecond: number | null;
  endToEndTokensPerSecond: number | null;
  costUsd: number | null;
}

/**
 * One instrumented call site, as the daemon stored it.
 *
 * `histogram` is a fixed bucket ladder, which is what makes a merge across runs
 * exact, so the percentiles are read from it rather than recomputed here: the
 * UI asks the plane the same question the CLI does, over the same buckets.
 */
export interface TimingStat {
  name: string;
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  /** Bytes the call handled, when it has a unit. Zero otherwise. */
  bytes: number;
  histogram: number[];
}

/** Where one run's time went. `wallMs` is what the shares are a share of. */
export interface RunTimings {
  runId: string;
  wallMs: number;
  entries: TimingStat[];
  /** When the worker last flushed, or null if it never did. */
  at: string | null;
}

/** Where the time went across every run, and in the daemon itself. */
export interface TimingsResponse {
  runs: number;
  wallMs: number;
  entries: TimingStat[];
  process: TimingStat[];
}

interface Base {
  seq: number;
  runId: string;
  at: string;
}

export type RunEventBody =
  | { type: 'status'; status: RunStatus; detail?: string }
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; turn: number; text: string }
  | { type: 'thinking.delta'; turn: number; text: string }
  | { type: 'tool.call'; turn: number; id: string; name: string; args: unknown }
  | { type: 'tool.result'; turn: number; id: string; name: string; ok: boolean; result: string }
  | { type: 'question'; id: string; question: string }
  | { type: 'answer'; id: string; answer: string; by: Speaker }
  | { type: 'message'; by: Speaker; text: string }
  | { type: 'metrics'; turn: number; call: CallMetrics; totals: RunTotals }
  | { type: 'summary'; text: string }
  | { type: 'retry'; turn: number; attempt: number; status: number; waitMs: number }
  | {
      type: 'context';
      turn: number;
      dropped: number;
      subjects: string[];
      tokensBefore: number;
      tokensAfter: number;
    }
  | {
      type: 'limit';
      which:
        | 'turns'
        | 'wallSeconds'
        | 'outputTokens'
        | 'totalTokens'
        | 'contextTokens'
        | 'askSeconds'
        /** The run spent its dollar budget. From DeepSeek's published prices. */
        | 'costUsd';
      detail: string;
      /** What it got to, of what. Never a bare number. */
      used: number;
      budget: number;
    }
  | {
      type: 'warning';
      which: 'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens' | 'contextTokens' | 'costUsd';
      used: number;
      budget: number;
      detail: string;
    }
  | { type: 'stray'; files: string[] }
  | { type: 'error'; message: string };

type Distribute<T> = T extends unknown ? Base & T : never;

export type RunEvent = Distribute<RunEventBody>;

export interface RunLimits {
  turns: number;
  wallSeconds: number;
  outputTokens: number;
  /** Billed tokens: prompt cache misses plus output. See core's limits.ts. */
  totalTokens: number;
  contextTokens: number;
  askSeconds: number;
  /**
   * Dollars the run may spend.
   *
   * Absent on a run recorded before the harness priced anything, which is why
   * every reader of it has to cope with `undefined` rather than a zero: a run
   * that was never given a dollar budget has not been given one of zero.
   */
  costUsd: number;
}

export interface ResolvedRunConfig {
  name: string;
  worktree: string;
  profile: string;
  profileHash: string;
  model: string;
  allow: string[];
  checks: string[];
  task: string;
  limits: RunLimits;
  /** The task text file, when the task file pointed at one. Null for an inline task. */
  sourcePath: string | null;
  /** The task JSON this run was resolved from. What a continuation re-reads. */
  configPath: string;
  raw: unknown;
  resolvedProfile: unknown;
}

export interface RunSummary {
  id: string;
  name: string;
  status: RunStatus;
  model: string;
  worktree: string;
  turns: number;
  totals: RunTotals;
  /** The limits in force, which a grant of more room can have changed. */
  limits: RunLimits;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  detail: string | null;
  detached: boolean;
  owners: number;
  /**
   * Whether the model has a known price, so a cost can be measured at all.
   *
   * Absent means the daemon was not asked, which is not the same as free.
   */
  priced?: boolean;
}

export interface RunDetail extends RunSummary {
  config: ResolvedRunConfig;
  summary: string | null;
}

export interface DiffResponse {
  diff: string;
  stray: string[];
}

export interface ModelStats {
  model: string;
  /** Which measurement method these figures came from. Only comparable within one. */
  metricsVersion: number;
  calls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  timeToFirstTokenMs: number | null;
  generationTokensPerSecond: number | null;
  endToEndTokensPerSecond: number | null;
  costUsd: number | null;
}

export interface StatsResponse {
  runs: number;
  models: ModelStats[];
}

/**
 * One check's last result, as the report carries it.
 *
 * Three states, not two: "could not be run" is not "failed". A live run asked
 * for checks its profile did not have, and reporting those as FAIL made a reader
 * distrust the section that is supposed to be the trustworthy one.
 */
export interface CheckOutcome {
  name: string;
  outcome: 'pass' | 'fail' | 'unavailable';
  output: string;
  /**
   * A profile check, or a command the project declared.
   *
   * Kept apart because they are different evidence. A declared command is the
   * project's own verification — a real test run — and it used to be invisible
   * here, which meant a run that had genuinely checked its work reported that
   * nothing verified it.
   */
  kind?: 'check' | 'command';
}

/**
 * What happened in a run, for somebody who did not watch it.
 *
 * Mirrors core's `RunReport`. The headline is the part that matters: a run that
 * stopped at a limit says so in those words, and an agent's claim that a check
 * contradicts is labelled as unbacked rather than shown as a conclusion.
 */
export interface RunReport {
  id: string;
  name: string;
  status: RunStatus;
  headline: string;
  task: string;
  model: string;
  turns: number;
  totals: RunTotals;
  limits: RunLimits;
  stoppedAt: { which: string; used: number; budget: number; ratio: number } | null;
  claim: string | null;
  claimSupported: boolean | null;
  checks: CheckOutcome[];
  allowed: string[];
  /** Files the run's own write tools touched, from its event log. */
  changed: string[];
  /**
   * Files git sees a change in, read when the report was built.
   *
   * Deliberately separate from `changed`, which is what the run did and does not
   * change afterwards. They disagree whenever somebody committed or reset the
   * worktree in between, and the panel says so rather than showing one of them.
   */
  onDisk: string[];
  stray: string[];
  /** Files outside the plan that the task said it might still need. */
  offPlan: string[];
  /** Files already changed before the run started, so not its doing. */
  preExisting: string[];
  strayFailure: string | null;
  questions: { question: string; answer: string | null }[];
  /** True when the harness warned the agent before a limit, and how often. */
  warnings: number;
  /**
   * Which limits it was warned about, by the name a person uses.
   *
   * "Warned once" does not say whether that was about turns or about money, and
   * the difference decides whether continuing the run is worth the money.
   */
  warnedAbout: string[];
}
