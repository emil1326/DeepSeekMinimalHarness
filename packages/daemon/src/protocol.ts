import type {
  ResolvedRunConfig,
  RunEvent,
  RunLimits,
  RunStatus,
  RunTotals,
  Speaker,
} from '@emilswork/harness-core';

export interface RunSummary {
  id: string;
  name: string;
  status: RunStatus;
  model: string;
  worktree: string;
  turns: number;
  totals: RunTotals;
  /**
   * The limits in force, which is not the same as the task's own by now: a run
   * that was granted more room carries the new figures here.
   *
   * On the summary rather than only on the detail, because "6.0M" is only
   * meaningful next to the 8M it is heading for, and the list view is where
   * somebody looks to see which run is about to stop.
   */
  limits: RunLimits;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Anything worth saying loudly, such as a stray change outside the allow list. */
  detail: string | null;
  detached: boolean;
  /** How many live connections are watching, and own, this run. */
  owners: number;
  /**
   * Whether this run's model has a price, and so whether a cost can be shown.
   *
   * Filled in by the server rather than the store, because only the server has
   * the price table; optional for that reason, since the store builds these rows
   * and genuinely does not know. Absent means "not asked", not "free".
   */
  priced?: boolean;
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
  /**
   * A run whose conversation this one should carry on from.
   *
   * The transcript is replayed verbatim so the prompt prefix still matches and
   * the cache still hits. Anything that rebuilt the conversation would be a new
   * conversation that happens to know things, and would bill as one.
   */
  continueFrom?: string;
  /** Limits to override, for a continuation that was granted more room. */
  limits?: Partial<RunLimits>;
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
/** `POST /runs/:id/limits`. Absolute figures, not deltas. */
export interface LimitsBody {
  turns?: number;
  wallSeconds?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  /** Dollars, and so not a whole number. Five cents is `0.05`. */
  costUsd?: number;
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
