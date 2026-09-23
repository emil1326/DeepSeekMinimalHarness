import type { RunEvent, RunStatus, RunTotals } from '@emilswork/harness-core';

const CODES = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  cyan: '\u001b[36m',
} as const;

export function useColor(): boolean {
  return process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
}

function paint(enabled: boolean, code: keyof typeof CODES, text: string): string {
  return enabled ? `${CODES[code]}${text}${CODES.reset}` : text;
}

export interface RendererOptions {
  /** One JSON event per line, for a machine to read. */
  json: boolean;
  color: boolean;
  /** Print the model's thinking, which is billed as output. */
  thinking?: boolean;
}

/** The readable stream. With `--json` the same events go out as JSON lines instead. */
export class Renderer {
  constructor(
    private readonly write: (text: string) => void,
    private readonly options: RendererOptions,
  ) {}

  event(event: RunEvent): void {
    if (this.options.json) {
      this.write(`${JSON.stringify(event)}\n`);
      return;
    }
    switch (event.type) {
      case 'turn.start':
        this.write(`\n${paint(this.options.color, 'dim', `[turn ${event.turn}]`)}\n`);
        break;
      case 'text.delta':
        this.write(event.text);
        break;
      case 'thinking.delta':
        // Not the answer, and it is usually most of what was billed. Dim, and
        // only worth printing when somebody asked to see it.
        if (this.options.thinking) this.write(paint(this.options.color, 'dim', event.text));
        break;
      case 'tool.call':
        this.write(
          `${this.colour('cyan', '→')} ${event.name} ${paint(this.options.color, 'dim', compact(event.args))}\n`,
        );
        break;
      case 'tool.result': {
        const head = event.ok ? this.colour('dim', '←') : this.colour('yellow', '←');
        const body = indent(truncate(event.result, 1600), '    ');
        this.write(`${head} ${paint(this.options.color, 'dim', `${event.name}:`)}\n${body}\n`);
        break;
      }
      case 'question':
        this.write(`\n${this.colour('yellow', '? the agent is asking')}\n`);
        this.write(`${indent(event.question, '    ')}\n`);
        this.write(
          `    answer with: ${paint(this.options.color, 'bold', `dsh reply ${event.runId} "your answer"`)}\n\n`,
        );
        break;
      case 'answer':
        this.write(`${this.colour('green', '← answer')} (${event.by}): ${event.answer}\n`);
        break;
      case 'message':
        this.write(`${this.colour('blue', `[${event.by}]`)} ${event.text}\n`);
        break;
      case 'metrics':
        this.write(`${paint(this.options.color, 'dim', metricsLine(event.call, event.totals))}\n`);
        break;
      case 'summary':
        this.write(`\n${paint(this.options.color, 'bold', '--- summary ---')}\n${event.text}\n`);
        break;
      case 'context':
        // The model's view of the conversation just changed. Say so, and say
        // what went, so a reader can tell whether the answer still has its
        // bearings.
        this.write(
          `${this.colour('yellow', 'context trimmed:')} dropped ${event.dropped} earlier result${event.dropped === 1 ? '' : 's'} to fit the window (${event.subjects.join(', ')})\n`,
        );
        break;
      case 'limit':
        this.write(`${this.colour('yellow', `stopped at the ${event.which} limit:`)} ${event.detail}\n`);
        break;
      case 'stray':
        this.write(
          `\n${this.colour('red', 'STRAY CHANGES OUTSIDE THE ALLOWED FILES:')} ${event.files.join(', ')}\n`,
        );
        break;
      case 'error':
        this.write(`${this.colour('red', 'error:')} ${event.message}\n`);
        break;
      case 'status':
        if (event.status !== 'running' && event.status !== 'queued') {
          this.write(
            `${paint(this.options.color, 'dim', `[${event.status}]`)}${event.detail ? ` ${event.detail}` : ''}\n`,
          );
        }
        break;
    }
  }

  private colour(code: keyof typeof CODES, text: string): string {
    return paint(this.options.color, code, text);
  }
}

export function metricsLine(
  call: {
    timeToFirstTokenMs: number | null;
    generationTokensPerSecond: number | null;
    endToEndTokensPerSecond: number | null;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheHitTokens: number;
  },
  totals: RunTotals,
): string {
  const parts = [
    call.timeToFirstTokenMs === null ? null : `first token ${(call.timeToFirstTokenMs / 1000).toFixed(2)}s`,
    call.endToEndTokensPerSecond === null ? null : `${call.endToEndTokensPerSecond.toFixed(0)} tok/s`,
    // Marked as decode only, because it is not the number to compare with a
    // vendor's headline and it is often null.
    call.generationTokensPerSecond === null
      ? null
      : `${call.generationTokensPerSecond.toFixed(0)} tok/s decoding`,
    `cache ${hitRate(call)}%`,
    `${call.promptTokens} in / ${call.completionTokens} out`,
    call.reasoningTokens > 0 ? `${call.reasoningTokens} of them thinking` : null,
  ].filter((part): part is string => part !== null);
  const run = totals.costUsd === null ? '' : ` | run cost $${totals.costUsd.toFixed(4)}`;
  return `   · ${parts.join(' | ')}${run}`;
}

function hitRate(call: { promptTokens: number; cacheHitTokens: number }): number {
  if (call.promptTokens <= 0) return 0;
  return Math.round((call.cacheHitTokens / call.promptTokens) * 100);
}

function compact(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n    [...] ${text.length - limit} more` : text;
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

export function statusWord(status: RunStatus): string {
  return status.replace(/_/g, ' ');
}

export function pad(text: string, width: number): string {
  const clean = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return clean.padEnd(width, ' ');
}
