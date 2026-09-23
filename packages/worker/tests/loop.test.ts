import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeepSeekClient,
  Sandbox,
  type ChatMessage,
  type RunEventBody,
  type Speaker,
} from '@emilswork/harness-core';
import { runAgentLoop, type LoopControl } from '@emilswork/harness-worker';
import { startFakeDeepSeek, type ScriptedTurn } from '../../core/tests/fake-server.js';
import { createFixture } from './fixture.js';

const fixture = createFixture();
afterAll(() => fixture.cleanup());
// Every test starts from the same two files. Without this, one test's edit is
// the next test's starting state, and the failures look like logic bugs.
beforeEach(() => fixture.reset());

class TestControl implements LoopControl {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  asked = 0;
  turns = 0;
  private readonly queued: { text: string; by: Speaker }[] = [];
  private readonly answers: string[] = [];
  /** Delivered on this turn's boundary, once. */
  private scheduled: { turn: number; text: string; by: Speaker } | null = null;

  takeMessages = (): { text: string; by: Speaker }[] => {
    this.turns += 1;
    if (this.scheduled !== null && this.scheduled.turn === this.turns) {
      const message = { text: this.scheduled.text, by: this.scheduled.by };
      this.scheduled = null;
      return [...this.queued.splice(0, this.queued.length), message];
    }
    return this.queued.splice(0, this.queued.length);
  };

  sayLater(turn: number, text: string, by: Speaker = 'claude'): void {
    this.scheduled = { turn, text, by };
  }

  willAnswer(text: string): void {
    this.answers.push(text);
  }

