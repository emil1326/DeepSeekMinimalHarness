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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DAEMON_PORT, loadHarnessConfig, uiHostnames } from '@emilswork/harness-core';

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

/**
 * The port rule, which is one line and has no cases.
 *
 * The first version of the fixed port was a plain constant, and it broke seven
 * tests in `packages/cli` immediately: a port is a machine-wide resource, so a
 * test home and the real home could not both be up. The second version fixed that
 * by making the default depend on **which home it was** — real home fixed, any
 * other random — which is worse: it makes the daemon's behaviour a function of
 * where its files are, and where its files are is not a fact about which ports
 * are free.
 *
 * What is left is `config.port ?? DEFAULT_DAEMON_PORT`. A home that has to run
 * beside this one says so in its own `config.json`, in a file, like everything
 * else about how a run behaves.
 */
describe('the daemon port', () => {
  it('is below the ephemeral range, so it cannot land on a transient allocation', () => {
    // Windows hands out ephemeral ports from 49152 up. A fixed port in that range
    // would collide eventually and the failure would look random.
    expect(DEFAULT_DAEMON_PORT).toBeLessThan(49152);
  });

  it('is taken from config.json when that file names one', () => {
    // The point of the whole rule: the file says how it behaves. Written through
    // a real home so this goes through the same read the daemon does.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-port-'));
    const before = process.env.DSH_DATA_DIR;
    try {
      process.env.DSH_DATA_DIR = home;
      // Nothing there yet, so it is seeded and answers with no port — which is
      // what makes the daemon fall back to the default.
      expect(loadHarnessConfig().port).toBeUndefined();

      // A number, and 0 for "any free one". Both are just what the file says.
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ prices: {}, port: 42000 }));
      expect(loadHarnessConfig().port).toBe(42000);

      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ prices: {}, port: 0 }));
      expect(loadHarnessConfig().port).toBe(0);
    } finally {
      if (before === undefined) delete process.env.DSH_DATA_DIR;
      else process.env.DSH_DATA_DIR = before;
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
