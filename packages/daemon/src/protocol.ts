import type { ResolvedRunConfig, RunEvent, RunStatus, RunTotals, Speaker } from '@emilswork/harness-core';

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
  /** Anything worth saying loudly, such as a stray change outside the allow list. */
  detail: string | null;
  detached: boolean;
  /** How many live connections are watching, and own, this run. */
  owners: number;
}

export interface RunDetail extends RunSummary {
  /** Exactly as the run used it, so the UI can show it and nothing can change it. */
  config: ResolvedRunConfig;
  summary: string | null;
}

export interface ProblemReport {
  path: string;
  message: string;
  file: string | null;
}

export interface ApiErrorBody {
  error: string;
  problems?: ProblemReport[];
}

export interface CreateRunBody {
  /** The task JSON file, read and validated by the daemon. */
  taskPath: string;
  detached?: boolean;
}

export interface MessageBody {
  text: string;
  by?: Speaker;
}

export interface AnswerBody {
  id: string;
  text: string;
  by?: Speaker;
}

export interface DiffResponse {
  diff: string;
  /** Changed files that are not on the allow list, reported loudly. */
  stray: string[];
}

export interface ModelStats {
  model: string;
  /**
   * Which measurement method these figures came from.
   *
   * Speed is only comparable within one version, so calls are grouped by it and
   * a model that has been run under two methods gets two rows rather than one
   * average of things that cannot be averaged.
   */
  metricsVersion: number;
  calls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  /** Of `completionTokens`, the part spent thinking. Billed as output. */
  reasoningTokens: number;
  timeToFirstTokenMs: number | null;
  /** Decode only, and often null. Not the number to quote. */
  generationTokensPerSecond: number | null;
  /** Output tokens over the whole call. This is what a vendor advertises. */
  endToEndTokensPerSecond: number | null;
  costUsd: number | null;
}

export interface StatsResponse {
  runs: number;
  models: ModelStats[];
}

export type AttachMessage =
  | { type: 'hello'; detail: RunDetail; events: RunEvent[] }
  | { type: 'event'; event: RunEvent }
  | { type: 'bye'; status: RunStatus };

/** A nudge for the UI: something happened, go and fetch what changed. */
export type NoticeMessage = { type: 'notice'; runId: string | null };
