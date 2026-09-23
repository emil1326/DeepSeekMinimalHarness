/**
 * Diagnosing a tool call that failed, so the model can fix it in one turn.
 *
 * The expensive failure is `replace_in_file` not finding its text. "matched 0
 * times" is true and useless: the model then re-reads the file, guesses again,
 * and burns a turn, which at a few hundred tokens a second is the most
 * expensive thing in the harness. Almost every miss is one of three things the
 * harness can name for free:
 *
 *   - the text is there but the whitespace or line endings differ
 *   - the text is there more than once, so it needs more context
 *   - the text is genuinely absent, so the file needs reading
 *
 * Everything here runs only after a failure, so none of it is on the hot path
 * of a call that worked.
 */

/** Longest text worth searching for again loosely. Beyond this it is not a typo. */
const NEAR_MATCH_MAX = 8000;

export function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface NearMatch {
  /** 1-based line the match starts on. */
  line: number;
  /** The first line of what is actually in the file. */
  text: string;
}

/**
 * A pattern matching `needle` wherever any run of whitespace appears in it, so
 * a difference in indentation or line endings still matches.
 *
 * Leading and trailing whitespace come off first. Left on, the opening `\s+`
 * reaches backwards past the newline and swallows the blank line above the
 * match, so the hit is reported on the wrong line with an empty snippet, which
 * is worse than no diagnostic at all. Indentation is what differs; the rest of
 * the text is what identifies the place.
 */
export function loosePattern(needle: string): RegExp | null {
  if (needle.length > NEAR_MATCH_MAX) return null;
  const trimmed = needle.replace(/^[\s]+|[\s]+$/g, '');
  if (trimmed === '') return null;
  const parts = trimmed.split(/(\s+)/).filter((part) => part !== '');
  const source = parts.map((part) => (/^\s+$/.test(part) ? '\\s+' : escapeLiteral(part))).join('');
  try {
    return new RegExp(source, 'g');
  } catch {
    return null;
  }
}

/** Where a whitespace-tolerant match of `needle` sits, and what it looks like. */
export function findNearMatches(haystack: string, needle: string, limit = 3): NearMatch[] {
  const pattern = loosePattern(needle);
  if (pattern === null) return [];
  const found: NearMatch[] = [];
  for (const match of haystack.matchAll(pattern)) {
    const at = match.index ?? 0;
    // Counted, not cached: this runs once, on a failure.
    let line = 1;
    for (let index = 0; index < at; index += 1) {
      if (haystack[index] === '\n') line += 1;
    }
    // The first line of the match that actually has something on it.
    const text = (match[0].split('\n').find((each) => each.trim() !== '') ?? '').trim();
    found.push({ line, text });
    if (found.length >= limit) break;
  }
  return found;
}

/** Every line `needle` occurs on, for when it matched too many times. */
export function findMatches(haystack: string, needle: string, limit = 5): number[] {
  if (needle === '') return [];
  const lines: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    let line = 1;
    for (let index = 0; index < at; index += 1) {
      if (haystack[index] === '\n') line += 1;
    }
    // Several matches can share a line, and "lines 1, 1" reads like a bug.
    if (!lines.includes(line)) lines.push(line);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return lines.slice(0, limit);
}

function lineCount(text: string): number {
  let lines = 1;
  for (const char of text) if (char === '\n') lines += 1;
  return lines;
}

/**
 * What to say when the old text was not in the file.
 *
 * `path` is only for the message; `haystack` is the file as the sandbox read
 * it, with line endings already normalised.
 */
export function explainMissing(path: string, haystack: string, needle: string): string {
  const total = lineCount(haystack);
  if (needle === '') {
    return `refused: no old text was given. ${path} has ${total} lines; read it with read_file.`;
  }

  const near = findNearMatches(haystack, needle);
  if (near.length === 1) {
    const only = near[0] as NearMatch;
    return [
      `refused: that text is not in ${path} exactly, but the same text is at line ${only.line} if`,
      'whitespace and line endings are ignored. What the file actually has there:',
      `    ${only.text}`,
      'Copy that text exactly as read_file showed it, including the indentation.',
    ].join('\n');
  }
  if (near.length > 1) {
    const lines = near.map((match) => match.line).join(', ');
    return [
      `refused: that text is not in ${path} exactly, but something like it is at lines ${lines}.`,
      'Copy the text exactly as read_file showed it, including the indentation.',
    ].join('\n');
  }

  // Nothing is close. Name the line of the replacement that is wrong, because
  // "one of these six lines is not in the file" is still six lines to guess
  // from, and naming the line is one turn instead of three.
  const fileLines = new Set(haystack.split('\n').map((line) => line.trim()));
  const needleLines = needle.split('\n');
  for (let index = 0; index < needleLines.length; index += 1) {
    const trimmed = (needleLines[index] ?? '').trim();
    if (trimmed === '' || fileLines.has(trimmed)) continue;
    return [
      `refused: that text is not in ${path} (${total} lines). Line ${index + 1} of what you sent is`,
      'the one that does not appear anywhere in the file:',
      `    ${trimmed}`,
      'Read the file and copy the text exactly.',
    ].join('\n');
  }

  return [
    `refused: that text is not in ${path} (${total} lines), though its lines each appear`,
    'somewhere. They are probably not in that order or that close together.',
    'Read the file and copy the exact text.',
  ].join('\n');
}

/** What to say when the old text was in the file more than once. */
export function explainAmbiguous(path: string, haystack: string, needle: string, count: number): string {
  const lines = findMatches(haystack, needle);
  const where =
    lines.length === 0
      ? ''
      : lines.length === 1
        ? ` All ${count} of them are on line ${lines[0]}.`
        : ` Lines ${lines.join(', ')}, and possibly more.`;
  return [
    `refused: that text appears ${count} times in ${path}; it has to appear exactly once.${where}`,
    'Include the lines above or below it so it is unambiguous.',
  ].join('\n');
}

/** A short edit distance, for suggesting a filename the model probably meant. */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Up to `limit` names from `candidates` that look like what was asked for. */
export function closestNames(wanted: string, candidates: string[], limit = 3): string[] {
  const stem = (name: string): string => name.replace(/\.[^.]*$/, '').toLowerCase();
  const target = wanted.toLowerCase();
  const scored = candidates
    .map((name) => {
      const lower = name.toLowerCase();
      const base = stem(name);
      let score = distance(target, lower);
      if (lower.startsWith(target) || target.startsWith(base)) score -= 3;
      if (lower.includes(target) || target.includes(base)) score -= 2;
      return { name, score };
    })
    .filter((entry) => entry.score <= Math.max(2, Math.ceil(target.length / 2)))
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((entry) => entry.name);
}
