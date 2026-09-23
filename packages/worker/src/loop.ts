import {
  AbortedError,
  DeepSeekClient,
  Sandbox,
  SandboxRefusal,
  SYSTEM_PROMPT,
  TOOL_NAMES,
  emptyTotals,
  taskMessage,
  totalsOf,
  toolSpecs,
  type ChatMessage,
  type Price,
  type ResolvedRunConfig,
  type RunEventBody,
  type RunStatus,
  type RunTotals,
  type Speaker,
  type ToolCall,
} from '@emilswork/harness-core';

export interface LoopOptions {
  sandbox: Sandbox;
  client: DeepSeekClient;
  config: ResolvedRunConfig;
  emit: (body: RunEventBody) => void;
  price?: Price;
}

export interface LoopControl {
  /** Set when the run is cancelled; the model call is aborted with it. */
  signal: AbortSignal;
  /** Anything the launcher said, delivered at the next turn boundary. */
  takeMessages: () => { text: string; by: Speaker }[];
  /** Blocks until the launcher answers, or the wait runs out. */
  waitForAnswer: (
    id: string,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<{ text: string; by: Speaker } | null>;
  now?: () => number;
}

export interface LoopResult {
  status: RunStatus;
  summary: string | null;
}

/**
 * Collect streamed text and hand it on in small batches, so a long answer does
 * not become a thousand rows in the event log.
 */
class TextBuffer {
  private pending = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly flush: (text: string) => void,
    private readonly everyMs = 50,
  ) {}

  push(text: string): void {
    this.pending += text;
    if (this.timer === null) {
      this.timer = setTimeout(() => this.drain(), this.everyMs);
    }
  }

  drain(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending !== '') {
      const text = this.pending;
      this.pending = '';
      this.flush(text);
    }
  }
}

/** The agent loop: one model call per turn, a closed set of tools, limits, finish. */
export async function runAgentLoop(options: LoopOptions, control: LoopControl): Promise<LoopResult> {
  const { sandbox, client, config, emit } = options;
  const limits = config.limits;
  const clock = control.now ?? ((): number => Date.now());
  const startedAt = clock();
  let totals: RunTotals = emptyTotals();
  let summary: string | null = null;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: taskMessage({
        task: config.task,
        allow: [...sandbox.allow].sort(),
        checks: sandbox.checkNames,
      }),
    },
  ];

  const specs = toolSpecs(sandbox.checkNames);
  let turn = 0;

  for (turn = 1; turn <= limits.turns; turn += 1) {
    if (control.signal.aborted) return { status: 'cancelled', summary };

    const elapsedSeconds = (clock() - startedAt) / 1000;
    if (elapsedSeconds > limits.wallSeconds) {
      const detail = `the run went past ${limits.wallSeconds} s of wall clock`;
      emit({ type: 'limit', which: 'wallSeconds', detail });
      return { status: 'stopped_at_limit', summary };
    }
    if (totals.completionTokens >= limits.outputTokens) {
      const detail = `the run wrote ${totals.completionTokens} output tokens, past the ${limits.outputTokens} it may`;
      emit({ type: 'limit', which: 'outputTokens', detail });
      return { status: 'stopped_at_limit', summary };
    }

    emit({ type: 'turn.start', turn });

    // Anything the launcher said arrives here, never in the middle of a tool
    // call. The daemon already recorded it as an event when it was sent, so
    // this only puts it into the conversation.
    for (const message of control.takeMessages()) {
      messages.push({ role: 'user', content: `[${message.by}] ${message.text}` });
    }

    const buffer = new TextBuffer((text) => emit({ type: 'text.delta', turn, text }));
    let outcome;
    try {
      outcome = await client.stream({
        model: config.model,
        messages,
        tools: specs,
        signal: control.signal,
        onText: (delta) => buffer.push(delta),
      });
    } catch (error) {
      buffer.drain();
      if (control.signal.aborted || error instanceof AbortedError) return { status: 'cancelled', summary };
      emit({ type: 'error', message: (error as Error).message });
      return { status: 'failed', summary };
    }
    buffer.drain();

    totals = totalsOf(totals, outcome.metrics, options.price);
    emit({ type: 'metrics', turn, call: outcome.metrics, totals });
    messages.push(outcome.message);

    const calls = outcome.message.tool_calls ?? [];
    if (calls.length === 0) {
      // The model answered without calling a tool. That is as final as finish.
      summary = outcome.message.content ?? '(stopped without calling finish)';
      emit({ type: 'summary', text: summary });
      return { status: 'finished', summary };
    }

    for (const call of calls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      emit({ type: 'tool.call', turn, id: call.id, name, args });

      if (name === 'finish') {
        summary = typeof args.summary === 'string' ? args.summary : '';
        pushToolResult(messages, call, 'ok');
        emit({ type: 'tool.result', turn, id: call.id, name, ok: true, result: 'ok' });
        emit({ type: 'summary', text: summary });
        return { status: 'finished', summary };
      }

      if (name === 'ask') {
        const question = typeof args.question === 'string' ? args.question : '(no question given)';
        emit({ type: 'question', id: call.id, question });
        emit({ type: 'status', status: 'waiting', detail: question });
        const answer = await control.waitForAnswer(call.id, limits.askSeconds * 1000, control.signal);
        if (answer === null) {
          if (control.signal.aborted) return { status: 'cancelled', summary };
          const detail = `nothing came back within ${limits.askSeconds} s of waiting for an answer`;
          emit({ type: 'limit', which: 'askSeconds', detail });
          return { status: 'stopped_at_limit', summary };
        }
        emit({ type: 'answer', id: call.id, answer: answer.text, by: answer.by });
        emit({ type: 'status', status: 'running' });
        const text = `the answer: ${answer.text}`;
        pushToolResult(messages, call, text);
        emit({ type: 'tool.result', turn, id: call.id, name, ok: true, result: text });
        continue;
      }

      const outcomeOfTool = await runTool(sandbox, name, args);
      if (control.signal.aborted) return { status: 'cancelled', summary };
      pushToolResult(messages, call, outcomeOfTool.result);
      emit({
        type: 'tool.result',
        turn,
        id: call.id,
        name,
        ok: outcomeOfTool.ok,
        result: outcomeOfTool.result,
      });
    }
  }

  emit({ type: 'limit', which: 'turns', detail: `the run used all ${limits.turns} turns` });
  return { status: 'stopped_at_limit', summary };
}

