export function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  return `${(ms / 1000).toFixed(2)}s`;
}

export function speed(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(0)}/s`;
}

export function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  if (value === 0) return '$0';
  if (value >= 1) return `$${value.toFixed(2)}`;
  // Fixed places rather than trimmed ones, because these get compared by eye
  // against each other. A hundredth of a cent is `$0.0001` and is not the
  // `$0.00` that rounding to cents would make of it.
  return `$${value >= 0.01 ? value.toFixed(3) : value.toFixed(4)}`;
}

/**
 * A limit's name as a person writes it.
 *
 * `costUsd` is a field name, and "the harness warned the agent about costUsd"
 * is what the chat reads otherwise.
 */
export function limitName(which: string): string {
  return which === 'costUsd' ? 'cost' : which;
}

/**
 * A limit's numbers in its own unit, short enough to sit inside a ring.
 *
 * `turns` is a count, tokens get their `k` and `M`, a wall clock is minutes once
 * it has any, and dollars never round to a whole number — a run that has spent
 * three cents and one that has spent none are different runs.
 */
export function compactLimit(which: string, value: number): string {
  if (which === 'costUsd') return money(value);
  if (which === 'wallSeconds') return value < 60 ? `${Math.round(value)}s` : `${Math.round(value / 60)}m`;
  if (which === 'turns') return String(Math.round(value));
  return tokens(value);
}

export function hitRate(promptTokens: number, cacheHitTokens: number): string {
  if (promptTokens <= 0) return '-';
  return `${Math.round((cacheHitTokens / promptTokens) * 100)}%`;
}

export function clockTime(iso: string | null): string {
  if (iso === null) return '-';
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function durationOf(start: string | null, end: string | null): string {
  if (start === null) return '-';
  const from = Date.parse(start);
  const to = end === null ? Date.now() : Date.parse(end);
  const total = Math.max(0, Math.round((to - from) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
}

/**
 * The last segment of a path.
 *
 * Temp paths are long and none of the middle tells you anything: what you need
 * is `esap-ds-1`. The full path stays in the tooltip.
 */
export function shortPath(value: string): string {
  const parts = value
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '');
  return parts.length === 0 ? value : (parts[parts.length - 1] ?? value);
}

export function statusWord(status: string): string {
  return status.replace(/_/g, ' ');
}
