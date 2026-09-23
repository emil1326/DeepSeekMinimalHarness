/**
 * Tool arguments as something a person can scan.
 *
 * The log used to print raw JSON on every tool row:
 *   read_file  {"path":"ui/mark.spec.ts","start":10}
 * which is the noisiest text on the page and the widest, so it wrapped and ate
 * the whole line. What actually matters is which file, which check, which
 * pattern, and roughly how big the change was. Everything else is one click
 * away inside the row.
 */

export interface CallSummary {
  /** The one thing this call is about: a file, a check name, a pattern. */
  subject: string;
  /** Optional, quiet, secondary: a line range, a change size, a directory. */
  detail: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function lines(value: unknown): number {
  const body = text(value);
  return body === null ? 0 : body.split('\n').length;
}

export function describeCall(name: string, args: unknown): CallSummary {
  const map = (args ?? {}) as Record<string, unknown>;
  const path = text(map.path);

  switch (name) {
    case 'read_file': {
      const subject = path ?? '?';
      const from = count(map.start);
      const to = count(map.end);
      if (from !== null && to !== null) return { subject, detail: `lines ${from}–${to}` };
      if (from !== null) return { subject, detail: `from line ${from}` };
      return { subject, detail: null };
    }
    case 'list_dir':
      return { subject: path ?? '.', detail: null };
    case 'search': {
      const pattern = text(map.pattern) ?? '?';
      return { subject: pattern, detail: path === null ? null : `in ${path}` };
    }
    case 'replace_in_file':
      return { subject: path ?? '?', detail: `−${lines(map.old)} +${lines(map.new)}` };
    case 'create_file': {
      const size = lines(map.content);
      return { subject: path ?? '?', detail: size === 0 ? 'new file' : `${size} lines` };
    }
    case 'run_check':
      return { subject: text(map.name) ?? '?', detail: null };
    case 'ask':
      return { subject: 'a question', detail: null };
    case 'finish':
      return { subject: 'the run', detail: null };
    default: {
      // An unknown tool still gets one readable line rather than a JSON blob.
      const keys = Object.keys(map);
      return { subject: path ?? name, detail: keys.length === 0 ? null : keys.join(', ') };
    }
  }
}
