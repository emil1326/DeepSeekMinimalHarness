import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  buildReport,
  gitOrNull,
  isTerminal,
  priceFor,
  timing,
  type PriceTable,
  type RunEvent,
  type RunLimits,
  type RunStatus,
} from '@emilswork/harness-core';
import { strayChanges } from '@emilswork/harness-worker';
import type { Auth } from './auth.js';
import type { Supervisor } from './supervisor.js';
import { RUN_TAGS, summarise, type Store } from './store.js';
import type {
  AnswerBody,
  ApiErrorBody,
  CreateRunBody,
  DiffResponse,
  LimitsBody,
  MessageBody,
  RunDetail,
  RunSummary,
  RunTimings,
  StatsResponse,
  TagBody,
  TimingsResponse,
} from './protocol.js';
import { TaskError } from '@emilswork/harness-core';

const HEARTBEAT_MS = 5000;
const DEAD_AFTER_MS = 15_000;
const MAX_BODY = 1_000_000;

export interface ServerOptions {
  store: Store;
  supervisor: Supervisor;
  auth: Auth;
  prices?: PriceTable;
  /** The built UI, served from the daemon so `dsh ui` is the only way in. */
  uiDir?: string;
  /** Called after the reply to `POST /daemon/stop`, so `dsh daemon stop` is clean. */
  onStop?: () => void;
}

