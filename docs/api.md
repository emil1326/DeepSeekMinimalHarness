# The daemon's API

Plain JSON over HTTP on `127.0.0.1`, plus three WebSockets. No credentials:
no token, no cookie, no login. The CLI sends nothing, and neither does the page.

Three checks run before anything else on every request and every upgrade:

- the `Host` header must be `127.0.0.1:<port>`, `localhost:<port>`, or a name from
  `uiHosts` in `config.json`
- an `Origin`, if present, must be the daemon's own — and `null` counts as foreign
- `Sec-Fetch-Site`, if present, must be `same-origin` or `none`

A request carrying none of them — the CLI, `curl`, the Vite dev proxy — is
allowed through. Those are programs running as this user, and a secret cannot
defend a resource from a caller that can read the secret: this one was written to
`daemon.json` in plain text, readable by every process it could plausibly have
been protecting against, and the API key at `~/.deepseek/api_key` is readable by
the same callers anyway.

The threat that is left, and the only one these checks answer, is a **web page**.
A localhost server is reachable from any page the browser has open, so without
them a random site could POST `/runs/:id/cancel` — a route that takes no body — or
start a run that spends money and writes files. `Host` closes DNS rebinding,
`Origin` closes a cross-origin `fetch` and every form POST, and `Sec-Fetch-Site`
is the one a page cannot forge, because browsers set it and forbid JavaScript
from writing it. See `packages/daemon/src/guard.ts`.

## HTTP

| Method | Route                      | Body                      | Returns                                          |
| ------ | -------------------------- | ------------------------- | ------------------------------------------------ |
| `GET`  | `/health`                  |                           | `{ ok, pid, port }`                              |
| `POST` | `/runs`                    | `{ taskPath, detached? }` | `201 { id, detail }`, or `400` with `problems[]` |
| `GET`  | `/runs`                    |                           | `{ runs: RunSummary[] }`, newest first           |
| `GET`  | `/runs/:id`                |                           | `RunDetail`, or `404`                            |
| `GET`  | `/runs/:id/events?after=n` |                           | `{ events: RunEvent[] }` with `seq > n`          |
| `GET`  | `/runs/:id/diff`           |                           | `{ diff, stray[] }`                              |
| `POST` | `/runs/:id/messages`       | `{ text, by? }`           | `{ ok }`                                         |
| `POST` | `/runs/:id/answers`        | `{ id?, text, by? }`      | `{ ok, id }`, or `409` when it is not waiting    |
| `POST` | `/runs/:id/cancel`         |                           | `{ ok }`                                         |
| `GET`  | `/stats`                   |                           | `{ runs, models: ModelStats[] }`                 |
| `GET`  | `/runs/:id/timings`        |                           | `{ runId, wallMs, at, entries[] }`               |
| `GET`  | `/timings`                 |                           | `{ runs, wallMs, entries[], process[] }`         |
| `POST` | `/daemon/stop`             |                           | `{ ok }`, then it stops                          |
| `GET`  | `/` and `/assets/*`        |                           | the built UI                                     |

`by` is `claude`, `emil` or `agent`, and only decides the label in the UI. An
answer with no `id` goes to the question the run is currently waiting on.

`/stats` groups by model **and by measurement method**, and that is deliberate.
The speed figures were computed wrongly once, and those rows are still in
`runs.db` because nothing rewrites recorded history. Averaging them with correct
ones would produce a figure describing neither, and it would get worse as more
rows accumulated. So a model run under two methods gets two `ModelStats`, each
carrying `metricsVersion`, and a reader can compare within a row and not across
them. Tokens and cost are comparable between methods and are still summed per
row. `METRICS_VERSION` in core is the current one; a stored call with no version
on it is v1's method, which is a fact about it rather than a guess.

A bad task file comes back as `400` with every problem at once, each naming the
field:

```json
{
  "error": "the task file is not valid",
  "problems": [
    { "path": "worktree", "message": "Required", "file": "F:/tasks/mark-timeouts.json" },
    {
      "path": "checks.2",
      "message": "the profile has no check called lint",
      "file": "F:/tasks/mark-timeouts.json"
    }
  ]
}
```

### Timings

What the harness itself spent, as opposed to what the model spent. The worker
measures every call site under a dotted name (`core.sandbox.readFile`,
`worker.tool.read_file`), and hands the readings to the daemon once per turn and
once more before it reports itself done, so a run that is killed still reports
the turns it managed.

Each entry is `{ name, count, totalMs, minMs, maxMs, bytes, histogram }`. The
histogram is a fixed 24-bucket ladder rather than a list of samples, for two
reasons: it is 24 numbers per name however often the name was hit, and two of
them add, so `/timings` can merge every run exactly and answer a real p95 of all
of them. `bytes` is the work the call handled when it has a unit, which is what
makes milliseconds per megabyte askable.

The daemon **replaces** a run's rows on every flush rather than appending: the
readings are cumulative for the worker's whole life, so appending would double
every count as the run went on.

`/timings` returns two lists. `entries` is the runs' readings, merged by name.
`process` is the daemon's own, since it started: not added to `entries`, because
a daemon outlives hundreds of runs and mixing its uptime into their runtime would
make both numbers meaningless. `wallMs` is the sum of every run's duration, which
is the denominator a share needs.

## WebSockets