  waitForAnswer = async (
    _id: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ text: string; by: Speaker } | null> => {
    this.asked += 1;
    const answer = this.answers.shift();
    if (answer !== undefined) return { text: answer, by: 'claude' };
    return new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(null);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(null);
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

interface HarnessResult {
  status: string;
  summary: string | null;
  events: RunEventBody[];
  requests: Record<string, unknown>[];
  server: Awaited<ReturnType<typeof startFakeDeepSeek>>;
}

async function drive(
  script: ScriptedTurn[],
  task: Record<string, unknown>,
  control: TestControl,
): Promise<HarnessResult> {
  const server = await startFakeDeepSeek(script);
  const config = fixture.writeTask(`task-${Math.random().toString(36).slice(2)}`, task);
  const sandbox = new Sandbox({
    root: fixture.repo,
    allow: config.allow,
    profile: config.resolvedProfile,
    checkNames: config.checks,
  });
  const client = new DeepSeekClient({ apiKey: 'test-key', baseUrl: server.url });
  const events: RunEventBody[] = [];
  const result = await runAgentLoop({ sandbox, client, config, emit: (body) => events.push(body) }, control);
  return {
    status: result.status,
    summary: result.summary,
    events: events,
    requests: server.requests,
    server,
  };
}

function messagesOf(result: HarnessResult, index: number): ChatMessage[] {
  return (result.requests[index]?.messages ?? []) as ChatMessage[];
}

describe('the agent loop', () => {
  it('reads, edits, runs a check and finishes', async () => {
    const control = new TestControl();
    const result = await drive(
      [
        {
          text: 'let me look at the file first and then change the constant',
          reasoning: 'the constant is the only thing the task names, so read the file it is in',
          tokenDelayMs: 20,
          toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }],
        },
        // A tool call streams its arguments, so this turn has a real decode
        // window. Long enough between chunks to be a measurement rather than
        // scheduler granularity.
        {
          tokenDelayMs: 25,
          toolCalls: [{ name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 2' } }],
        },
        { toolCalls: [{ name: 'run_check', args: { name: 'echo' } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'changed the constant' } }] },
      ],
      {},
      control,
    );

    expect(result.status).toBe('finished');
    expect(result.summary).toBe('changed the constant');
    expect(fixture.read('src/a.ts')).toBe('export const a = 2;\n');

    const names = result.events.filter((event) => event.type === 'tool.call').map((event) => event.name);
    expect(names).toEqual(['read_file', 'replace_in_file', 'run_check', 'finish']);

    const checkResult = result.events.find(
      (event) => event.type === 'tool.result' && event.name === 'run_check',
    );
    expect(checkResult?.type === 'tool.result' && checkResult.result).toContain('ran');

    const metrics = result.events.filter((event) => event.type === 'metrics');
    expect(metrics).toHaveLength(4);
    const last = metrics[3];
    if (last?.type === 'metrics') {
      expect(last.totals.calls).toBe(4);
      expect(last.totals.completionTokens).toBe(200);
      expect(last.totals.timeToFirstTokenMs).not.toBeNull();
    }
    // The first turn streamed text, so there is a decode window to measure.
    const first = metrics[0];
    if (first?.type === 'metrics') {
      expect(first.call.generationTokensPerSecond).not.toBeNull();
      expect(first.call.timeToFirstTokenMs).not.toBeNull();
    }
    // The thinking is its own channel, streamed and counted. It is billed as
    // output, so a run that hid it would be hiding most of its own cost.
    const thinking = result.events.filter((event) => event.type === 'thinking.delta');
    expect(thinking.length).toBeGreaterThan(0);
    expect(thinking.map((event) => (event.type === 'thinking.delta' ? event.text : '')).join('')).toContain(
      'the constant is the only thing the task names',
    );
    if (first?.type === 'metrics') {
      expect(first.call.reasoningTokens).toBeGreaterThan(0);
      expect(first.totals.reasoningTokens).toBeGreaterThan(0);
    }
    // The second streams its tool arguments, so it has a real, short window:
    // a number, and faster than the end-to-end figure that includes the wait.
    const second = metrics[1];
    if (second?.type === 'metrics') {
      expect(second.call.generationTokensPerSecond).not.toBeNull();
      expect(second.call.generationTokensPerSecond ?? 0).toBeGreaterThan(
        second.call.endToEndTokensPerSecond ?? 0,
      );
    }
    expect(result.events.filter((event) => event.type === 'text.delta').length).toBeGreaterThan(0);
    await result.server.close();
  });

  it('hands a refusal back to the model instead of crashing', async () => {
    const control = new TestControl();
    const result = await drive(
      [
        { toolCalls: [{ name: 'replace_in_file', args: { path: 'src/a.ts', old: 't', new: 'T' } }] },
        { toolCalls: [{ name: 'replace_in_file', args: { path: '.git/config', old: 'a', new: 'b' } }] },
        { toolCalls: [{ name: 'run_check', args: { name: 'rm -rf /' } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'gave up' } }] },
      ],
      {},
      control,
    );

    const results = result.events.filter((event) => event.type === 'tool.result');
    expect(results[0]?.type === 'tool.result' && results[0].result).toContain('appears 2 times');
    expect(results[1]?.type === 'tool.result' && results[1].result.startsWith('refused')).toBe(true);
    expect(results[2]?.type === 'tool.result' && results[2].result.startsWith('refused')).toBe(true);
    expect(result.status).toBe('finished');
    await result.server.close();
  });

  it('asks a question, waits, and carries the answer back to the model', async () => {
    const control = new TestControl();
    control.willAnswer('the ts one');
    const result = await drive(
      [
        { toolCalls: [{ name: 'ask', args: { question: 'which file?' } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'done' } }] },
      ],
      {},
      control,
    );

    expect(control.asked).toBe(1);
    const question = result.events.find((event) => event.type === 'question');
    expect(question?.type === 'question' && question.question).toBe('which file?');
    const answer = result.events.find((event) => event.type === 'answer');
    expect(answer?.type === 'answer' && answer.answer).toBe('the ts one');
    expect(result.events.some((event) => event.type === 'status' && event.status === 'waiting')).toBe(true);

    const second = messagesOf(result, 1);
    const toolMessage = second.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('the ts one');
    await result.server.close();
  });

  it('stops at the ask limit when nothing answers', async () => {
    const control = new TestControl();
    const result = await drive(
      [{ toolCalls: [{ name: 'ask', args: { question: 'anyone there?' } }] }],
      {
        limits: { askSeconds: 1 },
      },
      control,
    );

    expect(result.status).toBe('stopped_at_limit');
    const limit = result.events.find((event) => event.type === 'limit');
    expect(limit?.type === 'limit' && limit.which).toBe('askSeconds');
    await result.server.close();
  });

