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
}

export interface StreamRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Aborted the instant a run is cancelled. */
  signal?: AbortSignal;
  temperature?: number;
  onText?: (delta: string) => void;
}

export interface StreamOutcome {
  message: ChatMessage;
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
  onRetry?: (info: { attempt: number; status: number; waitMs: number }) => void;
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
  private readonly onRetry: DeepSeekOptions['onRetry'];

  constructor(options: DeepSeekOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.requestTimeoutMs ?? 15 * 60 * 1000;
    this.maxRetries = options.maxRetries ?? 3;
    this.onRetry = options.onRetry;
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
        this.onRetry?.({ attempt: attempt + 1, status, waitMs });
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
      toolCalls: new Map<number, { id: string; name: string; args: string }>(),
      usage: emptyUsage(),
      firstTokenMs: null as number | null,
      lastTokenMs: 0,
      finished: false,
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
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (state.firstTokenMs === null) state.firstTokenMs = at - start;
        state.lastTokenMs = at - start;
        state.text += delta.content;
        request.onText?.(delta.content);
      }
      for (const call of delta.tool_calls ?? []) {
        if (state.firstTokenMs === null) state.firstTokenMs = at - start;
        state.lastTokenMs = at - start;
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
      promptTokens: state.usage.prompt_tokens,
      cacheHitTokens: state.usage.prompt_cache_hit_tokens,
      cacheMissTokens: state.usage.prompt_cache_miss_tokens,
      completionTokens: state.usage.completion_tokens,
      generationTokensPerSecond: rate(state.usage.completion_tokens, streamingMs),
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

    return { message, usage: state.usage, metrics };
  }
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
}

export function emptyUsage(): Usage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: 0,
  };
}

function normaliseUsage(raw: Partial<RawUsage>): Usage {
  const prompt = raw.prompt_tokens ?? 0;
  const hit = raw.prompt_cache_hit_tokens ?? 0;
  const miss = raw.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit);
  return {
    prompt_tokens: prompt,
    completion_tokens: raw.completion_tokens ?? 0,
    total_tokens: raw.total_tokens ?? prompt + (raw.completion_tokens ?? 0),
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
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
