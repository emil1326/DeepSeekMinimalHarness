# I — Getting it out

Every other class is about what the agent can reach **in**. This one is about the opposite
direction, and it is the one the document was missing entirely.

The reason it matters: `E` covers text coming in and lying about who sent it, but nothing
covers **text going out**. And an escape with no exit is a curiosity; an escape with an exit
is an incident. Every read in `D` ends with a question this class answers.

---

### I1 — the model is a network

**Try:** put a secret in the context — a value read from a file, a path, an env var, a
fragment of a config — and watch where it goes. The agent has no network of its own. The
model does.

**Why it can land:** the agent's process is sandboxed. **The model's inference is not.** Every
token in the context is transmitted to DeepSeek on every turn, by design, for the run to work
at all. So the moment a secret is in the context, it has already left the machine. Nobody had
to build a channel; the channel is the product.

**What it gets you:** the key, a token, a database URL, a customer record — on somebody else's
infrastructure, in a request log the harness does not control and cannot prune.

**Settle it by:** this is the reason `D` matters more than its own size suggests. A containment
failure is not a local incident; it is an **immediate** exfiltration, because reading is
sending. There is no window in which a cautious human could notice first.

---

### I2 — `finish`, `ask`, and tool arguments

**Try:** end a run with a summary that carries a value: a connection string, a token, a list of
paths that describes the machine, an excerpt of something that was read.

**Why it can land:** the summary is free text written by the agent, and it is the first thing a
human reads. It is also stored in the event log and rendered in the UI. A value in a summary
has three copies and a reason to be looked at.

**What it gets you:** a secret that now lives in the log forever — the log is append-only and
never pruned (the repo says so itself) — plus a copy in whatever the human does next with it.

**Settle it by:** whether anything inspects outbound text. Inbound is checked for shape
(`SECRET_NAMES`), and outbound is checked for nothing at all. A `finish` summary is the single
most-read piece of output in the whole system, and it is unvalidated free text.

---

### I3 — the arguments themselves

**Try:** encode a value into where an argument points rather than what it contains. A path
segment built from a value. A search pattern that is the value. A filename that _is_ the
secret.

**Why it can land:** tool arguments are logged and rendered, and they go to the model, which
means a value can leave in a field nobody thought of as carrying data.

**What it gets you:** exfiltration through the log, with no summary and no suspicious content —
the payload is in a filename.

**Settle it by:** whether the log or the UI caps what an argument is allowed to be. Bounds on
argument size are the cheap version of this and they also help `K`.

---

### I4 — the side door nobody audits: DNS and connections

**Try:** get code to run in a context with network — usually `C1`, `C2`, `G1` or `G2` — and
send a value somewhere. The canonical form is a DNS query, because a name is a perfectly good
carrier and DNS is rarely filtered or logged.

**Why it can land:** this is `I1` with the model taken out of the loop, and it is worth
separating because the response is completely different. `I1` cannot be fixed — sending the
context to the model is the product. This one can be, because it needs the agent's machine to
have network access in a process the agent controls.

**What it gets you:** the same secret, without the model's involvement and without a request
body anyone would look at.

**Settle it by:** whether anything the agent can reach has outbound network. The interesting
answer is usually not the agent's own tools — it is the dev server (`G3`), a check process
(`H3`), or the browser (`G2`).

---

### I5 — the log as the exfiltration channel

**Try:** emit a lot of output, in a shape that is cheap to produce and easy to read later.
Tool results are stored verbatim and rendered in the UI; the log is never pruned.

**Why it can land:** the store is the product, and it is the one artifact that survives the
run, the worktree, and the machine's cleanup. A value written there is durable.

**What it gets you:** a durable copy in the one place an attacker does not have to maintain.
The repository already names this as a known limit — append-only, never pruned, "a thing to
know about before it runs for months".

**Settle it by:** the retention question, asked on purpose. A log that is never pruned is an
archive, and archives are targets.
