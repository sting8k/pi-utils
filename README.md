# pi-utils

Utility extensions for the [Pi coding agent](https://github.com/earendil-works/pi): a background-aware `bash`, script-mode `edit`, and `skill_write` for agents that maintain their own skills.

## Features

- **`bash`** (replaces the built-in): commands still running after 30s move to the background and their result arrives later, so the agent's turn is not blocked
- **Search routing**: plain `rg` / `grep` / `find` commands run on capped search cores that include gitignored files
- **`shell_status` / `shell_kill`**: list, inspect, and stop background jobs; a live widget shows running ones
- **`edit`** (replaces the built-in): the model sends a script plus the files it may touch and gets the diff back; failures roll back
- **`skill_write`**: create, patch, delete, or move `SKILL.md` files, with a compact skills index in the system prompt

## Installation

```sh
pi install npm:@sting8k/pi-utils
```

Search routing needs `rg` on `PATH` or in `~/.pi/agent/bin`.

## bash and background jobs

`bash` keeps Pi's shell, cwd, and env, and changes only the lifecycle:

| Situation | What happens |
| --- | --- |
| Finishes quickly | Returns normally |
| Still running after 30s | Moves to the background as `bg-1`; the result is delivered when it finishes |
| `background: true` | Starts in the background right away |
| `timeout: N` | Kills the whole process tree after N seconds |

```
shell_status()            # totals + newest 10 jobs, running first
shell_status(id="bg-2")   # one job: output so far, or the final result
shell_kill(id="bg-2")     # stop it and its process tree
/shell-bg [kill bg-2]     # same, as a slash command
```

Finished jobs arrive in the conversation as `<shell_bg_result>` and wake the agent. Jobs that finish during a run arrive together in one message. Under headless `pi -p` nothing arrives after the turn ends, so collect jobs with `shell_status` before it does.

## Search routing

A standalone search command sent to `bash` runs on the search cores instead of a raw shell. Output is capped, and when it hits the cap the full result is written to a temp file. Rows are `path:line: text`, so the line number feeds straight into `read`'s `offset`.

```
bash(command="rg -i preset src")       # grep core
bash(command="find src -name '*.ts'")  # glob core, newest first
```

Pipes, redirects, `$`, unknown flags, or anything else the matcher cannot map exactly run in real bash unchanged. Wrappers listed in `bashRouter.unwrapPrefixes` (default `["rtk"]`) are stripped before matching.

## edit

| Field | Required | Notes |
| --- | --- | --- |
| `code` | yes | python or node script, passed on stdin |
| `paths` | yes | every file the script may touch |
| `lang` | no | `python` (default) or `node` |
| `timeout` | no | seconds (default 10); kills the process tree and rolls back |

- **`paths` is the boundary.** Only declared files are snapshotted, diffed, and rolled back. Writes elsewhere are not seen.
- **Failures roll back.** A nonzero exit, timeout, or abort restores every declared file and deletes the ones the script created.
- **No-op runs warn.** A script that changed nothing returns `no declared file changed`.
- **Not a sandbox.** The script runs with your user's permissions.

## skill_write

`skill_write` manages skills under `~/.pi/agent/skills/<category>/<name>/SKILL.md`. Each change is snapshotted and rolled back on failure, and a skill must be read before it can be changed. It also:

- replaces Pi's `<available_skills>` list with a compact index, built once per session so the system prompt stays the same across turns. Small skill sets list every description; large ones list names by category plus the 15 most-used
- hides skills whose `platforms`, `requires`, or `dirs` frontmatter does not match
- suggests up to 3 relevant skills when the prompt matches them (`skills.hint`)
- reminds the agent to save lessons every 10 iterations (`skills.nudgeInterval`, `0` turns it off)

## Settings

`~/.pi/agent/pi-utils.json` is created with these defaults on first start. Missing keys fall back to defaults; a broken file falls back entirely, with a warning.

```json
{
  "fsSearch": { "noIgnore": true, "globMaxResults": 100, "grepMaxMatches": 250, "grepMaxLineBytes": 2000, "rawOutputMaxBytes": 20971520, "timeoutMs": 30000, "graceMs": 3000 },
  "shellBg": { "autoBackgroundMs": 30000, "tailBytes": 8192, "killGraceMs": 3000 },
  "bashRouter": { "unwrapPrefixes": ["rtk"] },
  "edit": { "lang": "python", "timeoutSec": 10 },
  "skills": { "index": "smart", "coreLimit": 15, "hint": true, "nudgeInterval": 10 },
  "disabledTools": []
}
```

`disabledTools` turns off individual tools: `bash`, `shell_status`, `shell_kill`, `edit`, `skill_write`. A trailing `*` works as a wildcard (`"shell*"`).

- `bash` or `edit`: Pi's built-in version takes over. Disabling `bash` also removes the job tools and the widget.
- `skill_write`: turns off the tool, the index, and the reminder.

## Styling

If [`@sting8k/pi-droid-styling`](https://www.npmjs.com/package/@sting8k/pi-droid-styling) is installed, the tools use its boxed rendering. Otherwise Pi's default rendering is used.

## Development

```sh
git clone https://github.com/sting8k/pi-utils && cd pi-utils && bun install
pi -e ./extensions/shell-bg.ts -e ./extensions/edit.ts -e ./extensions/skill-write.ts
bun run check && bun test
```

## Related Work

- [pifydev/shell-background](https://github.com/pifydev/shell-background) (MIT): the design `shell-bg` follows
- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): the host; the grep core is a fork of its streaming grep
- [ripgrep](https://github.com/BurntSushi/ripgrep): the engine behind routed searches

## License

[MIT](LICENSE)