function pushToolResult(messages: ChatMessage[], call: ToolCall, content: string): void {
  messages.push({ role: 'tool', tool_call_id: call.id, content });
}

interface ToolOutcome {
  result: string;
  ok: boolean;
}

async function runTool(sandbox: Sandbox, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    if (!TOOL_NAMES.has(name)) return { result: `no tool called ${name}`, ok: false };

    const text = (key: string): string => {
      const value = args[key];
      if (typeof value !== 'string') throw new TypeError(`${key} must be a string`);
      return value;
    };
    const count = (key: string): number | undefined => {
      const value = args[key];
      if (value === undefined || value === null) return undefined;
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed)) throw new TypeError(`${key} must be a number`);
      return Math.trunc(parsed);
    };

    switch (name) {
      case 'read_file':
        return ok(sandbox.readFile(text('path'), count('start') ?? 1, count('end') ?? null));
      case 'list_dir':
        return ok(sandbox.listDir(typeof args.path === 'string' ? args.path : '.'));
      case 'search':
        return ok(sandbox.search(text('pattern'), typeof args.path === 'string' ? args.path : '.'));
      case 'replace_in_file':
        return ok(sandbox.replaceInFile(text('path'), text('old'), text('new')));
      case 'create_file':
        return ok(sandbox.createFile(text('path'), text('content')));
      case 'run_check':
        return ok(await sandbox.runCheck(text('name')));
      default:
        return { result: `no tool called ${name}`, ok: false };
    }
  } catch (error) {
    if (error instanceof SandboxRefusal) return { result: `refused: ${error.message}`, ok: false };
    return { result: `failed: ${(error as Error).message}`, ok: false };
  }
}

function ok(result: string): ToolOutcome {
  const refusedResult = result.startsWith('refused') || result.startsWith('failed');
  return { result, ok: !refusedResult };
}
