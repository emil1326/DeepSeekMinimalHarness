/**
 * What is the real generation speed, and is my metric telling the truth?
 *
 *     node tools/tps.mjs
 *
 * The harness reported 1137 tokens/s on a turn, which is several times what
 * DeepSeek advertises. Two suspects, and this measures both by logging every
 * delta that arrives with its own timestamp.
 *
 *   Suspect 1: the window. `generationTokensPerSecond` is
 *   completion_tokens / (last delta - first delta). If the answer arrives in a
 *   couple of bursts rather than steadily, that window is the time to parse the
 *   bursts, not the time the model spent decoding, and dividing a whole
 *   response's token count by it invents a speed.
 *
 *   Suspect 2: chunks are not tokens. It counts the tokens the API says it
 *   generated, but a chunk can carry several tokens, so if the window is
 *   measured in chunks the two do not line up.
 *
 * A long prose answer is asked for, so decode dominates and the arrival pattern
 * is visible, then a tool call, which is where the bursts showed up.
 */

import { DeepSeekClient, readApiKey, DEFAULT_BASE_URL } from '../packages/core/dist/index.js';

const model = process.env.DSH_SMOKE_MODEL ?? 'deepseek-flash';
const baseUrl = process.env.DSH_BASE_URL ?? DEFAULT_BASE_URL;
const client = new DeepSeekClient({ apiKey: readApiKey(), baseUrl });

/** One call, logging every delta so the arrival pattern is visible. */
async function probe(label, messages, tools) {
  const arrivals = [];
  const started = performance.now();
  const outcome = await client.stream({
    model,
    messages,
    ...(tools ? { tools } : {}),
    onText: (text) => arrivals.push({ at: performance.now() - started, chars: text.length }),
  });
  const finished = performance.now() - started;
  const usage = outcome.usage;
  const metrics = outcome.metrics;

  const first = arrivals[0]?.at ?? 0;
  const last = arrivals[arrivals.length - 1]?.at ?? 0;
  const window = last - first;
  const chars = arrivals.reduce((total, item) => total + item.chars, 0);

  // The gaps between arrivals. A response that streams steadily has many small
  // gaps; one that arrives in bursts has a few tiny gaps and a few huge ones.
  const gaps = arrivals.slice(1).map((item, index) => item.at - (arrivals[index]?.at ?? 0));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const biggest = sorted[sorted.length - 1] ?? 0;
  // How much of the window is spent inside the largest single gap. If one gap
  // is most of the window, the window is one wait, not a decode.
  const largestShare = window === 0 ? 1 : biggest / window;

  const toolCalls = outcome.message.tool_calls ?? [];

  console.log(`\n=== ${label} ===`);
  console.log(`  deltas              : ${arrivals.length}`);
  console.log(`  chars streamed      : ${chars}`);
  console.log(`  completion_tokens   : ${usage.completion_tokens}   (what the API billed)`);
  console.log(`  chars per token     : ${(chars / Math.max(1, usage.completion_tokens)).toFixed(2)}`);
  console.log(
    `  deltas per 100 tok  : ${((arrivals.length / Math.max(1, usage.completion_tokens)) * 100).toFixed(1)}`,
  );
  console.log('');
  console.log(`  first delta         : ${first.toFixed(0)} ms`);
  console.log(`  last delta          : ${last.toFixed(0)} ms`);
  console.log(`  whole call          : ${finished.toFixed(0)} ms`);
  console.log(`  window (last-first) : ${window.toFixed(0)} ms`);
  console.log('');
  console.log(`  median gap          : ${median.toFixed(0)} ms`);
  console.log(
    `  largest gap         : ${biggest.toFixed(0)} ms   (${(largestShare * 100).toFixed(0)}% of the window)`,
  );
  console.log('');
  console.log(
    `  MY METRIC  tokens/window        : ${((usage.completion_tokens / Math.max(1, window)) * 1000).toFixed(0)} tok/s`,
  );
  console.log(
    `  honest     tokens/whole call    : ${((usage.completion_tokens / Math.max(1, finished)) * 1000).toFixed(0)} tok/s`,
  );
  console.log(
    `  chars/window                    : ${((chars / Math.max(1, window)) * 1000).toFixed(0)} chars/s`,
  );
  console.log(
    `  chars/whole call                : ${((chars / Math.max(1, finished)) * 1000).toFixed(0)} chars/s`,
  );
  if (toolCalls.length > 0) {
    console.log(`  tool calls          : ${toolCalls.map((call) => call.function.name).join(', ')}`);
  }
  console.log(
    `  the harness said    : ${metrics.generationTokensPerSecond} tok/s generating, ${metrics.endToEndTokensPerSecond} end to end`,
  );

  // The first ten arrivals, so the shape at the start is visible.
  console.log(
    `  first arrivals (ms, chars): ${arrivals
      .slice(0, 10)
      .map((a) => `${a.at.toFixed(0)}/${a.chars}`)
      .join(' ')}`,
  );
  return { arrivals, usage, window, finished, chars };
}

// Prose, so decode dominates and there is nothing to burst.
await probe('a long prose answer', [
  { role: 'system', content: 'You answer at length and in plain prose.' },
  {
    role: 'user',
    content:
      'Write about 300 words explaining, for a programmer who has never used one, how a streaming HTTP response is turned into a sequence of tokens by a client. No lists, no headings, prose only.',
  },
]);

// The case that produced the impossible number: tool-call arguments.
await probe(
  'a tool call with a large argument',
  [
    {
      role: 'user',
      content:
        'Call write_file once, with path "src/example.ts", and content set to a 40 line TypeScript file that exports a function adding two numbers, with a short comment above it.',
    },
  ],
  [
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
  ],
);

console.log('\ndone. Nothing above was written anywhere; the tool was described, not run.');
