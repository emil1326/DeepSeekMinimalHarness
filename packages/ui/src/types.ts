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
    }
  | { type: 'stray'; files: string[] }
  | { type: 'error'; message: string };

type Distribute<T> = T extends unknown ? Base & T : never;

export type RunEvent = Distribute<RunEventBody>;

export interface RunLimits {
  turns: number;
  wallSeconds: number;
  outputTokens: number;
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
  sourcePath: string | null;
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
