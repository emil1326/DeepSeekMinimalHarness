import {
  AbortedError,
  DeepSeekClient,
  Sandbox,
  SandboxRefusal,
  SYSTEM_PROMPT,
  approaching,
  causeOf,
  checkPassed,
  compact,
  emptyTotals,
  exceeded,
  formatCount,
  formatLimit,
  formatUsd,
  limitUse,
  priceFor,
  taskMessage,
  timing,
  toolNames,
  toolSpecs,
  totalsOf,
  type ChatMessage,
  type CumulativeLimit,
  type FailureCause,
  type LimitUse,
  type PriceTable,
  type ResolvedRunConfig,
  type RunLimits,
  type RunEventBody,
  type RunStatus,
  type RunTotals,
  type Speaker,
  type ToolCall,
} from '@emilswork/harness-core';

/**
 * What the run is told when it is nearly out of room.
 *
 * Two things matter here. It says the numbers, because "you are running low" is
 * not actionable and "you have used 10 of 12 turns" is. And it says what to do
 * about it, including that asking for more room is allowed, because an agent
 * that does not know it may ask will either stop early or guess.
 */
function warnAbout(use: LimitUse): string {
  return (
    `[harness] You are near a limit: ${left(use)} left of ${formatLimit(use.which, use.budget)} ` +
    `(${formatLimit(use.which, use.used)} already used).\n` +
    `Finish what you can within it. If you genuinely need more room, call ask with how much ` +
    `more you need and what is left to do, and the person who launched you can grant it. ` +
    `If you cannot finish, call finish saying exactly what is done and what is not.`
  );
}

/** The unit each limit is counted in, for a sentence a person reads. */
const UNIT: Record<CumulativeLimit, string> = {
  turns: 'model calls',
  wallSeconds: 'seconds',
  outputTokens: 'output tokens',
  totalTokens: 'billed tokens',
  costUsd: 'dollars',
};

/** What is left, in the limit's own unit and its own words. */
function left(use: LimitUse): string {
  if (use.which === 'costUsd') return formatUsd(use.remaining);
  // `1 model calls` is the kind of thing that makes a model stop trusting the
  // numbers around it, so the singular loses its s.
  const unit = UNIT[use.which];
  return `${formatCount(use.remaining)} ${use.remaining === 1 ? unit.replace(/s$/, '') : unit}`;
}

/** Why a run stopped, with both numbers, for the event and the report. */
function whyStopped(use: LimitUse, totals: RunTotals): string {
  switch (use.which) {
    case 'turns':
      return `the run used all ${use.budget} turns`;
    case 'wallSeconds':
      return `the run went past ${use.budget} s of wall clock`;
    case 'outputTokens':
      return `the run wrote ${formatCount(totals.completionTokens)} output tokens, past the ${formatCount(use.budget)} it may`;
    case 'costUsd':
      return (
        `the run spent ${formatUsd(use.used)} of the ${formatUsd(use.budget)} it may, over ` +
        `${totals.calls} model call${totals.calls === 1 ? '' : 's'}`
      );
    case 'totalTokens':
      return (
        `the run used ${formatCount(totals.billedTokens)} billed tokens of the ${formatCount(use.budget)} it may, ` +
        `out of ${formatCount(totals.promptTokens)} prompt tokens sent, of which ` +
        `${formatCount(totals.cacheHitTokens)} were cache hits and cost a fraction of a miss`
      );
  }
}

