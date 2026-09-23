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

export function harnessHome(): string {
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
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

export interface DaemonRecord {
  port: number;
  pid: number;
  token: string;
  startedAt: string;
}

export interface HarnessConfig {
  /** Filled in by hand, because prices change. Absent means cost is not shown. */
  prices?: PriceTable;
  /** Only for tests and for pointing at a proxy. Defaults to DeepSeek itself. */
  deepseekBaseUrl?: string;
  uiOrigins?: string[];
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
