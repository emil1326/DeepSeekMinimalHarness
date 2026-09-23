/**
 * The names the UI answers to.
 *
 * `uiHosts` is hand-written JSON in `config.json`, so this is the one place that
 * decides what a written entry means. Two things matter. The tolerant spellings
 * all have to land on the same lowercase name, because `Host` and `Origin` are
 * lowercased before the daemon compares them against this. And junk has to be
 * dropped rather than thrown: everything that reads this only ever *adds* a name
 * to a list of allowed ones, so a typo here must not be able to stop the daemon
 * from starting.
 */

import { describe, expect, it } from 'vitest';
import { uiHostnames } from '@emilswork/harness-core';

describe('uiHostnames', () => {
  it('is empty when nothing is configured', () => {
    expect(uiHostnames({})).toEqual([]);
  });

  it('takes a bare name and lowercases it', () => {
    expect(uiHostnames({ uiHosts: ['EmilsHarnessUI'] })).toEqual(['emilsharnessui']);
  });

  it('reads a name with a port as the bare name', () => {
    expect(uiHostnames({ uiHosts: ['EmilsHarnessUI:5173'] })).toEqual(['emilsharnessui']);
  });

  it('reads a full origin as the bare name', () => {
    expect(uiHostnames({ uiHosts: ['http://EmilsHarnessUI:5173'] })).toEqual(['emilsharnessui']);
  });

  it('reads a trailing slash as the bare name', () => {
    expect(uiHostnames({ uiHosts: ['http://EmilsHarnessUI:5173/'] })).toEqual(['emilsharnessui']);
  });

  it('drops duplicates, however they were written', () => {
    expect(
      uiHostnames({
        uiHosts: ['EmilsHarnessUI', 'emilsharnessui:5173', 'http://EMILSHARNESSUI'],
      }),
    ).toEqual(['emilsharnessui']);
  });

  it('keeps a dotted name as it is', () => {
    expect(uiHostnames({ uiHosts: ['harness.test'] })).toEqual(['harness.test']);
  });

  it('drops entries that are not names', () => {
    expect(uiHostnames({ uiHosts: ['', '   ', 'has space', 'http://'] })).toEqual([]);
  });

  it('drops a name with a path rather than keeping the part before it', () => {
    // `new URL('http://name/path')` has the hostname `name`, which would turn a
    // typo into a name that is accepted as if it had been meant.
    expect(uiHostnames({ uiHosts: ['name/path', 'http://name/path'] })).toEqual([]);
  });

  it('drops a name with credentials in front of it', () => {
    expect(uiHostnames({ uiHosts: ['http://user:pass@name'] })).toEqual([]);
  });

  it('keeps the names that are names next to the ones that are not', () => {
    expect(uiHostnames({ uiHosts: ['not a name', 'EmilsHarnessUI', 'harness.test'] })).toEqual([
      'emilsharnessui',
      'harness.test',
    ]);
  });

  it('sorts, so the first one is the same on every run', () => {
    expect(uiHostnames({ uiHosts: ['b.test', 'a.test'] })[0]).toBe('a.test');
  });
});
