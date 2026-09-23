/**
 * A fake DeepSeek, so the client and the whole agent loop can be tested without
 * touching the network or spending a token.
 *
 * Shared by the tests in every package that needs a model. It is a test helper,
 * not shipped code.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedTurn {
  text?: string;
  toolCalls?: { name: string; args: unknown }[];
  promptTokens?: number;
  cacheHitTokens?: number;
  completionTokens?: number;
  /** Wait this long before the first chunk, so time to first token is measurable. */
  delayMs?: number;
  /** Wait this long between chunks, so generation speed is measurable. */
  tokenDelayMs?: number;
  /** Answer with this status instead of streaming. */
  status?: number;
  /** Send nothing and never close. For abort tests. */
  hang?: boolean;
}

export interface FakeServer {
  url: string;
  port: number;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startFakeDeepSeek(script: ScriptedTurn[]): Promise<FakeServer> {
  const requests: Record<string, unknown>[] = [];
  let served = 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push(body);
      const turn = script[Math.min(served, script.length - 1)] ?? {};
      served += 1;

      if (turn.status !== undefined) {
        response.writeHead(turn.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `scripted ${turn.status}` } }));
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      const send = (payload: unknown): void => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const delta = (value: Record<string, unknown>): void => {
        send({ choices: [{ index: 0, delta: value, finish_reason: null }] });
      };

      const usage = {
        prompt_tokens: turn.promptTokens ?? 1000,
        completion_tokens: turn.completionTokens ?? 50,
        total_tokens: (turn.promptTokens ?? 1000) + (turn.completionTokens ?? 50),
        prompt_cache_hit_tokens: turn.cacheHitTokens ?? 0,
        prompt_cache_miss_tokens: (turn.promptTokens ?? 1000) - (turn.cacheHitTokens ?? 0),
      };

      if (turn.hang === true) {
        return;
      }

      const timers: NodeJS.Timeout[] = [];
      let clock = turn.delayMs ?? 0;

      const schedule = (fn: () => void): void => {
        timers.push(setTimeout(fn, clock));
      };

      const pieces = splitIntoChunks(turn.text ?? '');
      for (const piece of pieces) {
        schedule(() => delta({ content: piece }));
        clock += turn.tokenDelayMs ?? 0;
      }

      (turn.toolCalls ?? []).forEach((call, index) => {
        const id = `call_${served}_${index}`;
        schedule(() =>
          delta({ tool_calls: [{ index, id, type: 'function', function: { name: call.name } }] }),
        );
        // Every chunk costs a tick of the clock, the same way a real stream
        // arrives over time. Sharing one clock value for a whole tool call left
        // a sub-millisecond decode window, which is not a measurable speed.
        clock += turn.tokenDelayMs ?? 0;
        const serialised = JSON.stringify(call.args);
        for (const piece of splitIntoChunks(serialised, 6)) {
          schedule(() => delta({ tool_calls: [{ index, function: { arguments: piece } }] }));
          clock += turn.tokenDelayMs ?? 0;
        }
      });

      schedule(() => {
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
        response.write('data: [DONE]\n\n');
        response.end();
      });

      response.on('close', () => {
        for (const timer of timers) clearTimeout(timer);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function splitIntoChunks(text: string, size = 8): string[] {
  if (text === '') return [];
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces;
}
