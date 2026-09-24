/**
 * See the UI with a run in it, without spending a token.
 *
 *   node tools/preview.mjs [--keep]
 *
 * Builds a throwaway worktree and profile in a temp folder, points a private
 * daemon at a fake DeepSeek that plays a scripted six-turn run, and prints the
 * URL to open. The fake model streams text and calls tools, so the chat view,
 * the folded tool calls, the check output and the speed numbers all fill in.
 *
 * Everything lives in that temp folder; nothing here touches the real
 * %LOCALAPPDATA%/EmilsDeepSeekHarness or the real key.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const keep = process.argv.includes('--keep');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-'));

// --- a repo with something in it -----------------------------------------

const repo = path.join(home, 'esap-ds-1');
fs.mkdirSync(path.join(repo, 'ui'), { recursive: true });
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(
  path.join(repo, 'ui', 'mark.spec.ts'),
  [
    "import { expect, test } from '@playwright/test';",
    "import { openBoard } from './helpers';",
    '',
    "test('marks land on the board', async ({ page }) => {",
    '  await openBoard(page);',
    '',
    '  await expect(page.getByTestId("mark-dot")).toBeVisible();',
    '  await expect(page.getByTestId("mark-count")).toHaveText("0");',
    '  await expect(page.getByTestId("mark-label")).toHaveText("none");',
    '});',
    '',
  ].join('\n'),
);
fs.writeFileSync(path.join(repo, 'src', 'marks.ts'), 'export const marks: string[] = [];\n');
const git = (args) =>
  execFileSync('git', ['-c', 'user.name=preview', '-c', 'user.email=preview@example.invalid', ...args], {
    cwd: repo,
    stdio: 'ignore',
  });
git(['init', '-q']);
git(['add', '-A']);
git(['commit', '-q', '-m', 'start']);

const profile = path.join(home, 'esap.json');
fs.writeFileSync(
  profile,
  JSON.stringify(
    {
      description: 'Emil’s Super App Planner: a TypeScript front end and a Rust workspace.',
      checks: {
        typecheck: { run: [process.execPath, '-e', "console.log('tsc: no errors')"] },
        prettier: {
          when: ['.ts', '.tsx', '.md', '.json', '.css'],
          run: [process.execPath, '-e', "console.log('All matched files use Prettier code style!')"],
        },
      },
      format: [
        {
          when: ['.ts', '.tsx', '.md', '.json', '.css'],
          run: [process.execPath, '-e', "console.log('formatted')"],
        },
      ],
    },
    null,
    2,
  ),
);

const taskFile = path.join(home, 'mark-timeouts.json');
fs.writeFileSync(
  taskFile,
  JSON.stringify(
    {
      name: 'mark-timeouts',
      worktree: repo,
      profile,
      model: 'deepseek-flash',
      allow: ['ui/mark.spec.ts'],
      checks: ['typecheck', 'prettier'],
      task:
        'Give the three polls in ui/mark.spec.ts a timeout of their own, so a slow board does not make them flaky. ' +
        'Keep the assertions exactly as they are, and match the style already in the file.',
      limits: { turns: 12, wallSeconds: 900, outputTokens: 40000 },
    },
    null,
    2,
  ),
);

// --- a fake DeepSeek that plays a scripted run ----------------------------

const TURNS = [
  {
    text: 'I’ll look at the spec first, then the helper it leans on.',
    toolCalls: [{ name: 'read_file', args: { path: 'ui/mark.spec.ts' } }],
  },
  {
    text: 'Three polls, all with the default timeout. Let me search for the pattern elsewhere in the repo.',
    toolCalls: [{ name: 'search', args: { pattern: 'toBeVisible\\(', path: 'ui' } }],
  },
  {
    text: 'No other call sites, so the fix stays local to this file.',
    toolCalls: [{ name: 'list_dir', args: { path: 'ui' } }],
  },
  {
    toolCalls: [
      {
        name: 'replace_in_file',
        args: {
          path: 'ui/mark.spec.ts',
          old: '  await expect(page.getByTestId("mark-dot")).toBeVisible();',
          new: '  await expect(page.getByTestId("mark-dot")).toBeVisible({ timeout: 5_000 });',
        },
      },
      {
        name: 'replace_in_file',
        args: {
          path: 'ui/mark.spec.ts',
          old: '  await expect(page.getByTestId("mark-count")).toHaveText("0");',
          new: '  await expect(page.getByTestId("mark-count")).toHaveText("0", { timeout: 5_000 });',
        },
      },
    ],
  },
  {
    text: 'Now the checks.',
    toolCalls: [
      { name: 'run_check', args: { name: 'prettier' } },
      { name: 'run_check', args: { name: 'typecheck' } },
    ],
  },
  {
    text: 'Prettier and the typechecker are both happy, so this is done.',
    toolCalls: [
      {
        name: 'finish',
        args: {
          summary:
            'Gave the three polls in ui/mark.spec.ts a 5s timeout each. typecheck and prettier pass, and no other file changed.',
        },
      },
    ],
  },
];

let served = 0;
const fake = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const turn = TURNS[Math.min(served, TURNS.length - 1)];
    served += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    const delta = (value) => send({ choices: [{ index: 0, delta: value, finish_reason: null }] });

    let clock = 250;
    const at = (fn) => setTimeout(fn, (clock += 45));
    for (const piece of (turn.text ?? '').match(/[\s\S]{1,12}/g) ?? []) at(() => delta({ content: piece }));
    (turn.toolCalls ?? []).forEach((call, index) => {
      at(() =>
        delta({
          tool_calls: [
            { index, id: `call_${served}_${index}`, type: 'function', function: { name: call.name } },
          ],
        }),
      );
      at(() => delta({ tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }] }));
    });
    at(() => {
      const prompt = 1800 + served * 900;
      const completion = Math.round(60 + (turn.text?.length ?? 0) / 4);
      send({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
          prompt_cache_hit_tokens: Math.round(prompt * 0.6),
          prompt_cache_miss_tokens: Math.round(prompt * 0.4),
        },
      });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
});
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

// --- a private daemon -----------------------------------------------------

const keyFile = path.join(home, 'api_key');
fs.writeFileSync(keyFile, 'preview-key-never-real\n');
// Port 0: this preview daemon runs beside the real one, and the port it should
// use is a fact it states in its own `config.json` rather than something the
// daemon guesses from where the file lives.
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ prices: {}, port: 0 }));

const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_KEY_FILE: keyFile,
  DSH_BASE_URL: fakeUrl,
};
const daemon = fork(path.join(here, 'packages', 'daemon', 'dist', 'main.js'), [], { env, stdio: 'ignore' });

const daemonFile = path.join(home, 'daemon.json');
for (let tries = 0; tries < 100 && !fs.existsSync(daemonFile); tries += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!fs.existsSync(daemonFile)) {
  console.error('the daemon never came up');
  process.exit(1);
}
const { port } = JSON.parse(fs.readFileSync(daemonFile, 'utf8'));

const post = (route, body) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((response) => response.json());

const created = await post('/runs', { taskPath: taskFile, detached: true });
console.log(`\n  a run is going: ${created.id}`);
console.log(`  open this:  http://127.0.0.1:${port}/\n`);
console.log(`  (temp folder: ${home}${keep ? ', kept' : ''})`);
console.log('  ctrl-c to stop\n');

const stop = () => {
  daemon.kill();
  fake.close();
  if (!keep) fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
