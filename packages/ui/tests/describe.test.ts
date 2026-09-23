/**
 * Tool arguments as one readable line.
 *
 * The log used to print raw JSON on every row, which was the widest and
 * noisiest text on the page. These tests hold the replacement to being short,
 * specific, and never a JSON blob.
 */

import { describe, expect, it } from 'vitest';
import { describeCall } from '../src/describe';

describe('describing a tool call', () => {
  it('names the file for a read, and the range when there is one', () => {
    expect(describeCall('read_file', { path: 'ui/mark.spec.ts' })).toEqual({
      subject: 'ui/mark.spec.ts',
      detail: null,
    });
    expect(describeCall('read_file', { path: 'src/a.ts', start: 10, end: 40 })).toEqual({
      subject: 'src/a.ts',
      detail: 'lines 10–40',
    });
    expect(describeCall('read_file', { path: 'src/a.ts', start: 10 })).toEqual({
      subject: 'src/a.ts',
      detail: 'from line 10',
    });
  });

  it('shows the pattern and where it looked, for a search', () => {
    expect(describeCall('search', { pattern: 'toBeVisible\\(', path: 'ui' })).toEqual({
      subject: 'toBeVisible\\(',
      detail: 'in ui',
    });
  });

  it('shows how big the change was, not the text of it', () => {
    const summary = describeCall('replace_in_file', {
      path: 'ui/mark.spec.ts',
      old: 'await expect(dot).toBeVisible();',
      new: 'await expect(dot).toBeVisible({ timeout: 5_000 });',
    });
    expect(summary.subject).toBe('ui/mark.spec.ts');
    expect(summary.detail).toBe('−1 +1');
  });

  it('counts the lines of a new file rather than printing them', () => {
    const summary = describeCall('create_file', { path: 'src/new.ts', content: 'a\nb\nc' });
    expect(summary).toEqual({ subject: 'src/new.ts', detail: '3 lines' });
    expect(describeCall('create_file', { path: 'src/empty.ts', content: '' })).toEqual({
      subject: 'src/empty.ts',
      detail: 'new file',
    });
  });

  it('names the check, and never lets an argument through', () => {
    expect(describeCall('run_check', { name: 'prettier' })).toEqual({ subject: 'prettier', detail: null });
  });

  it('reads as a sentence for ask and finish', () => {
    expect(describeCall('ask', { question: 'which file?' }).subject).toBe('a question');
    expect(describeCall('finish', { summary: 'done' }).subject).toBe('the run');
  });

  it('never returns a JSON blob, even for a tool it does not know', () => {
    const summary = describeCall('brand_new_tool', { path: 'src/a.ts', flavour: 'x' });
    expect(summary.subject).toBe('src/a.ts');
    expect(summary.detail).toBe('path, flavour');
    // What the row actually renders: no braces, no quoted keys, one short line.
    const line = `${summary.subject} ${summary.detail ?? ''}`.trim();
    expect(line).not.toMatch(/[{}"]/);
    expect(line.length).toBeLessThan(60);
  });

  it('survives arguments that are missing or the wrong shape', () => {
    expect(describeCall('read_file', {}).subject).toBe('?');
    expect(describeCall('read_file', null).subject).toBe('?');
    expect(describeCall('search', { pattern: 7 }).subject).toBe('?');
    expect(describeCall('read_file', { path: 'a.ts', start: 'ten' }).detail).toBeNull();
  });
});