  it('delivers a message from the launcher at a turn boundary', async () => {
    const control = new TestControl();
    control.sayLater(2, 'also rename the constant');
    const result = await drive(
      [
        { toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'ok' } }] },
      ],
      {},
      control,
    );

    const second = messagesOf(result, 1);
    expect(second.some((message) => message.content?.includes('[claude] also rename the constant'))).toBe(
      true,
    );
    await result.server.close();
  });

  it('stops when it runs out of turns', async () => {
    const control = new TestControl();
    const result = await drive(
      [{ toolCalls: [{ name: 'list_dir', args: { path: '.' } }] }],
      { limits: { turns: 2 } },
      control,
    );
    expect(result.status).toBe('stopped_at_limit');
    const limit = result.events.find((event) => event.type === 'limit');
    expect(limit?.type === 'limit' && limit.which).toBe('turns');
    await result.server.close();
  });

  it('stops when the output token budget is gone', async () => {
    const control = new TestControl();
    const result = await drive(
      [{ toolCalls: [{ name: 'list_dir', args: { path: '.' } }], completionTokens: 500 }],
      { limits: { outputTokens: 100 } },
      control,
    );
    expect(result.status).toBe('stopped_at_limit');
    const limit = result.events.find((event) => event.type === 'limit');
    expect(limit?.type === 'limit' && limit.which).toBe('outputTokens');
    await result.server.close();
  });

  it('says a rate limit out loud instead of silently stalling', async () => {
    // Found live. The client had an `onRetry` hook and the worker never wired it
    // up, so a 429 cost up to eight seconds of backoff with nothing recorded
    // anywhere: the run just sat there, and the stall was indistinguishable from
    // the model being slow. A 429 is exactly what a wide sweep does.
    const control = new TestControl();
    const result = await drive(
      [{ status: 429 }, { toolCalls: [{ name: 'finish', args: { summary: 'survived a 429' } }] }],
      {},
      control,
    );

    expect(result.status).toBe('finished');
    const retries = result.events.filter((event) => event.type === 'retry');
    expect(retries).toHaveLength(1);
    const first = retries[0];
    if (first?.type !== 'retry') throw new Error('unreachable');
    expect(first.status).toBe(429);
    expect(first.attempt).toBe(1);
    expect(first.waitMs).toBeGreaterThanOrEqual(400);
    // The turn it happened in, so the notice lands in the right place.
    expect(first.turn).toBe(1);
    // And the run really did retry rather than the first attempt being used.
    expect(result.requests.length).toBeGreaterThanOrEqual(2);
    await result.server.close();
  });

  it('does not invent a retry notice for a run that never retried', async () => {
    // The control. A notice on every run would train a reader to ignore it, and
    // would make the cost of a clean run look worse than it is.
    const control = new TestControl();
    const result = await drive(
      [{ toolCalls: [{ name: 'finish', args: { summary: 'clean' } }] }],
      {},
      control,
    );
    expect(result.events.filter((event) => event.type === 'retry')).toHaveLength(0);
    await result.server.close();
  });

  it('cancels mid-stream and reports cancelled', async () => {
    const control = new TestControl();
    const server = await startFakeDeepSeek([{ text: 'never mind', delayMs: 5000, tokenDelayMs: 200 }]);
    const config = fixture.writeTask('task-cancel', {});
    const sandbox = new Sandbox({
      root: fixture.repo,
      allow: config.allow,
      profile: config.resolvedProfile,
      checkNames: config.checks,
    });
    const client = new DeepSeekClient({ apiKey: 'test-key', baseUrl: server.url });
    const events: RunEventBody[] = [];
    const pending = runAgentLoop({ sandbox, client, config, emit: (body) => events.push(body) }, control);
    setTimeout(() => control.controller.abort(), 150);
    const result = await pending;
    expect(result.status).toBe('cancelled');
    await server.close();
  });
});

