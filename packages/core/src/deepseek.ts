import { DEFAULT_BASE_URL } from './config.js';
import type { CallMetrics } from './metrics.js';
import { rate, round } from './metrics.js';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  /**
   * Of `completion_tokens`, how many were thinking rather than answer.
   *
   * deepseek-flash streams a reasoning channel on `delta.reasoning_content` and
   * bills it as output. Measured on a plain prose request it was 797 of 902
   * billed tokens, so "output tokens" and "what the answer cost" are not the
   * same number, and a reader needs to know which one they are looking at.
   */
  reasoning_tokens: number;
}

export interface StreamRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Aborted the instant a run is cancelled. */
  signal?: AbortSignal;
  temperature?: number;
  /**
   * A retryable refusal arrived and the client is about to wait and try again.
   *
   * Per call rather than per client, next to `onText`, because the caller is the
   * one that knows which turn this is.
   */
  onRetry?: (info: { attempt: number; status: number; waitMs: number }) => void;
  /** The answer, as it streams. */
  onText?: (delta: string) => void;
  /** The model thinking, as it streams. Arrives before the answer. */
  onReasoning?: (delta: string) => void;
}

export interface StreamOutcome {
  message: ChatMessage;
  /** The thinking channel, which is billed as output and arrives first. */
  reasoning: string;
  usage: Usage;
  metrics: CallMetrics;
}

export class DeepSeekError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.retryable = retryable;
  }
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

const RETRYABLE_STATUS = (status: number): boolean => status === 429 || status === 408 || status >= 500;

/**
 * Streaming chat completions against DeepSeek, which speaks the OpenAI wire
 * format including tool calls.
 *
 * Plain `fetch` rather than the `openai` SDK, on purpose: the wire format is a
 * short SSE stream, and doing it by hand is what makes the abort semantics and
 * the first-token timing exact. The metrics are the reason this exists.
 */
export class DeepSeekClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: DeepSeekOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? 15 * 60 * 1000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async stream(request: StreamRequest): Promise<StreamOutcome> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.attempt(request);
      } catch (error) {
        const retryable = error instanceof DeepSeekError ? error.retryable : isNetworkError(error);
        if (!retryable || attempt >= this.maxRetries || request.signal?.aborted) throw error;
        const status = error instanceof DeepSeekError ? error.status : 0;
        const waitMs = Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250);
        // Told before the wait, not after, so a reader sees the stall coming
        // rather than being told about it once it is over.
        request.onRetry?.({ attempt: attempt + 1, status, waitMs });
        await sleep(waitMs, request.signal);
        attempt += 1;
      }
    }
  }

  private async attempt(request: StreamRequest): Promise<StreamOutcome> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          tools: request.tools,
          temperature: request.temperature ?? 0,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw new AbortedError();
      throw error;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new DeepSeekError(
        `DeepSeek answered ${response.status}: ${detail.slice(0, 500)}`,
        response.status,
        RETRYABLE_STATUS(response.status),
      );
    }
    if (response.body === null) throw new DeepSeekError('DeepSeek sent no body', 0, true);

    const state = {
      text: '',
      reasoning: '',
      toolCalls: new Map<number, { id: string; name: string; args: string }>(),
      usage: emptyUsage(),
      firstTokenMs: null as number | null,
      lastTokenMs: 0,
      /** The longest wait between two output deltas, so a burst shows up. */
      largestGapMs: 0,
      lastDeltaAt: null as number | null,
      finished: false,
    };

    /**
     * One output delta arrived, of any kind.
     *
     * Everything counts, including the reasoning channel and tool arguments,
     * because the window this builds is the span the model spent producing
     * output and the token count it gets divided by includes all of it. Timing
     * only `content` was the bug behind a reported 930 tokens a second: the
     * denominator held the whole output while the denominator held the answer's
     * share of it, and the thinking that made up most of the rest went untimed.
     */
    const sawOutput = (at: number): void => {
      const since = at - start;
      if (state.firstTokenMs === null) state.firstTokenMs = since;
      if (state.lastDeltaAt !== null) {
        state.largestGapMs = Math.max(state.largestGapMs, since - state.lastDeltaAt);
      }
      state.lastDeltaAt = since;
      state.lastTokenMs = since;
    };

    const handle = (payload: string): void => {
      if (payload === '[DONE]') {
        state.finished = true;
        return;
      }
      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(payload) as ChatChunk;
      } catch {
        return;
      }
      if (chunk.usage) state.usage = normaliseUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (choice === undefined) return;
      const delta = choice.delta;
      if (delta === undefined) return;

      const at = performance.now();
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
        sawOutput(at);
        state.reasoning += delta.reasoning_content;
        request.onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        sawOutput(at);
        state.text += delta.content;
        request.onText?.(delta.content);
      }
      for (const call of delta.tool_calls ?? []) {
        sawOutput(at);
        const index = call.index ?? 0;
        const current = state.toolCalls.get(index) ?? { id: '', name: '', args: '' };
        if (typeof call.id === 'string' && call.id !== '') current.id = call.id;
        if (typeof call.function?.name === 'string' && call.function.name !== '')
          current.name = call.function.name;
        if (typeof call.function?.arguments === 'string') current.args += call.function.arguments;
        state.toolCalls.set(index, current);
      }
    };

    try {
      await readSse(response.body, handle);
    } catch (error) {
      if (request.signal?.aborted) throw new AbortedError();
      throw error;
    }

    const durationMs = round(performance.now() - start, 1);
    const streamingMs = state.firstTokenMs === null ? null : round(state.lastTokenMs - state.firstTokenMs, 1);
    const metrics: CallMetrics = {
      model: request.model,
      startedAt,
      durationMs,
      timeToFirstTokenMs: state.firstTokenMs === null ? null : round(state.firstTokenMs, 1),
      streamingMs,
      largestGapMs: round(state.largestGapMs, 1),
      promptTokens: state.usage.prompt_tokens,
      cacheHitTokens: state.usage.prompt_cache_hit_tokens,
      cacheMissTokens: state.usage.prompt_cache_miss_tokens,
      completionTokens: state.usage.completion_tokens,
      reasoningTokens: state.usage.reasoning_tokens,
      generationTokensPerSecond: decodeRate(state.usage.completion_tokens, streamingMs, state.largestGapMs),
      endToEndTokensPerSecond: rate(state.usage.completion_tokens, durationMs),
    };

    const toolCalls: ToolCall[] = [...state.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args === '' ? '{}' : call.args },
      }))
      .filter((call) => call.function.name !== '');

    const message: ChatMessage = {
      role: 'assistant',
      content: state.text === '' ? null : state.text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };

    return { message, reasoning: state.reasoning, usage: state.usage, metrics };
  }
}

