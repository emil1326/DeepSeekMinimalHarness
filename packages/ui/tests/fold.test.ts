/**
 * The event log turned into things a person reads.
 *
 * `fold` is the only real logic in the UI, and it is the one place where a bug
 * would quietly show the wrong story: a tool result landing on the wrong call,
 * an answer losing its question, or a metrics line turning into a paragraph per
 * turn. So it gets tests, with events shaped exactly like the daemon writes them.
 */

import { describe, expect, it } from 'vitest';
import { fold, lastNote, pendingQuestion } from '../src/fold';
import type { CallMetrics, RunEvent, RunEventBody, RunTotals } from '../src/types';

let seq = 0;

function event(body: RunEventBody, at = '2026-01-01T00:00:00.000Z'): RunEvent {
  seq += 1;
  return { seq, runId: 'run-test', at, ...body } as RunEvent;
}

function call(overrides: Partial<CallMetrics> = {}): CallMetrics {
  return {
    model: 'deepseek-flash',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1200,
    timeToFirstTokenMs: 300,
    streamingMs: 900,
    largestGapMs: 12,
    promptTokens: 1000,
    cacheHitTokens: 600,
    cacheMissTokens: 400,
    completionTokens: 120,
    reasoningTokens: 90,
    generationTokensPerSecond: 133.3,
    endToEndTokensPerSecond: 100,
    ...overrides,
  };
}

const totals: RunTotals = {
  calls: 1,
  timedCalls: 1,
  promptTokens: 1000,
  cacheHitTokens: 600,
  completionTokens: 120,
  reasoningTokens: 90,
  timeToFirstTokenMs: 300,
  generationTokensPerSecond: 133.3,
  endToEndTokensPerSecond: 100,
  costUsd: null,
};

