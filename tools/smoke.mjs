/**
 * Does the real API match what the harness assumes?
 *
 *     node tools/smoke.mjs
 *
 * Everything else in the suite runs against a fake server, which asserts what I
 * believe DeepSeek does rather than what it does. Three assumptions hold up the
 * whole design and none of them has been checked against the real thing:
 *
 *   1. usage arrives at all, and `prompt_cache_hit_tokens` is really spelled
 *      that way. If the field is named something else, every cache number in
 *      the UI is a silent zero.
 *   2. tool calls stream as `delta.tool_calls`, with an `index` that is stable
 *      across the fragments of one call. If it is not, ids and arguments get
 *      crossed and the loop calls the wrong tool.
 *   3. `stream_options: { include_usage: true }` produces a final chunk with
 *      usage on it. Without it there are no tokens to count and no speed.
 *
 * It makes one call with a tool on offer and asks for it to be used, so all
 * three are exercised at once. The key is read, never printed, and nothing here
 * touches a worktree: the tool is never executed, only described.
 */

import { DeepSeekClient, readApiKey, DEFAULT_BASE_URL, toolSpecs } from '../packages/core/dist/index.js';

const model = process.env.DSH_SMOKE_MODEL ?? 'deepseek-flash';
const baseUrl = process.env.DSH_BASE_URL ?? DEFAULT_BASE_URL;

const key = readApiKey();
console.log(`key:      ${key.length} characters, from ~/.deepseek/api_key (not printed)`);
console.log(`endpoint: ${baseUrl}`);
console.log(`model:    ${model}`);
console.log('');

const client = new DeepSeekClient({ apiKey: key, baseUrl });

const tools = toolSpecs(['typecheck']).filter((tool) => tool.function.name === 'read_file');
const deltas = [];
let firstSeen = null;

console.log('one streaming call, with read_file on offer...');
const started = Date.now();
const outcome = await client.stream({
  model,
  messages: [
    { role: 'system', content: 'You are a careful coding agent.' },
    {
      role: 'user',
      content: 'Read the file src/greeting.ts, then reply with one short sentence about what it contains.',
    },
  ],
  tools,
  onText: (text) => {
    if (firstSeen === null) firstSeen = Date.now() - started;
    deltas.push(text);
  },
});

const usage = outcome.usage;
const metrics = outcome.metrics;
const calls = outcome.message.tool_calls ?? [];

const check = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`);
  return ok;
};

console.log('');
let allOk = true;

allOk = check('streamed text arrived in pieces', deltas.length > 1, `${deltas.length} deltas`) && allOk;

allOk =
  check(
    'usage came back on the stream',
    usage.prompt_tokens > 0 || usage.completion_tokens > 0,
    `${usage.prompt_tokens} in / ${usage.completion_tokens} out`,
  ) && allOk;

allOk =
  check(
    'prompt_cache_hit_tokens is a real field',
    usage.prompt_cache_hit_tokens >= 0 && usage.prompt_cache_miss_tokens >= 0,
    `hit ${usage.prompt_cache_hit_tokens} / miss ${usage.prompt_cache_miss_tokens}`,
  ) && allOk;

allOk =
  check(
    'cache hit + miss adds up to the prompt',
    usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens === usage.prompt_tokens,
    `${usage.prompt_cache_hit_tokens} + ${usage.prompt_cache_miss_tokens} = ${usage.prompt_tokens}`,
  ) && allOk;

allOk =
  check(
    'tool calls streamed with an id and a name',
    calls.length > 0 && calls[0].id !== '' && calls[0].function.name !== '',
    calls.length === 0
      ? `none: the model answered in prose, try again or change the prompt`
      : `${calls.map((call) => call.function.name).join(', ')}`,
  ) && allOk;

if (calls.length > 0) {
  let args = null;
  try {
    args = JSON.parse(calls[0].function.arguments);
  } catch (error) {
    allOk = check('tool arguments are valid JSON', false, error.message) && allOk;
  }
  if (args !== null) {
    allOk =
      check('arguments reassembled across fragments', typeof args === 'object', JSON.stringify(args)) &&
      allOk;
  }
}

allOk =
  check(
    'a first token time was measured',
    metrics.timeToFirstTokenMs !== null,
    `${metrics.timeToFirstTokenMs} ms`,
  ) && allOk;

allOk =
  check(
    'a generation speed came out of it',
    metrics.generationTokensPerSecond !== null,
    `${metrics.generationTokensPerSecond} tok/s generating, ${metrics.endToEndTokensPerSecond} end to end`,
  ) && allOk;

console.log('');
console.log('--- what that means for the UI numbers ---');
console.log(`  time to first token : ${(metrics.timeToFirstTokenMs ?? 0) / 1000} s`);
console.log(`  generating          : ${metrics.generationTokensPerSecond} tokens/s   (decode only)`);
console.log(
  `  end to end          : ${metrics.endToEndTokensPerSecond} tokens/s   (prompt + network + decode)`,
);
console.log(
  `  cache               : ${
    usage.prompt_tokens === 0 ? '-' : Math.round((usage.prompt_cache_hit_tokens / usage.prompt_tokens) * 100)
  }% of the prompt`,
);
console.log(`  wall clock          : ${(Date.now() - started) / 1000} s`);
console.log('');
console.log(
  allOk
    ? 'all three assumptions hold on the real API.'
    : 'SOMETHING ABOVE FAILED: the fake server is lying about the real API, and the tests are wrong.',
);
process.exit(allOk ? 0 : 1);
