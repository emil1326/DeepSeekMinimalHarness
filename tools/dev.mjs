#!/usr/bin/env node
/**
 * The dev loop, one command.
 *
 *     npm run dev                    # everything, watching
 *     npm run dev -- --no-open       # do not open a browser
 *     npm run dev -- --no-ui         # daemon and workers only, no Vite
 *
 * It runs against the same daemon and the same database as `dsh`. One install,
 * one history — there is nothing to choose between and no `DSH_HOME` to set.
 *
 * **Restarting the daemon kills whatever was running**, because a run's worker is
 * a child of the daemon. That is stated up front rather than worked around: the
 * loop used to take a `-dev` directory of its own to avoid it, which traded a
 * clear consequence for a second database that quietly held half the runs.
 *
 * What it runs:
 *   - `tsc --watch` per server package, so a save lands in `dist/` in a few
 *     hundred milliseconds. The build is the typecheck, so errors land here too.
 *   - `tsc --watch --noEmit` for the UI, because Vite does not typecheck.
 *   - the daemon, from `packages/daemon/dist/main.js`, restarted whenever its
 *     `dist/` changes. It is the real daemon, so `dsh` in another terminal finds
 *     it through `daemon.json` and talks to the code you just saved.
 *   - Vite's dev server for the UI, with HMR, proxying the API to the daemon.
 *
 * Restarting the daemon interrupts any run in flight, because a run's worker is
 * a child of the daemon. That is honest rather than convenient: a run whose
 * daemon was replaced cannot be resumed, and pretending otherwise would leave
 * the UI showing a run that is not doing anything.
 *
 * Why `dist/` stays in the loop. The packages import each other through
 * `node_modules` symlinks that resolve to `dist/index.js`, and the supervisor
 * `fork`s the worker from a path under `dist/`. Running the sources directly
 * would need either a `.js`-to-`.ts` resolver hook or a `development` export
 * condition in every package, and both are more machinery than the loop is
 * worth. So `dist/` is kept hot instead of removed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const VITE_CONFIG = path.join(ROOT, 'tools', 'vite.dev.config.mjs');

/** Emitted by `tsc --watch`, and the three the daemon is built out of. */
const BUILD_PACKAGES = ['core', 'worker', 'daemon', 'cli'];
/** A change under these dists means the running daemon is stale. */
const DAEMON_INPUTS = ['core', 'worker', 'daemon'];

const UI_PORT = Number(process.env.DSH_DEV_UI_PORT ?? 5173);
/**
 * The name Vite is started with, and the origin the browser is sent to.
 *
 * `localhost` until `config.json` names a host, which it does through
 * `uiHosts`. The two are the same thing unless that name does not resolve, in
 * which case the browser gets `localhost` and the name is left to the hosts
 * file to fix — see `main` below.
 */
let uiHost = 'localhost';
let browserOrigin = `http://localhost:${UI_PORT}`;
/**
 * Where Vite is asked whether it is up.
 *
 * The loopback address, not the name, on purpose: Vite binds 127.0.0.1 and does
 * not care what a name resolves to. Asking by name would make this check depend
 * on a hosts file entry Vite never needs, and a missing entry would then be
 * reported as "Vite did not come up", which is the wrong diagnosis entirely.
 */
const VITE_PROBE = `http://127.0.0.1:${UI_PORT}`;
/**
 * Long on purpose. tsc emits in layers (core, then worker, then daemon), so one
 * save produces several bursts of writes; this is what folds them into the one
 * restart the change actually deserves.
 */
const DEBOUNCE_MS = 400;

const argv = new Set(process.argv.slice(2));
const wantUi = !argv.has('--no-ui');
const wantOpen = !argv.has('--no-open') && wantUi;
/** The harness's own directory, read from core after the first build. */
let dataDirLabel = '';

const children = new Set();
let daemonChild = null;
let viteChild = null;
let stopping = false;

// --- small things ---------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function say(label, message) {
  process.stdout.write(`${label.padEnd(8)} ${message}\n`);
}

/** Every child writes through here, so one terminal stays readable. */
function pipePrefixed(child, label) {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      rest += chunk;
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() !== '') process.stdout.write(`${label.padEnd(8)} ${line}\n`);
      }
    });
  }
}