describe('folding the event log', () => {
  it('keeps the thinking separate from the answer', () => {
    // The model thinks before it answers, on its own channel, and that thinking
    // is billed as output. Folding it into the answer would both misrepresent
    // the conversation and hide what the run cost.
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({ type: 'thinking.delta', turn: 1, text: 'the file is the thing ' }),
      event({ type: 'thinking.delta', turn: 1, text: 'the task names' }),
      event({ type: 'text.delta', turn: 1, text: 'Reading it now.' }),
    ]);
    expect(blocks).toMatchObject([
      { kind: 'turn', turn: 1 },
      { kind: 'thinking', turn: 1, text: 'the file is the thing the task names', tokens: null },
      { kind: 'text', turn: 1, text: 'Reading it now.' },
    ]);
  });

  it('attaches what the thinking cost to the thinking block', () => {
    const metrics = call({ reasoningTokens: 797 });
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({ type: 'thinking.delta', turn: 1, text: 'thinking about it' }),
      event({ type: 'text.delta', turn: 1, text: 'Done.' }),
      event({ type: 'metrics', turn: 1, call: metrics, totals }),
    ]);
    const thinking = blocks.find((block) => block.kind === 'thinking');
    expect(thinking).toMatchObject({ kind: 'thinking', tokens: 797 });
  });

  it('leaves the thinking block numberless when the API reported none', () => {
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({ type: 'thinking.delta', turn: 1, text: 'hmm' }),
      event({ type: 'metrics', turn: 1, call: call({ reasoningTokens: 0 }), totals }),
    ]);
    expect(blocks.find((block) => block.kind === 'thinking')).toMatchObject({ tokens: null });
  });

  it('joins the streamed text of one turn into a single block', () => {
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({ type: 'text.delta', turn: 1, text: 'I will ' }),
      event({ type: 'text.delta', turn: 1, text: 'read the file' }),
      event({ type: 'text.delta', turn: 1, text: ' first.' }),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ kind: 'text', text: 'I will read the file first.' });
  });

  it('starts a new paragraph when the turn moves on', () => {
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({ type: 'text.delta', turn: 1, text: 'first' }),
      event({ type: 'turn.start', turn: 2 }),
      event({ type: 'text.delta', turn: 2, text: 'second' }),
    ]);
    const text = blocks.filter((block) => block.kind === 'text');
    expect(text.map((block) => (block.kind === 'text' ? block.text : ''))).toEqual(['first', 'second']);
  });

  it('puts a tool result on the call it belongs to, not on the next one', () => {
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({ type: 'tool.call', turn: 1, id: 'a', name: 'read_file', args: { path: 'x.ts' } }),
      event({ type: 'tool.call', turn: 1, id: 'b', name: 'search', args: { pattern: 'y' } }),
      event({ type: 'tool.result', turn: 1, id: 'b', name: 'search', ok: true, result: 'found it' }),
      event({ type: 'tool.result', turn: 1, id: 'a', name: 'read_file', ok: false, result: 'refused: nope' }),
    ]);
    const tools = blocks.filter((block) => block.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'read_file', result: 'refused: nope', ok: false });
    expect(tools[1]).toMatchObject({ name: 'search', result: 'found it', ok: true });
  });

  it('hangs each model call on its turn instead of making a block per call', () => {
    const metrics = call();
    const blocks = fold([
      event({ type: 'turn.start', turn: 1 }),
      event({ type: 'text.delta', turn: 1, text: 'hello' }),
      event({ type: 'metrics', turn: 1, call: metrics, totals }),
      event({ type: 'turn.start', turn: 2 }),
      event({ type: 'text.delta', turn: 2, text: 'again' }),
      event({ type: 'metrics', turn: 2, call: metrics, totals }),
    ]);
    expect(blocks.filter((block) => block.kind !== 'turn' && block.kind !== 'text')).toEqual([]);
    const turns = blocks.filter((block) => block.kind === 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ kind: 'turn', turn: 1, call: metrics });
    expect(turns[1]).toMatchObject({ kind: 'turn', turn: 2, call: metrics });
    expect(blocks[0]).toMatchObject({ turn: 1, call: metrics });
  });

  it('leaves a turn with no metrics answering null rather than undefined', () => {
    const blocks = fold([event({ type: 'turn.start', turn: 1 })]);
    expect(blocks[0]).toMatchObject({ kind: 'turn', call: null });
  });

  it('keeps an answer with its question', () => {
    const blocks = fold([
      event({ type: 'question', id: 'q1', question: 'which file?' }),
      event({ type: 'answer', id: 'q1', answer: 'the ts one', by: 'claude' }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'question',
      question: 'which file?',
      answer: { text: 'the ts one', by: 'claude' },
    });
  });

  it('shows messages from the launcher and the UI as who said them', () => {
    const blocks = fold([
      event({ type: 'message', by: 'claude', text: 'also rename it' }),
      event({ type: 'message', by: 'emil', text: 'actually, leave it' }),
    ]);
    expect(blocks).toMatchObject([
      { kind: 'said', by: 'claude', text: 'also rename it' },
      { kind: 'said', by: 'emil', text: 'actually, leave it' },
    ]);
  });

  it('turns limits, strays and errors into loud notes', () => {
    const blocks = fold([
      event({ type: 'limit', which: 'turns', detail: 'used all 12 turns' }),
      event({ type: 'stray', files: ['src/other.ts', 'package.json'] }),
      event({ type: 'error', message: 'DeepSeek answered 503' }),
    ]);
    const notes = blocks.filter((block) => block.kind === 'note');
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatchObject({ tone: 'warn' });
    expect(notes[1]).toMatchObject({ tone: 'bad' });
    expect(notes[1]?.kind === 'note' && notes[1].text).toContain('src/other.ts, package.json');
    expect(notes[2]).toMatchObject({ tone: 'bad', text: 'DeepSeek answered 503' });
  });

  it('explains a retry while it is happening, so a stall is not a mystery', () => {
    // Without this the run just sits there for up to eight seconds and there is
    // nothing anywhere to say why. A rate limit during a wide sweep is the
    // normal case, not the rare one.
    const blocks = fold([
      event({ type: 'turn.start', turn: 3 }),
      event({ type: 'retry', turn: 3, attempt: 1, status: 429, waitMs: 900 }),
    ]);
    const note = blocks.find((block) => block.kind === 'note');
    if (note?.kind !== 'note') throw new Error('unreachable');
    expect(note.tone).toBe('warn');
    expect(note.text).toBe('the model answered 429; trying again in 0.9s (attempt 1)');
  });

  it('says "could not be reached" when there was no answer to quote', () => {
    // A status of 0 is a network failure: the request never got a reply, so
    // printing "answered 0" would be inventing one.
    const blocks = fold([event({ type: 'retry', turn: 1, attempt: 2, status: 0, waitMs: 1600 })]);
    const note = blocks.find((block) => block.kind === 'note');
    if (note?.kind !== 'note') throw new Error('unreachable');
    expect(note.text).toBe('the model could not be reached; trying again in 1.6s (attempt 2)');
  });

  it('reports the loudest thing, or nothing once there is a summary', () => {
    expect(lastNote([event({ type: 'stray', files: ['a.ts'] })])).toContain('a.ts');
    expect(lastNote([event({ type: 'error', message: 'boom' })])).toBe('boom');
    // A summary is the agent's own ending, so it is not a problem to shout about.
    expect(lastNote([event({ type: 'summary', text: 'done' })])).toBeNull();
    expect(lastNote([])).toBeNull();
  });

  it('finds the question still waiting for an answer', () => {
    const events = [
      event({ type: 'question', id: 'q1', question: 'first?' }),
      event({ type: 'answer', id: 'q1', answer: 'yes', by: 'claude' }),
      event({ type: 'question', id: 'q2', question: 'second?' }),
    ];
    expect(pendingQuestion(events)).toEqual({ id: 'q2', question: 'second?' });
    expect(pendingQuestion(events.slice(0, 2))).toBeNull();
  });
});
