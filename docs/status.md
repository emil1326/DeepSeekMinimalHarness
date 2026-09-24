# Where the plan got to

`PLAN.md` is the spec, kept as written. This is the honest report against it.

## Milestones

| #   | What                                                                                 | State |
| --- | ------------------------------------------------------------------------------------ | ----- |
| 1   | Scaffold: workspaces, TS strict, eslint, prettier, vitest, one `npm run check`       | done  |
| 2   | The sandbox, ported guard for guard, with realpath, junctions and the lstrip control | done  |
| 3   | DeepSeek client: streaming, tools, abort, backoff, metrics, fake server              | done  |
| 4   | Agent loop in a worker: closed tools, `ask`, queued messages, limits, `finish`       | done  |
| 5   | Daemon: API, header checks, supervisor, SQLite, crash recovery                       | done  |
| 6   | CLI: attach and stream, `--json`, `send`, `reply`, `cancel`, exit codes              | done  |
| 7   | UI: list, chat, config, diff, metrics, reply, message, cancel, live                  | done  |
| 8   | A real run through `dsh` with the UI open, and the speed numbers recorded            | done  |
| 9   | Retire the prototype: README, `legacy/`, note for Claude                             | done  |

## The real run

Done, against the live API, and the numbers are below. This is the part that a
fake server cannot tell you anything about, so it was worth the wait.

**First, the assumptions.** `node tools/smoke.mjs` makes one real streaming call
with a tool on offer and checks the three things everything else depends on.
All three hold: usage arrives, `prompt_cache_hit_tokens` is really spelled that
way and adds up with the miss count to the prompt, and tool calls stream as
`delta.tool_calls` with the arguments reassembling across fragments into valid
JSON. The fake server was not lying.

**Then the task.** The prototype's own first job, redone: give the three
`toPass()` polls in `ui/mark.spec.ts` a deadline of their own. The prototype's
result is commit `3671dac` in that repo, so a fresh worktree was made at its
parent, `134dba5`, to have the work left to do.

It came out the same, arrived at independently: one shared constant holding
8000, a comment explaining that the polls need their own budget, and the three
call sites changed. It named the constant `POLL_MS` where the prototype said
`WAIT`, and wrote the comment in its own words, which is the point of the
exercise rather than a defect.

```
mark-timeouts   finished   4 turns   2,137 out tokens   23 s
typecheck and prettier both pass; one file changed, and it was the allowed one
```

**The speed numbers, as first measured.**

|                               | single smoke call | the 4-turn task |
| ----------------------------- | ----------------- | --------------- |
| time to first token           | 0.94 s            | 2.28 s mean     |
| **generating** (decode only)  | **436 tok/s**     | **930 tok/s**   |
| end to end                    | 44.6 tok/s        | 130 tok/s       |
| cache hit share of the prompt | 0%                | **74%**         |

The plan predicted the generation figure would come out well above the
prototype's end-to-end one, since the prototype could not stream and measured
whole calls. It came out seven times higher. It also came out wrong, and what it
took to find that out is the most useful thing in this document, so the table
stays as it was first written.

## The 930 was a bug, and the reason is worth more than the fix

Emil asked why 930 tokens a second when DeepSeek advertises about 200. He was
right and the number was mine.

`node tools/raw-stream.mjs` prints the shape of the stream rather than the text.
It shows every delta carrying **two** payloads, and the usage reporting what each
cost:

```
delta.content                     857
delta.reasoning_content           857
usage.completion_tokens_details   { reasoning_tokens: 797 of 902 billed }
```

**797 of 902 billed output tokens were the model thinking**, on a channel the
harness was not reading, not showing and not timing. So the numerator was every
output token including the thinking, and the denominator was the arrival span of
only the answer's share of them. A turn whose output was almost entirely
thinking divided a whole response's token count by a few milliseconds of visible
answer: one real tool call did it across **34 ms** and reported **129,799 tokens
a second**.

The correction is three things:

1. **Time every output delta**, thinking and tool arguments included, so the
   window spans what the token count describes.
2. **Refuse to report a decode speed from a window that is not a measurement**:
   under 100 ms, or where a single wait is half the span, which is a burst
   wearing a decode's clothes. Both rules come from the measured evidence above.
3. **Lead with output tokens over the whole call.** That is what a vendor
   advertises and what answers "how long did this take". Decode stays, one click
   in, labelled as decode and often blank.

Re-measured on the same task after the fix: **114.7 tok/s over the whole call**,
against 629 on the old arithmetic. That is consistent with a ~200 tps claim once
the wait for the first token is in the arithmetic, which is the whole point.

**And the real finding is a product bug rather than a metrics one: the harness was
silently discarding the model's thinking.** It is most of the output tokens, most
of the cost, and arguably the most interesting thing to watch an agent do. It now
streams as its own `thinking.delta`, shows as a collapsed block under the turn it
belongs to, has a THOUGHT column in `dsh stats`, and is dim-printed by `dsh run
--thinking`.

One consequence worth knowing: runs recorded before this carry decode figures
computed the old way, and the event log is append-only, so an aggregate across
old and new runs mixes the two.

**What the corrected numbers say about latency, which is the thing that actually
matters.** Over a whole call the model reads far slower than it decodes, and the
difference is the wait for the first token: 0.7 s at best, 2.28 s on average,
5.9 s on the turn with the whole file in its prompt. So a turn costs about a
second before a single token exists, whatever the tools cost.

