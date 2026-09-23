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
