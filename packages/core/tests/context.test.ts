/**
 * Keeping a run inside the model's window.
 *
 * Three things are being defended here, in order of how bad it is to get them
 * wrong.
 *
 * **The pairing rule.** Every assistant message that carries `tool_calls` must
 * be followed by one `tool` message per id, or the API answers 400. That is the
 * failure this file exists to prevent, so a test proves nothing is ever removed
 * and every id keeps its reply.
 *
 * **What gets forgotten.** Old tool results, oldest first, and never the recent
 * ones: the model is working from what it just read, and eliding that makes it
 * read again and pay twice.
 *
 * **Not pretending to be clever.** An estimate is an estimate. Underestimating
 * costs the run, so the estimate is deliberately pessimistic and there is a
 * control for that direction.
 */

import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  compact,
  estimateTokens,
  largestToolResult,
  type ChatMessage,
} from '@emilswork/harness-core';

/** An assistant turn that calls `names.length` tools, then the results. */
function call(name: string, args: unknown, result: string): ChatMessage[] {
  const id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`;
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}

function opening(): ChatMessage[] {
  return [
    { role: 'system', content: 'You implement one small change.' },
    { role: 'user', content: 'Files you may change: src/a.ts' },
  ];
}

/** A big but plausible read: 1500 numbered lines. */
function bigRead(): string {
  return Array.from({ length: 1500 }, (_, line) => `${line + 1}\tconst row_${line} = ${line};`).join('\n');
}

describe('estimating the context', () => {
  it('counts the content, the tool arguments and the framing', () => {
    const small: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(350) }];
    // 350 chars at 3.5 per token is 100, plus the per-message overhead.
    expect(estimateTokens(small)).toBe(106);
  });

  it('counts tool call arguments, which are not in any content field', () => {
    const withArgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'replace_in_file', arguments: 'y'.repeat(350) } },
        ],
      },
    ];
    expect(estimateTokens(withArgs)).toBeGreaterThan(100);
  });

  it('is pessimistic, because underestimating costs the whole run', () => {
    // The rule of thumb for English is four characters per token. This sits
    // under that, so a budget compared against it is a budget with margin.
    expect(CHARS_PER_TOKEN).toBeLessThan(4);
    const english = 'the quick brown fox jumps over the lazy dog and keeps going. ';
    const real = estimateTokens([{ role: 'user', content: english.repeat(20) }]);
    // A real tokeniser would produce fewer tokens than this for that text.
    expect(real).toBeGreaterThan(english.repeat(20).length / 4);
  });
});

describe('compacting a conversation', () => {
  it('does nothing when the conversation already fits', () => {
    const messages = opening();
    const result = compact(messages, { budget: 10_000 });
    expect(result.elided).toEqual([]);
    expect(result.impossible).toBe(false);
    expect(result.tokensAfter).toBe(result.tokensBefore);
    // And it hands back a copy, so the caller's list is not aliased.
    expect(result.messages).not.toBe(messages);
  });

  it('never changes the number of messages, which is what the pairing rule needs', () => {
    const messages = [
      ...opening(),
      ...call('read_file', { path: 'a.ts' }, bigRead()),
      ...call('search', { pattern: 'needle' }, 'x'.repeat(40_000)),
      ...call('read_file', { path: 'b.ts' }, bigRead()),
      ...call('run_check', { name: 'typecheck' }, 'y'.repeat(30_000)),
    ];
    const result = compact(messages, { budget: 1_000 });

    expect(result.messages).toHaveLength(messages.length);
    // Every tool call id still has exactly one tool message answering it.
    const askedIds = result.messages.flatMap((message) => (message.tool_calls ?? []).map((c) => c.id));
    const answeredIds = result.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(answeredIds).toEqual(askedIds);
    for (const id of askedIds) expect(answeredIds.filter((each) => each === id)).toHaveLength(1);
  });

  it('forgets the oldest results and keeps the newest whole', () => {
    const messages = [
      ...opening(),
      ...call('read_file', { path: 'oldest.ts' }, bigRead()),
      ...call('read_file', { path: 'middle.ts' }, bigRead()),
      ...call('read_file', { path: 'newest.ts' }, bigRead()),
    ];
    // Each 1500-line read is about 12,000 tokens by the estimate, so a 20,000
    // budget holds the newest comfortably and cannot hold three. A budget that
    // could not hold even one would elide everything, which is correct and a
    // different case, covered below.
    const result = compact(messages, { budget: 20_000, keepRecent: 1 });

    const contents = result.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    // The newest is untouched, because the model is working from it.
    expect(contents[2]).toContain('const row_0 = 0;');
    // The older two are notices that say what they were and how to get it back.
    expect(contents[0]).toContain('read_file oldest.ts');
    expect(contents[0]).toContain('Ask again if you still need it');
    expect(contents[1]).toContain('read_file middle.ts');
    expect(result.elided).toHaveLength(2);
    expect(result.elided[0]?.subject).toBe('oldest.ts');
  });

  it('names a read by its line range, so the model knows what it lost', () => {
    const messages = [
      ...opening(),
      ...call('read_file', { path: 'src/a.ts', start: 100, end: 200 }, bigRead()),
      ...call('read_file', { path: 'src/b.ts' }, bigRead()),
    ];
    const result = compact(messages, { budget: 2_000, keepRecent: 1 });
    expect(result.elided[0]?.subject).toBe('src/a.ts (lines 100-200)');
  });

  it('names a search by its pattern and a check by its name', () => {
    const messages = [
      ...opening(),
      ...call('search', { pattern: 'toBeVisible\\(', path: 'ui' }, 'x'.repeat(50_000)),
      ...call('run_check', { name: 'prettier' }, 'y'.repeat(50_000)),
      ...call('read_file', { path: 'keep.ts' }, bigRead()),
    ];
    const result = compact(messages, { budget: 3_000, keepRecent: 1 });
    const subjects = result.elided.map((elision) => `${elision.name} ${elision.subject}`);
    expect(subjects).toContain('search toBeVisible\\(');
    expect(subjects).toContain('run_check prettier');
  });

  it('gives up the recent-results rule rather than fail the run', () => {
    // Four big reads and a budget that cannot hold even one of them: the run
    // cannot continue if nothing is forgotten, so everything is.
    const messages = [...opening(), ...call('read_file', { path: 'a.ts' }, bigRead())];
    const result = compact(messages, { budget: 500, keepRecent: 4 });
    expect(result.elided).toHaveLength(1);
    expect(result.impossible).toBe(false);
  });

  it('says so when even a fully compacted request will not fit', () => {
    const messages: ChatMessage[] = [...opening(), { role: 'user', content: 'z'.repeat(1_000_000) }];
    const result = compact(messages, { budget: 1_000 });
    // Nothing here can be dropped: it is not a tool result, and it is the task.
    expect(result.impossible).toBe(true);
    expect(result.elided).toEqual([]);
  });

  it('leaves a result alone when replacing it would not actually save anything', () => {
    const short = 'exit 0\nok';
    const messages: ChatMessage[] = [
      ...opening(),
      { role: 'user', content: 'q'.repeat(2_000) },
      ...call('run_check', { name: 'typecheck' }, short),
    ];
    const result = compact(messages, { budget: 100 });
    // The check result is shorter than the notice that would replace it, so it
    // stays. Over-budget is handled by the caller, not by making it bigger.
    const tool = result.messages.find((message) => message.role === 'tool');
    expect(tool?.content).toBe(short);
  });

  it('does not re-elide a result that is already a notice', () => {
    const messages = [...opening(), ...call('read_file', { path: 'a.ts' }, bigRead())];
    const once = compact(messages, { budget: 2_000 });
    const twice = compact(once.messages, { budget: 2_000 });
    expect(twice.elided).toEqual([]);
    const first = once.messages.find((message) => message.role === 'tool');
    const second = twice.messages.find((message) => message.role === 'tool');
    expect(second?.content).toBe(first?.content);
  });

  it('reports both sizes, so the saving is visible rather than claimed', () => {
    const messages = [
      ...opening(),
      ...call('read_file', { path: 'a.ts' }, bigRead()),
      ...call('read_file', { path: 'b.ts' }, bigRead()),
    ];
    const result = compact(messages, { budget: 3_000 });
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
    expect(result.tokensAfter).toBeLessThanOrEqual(3_000);
  });
});

describe('finding the biggest tool result', () => {
  it('returns the longest one, which is what a single-answer overflow needs', () => {
    const messages: ChatMessage[] = [
      ...opening(),
      ...call('read_file', { path: 'small.ts' }, 'a'.repeat(100)),
      ...call('read_file', { path: 'huge.ts' }, 'b'.repeat(90_000)),
    ];
    const biggest = largestToolResult(messages);
    // Two opening messages, then two per call: the big one's result is the last.
    expect(biggest?.index).toBe(messages.length - 1);
    expect(biggest?.length).toBe(90_000);
  });

  it('returns nothing when there is no tool result', () => {
    expect(largestToolResult(opening())).toBeNull();
  });
});
