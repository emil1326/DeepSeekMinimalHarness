import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  Auth,
  newToken,
  startServer,
  Store,
  Supervisor,
  type HarnessServer,
} from '@emilswork/harness-daemon';
import type { RunEvent } from '@emilswork/harness-core';
import { startFakeDeepSeek, type FakeServer, type ScriptedTurn } from '../../core/tests/fake-server.js';
import { createFixture, type Fixture } from '../../worker/tests/fixture.js';

export const WORKER_SCRIPT = fileURLToPath(new URL('../../worker/dist/main.js', import.meta.url));

export interface HttpResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface TestDaemon {
  port: number;
  token: string;
  url: string;
  store: Store;
  supervisor: Supervisor;
  fake: FakeServer;
  fixture: Fixture;
  request(
    method: string,
    route: string,
    options?: { body?: unknown; headers?: Record<string, string>; auth?: boolean },
  ): Promise<HttpResponse>;
  attach(runId: string): WebSocket;
  collect(runId: string): Promise<RunEvent[]>;
  close(): Promise<void>;
}

export async function startTestDaemon(script: ScriptedTurn[]): Promise<TestDaemon> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-daemon-'));
  const keyFile = path.join(home, 'api_key');
  fs.writeFileSync(keyFile, 'a-test-key-that-is-never-real\n');
  process.env.DSH_KEY_FILE = keyFile;

  const fake = await startFakeDeepSeek(script);
  const fixture = createFixture();
  const store = new Store(path.join(home, 'runs.db'));
  const token = newToken();
  const auth = new Auth(0, token);
  const supervisor = new Supervisor({
    store,
    baseUrl: fake.url,
    workerScript: WORKER_SCRIPT,
    unattachedGraceMs: 30_000,
  });
  const server: HarnessServer = await startServer({ store, supervisor, auth });

  const request: TestDaemon['request'] = (method, route, options = {}) =>
    new Promise<HttpResponse>((resolve, reject) => {
      const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
      const headers: Record<string, string> = {
        host: `127.0.0.1:${server.port}`,
        'content-type': 'application/json',
        ...(options.auth === false ? {} : { authorization: `Bearer ${token}` }),
        ...(payload === null ? {} : { 'content-length': String(payload.length) }),
        ...options.headers,
      };
      const call = http.request(
        { host: '127.0.0.1', port: server.port, method, path: route, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode ?? 0, body: text === '' ? {} : JSON.parse(text) });
          });
        },
      );
      call.on('error', reject);
      if (payload !== null) call.write(payload);
      call.end();
    });

  return {
    port: server.port,
    token,
    url: `http://127.0.0.1:${server.port}`,
    store,
    supervisor,
    fake,
    fixture,
    request,
    attach: (runId) =>
      new WebSocket(`ws://127.0.0.1:${server.port}/runs/${runId}/attach`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    collect: (runId) =>
      new Promise<RunEvent[]>((resolve, reject) => {
        const events: RunEvent[] = [];
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/runs/${runId}/attach`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error(`run ${runId} did not finish: ${JSON.stringify(events.slice(-3))}`));
        }, 30_000);
        socket.on('message', (raw: Buffer) => {
          const message = JSON.parse(raw.toString('utf8')) as {
            type: string;
            events?: RunEvent[];
            event?: RunEvent;
          };
          if (message.type === 'hello') events.push(...(message.events ?? []));
          if (message.type === 'event' && message.event !== undefined) events.push(message.event);
          if (message.type === 'bye') {
            clearTimeout(timer);
            socket.close();
            resolve(events);
          }
        });
        socket.on('error', (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
      }),
    close: async () => {
      supervisor.shutdownAll();
      await server.close();
      store.close();
      await fake.close();
      fixture.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
      delete process.env.DSH_KEY_FILE;
    },
  };
}

export function statusesOf(events: RunEvent[]): string[] {
  return events.filter((event) => event.type === 'status').map((event) => event.status);
}
