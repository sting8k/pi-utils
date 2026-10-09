# pi-utils

Utility extensions for the [Pi coding agent](https://github.com/earendil-works/pi): a background shell (`shell-bg`) so long-running commands never eat the agent's turn while it waits — with plain `rg` / `grep` / `find` commands routed onto capped search cores that also cover gitignored files — script-mode editing (`edit`), and a self-improving skills write layer (`skill_write`).

## Features

- `bash` (overrides the built-in): commands still running after 30s auto-move to the background, `background: true` starts detached immediately, `timeout: N` kills the whole process tree
- `bash` search auto-routing: standalone `rg` / `grep` / `find` commands run on the fs-search cores (caps, spill files, formatted rows) instead of a raw shell — anything the matcher cannot prove 1:1 falls through to bash unchanged. A wrapper whitelist (`bashRouter.unwrapPrefixes`, default `["rtk"]`) also routes prefixed commands like `rtk rg …` (pi-ctx-kit rewriting); unknown wrappers like `sudo` never strip
- `shell_status` / `shell_kill`: inspect, list, and stop background jobs; finished results are delivered into the conversation automatically and wake the agent, so it ends its turn instead of waiting
- `edit` (overrides the built-in): script-mode editing — pass `code` + `paths`, get the unified diff back; declared paths are snapshotted and rolled back on failure
- `skill_write`: the write half of the self-improving skills loop — create/patch/delete/move `SKILL.md` under `~/.pi/agent/skills/<category>/` (category required on create; patch/delete/move find the skill by name) with snapshot rollback, a read-before-write guard (bash `cat` doesn't count), and minimal frontmatter validation. The `before_agent_start` hook also replaces Pi's native `<available_skills>` index with a small catalog computed once per session (`skills.index: smart`: hides by `platforms`/`requires`/`dirs`; small sets (≤6k chars with descriptions) list every skill with its description; larger sets get one names-only line per category plus a `core` group of the `skills.coreLimit` (default 15) most-used skills, usage kept across sessions in `~/.pi/agent/pi-utils-skill-usage.json`), so the system prompt stays byte-identical across turns; it appends a skills rules block, and (`skills.hint`, default on) attaches up to 3 lexically-ranked skill hints to a turn when the prompt matches (cwd and recent files/commands only re-rank; repeated envelope text is ignored). Nudge (`skills.nudgeInterval`, default 10, `0` off) reminds the agent to save lessons. The layer is on by default; `"skill_write"` in `disabledTools` turns off the tool, the index transform, and the nudge together
- `/shell-bg` command and a live widget above the editor showing running jobs
- One settings file, `~/.pi/agent/pi-utils.json`, auto-scaffolded with defaults on first run
- Runtime deps: the Pi package plus `yaml` (frontmatter parsing); ripgrep is reused from `PATH` or Pi's managed bin dir

## Installation

```bash
pi install git:github.com/sting8k/pi-utils
```

Once published to npm:

```bash
pi install npm:@sting8k/pi-utils
```

For local development:

```sh
git clone https://github.com/sting8k/pi-utils && cd pi-utils
bun install
pi -e ./extensions/shell-bg.ts -e ./extensions/edit.ts -e ./extensions/skill-write.ts
```

Bash search routing needs `rg` on `PATH` or in Pi's managed `~/.pi/agent/bin`.

## Usage

A typical working session — locate, read with the line numbers you were given, then kick off a build without blocking:

```
> where is the cache invalidation handled?

bash(command="rg invalidate src")
  [fs-search] bash routed to grep semantics — hidden+gitignored files included, caps + spill apply.
  3 matches in 2 files
  src/cache/entry.ts:41:     invalidate(key: string) {
  src/cache/entry.ts:97:     this.invalidate(oldKey)
  src/cache/store.ts:12: import { invalidate } from "./entry.js"

read(path="src/cache/entry.ts", offset=35, limit=30)
  ...

> ok, rebuild and check the failing test while it runs

bash(command="npm run build && npm test", background=true)
  bg-1 started in the background.
    $ npm run build && npm test
  ...
```

## Bash search routing

A standalone search command sent to `bash` runs on the search cores instead of a raw shell. Bugs like to hide in files that ordinary search skips (gitignored build output, lockfiles, `.env` files), so routed searches include hidden and gitignored files, cap their output, and write the full result to a temp file when the cap hits.

```
bash(command="rg -i preset src")            # -> grep core
bash(command="rg -C 2 'line two'")          # context lines
bash(command="find src -name '*.ts'")       # -> glob core, mtime-sorted
```

Rows are `path:line: text`, so the line number feeds straight into `read`'s `offset`. The matcher is conservative: pipes, redirects, `$`, unknown flags, or anything it cannot prove 1:1 runs in real bash unchanged.

## shell-bg

`bash` keeps Pi's shell, cwd, and env but changes the lifecycle:

| Situation | What happens |
| --- | --- |
| Command finishes quickly | Returns normally, exactly like before |
| Still running after 30s (interactive) | Moved to the background: returns `moved to background, id=bg-1`; result is delivered when it finishes |
| `background: true` | Detached from the start; returns the id immediately |
| `timeout: N` | Whole process tree killed past N seconds |

```
shell_status()               # counts + newest 10 rows, running jobs first
shell_status(id="bg-2")      # one job: status + output so far (or final result)
shell_kill(id="bg-2")        # stop it and its whole process tree
```

In interactive sessions, finished jobs deliver themselves into the conversation wrapped in `<shell_bg_result id="...">`. A job that finishes while the agent is idle is delivered right away; jobs that finish mid-run wait until the run settles and arrive together in one message (pi drains follow-ups one per turn by default, so one message per job would cost a turn each). A finished job collected by hand via `shell_status` is not delivered again. Under headless `pi -p`, nothing is delivered after the turn ends — the tool's own message tells the model to poll `shell_status` within the turn.

`shell_status` with no id leads with the totals (`21 jobs this session · 1 running · 10 shown`) and then lists at most 10 rows: running jobs first, then the newest finished ones, with `… and N more` for the rest. The registry keeps every job a session ever ran, so an uncapped list would eventually dump hundreds of rows into the context; what gets cut is a finished job whose result is already in the conversation, and `shell_status` with its id still returns it.

```
/shell-bg                    # same list as shell_status()
/shell-bg kill bg-2          # same as shell_kill
```

A widget above the editor lists running jobs — one line per job (`• Jobs · N running`, tree connectors, live elapsed) — and clears itself when the last job settles.

## edit: script-mode editing

`edit` overrides Pi's built-in with a script-only form: the model passes a python or node script plus the files it may touch, and the result is the **unified diff in the model's own context** — the verification surface. Structured anchored replacement is intentionally not part of this tool; that niche belongs to dedicated anchored-edit tools.

| Field | Required | Notes |
| --- | --- | --- |
| `code` | yes | python/node script source (passed on stdin) |
| `paths` | yes | **every** file the script may touch |
| `lang` | no | `"python"` (default) or `"node"` |
| `timeout` | no | seconds; whole process tree killed past it (default 60) |

The contract, stated plainly:

- **`paths` is the boundary.** The tool snapshots, diffs, and rolls back exactly the declared paths — no git, no `.git` detection, one code path in git and non-git directories. Writes outside `paths` are invisible to it; declaring every target file is the model's responsibility.
- **Rollback on failure.** Nonzero exit, timeout, or abort restores every declared path to its snapshot bytes (files the script created are deleted). The error result reports what was touched before the restore.
- **Review the diff.** A script that matched nothing still exits 0 — a no-op run returns a prominent `no declared file changed` warning instead of silently pretending success.
- **Not a security boundary.** The script runs with full user privileges. The tool adds declared intent, diff review, and rollback — an ergonomics and safety layer, not a sandbox.
- Stray structured-form fields (`path`, `edits`, `oldText`, …) are a hard error naming the fix — the tool only runs scripts.

`edit` joins `disabledTools` (below): disabling it leaves Pi's built-in edit in charge.

## Styling: droid-styling adaptation

When [`@sting8k/pi-droid-styling`](https://www.npmjs.com/package/@sting8k/pi-droid-styling) is present, all five tools render in its boxed style automatically — pi-utils borrows its renderer primitives at session start, so colors, width, and expand behavior follow your droid-styling config. Without it, pi's default tool rendering is used. No hard dependency either way:

- both installed via `pi install npm:` → resolves automatically (flat `~/.pi/agent/npm/node_modules`)
- developing side by side → `devDependencies` `"file:../pi-droid-styling"` symlink (already configured here)
- any other setup → default rendering, everything else works unchanged

## Settings

All settings live in `~/.pi/agent/pi-utils.json` — created with these defaults on first start. Missing keys are filled in-memory without rewriting your edits; a broken file falls back to defaults with a warning toast:

```json
{
  "fsSearch": {
    "noIgnore": true,
    "globMaxResults": 100,
    "grepMaxMatches": 250,
    "grepMaxLineBytes": 2000,
    "rawOutputMaxBytes": 20971520,
    "timeoutMs": 30000,
    "graceMs": 3000
  },
  "shellBg": {
    "autoBackgroundMs": 30000,
    "tailBytes": 8192,
    "killGraceMs": 3000
  },
  "bashRouter": {
    "unwrapPrefixes": ["rtk"]
  },
  "edit": {
    "lang": "python",
    "timeoutSec": 10
  },
  "disabledTools": []
}
```

### Disabling individual tools (`disabledTools`)

`disabledTools` is a list of pi-utils tool names that are skipped at
registration time — turn off one tool, keep the rest of the module running.
Valid names are `bash`, `shell_status`, `shell_kill`, `edit`, `skill_write`. The key
is optional and every tool ships on (`[]`). The retired `grep` / `glob` names
are ignored silently, so older settings files keep loading
without warnings. Other unknown names produce a warning and are dropped, duplicates dedupe. Entries
may use a trailing `*` prefix wildcard: `"shell*"` disables `shell_status`
and `shell_kill`, and `"self-*"` stays dormant until `self-*` tools are
added in a later version — patterns expand at load time, so they pick up
future tools automatically. Only trailing wildcards are supported; other
`*` placements warn and are dropped.

Layering — two levels of toggles: to disable a whole module, use pi's own
extension toggle (`package.json → "pi"."extensions"`); to disable a single
tool inside pi-utils, use `disabledTools`.

What happens when a tool is disabled:

- `bash` — pi's built-in bash stays in charge. `bash` is a cluster head:
  disabling it also removes `shell_status`, `shell_kill`, and the Jobs widget
  (with the override off, no background jobs can exist)
- `edit` — pi's built-in edit stays in charge (the script-mode override is
  unregistered)
- `shell_status`, `shell_kill` — pi has no native equivalent, so the
  tool is simply absent
- `skill_write` — the tool, the smart skills index, and the nudge all switch off

Development:

```sh
bun run check   # biome + tsc --noEmit
bun test        # unit tests for src/, glue tests against a fake ExtensionAPI
```

## Related Packages

- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — the extension host; `grep-core` is a fork of its streaming grep
- [docs/pi-extensions-architecture-draft.md](docs/pi-extensions-architecture-draft.md) — design baseline for both extensions
- [docs/decisions/0008-pi-extensions-architecture.md](docs/decisions/0008-pi-extensions-architecture.md) — locked architecture decisions
- [docs/HARNESS.md](docs/HARNESS.md) — the repository harness this package develops under

## Related Work

- [pifydev/shell-background](https://github.com/pifydev/shell-background) (MIT) — the design `shell-bg` follows: log-file jobs, pid reconciliation after `/reload`, delivery-once, headless caveat
- `@deepseek-ai/dsh` `tool-fs-search` — the semantics the routed search cores implement: search ignored files, mtime ordering, hard caps, argv-only subprocess calls
- [ripgrep](https://github.com/BurntSushi/ripgrep) — the search engine behind routed searches

## License

[MIT](LICENSE)
