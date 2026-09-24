import type { CallMetrics } from './metrics.js';

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'finished',
  'failed',
  'cancelled',
  'interrupted',
  'stopped_at_limit',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: readonly RunStatus[] = [
  'finished',
  'failed',
  'cancelled',
  'interrupted',
  'stopped_at_limit',
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Who said a thing. The CLI is Claude; the UI is Emil. */
export type Speaker = 'agent' | 'claude' | 'emil' | 'system';

/**
 * Why a run failed, in a form a script can branch on.
 *
 * A string in a `detail` field is for a person. A launcher deciding whether to
 * start the next run needs something it can compare, and reading prose for
 * "insufficient balance" is how an orchestrator keeps launching runs against an
 * account that has no credit left — each one failing after a few seconds, for as
 * long as somebody leaves it running.
 */
export const FAILURE_CAUSES = [
  /** The provider says there is no money on the account. Stop launching. */
  'provider_balance',
  /** The key is missing, wrong, or revoked. Stop launching. */
  'provider_auth',
  /** The provider refused the request itself: too long, malformed, unsupported. */
  'provider_refused',
  /** The provider could not be reached after retries, or answered 5xx throughout. */
  'provider_unreachable',
  /** The harness itself failed: a bad worktree, a sandbox refusal, a crash. */
  'harness',
] as const;

export type FailureCause = (typeof FAILURE_CAUSES)[number];

export interface RunTotals {
  calls: number;
  /** How many of those calls managed to measure a first token. */
  timedCalls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
  /**
   * What this run actually costs tokens for: prompt misses plus output.
   *
   * Not `promptTokens + completionTokens`, which is what `totalTokens` used to
   * count and why so many real runs died at it. A repo-reading run is 95-97%
   * cache hits, and a cache hit costs about a tenth of a miss. Counting them at
   * full price bounded nothing that was worth bounding and killed runs that had
   * spent almost nothing: three of the seven dead runs on this machine stopped
   * at a `totalTokens` ceiling while being 96% cached.
   */
  billedTokens: number;
  /** Of `completionTokens`, how many were thinking rather than answer. */
  reasoningTokens: number;
  timeToFirstTokenMs: number | null;
  /** Decode only, and null when the stream did not span enough to measure one. */
  generationTokensPerSecond: number | null;
  /** Output tokens over the whole call. The honest headline number. */
  endToEndTokensPerSecond: number | null;
  costUsd: number | null;
}

interface Base {
  seq: number;
  runId: string;
  at: string;
}

export type RunEventBody =
  | { type: 'status'; status: RunStatus; detail?: string; cause?: FailureCause }
  | { type: 'text.delta'; turn: number; text: string }
  /** The model thinking. It arrives before the answer and is billed as output. */
  | { type: 'thinking.delta'; turn: number; text: string }
  | { type: 'turn.start'; turn: number }
  | { type: 'tool.call'; turn: number; id: string; name: string; args: unknown }
  | { type: 'tool.result'; turn: number; id: string; name: string; ok: boolean; result: string }
  | { type: 'question'; id: string; question: string }
  | { type: 'answer'; id: string; answer: string; by: Speaker }
  | { type: 'message'; by: Speaker; text: string }
  | { type: 'metrics'; turn: number; call: CallMetrics; totals: RunTotals }
  | { type: 'summary'; text: string }
  /**
   * A model call was refused with something worth trying again, and is waiting.
   *
   * Without this a `429` or a `503` looks like the model thinking for eight
   * seconds: the run just sits there, `dsh list` shows a run that has not moved,
   * and the eventual stall is indistinguishable from a slow model. The client
   * has had an `onRetry` hook all along; nothing was listening to it.
   */
  | { type: 'retry'; turn: number; attempt: number; status: number; waitMs: number }
  /**
   * The message list was shortened to fit the model's window.
   *
   * Worth an event of its own: the model's view of the conversation changed, so
   * a reader deciding whether to trust the answer needs to know it happened.
   */
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
        /** The run spent its dollar budget. Measured from DeepSeek's prices. */
        | 'costUsd';
      detail: string;
      /** What it got to. `used` of `budget`, so a reader is never shown a bare number. */
      used: number;
      budget: number;
    }
  /**
   * A limit is close, and the agent is told before it arrives.
   *
   * Real runs died at 80% of a budget nobody mentioned to them: seven of the
   * nine runs on this machine stopped at a limit, and in every case the agent
   * had no warning and no chance to finish what it was doing, ask for more room,
   * or stop tidily. A limit that arrives as a surprise is a limit that wasted
   * whatever came before it.
   */
  | {
      type: 'warning';
      which: 'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens' | 'contextTokens' | 'costUsd';
      /** Already used, and the ceiling it is heading for. */
      used: number;
      budget: number;
      /** What the harness told the agent, verbatim. */
      detail: string;
    }
  | { type: 'stray'; files: string[] }
  /**
   * Changed files that were on the soft list rather than the plan.
   *
   * Its own event rather than folded into `stray`, because they mean opposite
   * things: a stray change is something nobody allowed, and one of these is a
   * change the task said it might need. Reporting them together would teach a
   * reader to skim the loud one.
   */
  | { type: 'offPlan'; files: string[] }
  | { type: 'error'; message: string };

type Distribute<T> = T extends unknown ? Base & T : never;

export type RunEvent = Distribute<RunEventBody>;

export type RunEventType = RunEventBody['type'];

/** A nudge for the UI's live list: the payload is fetched, not pushed twice. */
export interface EventNotice {
  runId: string;
  seq: number;
  type: RunEventType;
  at: string;
}

export function emptyTotals(): RunTotals {
  return {
    calls: 0,
    timedCalls: 0,
    promptTokens: 0,
    cacheHitTokens: 0,
    completionTokens: 0,
    billedTokens: 0,
    reasoningTokens: 0,
    timeToFirstTokenMs: null,
    generationTokensPerSecond: null,
    endToEndTokensPerSecond: null,
    costUsd: null,
  };
}