function track(label, command, args, options = {}) {
  const child = spawn(command, args, { cwd: ROOT, ...options });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping && code !== 0 && signal === null) say(label, `exited with code ${code}`);
  });
  return child;
}

/** `fetch` with a deadline. The loser of the race is left to fail on its own. */
async function fetchIn(ms, url, init) {
  const abort = new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
  return Promise.race([
    fetch(url, init)
      .then((response) => response)
      .catch(() => null),
    abort,
  ]);
}

// --- where the daemon is --------------------------------------------------

/** Read from the built core, so the two never drift apart. */
async function paths() {
  const module = await import(pathToFileURL(path.join(ROOT, 'packages', 'core', 'dist', 'config.js')).href);
  return { daemonFile: module.daemonFile(), dataDir: module.dataDir() };
}

/**
 * The directory this loop runs against, decided after the first build.
 *
 * After the build because the path lives in core and reading it means importing
 * `dist/`, which does not exist yet on a fresh clone. That import is deliberately
 * still the source of the path: a second copy of the rule here would be a second
 * place for it to be wrong.
 *
 * There is one directory, so this only needs to say which one it is.
 */
async function chooseDataDir() {
  const { dataDir } = await paths();
  dataDirLabel = dataDir;
}

async function readRecord() {
  const { daemonFile } = await paths();
  try {
    const record = JSON.parse(fs.readFileSync(daemonFile, 'utf8'));
    return typeof record?.port === 'number' && typeof record?.pid === 'number' ? record : null;
  } catch {
    return null;
  }
}

async function healthy(port) {
  // No credentials: the daemon answers its own machine, and the only callers it
  // refuses are web pages. See `packages/daemon/src/guard.ts`.
  const answer = await fetchIn(600, `http://127.0.0.1:${port}/health`, {
    headers: { accept: 'application/json' },
  });
  return answer !== null && answer !== 'timeout' && answer.ok;
}

// --- what the UI is called ------------------------------------------------

/**
 * The first name from `config.json`, or null when there is none.
 *
 * Read out of the built core, the same way `daemonFile` is, so the loop and the
 * daemon can never disagree about what the UI is called. `pathToFileURL`
 * imports `dist/`, which `buildOnce` has already produced by this point.
 */
async function configuredUiHost() {
  const module = await import(pathToFileURL(path.join(ROOT, 'packages', 'core', 'dist', 'config.js')).href);
  return module.uiHostnames(module.loadHarnessConfig())[0] ?? null;
}

/**
 * Whether a name points back at this machine.
 *
 * Only the browser needs this to be true. A name that does not resolve fails
 * there in a way that looks exactly like the daemon being down, so it is checked
 * once and said out loud rather than left to be discovered.
 */
async function resolvesLocally(name) {
  if (name === 'localhost') return true;
  try {
    const found = await lookup(name, { all: true });
    return found.some((entry) => entry.address === '127.0.0.1');
  } catch {
    return false;
  }
}

/** The fix, which is a line in a file only an administrator can write. */
function hostsInstruction(name) {
  const file =
    process.platform === 'win32' ? String.raw`%SystemRoot%\System32\drivers\etc\hosts` : '/etc/hosts';
  return `add "127.0.0.1 ${name}" to ${file}, as an administrator`;
}

// --- build ----------------------------------------------------------------

/**
 * The first build has to finish before the daemon can start, so it blocks.
 * Everything after this is watched, and nothing after this blocks.
 */
