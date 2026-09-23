/**
 * The run report, which exists because seven of nine real runs died at a limit
 * and there was no way to find that out except by reading the log by hand.
 *
 * The tests that matter here are the dishonest-wordings: a run that stopped at a
 * budget must not read as a run that finished, a claim the checks contradict must
 * not read as verified, and a check the harness could not run must not read as
 * clean. Every one of those is a way the report could say something reassuring
 * about a run that went badly.
 */

import { describe, expect, it } from 'vitest';
import {
  buildReport,
  emptyTotals,
  type ReportInput,
  type RunEventBody,
  type RunEvent,
} from '@emilswork/harness-core';

const LIMITS = {
  turns: 10,
  wallSeconds: 600,
  outputTokens: 40_000,
  totalTokens: 2_000_000,
  contextTokens: 700_000,
  askSeconds: 3600,
};

let seq = 0;
function event(body: RunEventBody): RunEvent {
  seq += 1;
  return { seq, runId: 'run-test', at: '2026-01-01T00:00:00.000Z', ...body } as RunEvent;
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    id: 'run-test',
    name: 'a-task',
    status: 'finished',
    model: 'deepseek-flash',
    task: 'change the constant',
    allowed: ['src/a.ts'],
    limits: LIMITS,
    turns: 3,
    totals: { ...emptyTotals(), billedTokens: 100, promptTokens: 1000, cacheHitTokens: 800 },
    summary: 'done',
    events: [],
    changed: ['src/a.ts'],
    stray: [],
    strayFailure: null,
    ...overrides,
  };
}

/** A `run_check` call and its result, as the loop records them. */
function check(name: string, exitCode: number, turn = 1): RunEvent[] {
  return [
    event({ type: 'tool.call', turn, id: `c-${name}`, name: 'run_check', args: { name } }),
    event({
      type: 'tool.result',
      turn,
      id: `c-${name}`,
      name: 'run_check',
      ok: exitCode === 0,
      result: `exit ${exitCode}\nnothing much`,
    }),
  ];
}

describe('a run that stopped at a limit', () => {
  it('says so first, and says the work is partial', () => {
    const report = buildReport(
      input({
        status: 'stopped_at_limit',
        turns: 10,
        events: [
          event({ type: 'limit', which: 'turns', detail: 'the run used all 10 turns', used: 10, budget: 10 }),
        ],
      }),
    );
    // The words that matter: not "finished", and not "review this change".
    expect(report.headline).toContain('STOPPED');
    expect(report.headline).toContain('turns');
    expect(report.headline).toContain('unfinished');
    expect(report.stoppedAt?.which).toBe('turns');
  });

  it('reports the spent tokens as billed, out of the budget', () => {
    // The mistake that killed three real runs: a run 96% cache-hit was stopped
    // for using tokens it had not really spent.
    const report = buildReport(
      input({
        status: 'stopped_at_limit',
        turns: 10,
        totals: {
          ...emptyTotals(),
          promptTokens: 8_000_000,
          cacheHitTokens: 7_800_000,
          completionTokens: 2000,
          billedTokens: 202_000,
        },
        events: [
          event({
            type: 'limit',
            which: 'totalTokens',
            detail: 'the run used 202k billed tokens',
            used: 202_000,
            budget: 200_000,
          }),
        ],
      }),
    );
    const total = report.used.find((use) => use.which === 'totalTokens');
    expect(total?.used).toBe(202_000);
    expect(report.stoppedAt?.which).toBe('totalTokens');
  });

  it('mentions that the agent was warned, when it was', () => {
    // "It knew and ran out anyway" is a different story from "nobody told it",
    // and one of those is a harness bug.
    const report = buildReport(
      input({
        status: 'stopped_at_limit',
        events: [
          event({ type: 'warning', which: 'turns', used: 8, budget: 10, detail: '[harness] near a limit' }),
          event({ type: 'limit', which: 'turns', detail: 'all 10 turns', used: 10, budget: 10 }),
        ],
      }),
    );
    expect(report.warnings).toBe(1);
  });
});

