/**
 * The build stamp a CLI compares with the daemon it finds.
 *
 * A daemon started before an `npm run build` forks new workers from disk while
 * speaking the old protocol to them, and every run it starts then fails as "the
 * worker stopped without finishing" with nothing saying why. The stamp is what
 * lets `DaemonClient.connect` notice and restart an idle one; if it did not
 * move when a file was rebuilt, nothing would.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStamp } from '@emilswork/harness-daemon';

let dir: string | null = null;

afterEach(() => {
  if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('buildStamp', () => {
  it('moves when any file under the code is rebuilt, and only then', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stamp-'));
    fs.mkdirSync(path.join(dir, 'deep'));
    const old = new Date('2026-01-01T00:00:00Z');
    for (const file of ['main.js', path.join('deep', 'loop.js')]) {
      fs.writeFileSync(path.join(dir, file), '// built');
      fs.utimesSync(path.join(dir, file), old, old);
    }
    const before = buildStamp([dir]);
    expect(buildStamp([dir])).toBe(before);

    // A file that is not code moving is not a rebuild.
    fs.writeFileSync(path.join(dir, 'notes.md'), 'nothing');
    expect(buildStamp([dir])).toBe(before);

    // The control: one nested file rebuilt moves the stamp.
    const later = new Date('2026-02-01T00:00:00Z');
    fs.utimesSync(path.join(dir, 'deep', 'loop.js'), later, later);
    expect(buildStamp([dir])).not.toBe(before);
  });

  it('reads the real code without throwing', () => {
    expect(buildStamp()).toMatch(/^[1-9]\d*$/);
  });
});