export interface HarnessServer {
  port: number;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<HarnessServer> {
  const { store, supervisor, auth } = options;
  const runSubscribers = new Map<string, Set<WebSocket>>();
  const noticeSubscribers = new Set<WebSocket>();
  const heartbeats = new WeakMap<WebSocket, { lastPong: number; runId: string | null }>();

  const listen = (port: number): Promise<http.Server> =>
    new Promise((resolve) => {
      // Timed per route *pattern*, not per path: `/runs/:id/events` and not
      // `/runs/run-1a2b/events`, because a name per run id would be one row per
      // run for ever and the table would answer nothing.
      const server = http.createServer((request, response) => {
        timing.measure(`daemon.http.${routeNameOf(request.url ?? '/')}`, () => handleHttp(request, response));
      });
      server.on('upgrade', handleUpgrade);
      server.listen(port, '127.0.0.1', () => resolve(server));
    });

  const httpServer = await listen(0);
  auth.setPort(portOf(httpServer));

  const wss = new WebSocketServer({ noServer: true });

  const interval = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const info = heartbeats.get(client);
      if (info === undefined) continue;
      // A half-open connection: the socket still looks alive, nothing is there.
      if (now - info.lastPong > DEAD_AFTER_MS) {
        client.terminate();
        continue;
      }
      client.ping();
    }
  }, HEARTBEAT_MS);

  function notify(): void {
    const payload = JSON.stringify({ type: 'notice', runId: null });
    for (const client of noticeSubscribers) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  supervisor.onEvent = (event: RunEvent): void => {
    const subscribers = runSubscribers.get(event.runId);
    if (subscribers !== undefined) {
      const payload = JSON.stringify({ type: 'event', event });
      for (const client of subscribers) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
    }
    if (event.type === 'status' && isTerminal(event.status)) {
      const bye = JSON.stringify({ type: 'bye', status: event.status });
      for (const client of subscribers ?? []) {
        if (client.readyState === client.OPEN) client.send(bye);
      }
    }
    notify();
  };
  supervisor.onRunChange = (): void => notify();

  function subscribersFor(runId: string): Set<WebSocket> {
    const existing = runSubscribers.get(runId);
    if (existing !== undefined) return existing;
    const created = new Set<WebSocket>();
    runSubscribers.set(runId, created);
    return created;
  }

  function handleUpgrade(
    request: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    const refuse = (code: string, message: string): void => {
      socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!auth.checkHost(request.headers.host)) return refuse('403', 'Forbidden');
    if (!auth.checkOrigin(request.headers.origin)) return refuse('403', 'Forbidden');

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const bearer =
      auth.checkBearer(request.headers.authorization) || auth.checkCookie(request.headers.cookie);
    const queryToken = url.searchParams.get('token');
    const authorised = bearer || (queryToken !== null && auth.checkBearer(`Bearer ${queryToken}`));
    if (!authorised) return refuse('401', 'Unauthorized');

    const attach = /^\/runs\/([^/]+)\/attach$/.exec(url.pathname);
    const isNotices = url.pathname === '/events';
    if (attach === null && !isNotices) return refuse('404', 'Not Found');

    wss.handleUpgrade(request, socket, head, (client) => {
      heartbeats.set(client, { lastPong: Date.now(), runId: attach?.[1] ?? null });
      client.on('pong', () => {
        const info = heartbeats.get(client);
        if (info !== undefined) info.lastPong = Date.now();
      });
      client.on('close', () => {
        const info = heartbeats.get(client);
        if (info?.runId != null) {
          runSubscribers.get(info.runId)?.delete(client);
          supervisor.ownerLost(info.runId);
        } else {
          noticeSubscribers.delete(client);
        }
      });

      if (isNotices) {
        noticeSubscribers.add(client);
        client.send(JSON.stringify({ type: 'notice', runId: null }));
        return;
      }

      const runId = attach?.[1] ?? '';
      void attachRun(client, runId);
    });
  }

  async function attachRun(client: WebSocket, runId: string): Promise<void> {
    const detail = store.getRun(runId);
    if (detail === null) {
      client.send(JSON.stringify({ type: 'bye', status: 'failed' }));
      client.close();
      return;
    }
    subscribersFor(runId).add(client);
    const events = store.eventsAfter(runId, 0);
    client.send(
      JSON.stringify({ type: 'hello', detail: { ...detail, owners: supervisor.ownersOf(runId) }, events }),
    );
    if (isTerminal(detail.status)) {
      client.send(JSON.stringify({ type: 'bye', status: detail.status }));
      supervisor.ownerAttached(runId);
      return;
    }
    // Attaching is what starts a run that was left queued, and is what ties its
    // lifetime to this connection.
    supervisor.ownerAttached(runId);
  }

  // --- HTTP ---------------------------------------------------------------

  function handleHttp(request: http.IncomingMessage, response: http.ServerResponse): void {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

    if (!auth.checkHost(request.headers.host) || !auth.checkOrigin(request.headers.origin)) {
      return send(response, 403, { error: 'this daemon only answers its own host and origin' });
    }

    // The UI logs in through a one-time ticket, so the token never rides in a URL.
    if (request.method === 'GET' && url.pathname === '/ui/session') {
      if (!auth.redeemTicket(url.searchParams.get('ticket'))) {
        return send(response, 403, { error: 'that ticket is spent or unknown' });
      }
      response.writeHead(302, { 'set-cookie': auth.sessionCookie(), location: '/' });
      response.end();
      return;
    }

    const authed =
      auth.checkBearer(request.headers.authorization) || auth.checkCookie(request.headers.cookie);

    if (request.method === 'GET' && url.pathname.startsWith('/assets')) {
      return serveStatic(response, url.pathname);
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveStatic(response, '/index.html');
    }

    if (!authed) {
      return send(response, 401, { error: 'a bearer token or a session cookie is required' });
    }

    if (request.method === 'POST' && url.pathname === '/ui/ticket') {
      return send(response, 200, { ticket: auth.issueTicket() });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, { ok: true, pid: process.pid, port: portOf(httpServer) });
    }

    if (request.method === 'POST' && url.pathname === '/daemon/stop') {
      send(response, 200, { ok: true });
      setTimeout(() => options.onStop?.(), 50);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/runs') {
      return void readJson<CreateRunBody>(request)
        .then((body) => {
          if (typeof body.taskPath !== 'string' || body.taskPath === '') {
            return send(response, 400, { error: 'taskPath is required' });
          }
          try {
            const detail = supervisor.createRun(body.taskPath, body.detached === true, {
              ...(body.continueFrom === undefined ? {} : { continueFrom: body.continueFrom }),
              ...(body.limits === undefined ? {} : { limits: body.limits }),
            });
            return send(response, 201, { id: detail.id, detail });
          } catch (error) {
            if (error instanceof TaskError) {
              return send(response, 400, { error: 'the task file is not valid', problems: error.problems });
            }
            return send(response, 400, { error: (error as Error).message });
          }
        })
        .catch((error: Error) => send(response, 400, { error: error.message }));
    }

    if (request.method === 'GET' && url.pathname === '/runs') {
      const runs: RunSummary[] = store
        .listRuns((runId) => supervisor.ownersOf(runId))
        .map((run) => ({ ...run, priced: isPriced(run.model, options.prices) }));
      return send(response, 200, { runs });
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      const stats: StatsResponse = {
        runs: store.countRuns(),
        models: summarise(store.allMetrics(), options.prices),
        outcomes: store.outcomes(),
      };
      return send(response, 200, stats);
    }

    const timingsRoute = /^\/runs\/([^/]+)\/timings$/.exec(url.pathname);
    if (request.method === 'GET' && timingsRoute?.[1] !== undefined) {
      const detail = store.getRun(timingsRoute[1]);
      if (detail === null) return send(response, 404, { error: `no run called ${timingsRoute[1]}` });
      const readings = store.runTimings(detail.id);
      const body: RunTimings = {
        runId: detail.id,
        wallMs: wallMsOf(detail),
        entries: readings.entries,
        at: readings.at,
      };
      return send(response, 200, body);
    }

    if (request.method === 'GET' && url.pathname === '/timings') {
      const totals = store.timingTotals();
      const body: TimingsResponse = {
        runs: totals.runs,
        wallMs: totals.wallMs,
        entries: store.allTimings(),
        // The daemon's own readings, which are not part of a run and are not
        // added to one: see `TimingsResponse`.
        process: timing.snapshot().entries,
      };
      return send(response, 200, body);
    }

    const eventsRoute = /^\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method === 'GET' && eventsRoute?.[1] !== undefined) {
      const after = Number(url.searchParams.get('after') ?? '0');
      const runId = eventsRoute[1];
      if (store.getRun(runId) === null) return send(response, 404, { error: `no run called ${runId}` });
      return send(response, 200, { events: store.eventsAfter(runId, Number.isFinite(after) ? after : 0) });
    }

    const single = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && single?.[1] !== undefined) {
      const detail = store.getRun(single[1]);
      if (detail === null) return send(response, 404, { error: `no run called ${single[1]}` });
      const withOwners: RunDetail = {
        ...detail,
        owners: supervisor.ownersOf(detail.id),
        priced: isPriced(detail.model, options.prices),
      };
      return send(response, 200, withOwners);
    }

    const diffRoute = /^\/runs\/([^/]+)\/diff$/.exec(url.pathname);
    if (request.method === 'GET' && diffRoute?.[1] !== undefined) {
      const detail = store.getRun(diffRoute[1]);
      if (detail === null) return send(response, 404, { error: `no run called ${diffRoute[1]}` });
      // No baseline here: this is the worktree as it stands, for somebody who
      // wants to read the change, not a claim about who made it.
      const body: DiffResponse = {
        diff: gitDiff(detail.worktree),
        stray: strayChanges(detail.worktree, detail.config.allow, { soft: detail.config.soft }).files,
      };
      return send(response, 200, body);
    }

    const reportRoute = /^\/runs\/([^/]+)\/report$/.exec(url.pathname);
    if (request.method === 'GET' && reportRoute?.[1] !== undefined) {
      const detail = store.getRun(reportRoute[1]);
      if (detail === null) return send(response, 404, { error: `no run called ${reportRoute[1]}` });
      const stray = strayChanges(detail.worktree, detail.config.allow, { soft: detail.config.soft });
      return send(response, 200, {
        report: buildReport({
          id: detail.id,
          name: detail.name,
          status: detail.status,
          model: detail.model,
          task: detail.config.task,
          allowed: detail.config.allow,
          commands: Object.keys(detail.config.commands ?? {}),
          limits: detail.limits,
          turns: detail.turns,
          totals: detail.totals,
          summary: detail.summary,
          events: store.eventsAfter(detail.id, 0, 100_000),
          changed: changedFiles(detail.worktree),
          stray: stray.files,
          offPlan: stray.offPlan,
          preExisting: stray.preExisting,
          strayFailure: stray.failure,
        }),
      });
    }

    const messageRoute = /^\/runs\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method === 'POST' && messageRoute?.[1] !== undefined) {
      return void readJson<MessageBody>(request)
        .then((body) => {
          if (typeof body.text !== 'string' || body.text === '') {
            return send(response, 400, { error: 'text is required' });
          }
          supervisor.sendMessage(messageRoute[1] as string, body.text, body.by ?? 'claude');
          return send(response, 200, { ok: true });
        })
        .catch((error: Error) => send(response, 400, { error: error.message }));
    }

    const answerRoute = /^\/runs\/([^/]+)\/answers$/.exec(url.pathname);
    if (request.method === 'POST' && answerRoute?.[1] !== undefined) {
      return void readJson<AnswerBody>(request)
        .then((body) => {
          if (typeof body.text !== 'string') return send(response, 400, { error: 'text is required' });
          try {
            const id = supervisor.answer(answerRoute[1] as string, body.id, body.text, body.by ?? 'claude');
            return send(response, 200, { ok: true, id });
          } catch (error) {
            return send(response, 409, { error: (error as Error).message });
          }
        })
        .catch((error: Error) => send(response, 400, { error: error.message }));
    }

    const cancelRoute = /^\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === 'POST' && cancelRoute?.[1] !== undefined) {
      const runId = cancelRoute[1];
      if (store.getRun(runId) === null) return send(response, 404, { error: `no run called ${runId}` });
      supervisor.cancel(runId, 'cancelled from the CLI');
      return send(response, 200, { ok: true });
    }

    const tagRoute = /^\/runs\/([^/]+)\/tag$/.exec(url.pathname);
    if (request.method === 'POST' && tagRoute?.[1] !== undefined) {
      return void readJson<TagBody>(request)
        .then((body) => {
          const runId = tagRoute[1] as string;
          if (!RUN_TAGS.includes(body.tag)) {
            return send(response, 400, { error: `tag must be one of: ${RUN_TAGS.join(', ')}` });
          }
          if (store.getRun(runId) === null) return send(response, 404, { error: `no run called ${runId}` });
          // The lines come from the run's own write calls, through the same
          // report the reader sees, so the figure tagged here is the one on the
          // report and not a second count that could disagree with it.
          const detail = store.getRun(runId);
          const report = buildReport({
            id: runId,
            name: detail?.name ?? runId,
            status: detail?.status ?? 'finished',
            model: detail?.model ?? '',
            task: '',
            allowed: [],
            commands: Object.keys(detail?.config.commands ?? {}),
            limits: detail?.limits ?? ({} as RunLimits),
            turns: detail?.turns ?? 0,
            totals: detail?.totals ?? ({} as never),
            summary: null,
            events: store.eventsAfter(runId, 0, 100_000),
            changed: [],
            stray: [],
            strayFailure: null,
          });
          try {
            store.tag(runId, body.tag, {
              ...(body.note === undefined ? {} : { note: body.note }),
              lines: report.lines,
            });
          } catch (error) {
            return send(response, 404, { error: (error as Error).message });
          }
          return send(response, 200, { ok: true, tag: body.tag, lines: report.lines });
        })
        .catch((error: Error) => send(response, 400, { error: error.message }));
    }

    const limitsRoute = /^\/runs\/([^/]+)\/limits$/.exec(url.pathname);
    if (request.method === 'POST' && limitsRoute?.[1] !== undefined) {
      return void readJson<LimitsBody>(request)
        .then((body) => {
          const patch = limitsPatch(body);
          if (patch === null) {
            return send(response, 400, {
              error:
                'give at least one of turns, wallSeconds, outputTokens, totalTokens, contextTokens or costUsd; all are positive numbers, and costUsd is in dollars',
            });
          }
          try {
            return send(response, 200, {
              ok: true,
              limits: supervisor.raiseLimits(limitsRoute[1] as string, patch),
            });
          } catch (error) {
            // Not going: a stopped run cannot be given room in place, it has to
            // be continued, and saying which is more useful than "conflict".
            return send(response, 409, { error: (error as Error).message });
          }
        })
        .catch((error: Error) => send(response, 400, { error: error.message }));
    }

    return send(response, 404, { error: `no route for ${request.method ?? 'GET'} ${url.pathname}` });
  }

  function serveStatic(response: http.ServerResponse, urlPath: string): void {
    const uiDir = options.uiDir;
    if (uiDir === undefined || !fs.existsSync(uiDir)) {
      return send(response, 404, { error: 'the UI is not built; run npm run build:ui' });
    }
    const target = path.join(uiDir, urlPath);
    const inside = path.relative(uiDir, path.resolve(target));
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      return send(response, 403, { error: 'no' });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      const index = path.join(uiDir, 'index.html');
      if (fs.existsSync(index)) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void response.end(fs.readFileSync(index));
      }
      return send(response, 404, { error: 'not found' });
    }
    response.writeHead(200, { 'content-type': contentType(target) });
    return void response.end(fs.readFileSync(target));
  }

  return {
    port: portOf(httpServer),
    close: async (): Promise<void> => {
      clearInterval(interval);
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function portOf(server: http.Server): number {
  const address = server.address();
  return address !== null && typeof address === 'object' ? address.port : 0;
}

/**
 * Whether a model can be priced at all, and so whether a run of it has a cost.
 *
 * Asked about *now* and read as a yes-or-no about the model, because a priced
 * model has two prices — peak and off peak — so the hour changes the figure and
 * never the answer. The figures themselves are worked out per call, in the
 * worker and in `stats`.
 *
 * The UI needs this rather than inferring it from an empty cost, which would
 * render `$0 of $0.050` for a model nobody has priced: a run that is not being
 * measured, drawn as a run that has spent nothing.
 */
function isPriced(model: string, prices: PriceTable | undefined): boolean {
  return priceFor(model, Date.now(), prices) !== undefined;
}

/**
 * A request path as a route name, so the readings have one row per endpoint.
 *
 * Only the run id is collapsed: `/runs/:id/events` rather than a row per run.
 */
function routeNameOf(target: string): string {
  const path = target.split('?')[0] ?? '/';
  return path.replace(/\/runs\/[^/]+/, '/runs/:id');
}

/**
 * How long a run has taken so far, or took in all.
 *
 * A run still going counts up to now, which is what makes a live run's share
 * column meaningful rather than zero. A run whose start was never written (a
 * daemon that died before it forked the worker) falls back to its creation, so
 * the number is never negative or NaN.
 */
function wallMsOf(detail: RunDetail, now = Date.now()): number {
  const from = Date.parse(detail.startedAt ?? detail.createdAt);
  const to = detail.endedAt === null ? now : Date.parse(detail.endedAt);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0;
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(text);
}

async function readJson<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new Error('that body is too big');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

/** Every path git reports as changed, for the report's file lists. */
function changedFiles(worktree: string): string[] {
  const status = gitOrNull(['status', '--porcelain', '-uall'], { cwd: worktree });
  if (status === null) return [];
  return status
    .split('\n')
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== '')
    .map((entry) => {
      const renamed = entry.split(' -> ');
      return (renamed[renamed.length - 1] ?? entry).replace(/^"|"$/g, '');
    });
}

function gitDiff(worktree: string): string {
  // Through the shared helper, which is where `windowsHide` and the buffer size
  // live. Without the flag a detached daemon put a console window on the user's
  // screen every time somebody opened the Diff panel.
  const againstHead = gitOrNull(['diff', 'HEAD'], { cwd: worktree });
  if (againstHead !== null) return againstHead;
  return gitOrNull(['diff'], { cwd: worktree }) ?? '';
}

/**
 * The limits in a `POST /runs/:id/limits` body, or null if there are none.
 *
 * Values are *absolute*, not deltas: `{ turns: 60 }` means sixty turns, not
 * sixty more. The CLI turns `--turns +30` into an absolute figure before it gets
 * here, so that two grants in a row cannot compound by accident through a
 * message that got delivered twice.
 */
function limitsPatch(body: LimitsBody): Partial<RunLimits> | null {
  const patch: Partial<RunLimits> = {};
  for (const name of ['turns', 'wallSeconds', 'outputTokens', 'totalTokens', 'contextTokens'] as const) {
    const value = body[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
    patch[name] = value;
  }
  const cost = body.costUsd;
  if (cost !== undefined) {
    // The one limit that is not a count of whole things. Five cents is typed as
    // `0.05`, and demanding an integer here would make the dollar budget — the
    // only limit that says what a run actually costs — impossible to set.
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) return null;
    patch.costUsd = cost;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
  };
  return types[extension] ?? 'application/octet-stream';
}

export function defaultUiDir(): string {
  return fileURLToPath(new URL('./public', import.meta.url));
}

export type { ApiErrorBody, RunStatus };