/**
 * How long a window has to be before a speed derived from it means anything.
 *
 * Below this the number is mostly scheduler granularity and TCP timing rather
 * than decoding. It is a floor on measuring, not a cap on speed: a genuinely
 * fast short answer reports null here and its real rate end to end.
 */
export const MIN_DECODE_WINDOW_MS = 100;

/**
 * The decode rate, or null when the stream did not actually span enough to
 * measure one.
 *
 * Two things disqualify a window. Too short, for the reason above. And bursty:
 * if one single wait accounts for most of the span, the span is a wait rather
 * than a decode, and dividing a whole answer's tokens by it invents a speed.
 * The measured evidence for that guard is a real tool call whose 4430 tokens
 * arrived across 34 ms in two clumps, which the naive division turned into
 * 129,799 tokens a second.
 */
export function decodeRate(tokens: number, windowMs: number | null, largestGapMs = 0): number | null {
  if (windowMs === null || !Number.isFinite(windowMs)) return null;
  if (windowMs < MIN_DECODE_WINDOW_MS) return null;
  if (largestGapMs >= windowMs * 0.5) return null;
  return rate(tokens, windowMs);
}

export class AbortedError extends Error {
  constructor() {
    super('the call was cancelled');
    this.name = 'AbortedError';
  }
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      /** The thinking channel. Billed as output, and the bulk of it. */
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: Partial<RawUsage> | null;
}

interface RawUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

export function emptyUsage(): Usage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
    reasoning_tokens: 0,
  };
}

function normaliseUsage(raw: Partial<RawUsage>): Usage {
  const prompt = raw.prompt_tokens ?? 0;
  const hit = raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = raw.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);
  return {
    prompt_tokens: prompt,
    completion_tokens: raw.completion_tokens ?? 0,
    total_tokens: raw.total_tokens ?? prompt + (raw.completion_tokens ?? 0),
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    reasoning_tokens: raw.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** Parse an SSE body line by line, feeding each `data:` payload to `handle`. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  handle: (payload: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const drain = (flush: boolean): void => {
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
    if (flush && buffer.trim() !== '') {
      const line = buffer.trim();
      if (line.startsWith('data:')) handle(line.slice(5).trim());
      buffer = '';
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain(false);
  }
  buffer += decoder.decode();
  drain(true);
}

function isNetworkError(error: unknown): boolean {
  return error instanceof Error && !(error instanceof AbortedError);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
