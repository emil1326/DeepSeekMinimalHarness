import type { RunStatus } from '../types';
import { statusWord } from '../format';

export function StatusPill({ status, detail }: { status: RunStatus; detail?: string | null }) {
  return (
    <span className="status" data-status={status} title={detail ?? undefined}>
      <span className="dot" aria-hidden="true" />
      <span className="word">{statusWord(status)}</span>
    </span>
  );
}

/**
 * What happened to the work, once somebody has judged it.
 *
 * Worth a mark of its own next to the status, because the status cannot answer
 * the question this does: a run that stopped at a limit and whose half-finished
 * work was kept, and one whose work was thrown away, are the same row without it.
 *
 * Nothing at all when there is no tag. A run nobody has gated has not been
 * judged, and drawing that as a grey `dropped` would be inventing an answer.
 */
export function TagPill({ tag, note }: { tag: 'landed' | 'fixed' | 'dropped' | null; note?: string | null }) {
  if (tag === null) return null;
  return (
    <span className="tag-pill" data-tag={tag} title={note ?? undefined}>
      {tag}
    </span>
  );
}
