# esap: notes that apply to every task

These were being recopied into every task file by hand, which meant every task
file was a chance to lose one. They are true of the project, not of any one line
of its backlog.

- **Ids are random.** Never depend on them coming out in order, never compare
  against index 0, and never type one by hand — `7kq2m9pd4a1cz` is not an id.
- **Never compare a whole response from the core.** It carries `core_ms`, which
  changes every time.
- **The app runs in French on this machine.** A spec reads `data-*` attributes,
  never visible text.
- **A spec puts the app back exactly as it found it** — panel closed, focus on
  `.dock`, cleanup in a `finally`.
- **A command that records a time is tested through `bundles::apply_as`.** Calling
  it directly gives "this write has no time".
- **A new core command** goes in the `every_command` sample in
  `tests/registry.rs`, in a menu the app knows about, and on `NOT_BUILT` until the
  app really runs it.
- **A missing golden file is never created by hand.**
- **Do not ask.** If something is genuinely ambiguous, note the decision you made
  in your summary and carry on. A question costs the run its whole allowance
  waiting for an answer.
