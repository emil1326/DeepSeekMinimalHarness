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

export interface RunTotals {
  calls: number;
  /** How many of those calls managed to measure a first token. */
  timedCalls: number;
  promptTokens: number;
  cacheHitTokens: number;
  completionTokens: number;
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
  | { type: 'status'; status: RunStatus; detail?: string }
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
      which: 'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens' | 'contextTokens' | 'askSeconds';
      detail: string;
    }
  | { type: 'stray'; files: string[] }
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
    reasoningTokens: 0,
    timeToFirstTokenMs: null,
    generationTokensPerSecond: null,
    endToEndTokensPerSecond: null,
    costUsd: null,
  };
}
