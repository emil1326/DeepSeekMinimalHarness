import type { CallMetrics, RunEvent, Speaker } from './types';

/**
 * The event log flattened into things a person reads: paragraphs, folded tool
 * calls, questions, and the odd loud note. One list, many readers.
 */
export type Block =
  | { kind: 'text'; key: string; turn: number; text: string; streaming: boolean }
  /** The model thinking. Billed as output, and the bulk of it. */
  | { kind: 'thinking'; key: string; turn: number; text: string; tokens: number | null }
  | {
      kind: 'tool';
      key: string;
      turn: number;
      name: string;
      args: unknown;
      result: string | null;
      ok: boolean | null;
    }
  | {
      kind: 'question';
      key: string;
      id: string;
      question: string;
      answer: { text: string; by: Speaker } | null;
    }
  | { kind: 'said'; key: string; by: Speaker; text: string }
  /** One turn, with the numbers from the model call that produced it. */
  | { kind: 'turn'; key: string; turn: number; call: CallMetrics | null }
  | { kind: 'summary'; key: string; text: string }
  | { kind: 'note'; key: string; tone: 'info' | 'warn' | 'bad'; text: string };

export function fold(events: RunEvent[]): Block[] {
  const blocks: Block[] = [];
  const toolAt = new Map<string, number>();
  const questionAt = new Map<string, number>();
  const turnAt = new Map<number, number>();
  let openText: Extract<Block, { kind: 'text' }> | null = null;
  let openThinking: Extract<Block, { kind: 'thinking' }> | null = null;

  for (const event of events) {
    const key = `e${event.seq}`;
    switch (event.type) {
      case 'text.delta': {
        if (openText !== null && openText.turn === event.turn) {
          openText.text += event.text;
          break;
        }
        openThinking = null;
        openText = { kind: 'text', key, turn: event.turn, text: event.text, streaming: false };
        blocks.push(openText);
        break;
      }
      case 'thinking.delta': {
        if (openThinking !== null && openThinking.turn === event.turn) {
          openThinking.text += event.text;
          break;
        }
        openText = null;
        openThinking = { kind: 'thinking', key, turn: event.turn, text: event.text, tokens: null };
        blocks.push(openThinking);
        break;
      }
      case 'turn.start':
        openText = null;
        openThinking = null;
        turnAt.set(event.turn, blocks.length);
        blocks.push({ kind: 'turn', key, turn: event.turn, call: null });
        break;
      case 'tool.call':
        openText = null;
        openThinking = null;
        toolAt.set(event.id, blocks.length);
        blocks.push({
          kind: 'tool',
          key,
          turn: event.turn,
          name: event.name,
          args: event.args,
          result: null,
          ok: null,
        });
        break;
      case 'tool.result': {
        openText = null;
        openThinking = null;
        const at = toolAt.get(event.id);
        if (at === undefined) {
          blocks.push({
            kind: 'tool',
            key,
            turn: event.turn,
            name: event.name,
            args: {},
            result: event.result,
            ok: event.ok,
          });
          break;
        }
        const block = blocks[at];
        if (block?.kind === 'tool') {
          block.result = event.result;
          block.ok = event.ok;
        }
        break;
      }
      case 'question':
        openText = null;
        questionAt.set(event.id, blocks.length);
        blocks.push({ kind: 'question', key, id: event.id, question: event.question, answer: null });
        break;
      case 'answer': {
        openText = null;
        const at = questionAt.get(event.id);
        const block = at === undefined ? undefined : blocks[at];
        if (block?.kind === 'question') block.answer = { text: event.answer, by: event.by };
        else blocks.push({ kind: 'said', key, by: event.by, text: event.answer });
        break;
      }
      case 'message':
        openText = null;
        blocks.push({ kind: 'said', key, by: event.by, text: event.text });
        break;
      case 'metrics': {
        // The turn header already carries these, so this adds no block of its own.
        const at = turnAt.get(event.turn);
        const block = at === undefined ? undefined : blocks[at];
        if (block?.kind === 'turn') block.call = event.call;
        // How many of this turn's output tokens were thinking, attached to the
        // thinking block so its collapsed line can say what it cost.
        if (event.call.reasoningTokens > 0) {
          const thoughts = blocks.findLast((each) => each.kind === 'thinking' && each.turn === event.turn);
          if (thoughts?.kind === 'thinking') thoughts.tokens = event.call.reasoningTokens;
        }
        break;
      }
      case 'summary':
        openText = null;
        blocks.push({ kind: 'summary', key, text: event.text });
        break;
      case 'limit':
        openText = null;
        blocks.push({
          kind: 'note',
          key,
          tone: 'warn',
          text: `stopped at the ${event.which} limit: ${event.detail}`,
        });
        break;
      case 'stray':
        openText = null;
        blocks.push({
          kind: 'note',
          key,
          tone: 'bad',
          text: `changed outside the allowed files: ${event.files.join(', ')}`,
        });
        break;
      case 'error':
        openText = null;
        blocks.push({ kind: 'note', key, tone: 'bad', text: event.message });
        break;
      case 'status':
        openText = null;
        break;
    }
  }
  return blocks;
}

/** The loudest thing that happened, for the one-line summary above the chat. */
export function lastNote(events: RunEvent[]): string | null {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event === undefined) continue;
    if (event.type === 'stray') return `changed outside the allowed files: ${event.files.join(', ')}`;
    if (event.type === 'error') return event.message;
    if (event.type === 'limit') return event.detail;
    if (event.type === 'summary') return null;
  }
  return null;
}

export function pendingQuestion(events: RunEvent[]): { id: string; question: string } | null {
  const asked = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'question') asked.set(event.id, event.question);
    if (event.type === 'answer') asked.delete(event.id);
  }
  const entries = [...asked.entries()];
  const last = entries[entries.length - 1];
  return last === undefined ? null : { id: last[0], question: last[1] };
}
