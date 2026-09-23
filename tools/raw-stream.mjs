/**
 * What is actually in the stream?
 *
 *     node tools/raw-stream.mjs
 *
 * Prints the shape of the deepseek-flash stream rather than the text: which
 * fields each delta carries, how many deltas there are, and whether the API's
 * billed token count lines up with the text a reader can see. This is the check
 * behind the note in docs/status.md about hidden tokens, and it is why the
 * harness's own speed metric was wrong.
 */

import { readApiKey, DEFAULT_BASE_URL } from '../packages/core/dist/index.js';

const model = process.env.DSH_SMOKE_MODEL ?? 'deepseek-flash';
const baseUrl = process.env.DSH_BASE_URL ?? DEFAULT_BASE_URL;
const key = readApiKey();

async function dump(label, body) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, ...body, stream: true, stream_options: { include_usage: true } }),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const fieldCounts = new Map();
  const finishReasons = new Set();
  let usage = null;
  let contentChars = 0;
  let reasoningChars = 0;
  let argumentChars = 0;
  let deltas = 0;
  let usages = 0;

  const handle = (payload) => {
    if (payload === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk.usage) {
      usage = chunk.usage;
      usages += 1;
      for (const field of Object.keys(chunk.usage)) {
        fieldCounts.set(`usage.${field}`, (fieldCounts.get(`usage.${field}`) ?? 0) + 1);
      }
      console.log(`  usage detail object: ${JSON.stringify(chunk.usage)}`);
    }
    const choice = chunk.choices?.[0];
    if (choice === undefined) return;
    if (choice.finish_reason) finishReasons.add(choice.finish_reason);
    const delta = choice.delta;
    if (delta === undefined) return;
    deltas += 1;
    for (const field of Object.keys(delta)) {
      fieldCounts.set(`delta.${field}`, (fieldCounts.get(`delta.${field}`) ?? 0) + 1);
    }
    if (typeof delta.content === 'string') contentChars += delta.content.length;
    if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length;
    for (const call of delta.tool_calls ?? []) {
      if (typeof call.function?.arguments === 'string') argumentChars += call.function.arguments.length;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line.startsWith('data:')) handle(line.slice(5).trim());
      at = buffer.indexOf('\n');
    }
  }

  console.log(`\n=== ${label} ===`);
  console.log(
    `deltas: ${deltas}, chunks carrying usage: ${usages}, finish reasons: ${[...finishReasons].join(', ') || '(none)'}`,
  );
  console.log('fields seen:');
  for (const [field, count] of [...fieldCounts.entries()].sort()) {
    console.log(`  ${field.padEnd(34)} ${count}`);
  }
  console.log(`visible content chars:    ${contentChars}`);
  if (reasoningChars > 0) console.log(`reasoning content chars:  ${reasoningChars}`);
  if (argumentChars > 0) console.log(`tool argument chars:      ${argumentChars}`);
  if (usage) {
    const visible = contentChars + reasoningChars + argumentChars;
    console.log(`billed completion_tokens: ${usage.completion_tokens}`);
    console.log(`chars per billed token:   ${(visible / Math.max(1, usage.completion_tokens)).toFixed(2)}`);
    console.log(
      `prompt_tokens: ${usage.prompt_tokens}, cache hit ${usage.prompt_cache_hit_tokens}, miss ${usage.prompt_cache_miss_tokens}`,
    );
  }
}

await dump('plain prose', {
  messages: [
    { role: 'user', content: 'Write about 80 words of plain prose about the sea. No lists or headings.' },
  ],
});

await dump('a tool call', {
  messages: [
    {
      role: 'user',
      content:
        'Call write_file once with path "src/sum.ts" and content set to a 25 line TypeScript file exporting an add function.',
    },
  ],
  tools: [
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
});
