/**
 * Keeping a run inside the model's window.
 *
 * There was none of this, and the failure was real: the message list grew every
 * turn and every turn re-sent all of it, so a run that read a few large files
 * per turn could pass the model's ceiling and the API answered 400. A 400 is not
 * retryable, so the whole run was thrown away at the exact point it needed to
 * forget something instead.
 *
 * Measured, not assumed: the ceiling is 1,048,576 tokens, and past it the API
 * says `This model's maximum context length is 1048576 tokens. However, you
 * requested 1393999 tokens`. `node tools/context-limit.mjs` reproduces that.
 *
 * The bulk of a growing context is old tool results: a file read, a search, a
 * check's output. Those are the things to forget, because they can be fetched
 * again, and the model is told what it was so it can ask.
 *
 * The invariant that makes this safe to do at all: **an assistant message with
 * tool_calls must be followed by one tool message per call id.** The API is
 * strict about it, so nothing here ever removes a message. It only ever replaces
 * a tool message's *content* with a shorter one, which keeps the pairing intact
 * and cannot produce the 400 this file exists to avoid.
 */

import type { ChatMessage } from './deepseek.js';
import { timing } from './timing.js';

/**
 * Characters per token, deliberately pessimistic.
 *
 * English prose is about four and minified code nearer three, and the two
 * failure directions are not equal: overestimating costs a little compaction
 * that was not needed, underestimating costs the whole run. So this sits under
 * both.
 */
export const CHARS_PER_TOKEN = 3.5;

/** Fixed overhead per message for the role, the ids and the framing. */
const PER_MESSAGE_TOKENS = 6;

/** What a tool result is replaced with when it is elided. */
export interface Elision {
  id: string;
  /** The tool that produced it, from the assistant's call. */
  name: string;
  /** Enough of the arguments to recognise it. */
  subject: string;
}

export interface CompactOptions {
  /** The request budget. Compaction aims well under the model's real ceiling. */
  budget: number;
  /**
   * How many of the most recent tool results to leave alone.
   *
   * The model is usually working from what it just read, so eliding those would
   * make it read them again: slower, and it costs the tokens twice.
   */
  keepRecent?: number;
}

export interface CompactResult {
  /** The same length as the input, always, with some contents shortened. */
  messages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  elided: Elision[];
  /**
   * True when even a fully compacted request would not fit. The caller should
   * stop the run and say so rather than let the API refuse it.
   */
  impossible: boolean;
}

/**
 * Roughly how many tokens the message list would cost.
 *
 * Timed because `compact` calls it inside its own loop: it is the inner loop of
 * the per-turn context check, and it walks every character of every message
 * each time it is asked, so "the estimator" and "the compactor" are two
 * different answers to why a turn takes 40 ms before the request goes out.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  return timing.measure('core.context.estimateTokens', () => {
    let chars = 0;
    for (const message of messages) {
      if (typeof message.content === 'string') chars += message.content.length;
      for (const call of message.tool_calls ?? []) {
        chars += call.function.name.length + call.function.arguments.length + 20;
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN) + messages.length * PER_MESSAGE_TOKENS;
  });
}

/** The one thing worth knowing about a tool call, for the elision notice. */
function subjectOf(name: string, args: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const pick = (key: string): string | null =>
    typeof parsed[key] === 'string' && parsed[key] !== '' ? (parsed[key] as string) : null;
  switch (name) {
    case 'read_file': {
      const path = pick('path') ?? '?';
      const from = parsed.start;
      const to = parsed.end;
      return from === undefined && to === undefined
        ? path
        : `${path} (lines ${String(from ?? 1)}-${String(to ?? 'end')})`;
    }
    case 'search':
      return pick('pattern') ?? '?';
    case 'run_check':
      return pick('name') ?? '?';
    default:
      return pick('path') ?? name;
  }
}

/** The name and subject of the call that produced a tool message. */
function callFor(messages: ChatMessage[], index: number): { name: string; subject: string } {
  const id = messages[index]?.tool_call_id;
  for (let at = index - 1; at >= 0; at -= 1) {
    for (const call of messages[at]?.tool_calls ?? []) {
      if (call.id === id) {
        return { name: call.function.name, subject: subjectOf(call.function.name, call.function.arguments) };
      }
    }
  }
  return { name: 'tool', subject: 'something' };
}

function notice(name: string, subject: string): string {
  return `[${name} ${subject}: the result was dropped to make room in the context. Ask again if you still need it.]`;
}

/**
 * Shorten the message list until it fits, by forgetting old tool results.
 *
 * Never changes the number of messages and never touches the assistant messages,
 * so a tool call always keeps its reply and the API's pairing rule holds.
 */
export function compact(messages: ChatMessage[], options: CompactOptions): CompactResult {
  return timing.measure('core.context.compact', () => compactMessages(messages, options));
}

function compactMessages(messages: ChatMessage[], options: CompactOptions): CompactResult {
  const keepRecent = options.keepRecent ?? 4;
  const tokensBefore = estimateTokens(messages);
  if (tokensBefore <= options.budget) {
    return {
      messages: [...messages],
      tokensBefore,
      tokensAfter: tokensBefore,
      elided: [],
      impossible: false,
    };
  }

  const out = messages.map((message) => ({ ...message }));
  const elided: Elision[] = [];

  // Tool messages that are not already a notice, oldest first, keeping the tail
  // of them whole.
  const toolIndices = out
    .map((message, index) => (message.role === 'tool' ? index : -1))
    .filter((index) => index !== -1);
  const protectedIndices = new Set(toolIndices.slice(-keepRecent));

  // Two passes. The first leaves the model's recent work alone; the second gives
  // up that protection rather than fail the run, because a run that is over
  // budget is a run that cannot continue at all.
  for (const forgetProtected of [false, true]) {
    for (const index of toolIndices) {
      if (estimateTokens(out) <= options.budget) break;
      if (protectedIndices.has(index) && !forgetProtected) continue;
      const message = out[index];
      if (message === undefined || typeof message.content !== 'string') continue;
      if (message.content.startsWith('[read_file') || message.content.startsWith('[search')) continue;
      if (message.content.startsWith('[run_check')) continue;
      if (message.content.startsWith('[list_dir')) continue;
      const { name, subject } = callFor(out, index);
      const replacement = notice(name, subject);
      // Only worth it if it is actually smaller.
      if (replacement.length >= message.content.length) continue;
      message.content = replacement;
      elided.push({ id: message.tool_call_id ?? '', name, subject });
    }
  }

  const tokensAfter = estimateTokens(out);
  return {
    messages: out,
    tokensBefore,
    tokensAfter,
    elided,
    // A request that cannot be made small enough is not a limit the run hit by
    // being wasteful, it is a run that cannot continue. The caller stops it.
    impossible: tokensAfter > options.budget,
  };
}

/**
 * The largest recent tool result, for when a single answer is itself too big.
 *
 * A 1500-line read is about 60 KB, which is 17,000 tokens by the rule above. A
 * couple of those in one turn are fine; twenty are not, and no amount of
 * eliding the past helps because the present is the problem.
 */
export function largestToolResult(messages: ChatMessage[]): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    if (best === null || message.content.length > best.length)
      best = { index, length: message.content.length };
  }
  return best;
}