export interface LoopOptions {
  sandbox: Sandbox;
  client: DeepSeekClient;
  config: ResolvedRunConfig;
  emit: (body: RunEventBody) => void;
  /**
   * Prices to bill against, as written in `config.json`.
   *
   * A table rather than one price, because DeepSeek charges half during off-peak
   * hours: the price of a call depends on the hour it was made, so it is looked
   * up per call against that call's own timestamp. Anything the table does not
   * name falls back to the published prices in `core/pricing.ts`.
   */
  prices?: PriceTable;
  /**
   * A conversation to carry on from, when this run continues an earlier one.
   *
   * Sent back exactly as the previous run ended with it, because the prompt
   * prefix is compared byte for byte for the cache and anything rebuilt would
   * bill as a brand-new conversation. See `core/transcript.ts`.
   */
  resume?: ChatMessage[];
  /**
   * Called whenever the conversation changes, so the run can be continued later.
   *
   * Handed out rather than written here, so the loop stays free of the
   * filesystem and a test can watch it without one.
   */
  onTranscript?: (messages: ChatMessage[]) => void;
  /**
   * Called the moment the agent asks a question.
   *
   * Synchronous and best effort. It exists because of a real run that asked
   * "may I edit a line of wire.rs?" and waited a full hour for nobody: whoever
   * launched it had walked away, and the run had no way to say so. Nothing here
   * can answer the question — the loop still blocks — but somebody who is told
   * can run `dsh reply`.
   */
  onQuestion?: (id: string, question: string) => void;
  /**
   * Hand the stopwatch's readings over, cumulative.
   *
   * Called once per turn and once more before the run reports itself done. The
   * per-turn call is what makes the readings survive a run that is killed
   * rather than finished: a process tree kill takes the memory with it, and a
   * run that is cancelled at turn thirty is exactly the run whose timings
   * somebody wants. Handed out rather than sent from here, because this file
   * knows nothing about IPC.
   */
  flushTimings?: () => void;
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
  /**
   * The limits in force, read fresh on every turn.
   *
   * A live object rather than `config.limits`, because the launcher can raise
   * them while the run is going: an agent that is about to run out can ask for
   * more room, and the answer has to be able to arrive. Mutated in place by the
   * daemon's `limits` message.
   */
  limits?: RunLimits;
}

export interface LoopResult {
  status: RunStatus;
  summary: string | null;
  /**
   * Why it failed, when it did, in a form a launcher can branch on.
   *
   * A spent account and a bad answer both leave the run `failed`, and one of
   * them means stop launching. A launcher that has to read prose to tell them
   * apart will keep starting runs against an account with no money on it.
   */
  cause?: FailureCause;
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

/**
 * What a continued run is told before it carries on.
 *
 * Without this, the agent does what its transcript tells it to. The last thing
 * it heard before it stopped was "you have run out of room, wrap up", so it
 * wrapped up: measured live, a continuation's first and only act was to call
 * `finish` with a summary of the one file it had managed. Replaying a
 * conversation whose ending is an instruction to stop, and then expecting the
 * work to resume, is expecting the model to ignore its own context.
 *
 * Appended rather than inserted, so every message before it is byte-identical to
 * what the previous run sent and the prompt cache still matches. A cache hit is
 * a prefix match; a message at the end does not disturb the prefix.
 */
function continuationMessage(limits: RunLimits, resumes: number): string {
  return (
    `[harness] You are continuing an earlier run that stopped at a limit. You now have ` +
    `${limits.turns} turns, ${formatCount(limits.totalTokens)} billed tokens and ` +
    `${formatUsd(limits.costUsd)} to spend.\n` +
    `That run made ${resumes} model calls. Its edits are already in the worktree: do not redo them, and ` +
    `do not re-read a file to check whether you changed it, because you did.\n` +
    `Carry on from where you stopped. The remaining work is whatever you had not done when you ran out. ` +
    `When it is all done, and the checks pass, call finish with a summary of the whole task, not just this ` +
    `continuation.`
  );
}

/** The agent loop: one model call per turn, a closed set of tools, limits, finish. */
export async function runAgentLoop(options: LoopOptions, control: LoopControl): Promise<LoopResult> {
  const { sandbox, client, config, emit } = options;
  // Read from the live object, so a limit raised mid-run is picked up by the
  // next turn rather than the next run.
  const limits = control.limits ?? config.limits;
  const clock = control.now ?? ((): number => Date.now());
  const startedAt = clock();
  let totals: RunTotals = emptyTotals();
  let summary: string | null = null;
  /** Files the agent claimed it changed, when it said so at all. */
  let claimed: string[] | null = null;
  /** Limits already announced, so each is warned about once and not every turn. */
  const warned = new Set<CumulativeLimit>();

  const continuing = options.resume !== undefined && options.resume.length > 0;
  const messages: ChatMessage[] = continuing
    ? [
        // The previous conversation, verbatim, so the prefix still matches and
        // still bills at the cache rate.
        ...(options.resume as ChatMessage[]),
        // And then one message of its own, at the end where it cannot disturb
        // that prefix, saying what has changed since it stopped.
        {
          role: 'user',
          content: continuationMessage(limits, (options.resume as ChatMessage[]).length),
        },
      ]
    : [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: taskMessage({
            task: config.task,
            allow: [...sandbox.allow].sort(),
            checks: sandbox.checkNames,
            soft: config.soft,
            rules: config.rules,
          }),
        },
      ];

