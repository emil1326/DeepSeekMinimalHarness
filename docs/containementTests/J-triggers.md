# J — The file that is a trigger

A file is not always just a file. Some of them are **run by something else when they are
opened, indexed, built or previewed**, and the harness has no idea which ones those are,
because it decides _paths_ and this is a property of _formats_.

This is the concrete instance list for the class the plan gestures at with "`*.ps1`, `*.cmd`,
`*.bat`, `*.sh` are refused". That list is four extensions. The real list is a few dozen, it
changes with every Windows release, and it is different on every toolchain in the repo.

**The asymmetry that makes this class dangerous.** A deny list is written against names
somebody thought of, matched as a string. `*.ps1` is caught and `.psm1`, `.psd1` and
`.ps1xml` — all PowerShell, all capable of running code when a module loads — are caught by
nothing. `*.config.*` catches `eslint.config.js` and misses `.eslintrc.js`, which does exactly
the same thing. The list is a snapshot of a moving target, and the misses are invisible
because a miss produces no error message.

So read this file as **a list of formats to ask about**, not a list to block. The durable rule
is in `C4`, and it is the only thing here that scales: _a file the agent may write must never
be read as instructions by anything that runs later._

---

### J1 — The Windows shell

These run, or resolve something that runs, when a person **opens** them — a double-click, an
Explorer preview, a hover. The agent does not need to execute anything; it needs a human to
be curious later.

| Extension            | What happens                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `.reg`               | Explorer merges it into the registry. Registry writes, from a double-click.                              |
| `.lnk`               | Shortcut with a command line and arguments; preview resolves its target.                                 |
| `.scf`               | Preview resolves an icon from a path — a **UNC path, so credentials leak** without any execution at all. |
| `.url`, `.website`   | The `IconFile=` field is resolved the same way as `.scf`.                                                |
| `Desktop.ini`        | `IconResource` gives the same leak as `.scf`, from a file that looks mundane.                            |
| `.hta`               | HTML Application, run by `mshta` in full trust.                                                          |
| `.js`, `.jse`        | Windows Script Host, executed on open. `.jse` is the obfuscated variant.                                 |
| `.vbs`, `.vbe`       | Windows Script Host.                                                                                     |
| `.wsf`, `.wsh`       | Script host, and it can contain several scripts at once.                                                 |
| `.chm`               | Compiled help; can carry and run code.                                                                   |
| `.settingcontent-ms` | Ran commands on open. Patched, and still worth asking about on older builds.                             |
| `.diagcab`           | Troubleshooter packages that could run PowerShell.                                                       |
| `.msi`, `.mst`       | Installs run with elevation prompts that a user will accept.                                             |
| `a.pdf.exe`          | A double extension, and Windows hides known extensions by default, so it displays as `a.pdf`.            |

**Mark of the Web, which is the part most people miss.** A file that arrives from the network
carries a `Zone.Identifier` stream, and Windows uses it to block or warn. A file the **agent
creates** has no such stream — so it looks locally authored. Writing the _contents_ of a
downloaded script into a fresh allowed file **launders its trust**, and the download warning
that would have appeared does not.

**PowerShell's own family**, since `*.ps1` is refused and nothing else is: `.psm1` (a module,
run on import), `.psd1` (a module manifest, which can list `ScriptsToProcess`), `.ps1xml`
(type formatting), `.psrc` plus `.psc1` (a console file, which names a script and is what
`-PSConsoleFile` loads).

---

### J2 — Drives, shares, and removable media

The containment question is different when the worktree is not a folder on an internal disk.

- **`autorun.inf`** at the root of a removable drive, or a network share. Mostly disabled on
  modern Windows and still a property of _where the worktree is_ rather than of anything the
  agent does. If the worktree is a USB stick, it is worth one question.
- **A network share as the worktree root.** "Inside the worktree" is now a location other
  people mount, other people may have write access to (which makes `A8` and `F6` real rather
  than theoretical), and where the diff is on somebody else's storage.
- **A mapped drive or a `subst` alias as the root.** The same directory under two names —
  `A7` — and now with a name that can change between runs, so a task file's `worktree` path
  can mean a different place later.
- **A cloud-synced folder as the worktree.** The agent writes, the sync client uploads, and the
  file is now off the machine by a route with no audit and no relation to the sandbox. The
  write never left the allow list.
- **The volume behind the harness home.** `B5` and `F2` assumed one volume for everything. The
  daemon's database and the worktree can be on different ones, which decides whether filling
  the disk destroys the record of the run or only the run.

---

### J3 — The editor and the IDE

The agent has a write tool. The developer has an editor open on the same folder.

- `.vscode/tasks.json` with `runOptions.runOn: folderOpen` — a task on folder open.
- `.vscode/settings.json` — a language server path, or a formatter that is a command.
- `.vscode/extensions.json` and `*.code-workspace` — **recommendations**, which produce a
  prompt asking the human to install an extension. The agent chooses what the human is asked
  to install.
- `.code-workspace` — its own `tasks` section runs on open, outside `.vscode` entirely.
- `.editorconfig` — formatting only, included because it is the counter-example: a config file
  that is genuinely inert. Not every config is a trigger, and that distinction is worth being
  able to make.

---

### J4 — The toolchain, by ecosystem

Each of these is a file that some tool **executes or obeys** when a person merely runs the
project's own commands.

| File                                             | Runs when                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `.eslintrc.js`, `.eslintrc.cjs`                  | ESLint starts — the same as `eslint.config.js`                                            |
| `.babelrc.js`, `babel.config.js`                 | a Babel build                                                                             |
| `.npmrc`, `.yarnrc.yml`                          | a different registry, or a different shell to run scripts in                              |
| `conftest.py`, `sitecustomize.py`                | Python starts, or pytest collects                                                         |
| `*.pth` in site-packages                         | Python starts — **in site-packages only**, so it needs a check that installs the worktree |
| `justfile`, `Taskfile.yml`                       | the developer runs the project's task runner                                              |
| `build.gradle`, `pom.xml`, `Rakefile`, `Gemfile` | a build, which the deny list has never heard of                                           |
| `.envrc`                                         | `direnv` — and this is the one that **executes**                                          |
| `.devcontainer/devcontainer.json`                | a container build — `postCreateCommand`, `onCreateCommand`                                |
| `compose.yaml`, `Dockerfile`                     | a container build, with volume mounts                                                     |
| `.gitmodules`                                    | a clone or a submodule update, from a repository of the agent's choosing                  |
| `.dockerignore`, `.npmignore`                    | which files travel, rather than which code runs                                           |

---

### J5 — Git's own triggers

Separate from `H1` because this is not the harness doing the running — it is whoever touches
the repository next.

- `.husky/pre-commit` — **a shell script with no extension**, so every extension-based rule
  misses it and `*.sh` does not apply.
- `.githooks/*`, `.git-hooks/*` — the same files under the names some tooling prefers.
- `core.hooksPath` in a config that names one of the above.
- `.gitattributes` — not executed, and it changes how everything else is _presented_ (`B6`).
- `.gitignore` — not executed, and it hides a changed file from review (`B6`).

---

## How to ask the question

Do not try to complete the list. Instead, for each file on the allow list, ask two questions:

1. **Who reads this file, other than a human?** Name the program, not the category.
2. **Does anything read it as instructions rather than as data?**

A file where both answers are "nobody" and "no" is a plain file. Everything else belongs in
a task decision, and the decision is: does this task need to allow it, and does the person
writing the task know what will read it.