There are three. None takes credentials; all three pass the same checks over the
upgrade request as the HTTP routes do, because a socket is not a lesser door —
closing the last owner's connection is what cancels a run.

**`WS /runs/:id/attach`** streams one run and owns it. The daemon pings every
5 s and cancels the run after 15 s with no pong, so a half-open connection (a
process killed hard, a closed terminal) still ends the agent inside the second.
If more than one client attaches, the run ends when the last one goes.

**`WS /runs/:id/watch`** is the same stream without the ownership. It sees every
event and a `bye` at the end, and it can neither start a run nor cancel one. This
is what `dsh watch` uses, so a second terminal can follow a run without being able
to end it.

**`WS /events`** is a nudge channel for the UI: a message per change, and the UI
fetches what changed.

| Message                             | Meaning                               |
| ----------------------------------- | ------------------------------------- |
| `{ type: 'hello', detail, events }` | on connect, with the whole log so far |
| `{ type: 'event', event }`          | one new event                         |
| `{ type: 'bye', status }`           | the run reached a terminal status     |

**`WS /events`** is a nudge channel for the UI. Every event on every run, and
every status change, sends `{ type: 'notice', runId }`. The payload is not
included: the UI batches these for 250 ms and then refetches what changed, so a
streaming run does not push a hundred messages a second.

## Events

One append-only list per run, numbered by `seq`, and the only copy of the truth.
The chat view, the CLI stream, `dsh logs` and a resume after a restart are all
readers of it.

```ts
type RunEvent = { seq: number; runId: string; at: string } & (
  | { type: 'status'; status: RunStatus; detail?: string }
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; turn: number; text: string }
  | { type: 'thinking.delta'; turn: number; text: string }
  | { type: 'tool.call'; turn: number; id: string; name: string; args: unknown }
  | { type: 'tool.result'; turn: number; id: string; name: string; ok: boolean; result: string }
  | { type: 'question'; id: string; question: string }
  | { type: 'answer'; id: string; answer: string; by: Speaker }
  | { type: 'message'; by: Speaker; text: string }
  | { type: 'metrics'; turn: number; call: CallMetrics; totals: RunTotals }
  | { type: 'summary'; text: string }
  | { type: 'retry'; turn: number; attempt: number; status: number; waitMs: number }
  | {
      type: 'context';
      turn: number;
      dropped: number;
      subjects: string[];
      tokensBefore: number;
      tokensAfter: number;
    }
  | {
      type: 'limit';
      which:
        'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens' | 'contextTokens' | 'askSeconds' | 'costUsd';
      detail: string;
      /** What it got to, of what. Never a bare number. */
      used: number;
      budget: number;
    }
  | {
      type: 'warning';
      which: 'turns' | 'wallSeconds' | 'outputTokens' | 'totalTokens' | 'contextTokens' | 'costUsd';
      used: number;
      budget: number;
      detail: string;
    }
  | { type: 'stray'; files: string[] }
  | { type: 'error'; message: string }
);
```

`limit` and `warning` both carry `used` and `budget` in the limit's own unit, and
`costUsd` is the one counted in dollars: a reader that formats every one of these
as a whole number would show a run that has spent three cents as having spent
nothing.

Statuses are `queued`, `running`, `waiting`, `finished`, `failed`, `cancelled`,
`interrupted` and `stopped_at_limit`. The last five are terminal, and a run that
just went quiet is not one of them: the log always ends with a terminal status,
so a reader can tell a finished run from a dead connection.

`text.delta` is streamed and arrives in small batches, so a client appends it to
the current turn's text rather than treating each one as a paragraph.

`thinking.delta` is the model's reasoning channel, separate from the answer and
billed as output. It is usually most of the bill. A reader that drops it is not
showing the answer, it is showing the part of the answer the model decided to
say out loud.

`context` means the message list was shortened to fit the model's window. It is
worth surfacing rather than logging: the model's view of the conversation just
changed, so an answer that contradicts an earlier file read is explained by this
and not by a mistake. `dropped` is how many tool results were replaced with a
notice, and `subjects` names them. The request that goes out never has a message
removed, only a tool result's content shortened, so a `tool_calls` id always
keeps exactly one `tool` reply.

`limit` ends the run with `stopped_at_limit`. `contextTokens` is the exception
worth knowing about: it fires when even a fully shortened conversation will not
fit, which means the run cannot continue. Reaching `contextTokens` on its own
does not stop anything, it compacts.

## Limits

| Limit           | Default   | Counts                                                       |
| --------------- | --------- | ------------------------------------------------------------ |
| `turns`         | 12        | model calls                                                  |
| `wallSeconds`   | 900       | wall clock for the whole run                                 |
| `outputTokens`  | 40 000    | what the model wrote, thinking included                      |
| `totalTokens`   | 2 000 000 | prompt plus completion, over every turn                      |
| `contextTokens` | 700 000   | the size of one request, which compacts rather than stopping |
| `askSeconds`    | 3 600     | how long `ask` waits for a reply                             |

`outputTokens` alone is not a cost bound. Every turn re-sends the whole
conversation, so a run that reads large files pays for them again on each turn
while writing almost nothing. `totalTokens` is the bound that reflects that, and
`contextTokens` is what keeps a single request inside the model's 1,048,576-token
ceiling.

## Exit codes

`dsh run` exits `0` finished, `1` failed, `2` cancelled, `3` stopped at a limit,
`4` bad task file, `5` the daemon could not be reached.