  const tools = { checkNames: sandbox.checkNames, commands: sandbox.commands };
  const specs = toolSpecs(tools);
  const known = toolNames(tools);
  let turn = 0;

  /**
   * Hand the conversation out, so this run can be continued later.
   *
   * Called only where the message list is *balanced*: every `tool_calls` id has
   * its one `tool` reply. A list that ends with an assistant `tool_calls` and no
   * replies is a request the API rejects, so writing one mid-tool-call would
   * make a run uncontinuable at exactly the moment somebody wants to continue
   * it. Any return that skips the end-of-turn save has to call this itself.
   */
  const save = (): void => options.onTranscript?.(messages);

  // Offered straight away, so a run that is interrupted on its first turn is
  // still continuable.
  save();

  for (turn = 1; turn <= limits.turns; turn += 1) {
    if (control.signal.aborted) return { status: 'cancelled', summary };

    const elapsedSeconds = (clock() - startedAt) / 1000;
    const uses = limitUse({ turns: turn - 1, elapsedSeconds, totals }, limits);

    const hit = exceeded(uses);
    if (hit !== null) {
      const detail = whyStopped(hit, totals);
      emit({ type: 'limit', which: hit.which, detail, used: hit.used, budget: hit.budget });
      return { status: 'stopped_at_limit', summary };
    }

    // Close to a ceiling, and not told yet. Said before the model call, so the
    // agent can act inside the turn it still has rather than discover the
    // budget only when it is already spent.
    for (const near of approaching(uses, warned)) {
      warned.add(near.which);
      const detail = warnAbout(near);
      emit({
        type: 'warning',
        which: near.which,
        used: near.used,
        budget: near.budget,
        detail,
      });
      messages.push({ role: 'user', content: detail });
    }

    emit({ type: 'turn.start', turn });

    // Anything the launcher said arrives here, never in the middle of a tool
    // call. The daemon already recorded it as an event when it was sent, so
    // this only puts it into the conversation.
    for (const message of control.takeMessages()) {
      messages.push({ role: 'user', content: `[${message.by}] ${message.text}` });
    }

    // The message list grows every turn and every turn re-sends all of it, so
    // before the request goes out it is shortened to fit. Old tool results are
    // what gets forgotten, because they can be fetched again. Measured: the
    // model's ceiling is 1,048,576 tokens and past it the API answers 400, which
    // is not retryable, so without this the whole run was lost at the point it
    // needed to forget something instead.
    const fitted = compact(messages, { budget: limits.contextTokens });
    if (fitted.impossible) {
      const detail =
        `the conversation is ${fitted.tokensAfter} tokens and the budget is ${limits.contextTokens}, ` +
        `even after dropping every tool result that could be dropped`;
      emit({
        type: 'limit',
        which: 'contextTokens',
        detail,
        used: fitted.tokensAfter,
        budget: limits.contextTokens,
      });
      return { status: 'stopped_at_limit', summary };
    }
    if (fitted.elided.length > 0) {
      // The model's view changed, so the reader is told. Keep the live list in
      // step, because the next turn appends to it.
      messages.splice(0, messages.length, ...fitted.messages);
      emit({
        type: 'context',
        turn,
        dropped: fitted.elided.length,
        subjects: fitted.elided.map((elision) => `${elision.name} ${elision.subject}`),
        tokensBefore: fitted.tokensBefore,
        tokensAfter: fitted.tokensAfter,
      });
    }

    const buffer = new TextBuffer((text) => emit({ type: 'text.delta', turn, text }));
    // Thinking is its own stream. It is billed as output and it arrives before
    // the answer, so folding it into the answer would both misrepresent the
    // conversation and hide most of what a run actually costs.
    const thoughts = new TextBuffer((text) => emit({ type: 'thinking.delta', turn, text }));
    let outcome;
    try {
      // One span for the call as a whole, next to the finer `core.deepseek.*`
      // ones inside it. The difference between the two is the loop's own
      // overhead around the call, and the count is the number of turns.
      outcome = await timing.measureAsync(`worker.turn.model`, () =>
        client.stream({
          model: config.model,
          messages,
          tools: specs,
          signal: control.signal,
          onText: (delta) => buffer.push(delta),
          onReasoning: (delta) => thoughts.push(delta),
          // A 429 or a 503 costs up to eight seconds of waiting before the next
          // attempt, and until this existed nothing at all recorded it: the run
          // simply sat there, and the stall was indistinguishable from a slow
          // model. The client had the hook; nothing was listening.
          onRetry: (info) => emit({ type: 'retry', turn, ...info }),
        }),
      );
    } catch (error) {
      buffer.drain();
      thoughts.drain();
      if (control.signal.aborted || error instanceof AbortedError) return { status: 'cancelled', summary };
      emit({ type: 'error', message: (error as Error).message });
      return { status: 'failed', summary, cause: causeOf(error) };
    }
    buffer.drain();
    thoughts.drain();

    totals = totalsOf(
      totals,
      outcome.metrics,
      // At the moment this call went out, not at the moment the run started. An
      // hour into a run that began at 00:55 UTC, every further call is billed at
      // half, and pricing the lot at the opening rate would overstate the bill
      // that the cost limit is measured against.
      priceFor(config.model, outcome.metrics.startedAt, options.prices),
    );
    emit({ type: 'metrics', turn, call: outcome.metrics, totals });
    messages.push(outcome.message);

    const calls = outcome.message.tool_calls ?? [];
    if (calls.length === 0) {
      // The model answered without calling a tool. That is as final as finish.
      // Balanced, so worth writing: an assistant message with no tool calls ends
      // an exchange.
      save();
      summary = outcome.message.content ?? '(stopped without calling finish)';
      emit({ type: 'summary', text: summary });
      return { status: 'finished', summary };
    }

    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index] as ToolCall;
      const name = call.function.name;
      const args = parseArgs(call);
      emit({ type: 'tool.call', turn, id: call.id, name, args });

