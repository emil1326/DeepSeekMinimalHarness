/**
 * What the agent is told about the job before it starts.
 *
 * This file exists because of one measured number and one blind spot. The number:
 * of nine real runs, seven stopped at a limit, and in every single case the agent
 * had no warning and no idea which clock was about to run out. The blind spot:
 * the wall clock was never mentioned anywhere in the task message, so a run told
 * "12 turns" would spend most of them on an `ask` it did not need — and the
 * stopwatch does not pause while an agent waits for a person, which is not
 * obvious from inside the conversation and is the exact reason it is worth
 * saying out loud.
 *
 * The other thing worth holding down here is what the message must *not* do. It
 * is the highest-signal text a run ever receives, so it stays short, and the task
 * itself stays first: a run that reads a paragraph of harness framing before it
 * reads what it was asked to do has been given the wrong thing first.
 */

import { describe, expect, it } from 'vitest';
import { budgetLine, taskMessage, wallClock, type RunLimits } from '@emilswork/harness-core';

const LIMITS: RunLimits = {
  turns: 12,
  wallSeconds: 900,
  outputTokens: 40_000,
  totalTokens: 2_000_000,
  contextTokens: 700_000,
  askSeconds: 3_600,
  costUsd: 0.05,
};

describe('how much room the run has, as the agent is told it', () => {
  it('says the wall clock in minutes, which is the unit a person plans in', () => {
    // `900 seconds` is a number nobody converts. This is the specific figure the
    // missing wall clock was costing: a run had no way to know whether it had
    // fifteen minutes or an hour, and those are different jobs.
    expect(wallClock(900)).toBe('15 minutes');
    // An hour reads as 60 minutes rather than 1.0 hours, which is both clearer
    // and exactly how somebody would say it.
    expect(wallClock(3600)).toBe('60 minutes');
    // Past two hours it becomes hours, and a whole one loses the `.0` so it does
    // not look like a measurement that was taken.
    expect(wallClock(86_400)).toBe('24 hours');
    expect(wallClock(9_000)).toBe('2.5 hours');
  });

  it('does not round a short clock into nothing', () => {
    // A test budget of 30 seconds must not read as "1 minute", and 100 seconds
    // must not read as "2 minutes".
    expect(wallClock(30)).toBe('30 seconds');
    expect(wallClock(100)).toBe('100 seconds');
    expect(wallClock(120)).toBe('2 minutes');
  });

  it('names every clock, not just the interesting one', () => {
    const line = budgetLine(LIMITS);
    expect(line).toContain('15 minutes');
    expect(line).toContain('12 model calls');
    expect(line).toContain('$0.05');
  });

  it('says that waiting for an answer is on the clock', () => {
    // The fact that costs a run the most and is the least obvious. An agent that
    // does not know this asks generously, because from inside the conversation
    // asking looks free.
    expect(budgetLine(LIMITS)).toContain('does not pause while you wait');
    // And it is told what to do about it, which is what makes the number
    // actionable rather than merely discouraging.
    expect(budgetLine(LIMITS)).toContain('Finishing less and saying so');
  });

  it('puts the task first and the framing second', () => {
    // The highest-signal thing in the whole conversation is what the run was
    // asked to do. Everything the harness has to say about itself comes after.
    const message = taskMessage({
      task: 'Change the constant in src/a.ts.',
      allow: ['src/a.ts'],
      checks: ['typecheck'],
      limits: LIMITS,
    });
    const lines = message.split('\n');
    expect(lines[0]).toBe('Change the constant in src/a.ts.');
    expect(message.indexOf('How long you have')).toBeLessThan(message.indexOf('Files you may change'));
  });

  it('leaves the message exactly as it was when no limits were given', () => {
    // Every existing caller keeps working, and the message a harness without a
    // budget sends is the message it always sent.
    const bare = taskMessage({ task: 'do it', allow: ['src/a.ts'], checks: [] });
    expect(bare).toBe('do it\n\nFiles you may change: src/a.ts');
    expect(bare).not.toContain('How long');
  });

  it('still puts the project rules last, where they cannot displace the task', () => {
    const message = taskMessage({
      task: 'do it',
      allow: ['src/a.ts'],
      checks: ['typecheck'],
      soft: ['src/b.ts'],
      rules: 'Never touch wire.rs.',
      limits: LIMITS,
    });
    expect(message).toContain('Notes from this project');
    // Specific beats general: the task, then the budget, then the project's
    // standing notes, which apply to everything.
    expect(message.indexOf('Files you may change')).toBeLessThan(message.indexOf('src/b.ts'));
    expect(message.indexOf('src/b.ts')).toBeLessThan(message.indexOf('Never touch wire.rs'));
  });
});
