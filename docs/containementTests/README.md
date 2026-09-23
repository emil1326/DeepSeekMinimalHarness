# Containment and destruction probes

What an agent in this environment might try, written down before anyone tries it.

## Two things this is not

**It is not a test file.** There is no pass and no fail here, on purpose. A refusal
asserted in code either re-states something already guarded, or it encodes an attack
the environment does not stop and goes red for ever. Both are noise. Each entry is
a **probe**: one thing to do once, by hand, in a scratch worktree, to get an answer.
The answer is the deliverable, not a green line.

**It is not derived from the current guards.** The list was written from the agent's
position outward — a git worktree, a handful of file tools, a set of named checks,
and a daemon holding a token — by following the openings. Starting from the refusals
would have produced a mirror of them, and the entries that matter are the ones nobody
has written a guard for.

## How to use it

- One probe at a time, in a **scratch** worktree and a scratch harness home. Never the
  real one, and never with the real key.
- Fill in **Tried** and **Result** when you do. A blank result is a question, not a pass.
- The list does not expire. Every opening here is basically "a file that something reads
  as instructions" or "a name that a comparison gets wrong", and new tools, new languages
  and new checks invent new instances of both. When one is added, re-ask the whole list.

## Two ideas do most of the work

**Blast radius is the allow list.** Almost every attack below ends at "and then it could
also write X". The only thing that decides how bad that is, is how many files the task
allowed. A task that allows one file is a different risk class from a task that allows
forty, and that is a decision made when the task is written, not when the run happens.

**The diff and the log are the products.** The code is nearly a by-product. Several
entries here attack those two instead of the worktree — hiding a change from the diff,
or making the transcript say something that did not happen. Those are worth more to an
attacker than a stray write, and they are quieter.

## Index

| ID  | Attack                                    | What it gets you                                    |
| --- | ----------------------------------------- | --------------------------------------------------- |
| A1  | traversal, in every argument              | any file the process can read                       |
| A2  | symlinks, including dangling ones         | the same, with no `..` to spot                      |
| A3  | hard links                                | a secret read, or a file outside destroyed, legally |
| A4  | Windows path forms                        | deny-list bypass; a write that stores nothing       |
| A5  | case and Unicode folding                  | a write to a file that was never allowed            |
| A6  | directory links during a walk             | a map of the machine                                |
| A7  | the same directory by another name        | containment decided on a string                     |
| A8  | check-then-use                            | anything A1–A3, through a path that changed         |
| B1  | emptying an allowed file                  | a delete that reads as an edit                      |
| B2  | deletion by assertion                     | a removal the reviewer misses                       |
| B3  | one file, two names                       | a write outside the allow list, reported inside     |
| B4  | out through a check                       | writes with the user's privileges                   |
| B5  | filling the disk                          | the daemon's log, for every run                     |
| B6  | blinding the review                       | approval of a change nobody can see                 |
| B7  | two runs, one worktree                    | two half-changes, one diff                          |
| B8  | corrupting the record instead of the code | work on disk in no diff                             |
| C1  | the config file that is also a program    | code execution in a check, then D3                  |
| C2  | a name taken from PATH                    | the profile's tool becomes the agent's tool         |
| C3  | the model's file handed to an interpreter | a shell, declared in the profile                    |
| C4  | code that runs later                      | execution on the developer's machine, after the run |
| C5  | a check reading model-written output      | C1 with no error to point at                        |
| D1  | reading the key where it lives            | the key                                             |
| D2  | the environment, filtered by name         | pointers to where secrets are kept                  |
| D3  | `daemon.json` and the token               | the daemon, and every other run                     |
| D4  | a name the deny list does not know        | the secret, read openly                             |
| D5  | reading it out of output                  | the secret, plus a copy that never expires          |
| D6  | the neighbours                            | whatever sits beside the code                       |
| E1  | speaking as somebody else                 | a transcript that says a person approved            |
| E2  | a summary that disagrees with the diff    | an approval based on the wrong document             |
| E3  | hiding the change                         | defeats the control that catches everything else    |
| E4  | instructions the agent was not given      | unauthorised work, inside the allow list            |
| E5  | the human as an attack surface            | a secret or a command, handed over by a person      |
| E6  | confusing one run with another            | a wrong instruction applied to real work            |
| E7  | the log under two writers                 | a live view that silently drops events              |
| E8  | being interesting on purpose              | a wider allow list, negotiated with a helpful human |
| F1  | a regex that does not finish              | a worker that cannot be stopped                     |
| F2  | filling the volume                        | every run's record                                  |
| F3  | sitting still                             | processes accumulating, looking like patience       |
| F4  | cheap turns                               | occupancy with nothing to show                      |
| F5  | the shape of the tree                     | slowness misattributed to the model                 |
| F6  | two writers                               | an unreliable stray-change report                   |
| F7  | losing the tail of a failure              | turns burnt on an error the agent cannot see        |

## Order worth reading them in

`C1` first: it is the keystone. Almost everything with teeth — `D3`, `B4`, `C4` — needs
code running inside a check process, and `C1` and `C2` are how that happens. If `C1` is
closed, a good half of this document becomes academic.

Then `A3`, because it is the one entry where damage leaves the sandbox along a path that
every name-based check agrees is legal.

Then `B6` and `E3`, because they attack the review rather than the code.

## Files

- `A-escape.md` — leaving the worktree
- `B-destroy.md` — destroying data
- `C-execute.md` — getting code to run
- `D-secrets.md` — getting at a credential
- `E-integrity.md` — making the record lie
- `F-resources.md` — refusing to stop, and slowing everything down