Which makes the lever **the number of turns, not the speed of a tool call**. The
first run took four turns and three of them paid a fresh first-token wait. That
is what the diagnostics in `diagnose.ts` are for: a `replace_in_file` that names
the line it could not find is a turn not spent, and a turn not spent is a second
of first-token wait not paid. The syscall work is real and it is measured in
milliseconds against a second.

Worth knowing too: **74% of the prompt came from DeepSeek's cache** across the
run, and 97% on the last two calls. The context is re-sent every turn and the
cache is what makes that affordable.

Cost is worked out from DeepSeek's published prices, which are in the code, and
which `config.json` overrides per model. The cache rate is why the figure is
small: a hit is a fiftieth of a miss on Flash, and most of what a run sends is
hits.

## Where this went past the plan

- **`ask` and the message queue both exist and are tested end to end**, including
  a CLI test that answers a question from a second process while the first one is
  still streaming.
- **The metrics event carries its turn number**, so the UI folds each call's
  numbers into that turn instead of printing a line per turn.
- **`DSH_SMOKE`, `DSH_DATA_DIR`, `DSH_KEY_FILE` and `DSH_BASE_URL`** exist so
  tests and the preview can run without touching the real key or the real
  database. `DSH_DATA_DIR` is the only one that changes where the harness keeps
  its files, and it exists for the test suite: there is one install and one
  history, and no supported way to have a second.
- **`tools/preview.mjs`** is not in the plan. It was worth having: it gave a
  scripted six-turn run to look at while doing the UI.
- **`tools/smoke.mjs`** is not in the plan either. It is the one thing that
  checks the harness's assumptions about the real API rather than the fake
  server's, in a single call, and it is the reason milestone 8 was not a
  debugging session.
- **`tasks/mark-timeouts.json`** is the first real task, kept as a working
  example of a task file.
- **Refusals explain themselves** (`diagnose.ts`), which the plan did not ask
  for. The real-run numbers are what justify it: a turn costs about a second of
  first-token wait, and a refusal that says why is a turn not spent.
- **The UI is denser than the plan's "dense, calm" suggests** after a pass on it,
  because the first version buried the conversation under its own numbers.

## Three things the plan asked for that are now gone on purpose

Each was built, used, and then removed because it cost more than it bought. They
are recorded here rather than left out, because "the plan said so" is not a reason
to keep something and the reasoning is the part worth keeping.

- **The token, and the login that existed to protect it.** The plan puts "every
  request needs the token" in the daemon's section, and it was implemented — bearer
  header, session cookie, one-time ticket. It went, because it was written to
  `daemon.json` in plain text where every process that could plausibly be the
  attacker could read it, and because it made the URL unbookmarkable and every
  restart a logout. `guard.ts` keeps the part that was load-bearing: `Host` against
  DNS rebinding, and `Origin` plus `Sec-Fetch-Site` against a web page. The
  security reasoning is in `docs/api.md` and `docs/containementTests/D-secrets.md`,
  including what got weaker.
- **The random port.** The plan says "on a random free port", and it was. A port is
  a machine-wide resource and the URL is a thing a person keeps open, so it is now
  `41777` unless `config.json` says otherwise. Conflicts are refused loudly rather
  than silently moved away from.
- **The "homes".** Never in the plan, and they accumulated: a `-dev` directory, one
  per agent, `--home X`, `DSH_HOME`, and a default that depended on which one it
  was. Four ways to have a second database, and the result was 67 runs missing from
  the history until they were merged back. One directory now.

## Deliberate deviations

- **`node:http` rather than `fastify`.** The route table is small and the plan's
  list of things to check by hand (Host, Origin, Sec-Fetch-Site) is clearer
  written directly against the request than configured through a framework.
- **`better-sqlite3` rather than the built-in `node:sqlite`.** Node 22's is
  still flagged experimental and prints a warning on every start.
- **Vite 8, Vitest 5, plugin-react 6.** The first pairing (Vite 6 with Vitest 2)
  put two copies of Vite in the tree, which broke typechecking on the UI config,
  and the older Vite carried a dev-server advisory. One generation, no advisory.
- **`.cmd` shims are started through `cmd.exe`** with every argument validated,
  because Windows cannot start an npm shim directly. Everything else uses no
  shell at all.
- **The UI's palette is Emil's own site**, not an invented one: same surfaces,
  `#0d6efd`, same radii, same system font stack.

## Known limits

- **The sandbox reads are synchronous**, so the loop's batching of read-only
  calls cannot actually overlap them: `Promise.all` over synchronous work on one
  thread is sequential. It is kept because it is correct and costs nothing, and
  because the ordering rule it encodes is load-bearing and tested. Making the
  reads asynchronous is what would overlap them, and the measured prize is
  milliseconds against a one-second first-token wait, so it is written down
  rather than done.
- **Cost comes from DeepSeek's published prices**, in `core/pricing.ts`: cache
  hit, cache miss and output, at peak and off peak, read per call from the hour
  that call was made. `config.json` overrides any model outright, so a price
  change or a new model does not wait for a release. Chinese public holidays are
  not modelled, so a call in a peak window on one of those days is priced at
  double what it really cost — the estimate is wrong upward, which is the
  direction that keeps a budget a budget.
- **The event log is append-only and never pruned.** Fine at this scale, and a
  thing to know about before it runs for months.
- **`dsh` assumes Node 22 or later.**
- **Tests are the reviewer's job**, per the plan: the harness runs static checks
  only and never runs the code the model wrote. The real run above passed
  `typecheck` and `prettier`, and the `mark.spec.ts` suite it touches was not
  run, because running it needs the app built and that is a human decision.
- **The browser-driven end-to-end path was exercised against a fake model** (the
  preview script) and against the real one only through `dsh run`, which is the
  same code path.
