import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PriceTable } from './metrics.js';

/** Where the key lives. Only the daemon and the worker ever read this. */
export function keyFilePath(): string {
  return process.env.DSH_KEY_FILE ?? path.join(os.homedir(), '.deepseek', 'api_key');
}

/**
 * The key, from `~/.deepseek/api_key`. Just the key, nothing else.
 * Never logged, never put in an event, never sent anywhere but DeepSeek.
 */
export function readApiKey(): string {
  const file = keyFilePath();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`no DeepSeek key at ${file}; write the key there and nothing else, or set DSH_KEY_FILE`);
  }
  const key = text.trim();
  if (key === '') throw new Error(`the DeepSeek key at ${file} is empty`);
  return key;
}

/**
 * The harness's own directory: the database, `config.json`, the daemon record,
 * the transcripts, the setup markers. One directory, one machine.
 *
 * There is no second one. There used to be "homes" — a `-dev` one for the dev
 * loop, one per agent, `--home X` on top of them and a `DSH_HOME` to choose — and
 * every one of those made the answer to "which runs exist" depend on an
 * environment variable, and made the daemon behave differently depending on the
 * directory it had been launched from. A port is a fact about the machine; so is
 * the history.
 *
 * `DSH_DATA_DIR` overrides it for exactly one caller: the test suite, which must
 * not write into the real database. It is not a feature, the docs do not mention
 * it, and no code path reads it a second time.
 */
export function dataDir(): string {
  const override = process.env.DSH_DATA_DIR;
  if (override !== undefined && override !== '') return path.resolve(override);
  const local = process.env.LOCALAPPDATA;
  return local
    ? path.join(local, 'EmilsDeepSeekHarness')
    : path.join(os.homedir(), '.local', 'share', 'EmilsDeepSeekHarness');
}

export function daemonFile(): string {
  return path.join(dataDir(), 'daemon.json');
}

export function runsDbFile(): string {
  return path.join(dataDir(), 'runs.db');
}

export function daemonConfigFile(): string {
  return path.join(dataDir(), 'config.json');
}

/**
 * The daemon's address, written by the daemon and read by the CLI.
 *
 * No token. There was one, and it was the wrong instrument: it was written here
 * in plain text, readable by any program running as this user, so it could not
 * defend against the only callers a local secret could plausibly be for. The
 * daemon now checks three request headers instead — see `guard.ts`.
 */
export interface DaemonRecord {
  port: number;
  pid: number;
  startedAt: string;
  /**
   * `buildStamp()` when the daemon started, so a CLI can tell a daemon that is
   * older than the code on disk. Absent in a record written before it existed.
   */
  build?: string;
}

/**
 * The port the daemon binds when `config.json` does not name one.
 *
 * Deliberately below 49152, which is where Windows starts handing out ephemeral
 * ports: a fixed port inside that range would collide with a transient
 * allocation sooner or later, and the failure would look random.
 */
export const DEFAULT_DAEMON_PORT = 41777;

export interface HarnessConfig {
  /**
   * Model prices, written by hand, to override the published ones.
   *
   * Prices and models change, and the built-in table in `core/pricing.ts` will
   * eventually be out of date. This is the way to correct it without waiting for
   * a release, and to price a model the table has never heard of: anything here
   * wins outright, and anything it does not name falls back to the table.
   *
   * A price given here is a flat figure and is not split by time of day, which
   * is what somebody writing one means.
   */
  prices?: PriceTable;
  /** Only for tests and for pointing at a proxy. Defaults to DeepSeek itself. */
  deepseekBaseUrl?: string;
  /**
   * Other names the UI answers to, so it can be reached at something nicer than
   * a port on the loopback address. Bare hostnames, though `uiHostnames` below
   * is tolerant about how they are written. Absent means `localhost` and
   * `127.0.0.1` and nothing else.
   *
   * A name here is only half the job: it also has to resolve to `127.0.0.1` on
   * the machine, which is a line in the hosts file and not something this
   * program can do for you.
   */
  uiHosts?: string[];
  /**
   * The port the daemon binds. Defaults to `DEFAULT_DAEMON_PORT`.
   *
   * A number, or `0` to take any free one. A second daemon on the same machine —
   * a test home, the dev loop — says so here rather than the daemon guessing from
   * where its files happen to be, because where the files are is not a fact about
   * which ports are free.
   */
  port?: number;
}

/**
 * `uiHosts` as bare, lowercase, de-duplicated hostnames.
 *
 * The field is written by hand in `config.json`, so it gets written however it
 * came out: `EmilsHarnessUI`, `EmilsHarnessUI:5173` and
 * `http://EmilsHarnessUI:5173` all name the same host and all three are
 * accepted. Lowercase because both `Host` and `Origin` are lowercased before
 * they are compared against this.
 *
 * A malformed entry is dropped rather than thrown. Everything that reads this
 * only ever *adds* a name to a list of allowed ones, so the worst a typo can do
 * is nothing at all; refusing to start over it would turn a cosmetic field into
 * an outage.
 */
export function uiHostnames(config: HarnessConfig): string[] {
  const names = new Set<string>();
  for (const entry of config.uiHosts ?? []) {
    const name = hostnameOf(entry);
    if (name !== null) names.add(name);
  }
  return [...names].sort();
}

/**
 * The host part of whatever was written, or null if it is not a hostname.
 *
 * `URL` will not parse a bare `name:port` without a scheme to hang it on, so
 * one is added first.
 */
function hostnameOf(entry: string): string | null {
  const text = String(entry).trim();
  if (text === '') return null;
  let url: URL;
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`);
  } catch {
    return null;
  }
  // `http://name/path` parses happily and its hostname is `name`, which would
  // turn a typo into a name that is accepted as if it had been meant. A trailing
  // slash is the only thing allowed after the host.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  const name = url.hostname.toLowerCase();
  // A space or a colon left in there is not a name either. `URL` would
  // percent-encode some of it and hand back something that matches nothing.
  return /^[a-z0-9.-]+$/.test(name) ? name : null;
}

export const DEFAULT_BASE_URL = 'https://api.deepseek.com';

export function loadHarnessConfig(): HarnessConfig {
  const file = daemonConfigFile();
  if (!fs.existsSync(file)) {
    const seeded: HarnessConfig = { prices: {} };
    writePrivateJson(file, seeded);
    return seeded;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as HarnessConfig;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

export function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows mostly ignores this; it costs nothing to ask. */
  }
}

export function writePrivateText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows mostly ignores this; it costs nothing to ask. */
  }
}
