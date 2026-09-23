/**
 * What is the real context limit, and what does the API say when you pass it?
 *
 *     node tools/context-limit.mjs
 *
 * A run has no context management at all: the message list grows every turn and
 * every turn re-sends all of it. So the first question is the actual ceiling,
 * and the second is what a run sees when it hits it. A rejection costs nothing,
 * because it is refused before anything is generated.
 *
 * The filler is repeated prose, which tokenises at roughly the usual rate for
 * English. It is deliberately not `AAAA...`, which tokenises far better and would
 * make the estimate wrong in the unsafe direction.
 */

import { readApiKey, DEFAULT_BASE_URL } from '../packages/core/dist/index.js';

const model = process.env.DSH_SMOKE_MODEL ?? 'deepseek-flash';
const baseUrl = process.env.DSH_BASE_URL ?? DEFAULT_BASE_URL;
const key = readApiKey();

/** A sentence of ordinary English, about 11 tokens by the usual 4-chars rule. */
const SENTENCE =
  'The board keeps a record of every change, so a person can see who moved what and when they did it. ';

/** Ask for `tokens` worth of prompt and report exactly what comes back. */
async function ask(tokens) {
  const repeats = Math.ceil((tokens * 4) / SENTENCE.length);
  const filler = SENTENCE.repeat(repeats);
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You answer with one word.' },
      { role: 'user', content: `${filler}\n\nIgnore all of that. Reply with the single word: ready` },
    ],
    max_tokens: 4,
    stream: false,
  };

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // A prompt this big takes a while to process, and a rejection is quick.
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    return { asked: tokens, outcome: `request failed: ${error.message}`, ms: Date.now() - started };
  }

  const text = await response.text();
  return {
    asked: tokens,
    status: response.status,
    body: text.slice(0, 600),
    ms: Date.now() - started,
  };
}

console.log(`model:    ${model}`);
console.log('probing, from a size that must work up to one that must not.');
console.log('a rejection is free: nothing is generated.\n');

// Ascending, and it stops at the first rejection. The limit is between the last
// accepted size and that one. Emil asked about a million specifically, so this
// goes there. Each accepted size is billed as prompt tokens, which is why it
// steps in big jumps rather than bisecting.
const sizes = [
  1_000, 16_000, 32_000, 64_000, 100_000, 120_000, 131_072, 200_000, 300_000, 1_000_000, 1_500_000,
];
let ceiling = null;

for (const size of sizes) {
  const result = await ask(size);
  if (result.status === undefined) {
    console.log(`  ~${size.toLocaleString()} tokens  ${result.outcome}`);
    break;
  }
  if (result.status === 200) {
    console.log(`  ~${size.toLocaleString()} tokens  accepted  (${result.ms} ms, genuine work done)`);
    ceiling = size;
    continue;
  }
  console.log(`  ~${size.toLocaleString()} tokens  REFUSED ${result.status}  (${result.ms} ms)`);
  console.log(`\n  what the API says:\n`);
  console.log(`    ${result.body.replace(/\s+/g, ' ').slice(0, 400)}`);
  break;
}

console.log('');
console.log(
  ceiling === null
    ? 'not even the smallest prompt was accepted; the probe itself is wrong.'
    : `accepted at ~${ceiling.toLocaleString()} tokens, so the ceiling is above that.`,
);
console.log('\nwhat this means for the harness: a run has no context management, so the');
console.log('message list grows until the API refuses it, and then the run fails.');
