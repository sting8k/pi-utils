# pi-utils

Utility extensions for the [Pi coding agent](https://github.com/earendil-works/pi): a deep filesystem search (`grep` / `glob`) that also searches gitignored files, and a background shell (`shell-bg`) so long-running commands never eat the agent's turn while it waits.

## Features

- `grep` (overrides the built-in): streaming ripgrep search over hidden **and** gitignored files by default, `--no-config` hardening, a cooperative 30s timeout, and match/byte caps with spill files for the full output
- `glob` (new tool): find files by name pattern at any depth, sorted by modification time with the most recently changed files last, includes gitignored files
- `bash` (overrides the built-in): commands still running after 30s auto-move to the background, `background: true` starts detached immediately, `timeout: N` kills the whole process tree
- `shell_status` / `shell_kill`: poll, list, and stop background jobs; finished results are delivered into the conversation automatically
- `/shell-bg` command and a live widget above the editor showing running jobs
- One settings file, `~/.pi/agent/pi-utils.json`, auto-scaffolded with defaults on first run
- Zero runtime dependencies beyond the Pi package; ripgrep is reused from `PATH` or Pi's managed bin dir

## Installation

Local checkout for now (no npm publish yet):

```sh
git clone <this repo> && cd pi-utilities
bun install
```

Quick test without installing:

```sh
pi -e ./extensions/fs-search.ts -e ./extensions/shell-bg.ts
```

For auto-discovery and hot `/reload`, add the package root to the `extensions` array in `~/.pi/agent/settings.json` (pi reads the `pi.extensions` entries from `package.json`):

```json
{
  "extensions": ["/absolute/path/to/pi-utilities"]
}
```

Alternatively, symlink both entries into the global extensions dir:

```sh
ln -s "$PWD/extensions/fs-search.ts" ~/.pi/agent/extensions/pi-utils-fs-search.ts
ln -s "$PWD/extensions/shell-bg.ts" ~/.pi/agent/extensions/pi-utils-shell-bg.ts
```

Requires `rg` on `PATH` (or run Pi's built-in grep once so Pi downloads ripgrep into `~/.pi/agent/bin`).

## Usage

A typical working session — locate, read with the line numbers you were given, then kick off a build without blocking:

```
> where is the cache invalidation handled?

grep(pattern="invalidate", include="*.ts")
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

## fs-search

`grep` and `glob` share one idea: bugs like to hide in files that ordinary search skips (gitignored build output, lockfiles, `.env` files), so both tools include hidden and gitignored files by default. Pass `noIgnore: false` to `grep` when ignores should be respected.

```
grep(pattern="API_KEY", noIgnore=false)     # respect .gitignore this time
grep(pattern="preset", include="*.md")      # single positive glob filter
grep(pattern="line two", context=2)         # context lines like built-in grep
grep(pattern="TODO", limit=500)             # raise the default 250-match cap
```

Rows are `path:line: text`, so the line number feeds straight into `read`'s `offset`. An empty result is a successful "No matches found." — never an error. Errors carry a `SEARCH_INVALID_PATTERN`, `SEARCH_FAILED`, `SEARCH_ABORTED`, or `SEARCH_RAW_OUTPUT_OVERFLOW` prefix.

```
glob(pattern="*.test.ts")                   # basenames at ANY depth
glob(pattern="src/*.ts")                    # anchored: one level under src/
glob(pattern="*.log", path="var")
```

Results are paths relative to the working directory, oldest first. When results exceed the cap, the inline list is cut and the full list is written to a temp file whose path is returned in the output.

## shell-bg

`bash` keeps Pi's shell, cwd, and env but changes the lifecycle:

| Situation | What happens |
| --- | --- |
| Command finishes quickly | Returns normally, exactly like before |
| Still running after 30s (interactive) | Moved to the background: returns `moved to background, id=bg-1`; result is delivered when it finishes |
| `background: true` | Detached from the start; returns the id immediately |
| `timeout: N` | Whole process tree killed past N seconds |

```
shell_status()               # list every background job this session
shell_status(id="bg-2")      # one job: status + output so far (or final result)
shell_kill(id="bg-2")        # stop it and its whole process tree
```

In interactive sessions, finished jobs deliver themselves into the conversation wrapped in `<shell_bg_result id="...">`. Under headless `pi -p`, nothing is delivered after the turn ends — the tool's own message tells the model to poll `shell_status` within the turn.

```
/shell-bg                    # same list as shell_status()
/shell-bg kill bg-2          # same as shell_kill
```

A widget above the editor shows each running job's header and latest output line while it works.

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
  }
}
```

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
- `@deepseek-ai/dsh` `tool-fs-search` — the semantics `grep`/`glob` implement: search ignored files, mtime ordering, hard caps, argv-only subprocess calls
- [ripgrep](https://github.com/BurntSushi/ripgrep) — the search engine behind both tools

## License

[MIT](LICENSE)
