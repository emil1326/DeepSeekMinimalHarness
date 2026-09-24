import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { describeCall } from '../describe';
import { fold, type Block } from '../fold';
import { seconds, speed, tokens } from '../format';
import type { RunEvent } from '../types';

export function Chat({
  runId,
  events,
  ready,
  live,
}: {
  runId: string;
  events: RunEvent[];
  /** False until the first batch has been read, which is not the same as empty. */
  ready: boolean;
  live: boolean;
}) {
  const blocks = useMemo(() => fold(events), [events]);
  const scroller = useRef<HTMLDivElement>(null);
  // A live run is followed; a finished one is read from the start.
  const pinned = useRef(live);

  useEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [blocks]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (element === null) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  };

  const last = blocks[blocks.length - 1]?.key;

  return (
    <div className="chat">
      <div className="log" ref={scroller} onScroll={onScroll}>
        {!ready && <div className="empty">loading…</div>}
        {ready && blocks.length === 0 && <div className="empty">nothing has happened yet</div>}
        {blocks.map((block) => (
          <BlockView key={block.key} block={block} runId={runId} streaming={live && block.key === last} />
        ))}
      </div>
      <Composer runId={runId} live={live} />
    </div>
  );
}

function BlockView({ block, runId, streaming }: { block: Block; runId: string; streaming: boolean }) {
  switch (block.kind) {
    case 'turn':
      return <TurnRule block={block} />;
    case 'text':
      return <p className={`utterance${streaming ? ' streaming' : ''}`}>{block.text}</p>;
    case 'said':
      return (
        <div className="said">
          <span className="who">{block.by === 'emil' ? 'you' : block.by}</span>
          <pre>{block.text}</pre>
        </div>
      );
    case 'thinking':
      return (
        <details className="thinking">
          <summary>
            <span>thought it through</span>
            {block.tokens !== null && <span className="cost">{block.tokens.toLocaleString()} tokens</span>}
          </summary>
          <div className="thinking-body">{block.text}</div>
        </details>
      );
    case 'tool':
      return <ToolCall block={block} />;
    case 'question':
      return <Question block={block} runId={runId} />;
    case 'summary':
      return (
        <div className="summary">
          <span className="label">summary</span>
          {block.text}
        </div>
      );
    case 'note':
      return (
        <div className="block-note" data-tone={block.tone}>
          {block.text}
        </div>
      );
  }
}

/**
 * A turn is a thin rule with the turn number. The numbers for that call are
 * real but they are reference material, and printing all five on every turn
 * buried the conversation under its own telemetry. They live one click in.
 */
function TurnRule({ block }: { block: Extract<Block, { kind: 'turn' }> }) {
  return (
    <details className="turn">
      <summary className="turn-rule">
        <span className="turn-label">turn {block.turn}</span>
        {block.call !== null && block.call.endToEndTokensPerSecond !== null && (
          <span className="turn-peek">{block.call.endToEndTokensPerSecond.toFixed(0)}/s</span>
        )}
      </summary>
      {block.call !== null && (
        <dl className="turn-numbers">
          <div>
            <dt>first token</dt>
            <dd>{seconds(block.call.timeToFirstTokenMs)}</dd>
          </div>
          <div>
            <dt>speed</dt>
            <dd>{speed(block.call.endToEndTokensPerSecond)}</dd>
          </div>
          <div>
            <dt>tokens</dt>
            <dd>
              {tokens(block.call.promptTokens)} in, {block.call.completionTokens} out
            </dd>
          </div>
          {block.call.reasoningTokens > 0 && (
            <div>
              <dt>thinking</dt>
              <dd>{block.call.reasoningTokens} of them</dd>
            </div>
          )}
          {block.call.generationTokensPerSecond !== null && (
            <div>
              <dt>decode</dt>
              <dd>{speed(block.call.generationTokensPerSecond)}</dd>
            </div>
          )}
          {block.call.cacheHitTokens > 0 && (
            <div>
              <dt>cached</dt>
              <dd>{tokens(block.call.cacheHitTokens)}</dd>
            </div>
          )}
        </dl>
      )}
    </details>
  );
}

function ToolCall({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const summary = useMemo(() => describeCall(block.name, block.args), [block.name, block.args]);
  const ref = useRef<HTMLDetailsElement>(null);

  // Opened while it is still going, closed once it lands. A ref rather than the
  // `open` prop, so React does not fight the user if they open it themselves.
  // Mount only: after that the box belongs to whoever clicked it.
  useEffect(() => {
    if (ref.current !== null && block.result === null) ref.current.open = true;
  }, []);

  return (
    <details className="tool" data-ok={block.ok === null ? undefined : String(block.ok)} ref={ref}>
      <summary>
        <span className="name">{block.name}</span>
        <span className="subject">{summary.subject}</span>
        {summary.detail !== null && <span className="detail">{summary.detail}</span>}
        <span className="outcome">{block.ok === null ? 'running' : block.ok ? 'ok' : 'refused'}</span>
      </summary>
      <div className="tool-body">
        <span className="label">arguments</span>
        {JSON.stringify(block.args, null, 2)}
        <span className="label">result</span>
        {block.result ?? '(still running)'}
      </div>
    </details>
  );
}

function Question({ block, runId }: { block: Extract<Block, { kind: 'question' }>; runId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async (): Promise<void> => {
    if (draft.trim() === '') return;
    setBusy(true);
    try {
      await api.answer(runId, draft.trim());
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['events', runId] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="question">
      <span className="label">{block.answer === null ? 'waiting on you' : 'answered'}</span>
      <p>{block.question}</p>
      {block.answer === null ? (
        <div className="reply">
          <textarea
            className="grow"
            rows={2}
            value={draft}
            autoFocus
            placeholder="answer for the agent…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button className="primary" onClick={() => void send()} disabled={busy || draft.trim() === ''}>
            answer
          </button>
        </div>
      ) : (
        <p className="answered">{block.answer.text}</p>
      )}
    </div>
  );
}

function Composer({ runId, live }: { runId: string; live: boolean }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // Nothing to tell an agent that has stopped, so the box is not there at all.
  if (!live) {
    return (
      <p className="composer-done">
        this run is over. start another with <code>dsh run task.json</code>.
      </p>
    );
  }

  const send = async (): Promise<void> => {
    if (draft.trim() === '') return;
    setBusy(true);
    try {
      await api.tell(runId, draft.trim());
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['events', runId] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <textarea
        className="grow"
        rows={2}
        value={draft}
        autoFocus
        placeholder="tell the agent something. it arrives at the next turn."
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <button className="primary" onClick={() => void send()} disabled={busy || draft.trim() === ''}>
        send
      </button>
    </div>
  );
}
