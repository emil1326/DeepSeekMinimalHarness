import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

const BUILDS: [string, string][] = [
  ['packages/core/src', 'packages/core/dist'],
  ['packages/worker/src', 'packages/worker/dist'],
  ['packages/daemon/src', 'packages/daemon/dist'],
  ['packages/cli/src', 'packages/cli/dist'],
];

function newest(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  let latest = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs);
  }
  return latest;
}

/**
 * The daemon and CLI tests fork the built worker and the built daemon, so those
 * have to exist before the suite runs. Only rebuilt when a source file is newer
 * than its output, so watch mode stays quick.
 */
export default function setup(): void {
  const stale = BUILDS.some(([source, output]) => !fs.existsSync(output) || newest(source) > newest(output));
  if (!stale) return;
  execFileSync('npm', ['run', 'build:server'], { cwd: root, stdio: 'inherit', shell: true });
}