describe('keeping a run inside the model window', () => {
  /** About 8,900 tokens by the estimate in core, so three cannot share a 12,000 budget. */
  function writeBigFile(): void {
    const lines = Array.from({ length: 1200 }, (_, index) => `export const row_${index} = ${index};`);
    fs.writeFileSync(path.join(fixture.repo, 'src', 'big.ts'), `${lines.join('\n')}\n`);
  }

  // The big file is written by these tests and is not part of the fixture, so it
  // is removed again. Left behind, it would show up in another test's directory
  // listing and read as a failure of something unrelated.
  afterEach(() => {
    fs.rmSync(path.join(fixture.repo, 'src', 'big.ts'), { force: true });
  });

  it('forgets older reads once the conversation would not fit', async () => {
    writeBigFile();
    const control = new TestControl();
    const result = await drive(
      [
        { toolCalls: [{ name: 'read_file', args: { path: 'src/big.ts' } }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'src/big.ts' } }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'src/big.ts' } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'read it three times' } }] },
      ],
      { allow: ['src/a.ts', 'src/big.ts'], limits: { contextTokens: 12_000 } },
      control,
    );

    expect(result.status).toBe('finished');

    // The event is the point: a reader has to know the model's view changed, or
    // an answer that contradicts an earlier read looks like a bug in the model.
    const trimmed = result.events.filter((event) => event.type === 'context');
    expect(trimmed.length).toBeGreaterThan(0);
    const first = trimmed[0];
    if (first?.type !== 'context') throw new Error('unreachable');
    expect(first.dropped).toBeGreaterThan(0);
    expect(first.subjects.join(' ')).toContain('big.ts');
    expect(first.tokensAfter).toBeLessThan(first.tokensBefore);

    // And it actually reached the wire: the last request has a notice in it
    // where a file's contents used to be.
    const last = messagesOf(result, result.requests.length - 1);
    const toolMessages = last.filter((message) => message.role === 'tool');
    const notices = toolMessages.filter(
      (message) => typeof message.content === 'string' && message.content.includes('dropped to make room'),
    );
    expect(notices.length).toBeGreaterThan(0);
    // The pairing rule the API enforces: one tool reply per call id, always.
    const callIds = last.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id));
    const replyIds = toolMessages.map((message) => message.tool_call_id);
    expect(replyIds).toEqual(callIds);
    await result.server.close();
  });

  it('leaves a conversation that fits exactly as it was', async () => {
    const control = new TestControl();
    const result = await drive(
      [
        { toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'src/b.ts' } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'done' } }] },
      ],
      {},
      control,
    );

    // Nothing was dropped, so nothing should have been announced. A `context`
    // event on every run would train the reader to ignore it.
    expect(result.events.filter((event) => event.type === 'context')).toHaveLength(0);
    expect(result.status).toBe('finished');
    await result.server.close();
  });

  it('stops the run when even a fully trimmed conversation cannot fit', async () => {
    writeBigFile();
    const control = new TestControl();
    const result = await drive(
      [
        { toolCalls: [{ name: 'read_file', args: { path: 'src/big.ts' } }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'src/big.ts' } }] },
        { toolCalls: [{ name: 'finish', args: { summary: 'never reached' } }] },
      ],
      // Below a single read, so there is nothing left to drop that would help.
      { allow: ['src/a.ts', 'src/big.ts'], limits: { contextTokens: 500 } },
      control,
    );

    expect(result.status).toBe('stopped_at_limit');
    const limit = result.events.find((event) => event.type === 'limit');
    if (limit?.type !== 'limit') throw new Error('unreachable');
    expect(limit.which).toBe('contextTokens');
    expect(limit.detail).toContain('even after dropping every tool result');
    // Stopping is the point. Letting the request go out would get a 400 back,
    // which is not retryable, so the run would be lost rather than stopped.
    expect(result.events.filter((event) => event.type === 'error')).toHaveLength(0);
    await result.server.close();
  });
});

