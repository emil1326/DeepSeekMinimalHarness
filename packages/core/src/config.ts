import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath } from './paths.js';
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

export function harnessHome(): string {
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return defaultHarnessHome();
}

/** Where the harness lives when nothing overrides it. */
export function defaultHarnessHome(): string {
  const local = process.env.LOCALAPPDATA;
  return local
    ? path.join(local, 'EmilsDeepSeekHarness')
    : path.join(os.homedir(), '.local', 'share', 'EmilsDeepSeekHarness');
}

export function daemonFile(): string {
  return path.join(harnessHome(), 'daemon.json');
}

export function runsDbFile(): string {
  return path.join(harnessHome(), 'runs.db');
}

export function daemonConfigFile(): string {
  return path.join(harnessHome(), 'config.json');
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
}

/**
 * The port the daemon binds when `config.json` does not say otherwise.
 *
 * Deliberately below 49152, which is where Windows starts handing out ephemeral
 * ports: a fixed port inside that range would collide with a transient
 * allocation sooner or later, and the failure would look random.
 */
export const DEFAULT_DAEMON_PORT = 41777;

/**
 * The port this home's daemon binds, before `config.json` is consulted.
 *
 * The real home gets the fixed one, so its URL can be bookmarked and survives a
 * restart. Any **other** home gets a random port instead, and that is not a
 * fallback but the point: a port is a machine-wide resource, so two homes holding
 * the same number cannot both be up. The dev loop and the test suite each run a
 * daemon beside the real one, and a fixed port everywhere would mean starting one
 * of them failing with "already in use" — which is exactly what happened the
 * first time this was written as a plain constant.
 *
 * A scratch home that wants a stable URL can still have one by naming a port in
 * its own `config.json`.
 */
export function defaultDaemonPort(home = harnessHome()): number {
  return samePath(home, defaultHarnessHome()) ? DEFAULT_DAEMON_PORT : 0;
}

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
   * The port the daemon binds.
   *
   * Defaults to `defaultDaemonPort()`: the fixed `DEFAULT_DAEMON_PORT` for the
   * real home, and a random one for any other, so a scratch home cannot collide
   * with it. Set `0` to ask the OS for any free port whatever the home is.
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