      if (name === 'finish') {
        summary = typeof args.summary === 'string' ? args.summary : '';
        claimed = stringList(args.changed);
        pushToolResult(messages, call, 'ok');
        // Saved before returning, because this is a return inside the turn loop:
        // the end-of-turn save below never runs, and without this the last
        // transcript on disk is one exchange out of date.
        save();
        emit({ type: 'tool.result', turn, id: call.id, name, ok: true, result: 'ok' });
        emit({ type: 'summary', text: summary, ...(claimed === null ? {} : { changed: claimed }) });
        return { status: 'finished', summary };
      }

      if (name === 'ask') {
        const question = typeof args.question === 'string' ? args.question : '(no question given)';
        emit({ type: 'question', id: call.id, question });
        // Before the wait, not after: the whole value of the notification is
        // that it arrives while somebody could still do something about it.
        try {
          options.onQuestion?.(call.id, question);
        } catch {
          /* a notification must never be a reason to lose a run */
        }
        emit({ type: 'status', status: 'waiting', detail: question });
        const answer = await timing.measureAsync('worker.ask.wait', () =>
          control.waitForAnswer(call.id, limits.askSeconds * 1000, control.signal),
        );
        if (answer === null) {
          if (control.signal.aborted) return { status: 'cancelled', summary };
          const detail = `nothing came back within ${limits.askSeconds} s of waiting for an answer`;
          emit({
            type: 'limit',
            which: 'askSeconds',
            detail,
            used: limits.askSeconds,
            budget: limits.askSeconds,
          });
          return { status: 'stopped_at_limit', summary };
        }
        emit({ type: 'answer', id: call.id, answer: answer.text, by: answer.by });
        emit({ type: 'status', status: 'running' });
        const text = `the answer: ${answer.text}`;
        pushToolResult(messages, call, text);
        emit({ type: 'tool.result', turn, id: call.id, name, ok: true, result: text });
        continue;
      }

      // Reads are independent of each other, so a model that asks for four
      // files at once waits for one round trip instead of four. Writes and
      // checks stay strictly in order: two edits to the same file must land in
      // the order they were written, and two formatters fighting over one file
      // is not a speed-up.
      const batch: ToolCall[] = [call];
      if (READ_ONLY.has(name)) {
        for (let next = index + 1; next < calls.length; next += 1) {
          const candidate = calls[next] as ToolCall;
          if (!READ_ONLY.has(candidate.function.name)) break;
          batch.push(candidate);
        }
      }

      const outcomes = await Promise.all(
        batch.map((each) => runTool(sandbox, each.function.name, parseArgs(each), known)),
      );