describe('ordering and batching of tool calls', () => {
  it('answers a turn of several reads in the order they were asked for', async () => {
    const control = new TestControl();
    const result = await drive(
      [
        {
          toolCalls: [
            { name: 'read_file', args: { path: 'src/a.ts' } },
            { name: 'read_file', args: { path: 'src/b.ts' } },
            { name: 'list_dir', args: { path: 'src' } },
          ],
        },
        // A second turn, so the next request carries the tool messages and they
        // can be checked for order and pairing.
        { toolCalls: [{ name: 'finish', args: { summary: 'read them all' } }] },
      ],
      {},
      control,
    );

    const results = result.events.filter((event) => event.type === 'tool.result');
    expect(results.map((event) => (event.type === 'tool.result' ? event.name : ''))).toEqual([
      'read_file',
      'read_file',
      'list_dir',
      'finish',
    ]);
    // Each result belongs to its own call, not to whichever happened to finish.
    const reads = results.filter((event) => event.type === 'tool.result' && event.name === 'read_file');
    expect(reads[0]?.type === 'tool.result' && reads[0].result).toContain('export const a');
    expect(reads[1]?.type === 'tool.result' && reads[1].result).toContain('export const b');

    // One tool message per call, in the same order, each with the id of the call
    // it answers: the API pairs them by id, and a mismatch is a 400 from
    // DeepSeek rather than a wrong answer.
    const second = messagesOf(result, 1);
    const toolMessages = second.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0]?.content).toContain('export const a');
    expect(toolMessages[1]?.content).toContain('export const b');
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['call_1_0', 'call_1_1', 'call_1_2']);
    await result.server.close();
  });

  it('keeps a write in order with the reads around it', async () => {
    // The load-bearing case. If a write were batched with the reads, the second
    // read could come back before the edit and the model would be told the file
    // still says what it just changed.
    const control = new TestControl();
    const result = await drive(
      [
        {
          toolCalls: [
            { name: 'read_file', args: { path: 'src/a.ts' } },
            { name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 5' } },
            { name: 'read_file', args: { path: 'src/a.ts' } },
            { name: 'finish', args: { summary: 'changed it' } },
          ],
        },
      ],
      {},
      control,
    );

    const reads = result.events.filter((event) => event.type === 'tool.result' && event.name === 'read_file');
    expect(reads[0]?.type === 'tool.result' && reads[0].result).toContain('= 1');
    expect(reads[1]?.type === 'tool.result' && reads[1].result).toContain('= 5');
    await result.server.close();
  });

  it('runs two edits to one file in the order they were written', async () => {
    const control = new TestControl();
    const result = await drive(
      [
        {
          toolCalls: [
            { name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 1', new: '= 2' } },
            { name: 'replace_in_file', args: { path: 'src/a.ts', old: '= 2', new: '= 3' } },
            { name: 'finish', args: { summary: 'twice' } },
          ],
        },
      ],
      {},
      control,
    );

    const edits = result.events.filter(
      (event) => event.type === 'tool.result' && event.name === 'replace_in_file',
    );
    // The second edit only matches because the first one already landed.
    expect(edits[0]?.type === 'tool.result' && edits[0].result).toBe('replaced');
    expect(edits[1]?.type === 'tool.result' && edits[1].result).toBe('replaced');
    expect(fixture.read('src/a.ts')).toBe('export const a = 3;\n');
    await result.server.close();
  });

  it('hands the model a readable reason when a replace misses', async () => {
    // The point of the diagnostics. This text is in the file with different
    // indentation, and the result says so rather than just refusing.
    const control = new TestControl();
    const result = await drive(
      [
        {
          toolCalls: [
            { name: 'replace_in_file', args: { path: 'src/a.ts', old: '    export const a = 1;', new: 'x' } },
            { name: 'finish', args: { summary: 'gave up' } },
          ],
        },
      ],
      {},
      control,
    );

    const first = result.events.find((event) => event.type === 'tool.result');
    const text = first?.type === 'tool.result' ? first.result : '';
    expect(text).toContain('whitespace');
    expect(text).toContain('line 1');
    expect(text).toContain('export const a = 1;');
    await result.server.close();
  });
});