describe('a run that finished', () => {
  it('says the checks passed, when they did', () => {
    const report = buildReport(
      input({ status: 'finished', events: [...check('typecheck', 0), ...check('prettier', 0)] }),
    );
    expect(report.headline).toContain('every check it ran passed');
    expect(report.claimSupported).toBe(true);
  });

  it('does not let a claim stand when a check failed', () => {
    // The one that matters. An agent that says "done" and leaves a failing
    // typecheck behind must not read as verified.
    const report = buildReport(
      input({ status: 'finished', events: [...check('typecheck', 1), ...check('prettier', 0)] }),
    );
    expect(report.headline).toContain('did NOT pass');
    expect(report.claimSupported).toBe(false);
    expect(report.checks.find((entry) => entry.name === 'typecheck')?.passed).toBe(false);
  });

  it('says so when nothing verified it at all', () => {
    const report = buildReport(input({ status: 'finished', events: [] }));
    expect(report.headline).toContain('ran no checks');
    // Not `false`: nothing contradicted the claim, nothing supported it either.
    expect(report.claimSupported).toBe(true);
  });

  it('reads the last result of a check, not the first', () => {
    // A check run twice, failing and then passing, is a check that passes.
    const report = buildReport(
      input({ status: 'finished', events: [...check('typecheck', 1, 1), ...check('typecheck', 0, 3)] }),
    );
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.passed).toBe(true);
  });

  it('keeps the order the checks were first run in', () => {
    const report = buildReport(
      input({ status: 'finished', events: [...check('prettier', 0, 1), ...check('typecheck', 0, 2)] }),
    );
    expect(report.checks.map((entry) => entry.name)).toEqual(['prettier', 'typecheck']);
  });
});

describe('the other endings', () => {
  it('does not present a failure as an outcome', () => {
    const report = buildReport(input({ status: 'failed', summary: 'DeepSeek answered 500' }));
    expect(report.headline).toContain('FAILED');
    expect(report.headline).toContain('500');
  });

  it('explains an interruption, because nothing was cleaned up', () => {
    const report = buildReport(input({ status: 'interrupted', summary: null }));
    expect(report.headline).toContain('INTERRUPTED');
    expect(report.headline).toContain('nothing here was finished');
  });

  it('does not shout about a run that is still going', () => {
    const report = buildReport(input({ status: 'running' }));
    expect(report.headline).toContain('Still going');
    expect(report.headline).not.toContain('STOPPED');
  });
});

describe('what the report says about the worktree', () => {
  it('carries the stray list, so a change outside the allow list is unmissable', () => {
    const report = buildReport(input({ stray: ['docs/plan.md'] }));
    expect(report.stray).toEqual(['docs/plan.md']);
  });

  it('says the stray check could not run rather than that it was clean', () => {
    // The loudest control in the harness used to fail open: past its buffer,
    // `execFileSync` threw and the old `catch` returned "no stray changes". A
    // report that cannot tell has to say so.
    const report = buildReport(
      input({ strayFailure: 'git produced more output than the harness will hold' }),
    );
    expect(report.stray).toEqual([]);
    expect(report.strayFailure).toContain('more output than the harness will hold');
  });

  it('lists the questions the run asked, and whether they were answered', () => {
    const report = buildReport(
      input({
        events: [
          event({ type: 'question', id: 'q1', question: 'which file?' }),
          event({ type: 'answer', id: 'q1', answer: 'the second one', by: 'claude' }),
          event({ type: 'question', id: 'q2', question: 'and the count?' }),
        ],
      }),
    );
    expect(report.questions).toHaveLength(2);
    expect(report.questions[0]?.answer).toBe('the second one');
    expect(report.questions[1]?.answer).toBeNull();
  });

  it('has no claim to check when the agent never made one', () => {
    const report = buildReport(input({ summary: null }));
    expect(report.claim).toBeNull();
    expect(report.claimSupported).toBeNull();
  });
});