      if (control.signal.aborted) return { status: 'cancelled', summary };
      for (const [at, each] of batch.entries()) {
        const outcomeOfTool = outcomes[at] as ToolOutcome;
        pushToolResult(messages, each, outcomeOfTool.result);
        emit({
          type: 'tool.result',
          turn,
          id: each.id,
          name: each.function.name,
          ok: outcomeOfTool.ok,
          result: outcomeOfTool.result,
        });
      }
      index += batch.length - 1;
    }
    // Once per turn's tool results, not per result. And only here, or at one of
    // the other balanced points: a transcript that ends with an assistant
    // `tool_calls` and no replies is a conversation the API refuses, so writing
    // one between the call and its result would make the run uncontinuable at
    // exactly the moment somebody wants to continue it.
    save();
    // And the readings, at the same boundary. Cumulative, so the daemon replaces
    // this run's rows rather than adding to them and a flush that arrives twice
    // cannot double a figure.
    options.flushTimings?.();
  }

  // The loop ran out by counting up to `turns`, which is the same thing as the
  // check at the top of the next iteration but with the numbers still in hand.
  emit({
    type: 'limit',
    which: 'turns',
    detail: `the run used all ${limits.turns} turns`,
    used: limits.turns,
    budget: limits.turns,
  });
  return { status: 'stopped_at_limit', summary };
}

/** Tools with no side effects, and therefore safe to run several of at once. */
const READ_ONLY = new Set(['read_file', 'list_dir', 'search']);

/** A tool call's arguments, or an empty object when the model wrote nonsense. */
function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * A list of strings from a tool argument, or null when it is not one.
 *
 * Null rather than an empty array, because "the agent listed no files" and "the
 * agent did not list files" are different claims and the report says different
 * things about them. A model that writes a single string instead of an array
 * gets the one-element list it clearly meant.
 */
function stringList(value: unknown): string[] | null {
  if (typeof value === 'string') return value.trim() === '' ? null : [value.trim()];
  if (!Array.isArray(value)) return null;
  const kept = value.filter((each): each is string => typeof each === 'string' && each.trim() !== '');
  return kept.length === 0 ? null : kept.map((each) => each.trim());
}

function pushToolResult(messages: ChatMessage[], call: ToolCall, content: string): void {
  messages.push({ role: 'tool', tool_call_id: call.id, content });
}

interface ToolOutcome {
  result: string;
  ok: boolean;
}

/**
 * One tool call, answered.
 *
 * `known` is passed in rather than imported, because the set of tools is a
 * property of the run now: it is the built-ins plus whatever this project
 * declared. A module-level constant here would be the one place a project's own
 * command names had to be known to the harness.
 */
async function runTool(
  sandbox: Sandbox,
  name: string,
  args: Record<string, unknown>,
  known: Set<string>,
): Promise<ToolOutcome> {
  // Named for the tool, and for the project's own commands by their own name,
  // so the row a reader wants ("the test suite took 40 s") exists. A name the
  // run does not offer is recorded as `unknown` rather than as itself: the name
  // comes from the model, and a model that invents a hundred of them must not
  // be able to invent a hundred rows.
  return timing.measureAsync(
    `worker.tool.${known.has(name) ? name : 'unknown'}`,
    () => runToolCall(sandbox, name, args, known),
    (outcome) => outcome.result.length,
  );
}

async function runToolCall(
  sandbox: Sandbox,
  name: string,
  args: Record<string, unknown>,
  known: Set<string>,
): Promise<ToolOutcome> {
  try {
    if (!known.has(name)) return { result: `no tool called ${name}`, ok: false };

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
      case 'run_check': {
        const output = await sandbox.runCheck(text('name'));
        // `ok` means "and it passed", not just "the call was not refused". A
        // check that exits 1 used to come back ok, so the CLI painted a failing
        // typecheck the same as a passing one, and a report built on `ok` would
        // have read the check as fine.
        return { result: output, ok: checkPassed(output) };
      }
      default: {
        // A command the project declared. Reaching the default is not an error:
        // it is where every project-specific tool in every run is handled, and
        // the branch is one line because everything specific about it lives in
        // the workspace file the project wrote. The sandbox refuses an unknown
        // name, so a command that no longer exists is answered rather than
        // crashing the turn.
        const output = await sandbox.runDeclared(name, args);
        return {
          result: output,
          ok: !output.startsWith('refused') && !output.startsWith('failed'),
        };
      }
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
