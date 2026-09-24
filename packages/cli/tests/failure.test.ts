/**
 * Why a call failed, and the one distinction that matters.
 *
 * A spent account and a model that answered badly both leave the run `failed`.
 * One of them means stop launching; the other means try again. An orchestrator
 * that cannot tell them apart keeps starting runs against an account with no
 * money on it — each one failing after a few seconds, for as long as somebody
 * leaves the loop running — and telling them apart in prose is not telling them
 * apart, because the thing doing the telling is a shell script.
 *
 * The HTTP status is checked first and the text only as a fallback, because the
 * one thing worth knowing for certain is that DeepSeek answered `402`.
 */

import { describe, expect, it } from 'vitest';
import { DeepSeekError, causeOf, describeCause, needsAttention } from '@emilswork/harness-core';
import { EXIT_PROVIDER_REFUSED, exitCodeFor } from '../src/client.js';

const error = (status: number, message = 'something'): DeepSeekError =>
  new DeepSeekError(message, status, false);

describe('working out the cause', () => {
  it('reads a 402 as an account with nothing on it', () => {
    expect(causeOf(error(402, 'Insufficient Balance'))).toBe('provider_balance');
  });

  it('reads a refused key as a key problem', () => {
    expect(causeOf(error(401, 'Authentication Fails'))).toBe('provider_auth');
    expect(causeOf(error(403, 'Forbidden'))).toBe('provider_auth');
  });

  it('reads a 400 as the provider refusing the request', () => {
    expect(causeOf(error(400, 'the context length exceeds the maximum'))).toBe('provider_refused');
  });

  it('catches a spent account that arrives as a 400, which DeepSeek does', () => {
    // The reason the text is consulted at all. A spent account is not always a
    // 402, and a launcher that only looked at the status would keep going.
    expect(causeOf(error(400, 'Insufficient Balance'))).toBe('provider_balance');
    expect(causeOf(error(400, 'You have no credit left, please top up'))).toBe('provider_balance');
  });

  it('catches a key that arrives with a 400 too', () => {
    expect(causeOf(error(400, 'invalid api key'))).toBe('provider_auth');
    expect(causeOf(error(400, 'Authentication Fails, Your api key is invalid'))).toBe('provider_auth');
  });

  it('does not stop a launcher over an unrelated 400 that happens to say balance', () => {
    // The hints are deliberately narrow phrases rather than loose words. A bare
    // `/balance/` would classify an unrelated refusal as a spent account and stop
    // an orchestrator over nothing, which is worse than missing the case the
    // hints are for: a missed one keeps failing loudly, and a false one stops
    // work that would have carried on.
    expect(causeOf(error(400, 'the message list is malformed'))).toBe('provider_refused');
    expect(causeOf(error(400, 'context length exceeded the maximum'))).toBe('provider_refused');
  });

  it('never blames the provider for something the harness did', () => {
    // A plain Error is the harness: a bad worktree, a sandbox refusal, a bug.
    // Its text is not searched for hints at all, because a hint is a thing a
    // provider said and nothing else wrote it.
    expect(causeOf(new Error('insufficient balance of braces in the file'))).toBe('harness');
  });

  it('reads status 0 as never having reached anywhere', () => {
    // The client's own code for "no answer at all", which after its retries is a
    // network failure rather than a refusal.
    expect(causeOf(error(0, 'fetch failed'))).toBe('provider_unreachable');
  });

  it('reads a 5xx as unreachable, because that is what it was', () => {
    expect(causeOf(error(503, 'service unavailable'))).toBe('provider_unreachable');
  });

  it('reads anything that is not the provider as the harness', () => {
    expect(causeOf(new Error('the sandbox must be a git worktree'))).toBe('harness');
    expect(causeOf('a string')).toBe('harness');
  });
});

describe('what a launcher should do about it', () => {
  it('says stop for the two that will not fix themselves', () => {
    expect(needsAttention('provider_balance')).toBe(true);
    expect(needsAttention('provider_auth')).toBe(true);
  });

  it('says carry on for the ones that might', () => {
    expect(needsAttention('provider_unreachable')).toBe(false);
    expect(needsAttention('provider_refused')).toBe(false);
    expect(needsAttention('harness')).toBe(false);
    expect(needsAttention(undefined)).toBe(false);
  });
});

describe('the exit code', () => {
  it('is 6 for a spent account or a refused key', () => {
    // Its own code, because 0 to 5 are taken by the statuses and by a bad task
    // file and an unreachable daemon. Without it, "stop launching" and "try
    // again" are the same number.
    expect(exitCodeFor('failed', 'provider_balance')).toBe(EXIT_PROVIDER_REFUSED);
    expect(exitCodeFor('failed', 'provider_auth')).toBe(EXIT_PROVIDER_REFUSED);
  });

  it('is the plain failed code for everything else', () => {
    expect(exitCodeFor('failed')).toBe(1);
    expect(exitCodeFor('failed', 'provider_refused')).toBe(1);
    expect(exitCodeFor('failed', 'harness')).toBe(1);
  });

  it('leaves the statuses that were already fine alone', () => {
    expect(exitCodeFor('finished')).toBe(0);
    expect(exitCodeFor('cancelled')).toBe(2);
    expect(exitCodeFor('stopped_at_limit')).toBe(3);
  });

  it('has something to say about each cause', () => {
    for (const cause of [
      'provider_balance',
      'provider_auth',
      'provider_refused',
      'provider_unreachable',
      'harness',
    ] as const) {
      expect(describeCause(cause).length).toBeGreaterThan(10);
    }
  });
});
