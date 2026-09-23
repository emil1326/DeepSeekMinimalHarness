# F — Refusing to stop, and slowing everything down

Nothing here breaks a rule. Every one of these is a legal sequence of legal calls, and the
environment has to survive it. This class is easy to dismiss and it is the one most likely
to be hit by accident, because an agent under pressure does all of it without meaning to.

---

### F1 — a regex that does not finish

**Try:** `search` with `(a+)+$`, `(a|a)*b`, or any pattern with nested quantifiers, against
a file with a long line. Then try to stop it.

**Why it can land:** the pattern is model-supplied and compiled as given, and the search
walks every file under the root. A byte cap per file limits how much is _read_; it does not
limit how much work the engine does on what it read. Catastrophic backtracking is
per-character and can run for hours on a few kilobytes.

**What it gets you:** the worker pinned for the remainder of the run. If the search is
synchronous, the process stops answering altogether — **including the cancel path**, so the
run cannot be stopped by the code whose job is stopping runs. That turns a slow search into
a process that has to be killed from outside.

**Settle it by:** whether there is any time budget on one regex evaluation, and whether a
cancel survives a worker stuck inside one. Probe it by cancelling a run that is deliberately
stuck, and see whether the cancel is what ends it.

---

### F2 — filling the volume

See `B5`. Repeated here because the target is not this run: a full disk takes the daemon's
event log with it, and the log is the record of every other run too. One run's greed deletes
another run's history.

**Settle it by:** what the daemon does when a write to its own database fails. A harness that
dies quietly when it cannot log is worse than one that refuses to start.

---

### F3 — sitting still

**Try:** `ask` with a question nobody will answer, from a detached run. Then do it several
times.

**Why it can land:** waiting is a supported state with a long limit by default, and a parked
run holds a worker process and, if a socket is attached, a connection. Nothing is doing
work, so nothing trips a work-based limit, and the run looks healthy in a list of runs.

**What it gets you:** processes and sockets accumulating until something else gives. This is
a denial of service that presents as patience, which is why nothing about it looks wrong.

**Settle it by:** how many parked runs are allowed at once, and whether anything reaps a run
with no owner attached any more. That second one is the interesting half.

---

### F4 — cheap turns

**Try:** loop on the cheapest possible call — a one-line read, a `search` matching nothing —
until a limit fires.

**Why it can land:** a token limit and a turn limit are the same shape of backstop, and a run
doing almost nothing per turn can still do it for a long time. Which limit fires first is
the whole question, and it is a number nobody usually checks until it matters.

**What it gets you:** wall-clock and process occupancy with nothing to show for it, plus a
large event log for a run that produced nothing.

**Settle it by:** which limit fires first, whether the remaining budget is visible in the UI
before it fires, and whether the limit is a number the human set or a default they never saw.

---

### F5 — the shape of the tree

**Try:** a directory of many small files; a deep tree; a file with one enormous line; a file
with no trailing newline; a file that is not valid UTF-8.

**Why it can land:** the caps that exist are _per file_, and the cost that matters is usually
the total. Reading is windowed, which is good. Listing sorts a whole directory, searching
walks everything, and a single enormous line defeats line-oriented reasoning in the reader as
well as in the tool.

**What it gets you:** slow turns that look like a slow model. That is the worst kind of
slowness, because it is misattributed and somebody goes and changes the wrong thing.

**Settle it by:** which total budget is missing. The per-file caps are known; the question is
whether anything bounds the sum.

---

### F6 — two writers

See `B7`. Also worth its own line here: the stray-change report is produced by running `git
status` in the worktree, so a run competing with another writer makes its own report
unreliable — it can neither see its own change clearly nor claim it did nothing else.

**Settle it by:** whether the report is taken at a moment when nothing else can be writing.
If it is not, the report is a guess with a confident tone.

---

### F7 — losing the tail of a failure

**Try:** make a check fail with output longer than the cap, with the actual explanation in
the middle.

**Why it can land:** keeping the head and the tail is a good default and drops the middle. A
compiler writes its preamble first and its errors last, so head-and-tail is right most of the
time. A tool that writes a long banner, then one line saying what broke, then pages of noise,
defeats it exactly.

**What it gets you:** an agent looping on a failure it cannot see, which is the known way a
run burns its turns and then reverts good work — the prototype's own recorded failure mode,
arrived at from the other direction.

**Settle it by:** whether any check in the shipped profiles can produce output where the
diagnostic lands in the dropped middle. This is cheap to check and it is the kind of loss
that never shows up as an error.
