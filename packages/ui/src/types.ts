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
      which: 'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens' | 'contextTokens' | 'askSeconds';
      detail: string;
      /** What it got to, of what. Never a bare number. */
      used: number;
      budget: number;
    }
  | {
      type: 'warning';
      which: 'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens' | 'contextTokens';
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
  changed: string[];
  stray: string[];
  strayFailure: string | null;
  questions: { question: string; answer: string | null }[];
  warnings: number;
}