function buildOnce() {
  for (const pkg of BUILD_PACKAGES) {
    say('build', pkg);
    const result = spawnSync(
      process.execPath,
      [TSC, '-p', `packages/${pkg}/tsconfig.json`, '--incremental'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    if (result.status !== 0) throw new Error(`tsc failed for ${pkg}; fix the errors above and run again`);
  }
}

function startWatchers() {
  for (const pkg of BUILD_PACKAGES) {
    const child = track(
      pkg,
      process.execPath,
      [TSC, '-p', `packages/${pkg}/tsconfig.json`, '--watch', '--preserveWatchOutput'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    pipePrefixed(child, pkg);
  }
  const ui = track(
    'ui:types',
    process.execPath,
    [TSC, '-p', 'packages/ui/tsconfig.json', '--watch', '--preserveWatchOutput'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  pipePrefixed(ui, 'ui:types');
}

// --- daemon ---------------------------------------------------------------

async function stopDaemon() {
  const record = await readRecord();
  if (record !== null && (await healthy(record.port))) {
    await fetchIn(1500, `http://127.0.0.1:${record.port}/daemon/stop`, { method: 'POST' }).catch(() => null);
    for (let waited = 0; waited < 3000; waited += 100) {
      if (!(await healthy(record.port))) break;
      await sleep(100);
    }
  }
  if (daemonChild !== null) {
    // Whatever the polite route did, our own child must be gone before respawn.
    try {
      daemonChild.kill();
    } catch {
      /* already gone */
    }
    daemonChild = null;
  }
  if (record !== null && (await healthy(record.port))) {
    // A daemon we did not start and that will not stop: kill it and be loud.
    say('daemon', `port ${record.port} still answers after a stop; killing pid ${record.pid}`);
    try {
      process.kill(record.pid);
    } catch {
      /* nothing left to kill */
    }
  }
}

async function startDaemon() {
  daemonChild = track('daemon', process.execPath, [path.join('packages', 'daemon', 'dist', 'main.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipePrefixed(daemonChild, 'daemon');
  const child = daemonChild;
  child.on('exit', () => {
    if (daemonChild === child) daemonChild = null;
  });

  for (let waited = 0; waited < 20_000; waited += 100) {
    const record = await readRecord();
    if (record !== null && record.pid === child.pid && (await healthy(record.port))) {
      say('dev', `daemon on 127.0.0.1:${record.port} (pid ${record.pid})`);
      return record;
    }
    await sleep(100);
  }
  throw new Error('the daemon never answered /health; read its output above');
}

// --- vite -----------------------------------------------------------------

function startVite(daemonPort) {
  viteChild = track('ui', process.execPath, [VITE, '--config', VITE_CONFIG], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_DEV_DAEMON_PORT: String(daemonPort),
      DSH_DEV_UI_PORT: String(UI_PORT),
      // Vite refuses a `Host` it was not told about, and the name is not one of
      // the two it allows by itself.
      DSH_DEV_UI_HOST: uiHost,
    },
  });
  pipePrefixed(viteChild, 'ui');
  const child = viteChild;
  child.on('exit', () => {
    if (viteChild === child) viteChild = null;
  });
}

async function viteReady() {
  for (let waited = 0; waited < 20_000; waited += 150) {
    const answer = await fetchIn(500, `${VITE_PROBE}/`);
    if (answer !== null && answer !== 'timeout') return true;
    await sleep(150);
  }
  return false;
}

/**
 * Where the browser should go.
 *
 * There used to be a ticket in here and a `/ui/session` round trip, because the
 * UI needed a session cookie and the token was not allowed in a URL. There is no
 * cookie now — the daemon serves the page and the page talks to the daemon, so
 * reaching the address *is* being the operator's browser. See
 * `packages/daemon/src/guard.ts`.
 *
 * Vite serves this at `browserOrigin` and forwards the API to the daemon, which
 * is what keeps HMR and the real daemon in one tab.
 */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => say('dev', `could not open a browser; use ${url}`));
  child.unref();
}

// --- restarts -------------------------------------------------------------

let daemonPort = 0;
let pendingRestart = false;
let restarting = false;
let restartTimer = null;
/** The last digest of built JavaScript the running daemon was started from. */
let lastDigest = '';

async function restartDaemon(reason) {
  if (restarting) {
    pendingRestart = true;
    return;
  }
  restarting = true;
  try {
    say('dev', `restarting the daemon (${reason})`);
    await stopDaemon();
    const record = await startDaemon();
    lastDigest = distDigest();
    if (record.port !== daemonPort) {
      daemonPort = record.port;
      if (viteChild !== null) {
        // Only reachable when `config.json` names port 0. The default is a fixed
        // port, so a restart normally keeps the address and the proxy target stays
        // valid; this is here so that choosing a random port does not silently
        // leave Vite pointing at nothing.
        say('dev', `the daemon moved to port ${record.port}; restarting Vite`);
        viteChild.kill();
        viteChild = null;
        startVite(record.port);
      }
    }
    say('dev', 'daemon up to date');
  } catch (error) {
    say('dev', `restart failed: ${error.message}`);
  } finally {
    restarting = false;
    if (pendingRestart) {
      pendingRestart = false;
      scheduleRestart('a change arrived mid-restart');
    }
  }
}

function scheduleRestart(reason) {
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    // The write is only interesting if it changed the bytes behind it.
    const digest = distDigest();
    if (digest === lastDigest) {
      lastDigest = digest;
      return;
    }
    lastDigest = digest;
    void restartDaemon(reason);
  }, DEBOUNCE_MS);
}

function watchDaemonInputs() {
  for (const pkg of DAEMON_INPUTS) {
    const dir = path.join(ROOT, 'packages', pkg, 'dist');
    try {
      fs.watch(dir, { recursive: true }, (_event, file) => {
        // Only emitted JavaScript is worth a restart. Declarations, source maps
        // and the build info change on every emit and none of them is loaded.
        if (file === null || !file.endsWith('.js') || file.endsWith('.js.map')) return;
        // The built UI lands in `daemon/dist/public`; Vite's HMR handles that.
        if (file.includes('public')) return;
        scheduleRestart(`${pkg}/${file}`);
      });
    } catch (error) {
      say('dev', `cannot watch ${dir}: ${error.message}`);
    }
  }
}

/**
 * A digest of every `.js` the daemon loads.
 *
 * Watching for writes is not enough on its own. `tsc --watch` re-emits all its
 * output on its first pass whether or not anything changed, and a rewrite that
 * produces the same bytes is not a change: restarting on it would restart the
 * daemon seconds after it started, and move its port, for nothing. Comparing
 * the bytes is what tells the two apart.
 */
function distDigest() {
  const entries = [];
  for (const pkg of DAEMON_INPUTS) {
    const dir = path.join(ROOT, 'packages', pkg, 'dist');
    let files;
    try {
      files = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) continue;
      const full = path.join(entry.parentPath, entry.name);
      if (full.includes(`${path.sep}public${path.sep}`)) continue;
      entries.push(`${full}:${createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`);
    }
  }
  return createHash('sha1').update(entries.sort().join('\n')).digest('hex');
}

// --- shutdown -------------------------------------------------------------

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (restartTimer !== null) clearTimeout(restartTimer);
  say('dev', 'stopping');
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  void stopDaemon()
    .catch(() => null)
    .then(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// --- go -------------------------------------------------------------------

async function main() {
  say('dev', 'building once, so the daemon has something to run');
  buildOnce();

  await chooseDataDir();
  startWatchers();
  daemonPort = (await startDaemon()).port;
  // Taken now, so the watchers' first pass, which rewrites the same bytes, is
  // not mistaken for a change.
  lastDigest = distDigest();
  watchDaemonInputs();

  /** A name from `config.json` that the machine does not resolve, if there is one. */
  let unresolved = null;
  if (wantUi) {
    // Before Vite starts, because the name goes to Vite in its environment.
    const named = await configuredUiHost();
    if (named !== null) {
      uiHost = named;
      if (await resolvesLocally(named)) {
        browserOrigin = `http://${named}:${UI_PORT}`;
      } else {
        // Nothing in this loop needs the name to resolve, so the loop goes on
        // and the browser is sent to the name that always works. Saying it here
        // is the whole point: from the browser it would have looked like a
        // daemon that is not running.
        unresolved = named;
      }
    }
    startVite(daemonPort);
  }

  if (wantUi) {
    const ready = await viteReady();
    say('dev', '');
    say('dev', `UI       ${browserOrigin}`);
    if (unresolved !== null) {
      say('dev', `         ${unresolved} is not in the hosts file, so it is not used yet`);
      say('dev', `         ${hostsInstruction(unresolved)}`);
    }
    // One directory, so the bare command is the right one. It used to need
    // `DSH_HOME=` to talk to the loop's daemon rather than another one, which
    // meant the line that told you what to type was the line that was easiest to
    // get wrong.
    say('dev', `CLI      npx dsh list   (this daemon, this code)`);
    say('dev', `data     ${dataDirLabel}`);
    say('dev', '');
    if (wantOpen && ready) openBrowser(browserOrigin);
    else if (!ready) say('dev', 'Vite did not come up; read its output above');
  }

  say('dev', 'watching. Ctrl+C stops everything.');
}

await main();
