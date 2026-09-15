# US-003 `edit` override — script-mode editing

## Status

planned — spec revised 2026-09-15 after owner review (script-only form);
ready for Peanut → Xi handoff

## Lane

normal

## Goal

Override pi's `edit` tool (same shadow mechanism as `bash`/`grep`/`glob`)
with a **script-only** edit tool: the model passes `code` + `paths` +
optional `lang`, a python/node script runs against the declared files,
and the result is the unified diff.

This legitimizes the "agent writes a python script to edit" pattern —
which agents already reach for through `bash` — as a first-class tool
with declared intent, rollback, and reviewable output. There is no
structured `edits[]` form — script is the only mode, self-contained.

Core `edit` returns its diff only in `details` (TUI); the model sees
just "Successfully replaced N blocks". This override puts the diff in
`content` — the verification surface the model actually reads, which is
required because script mode has no anchor-check (see decisions).

## Scope

In scope:

- `extensions/edit.ts`: `pi.registerTool({ name: "edit" })` shadowing the
  core tool; params; `prepareArguments` alias normalization.
- `src/edit/` cores (no pi imports — repo rule):
  - `snapshot.ts` — in-memory content map of declared `paths`
    (absent-file recorded as absent so scripts may create files).
  - `run-script.ts` — spawn interpreter with code on stdin, captured
    stdout/stderr, timeout, abort → kill process tree.
  - `diff.ts` — context-hunk diff renderer plus a small
    unified-patch emitter for the `patch` detail.
  - `args.ts` — alias normalization + validation errors that name the
    fix (no mode resolution needed — one form only).
- `src/common/settings.ts`: `edit` section (`lang`, `timeoutSec`);
  add `"edit"` to `KNOWN_TOOLS` (US-002 `disabledTools` interplay —
  disabling `edit` leaves core edit in charge, same documented
  semantics as bash).
- README: tool documentation, script contract, security note.
- Unit tests for cores; glue tests for registration.

Out of scope:

- Structured `edits[]`/`oldText`/`newText` form (rejected by owner —
  see decisions). pi-utils is standalone; this spec must not reference
  or recommend any external editing tool.
- Sandboxing / permission boundary. The script runs with full user
  privileges; this tool is an **ergonomics and safety layer** (diff,
  rollback, declared intent), not a security boundary. README states
  this plainly.
- Undo across turns; rollback covers the script run only.
- MCP/pi-fabric interop.

## Owner decisions already settled (do not relitigate)

Confirmed by owner 2026-09-15 (direct stamp to Peanut: "Đúng, 4 cái đều
của tao"); decision 1 then narrowed in the same review round:

- **Override `edit`, script form ONLY** (owner, 2026-09-15, spec-review
  UI: "Chỉ script mode — không mirror structured form — edit tool chỉ
  nhận script"). No `edits`/`path` params; the tool is self-contained.
- **No anchor-check in this tool — accepted tradeoff** (owner
  2026-09-15): the diff in `content` + explicit no-op warning is the
  only verification surface.
- **Diff is self-written** — a hunk renderer plus a small
  unified-patch emitter; no `git diff`/`diff -u` subprocess
  dependency.
- **No git anywhere** (owner, 2026-09-15): identical behavior in git and
  non-git directories; no `.git` detection — one code path. `paths` is
  the hard contract boundary: the tool snapshots, diffs, and rolls back
  exactly the declared paths; writes outside `paths` are outside what
  the tool can see. README documents this as a contract.
- **Stray structured-form fields = hard error** (Peanut recommendation,
  spec default): `path`, `edits`, `oldText`, `newText`, `all` alongside
  or instead of `code` → validation error naming the fix. Rationale: a
  model sending structured fields is confusing tools; the error teaches
  the contract for later calls, and lenient merging risks misreading
  intent.

## Spec (the contract)

### Params (flat object)

| Field | Required | Notes |
| --- | --- | --- |
| `code` | yes | script source |
| `paths` | yes | every file the script may touch |
| `lang` | no | `"python" | "node"`, default from settings (`"python"`) |
| `timeout` | no | seconds; whole process tree killed past it |

Validation (`args.ts`):

- Missing `code` → error showing a minimal example.
- Missing/empty `paths` → error ("declare every file the script may
  touch").
- `path`/`edits`/`oldText`/`newText`/`all` present (before or after
  alias normalization) → hard error naming the fix, e.g.
  `script-mode tool: "path" is not a field — declare files in "paths"`.
- Unknown keys → standard excess-property validation error.

`prepareArguments` aliases (normalize before validation): `script` /
`source` → `code`; `files` / `targets` → `paths`; `file_path` /
`filename` / `target_file` / `file` → **error pointing to `paths`** (a
single-path alias would reintroduce the ambiguity the hard-error rule
exists to kill); `timeoutMs` → `timeout` (÷1000).

### Execution (`run-script.ts` + `snapshot.ts`)

1. Snapshot every entry of `paths` (content or "absent" marker).
2. Spawn interpreter, code on stdin, `cwd = ctx.cwd`, env = process env +
   `PYTHONIOENCODING=utf-8`:
   - `python` → `python3 -`, fallback `python -` when `python3` missing;
     both missing → error telling the model to pass `lang:"node"`.
   - `node` → `node -` (always available — Pi itself runs on it).
   - Stdout/stderr captured and capped (over cap → spill to temp file,
     pointer in result — same convention as fs-search).
   - `timeout` (default `edit.timeoutSec`) kills the whole tree; abort
     signal kills too.
3. Exit ≠ 0 / timeout / abort / spawn failure → **restore all declared
   paths from snapshot** → error result with `rolledBack: true`,
   `exitCode`, `stderr` excerpt, and which declared paths were left
   dirty before restore (diagnostics; after restore they are clean).
   Files created by the script under `paths` are deleted on rollback.
4. Exit 0 → diff each declared path old↔new (absent→present = creation,
   present→absent = deletion, both reported).
5. Undeclared writes are out of contract by design (no git — see
   decisions): the tool observes only `paths`.
6. All declared paths byte-identical → content carries a prominent
   warning line (`script exited 0 but no declared file changed`) —
   `isError` stays false; the warning is the no-op detector.

### Result contract

`content[0].text`:

- Header: `script edit: M file(s) changed (+X/-Y).`
- Then the rendered diff, capped (~200 lines / 50KB consistent with repo
  spill conventions; over cap → truncated marker + `spillPath`).

`details`:

- `diff` (rendered context diff), `patch` (unified
  patch, per-file `---`/`+++`/`@@` concatenated for multi-file),
  `firstChangedLine` — same keys core `edit` uses, so render code paths
  stay familiar.
- Script extras: `lang`, `exitCode`, `elapsedMs`, `filesChanged[]`,
  `rolledBack`, `stdout`, `stderr`, `spillPath?`.

`description` (one line only — long descriptions make models worse):
edit files by running a script; the unified diff is returned for
verification.

`promptGuidelines` (steering — this is where guidance lives):

- Declare every file the script may touch in `paths` — the tool can only
  diff and roll back declared paths.
- **Review the returned diff** — a script that matched nothing still
  exits 0; check the "no declared file changed" warning.
- Never embed file contents or large payloads inside `code` — the
  script reads files from disk; for large new content, `write` it to a
  file first and have the script read it (keeps `code` free of
  escape-heavy literals).
- Do not shell out inside the script (`subprocess`, `os.system`) — for
  shell work call `bash` directly; nested shells recreate quoting
  problems this tool exists to remove.

### Settings (`src/common/settings.ts`)

```jsonc
"edit": {
  "lang": "python",          // "python" | "node"
  "timeoutSec": 60           // default script timeout
}
```

Missing key → defaults silently (same precedent as bashRouter A1);
invalid values → warning + default. `"edit"` joins `KNOWN_TOOLS` —
`disabledTools: ["edit"]` unregisters the override and core `edit`
stays in charge.

## Context Map

- Read first: `extensions/shell-bg.ts` (the `bash` shadow pattern —
  `registerBash`, result shapes), `src/common/settings.ts` (bashRouter
  parse precedent), `src/common/subprocess.ts` + `src/common/tempfile.ts`
  (spawn + spill helpers), `extensions/fs-search.ts`
  (`prepareArguments` + droid render pattern).
- Core contract being replaced:
  `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js`
  (details keys `{diff, patch, firstChangedLine}` to mirror).
- Guardrails: no pi imports in `src/`; rollback touches declared paths
  only; abort/timeout must kill the whole process tree (same
  process-tree semantics as shell-bg).

## Coordination / Handoff

- Integrating owner: main pi-utils session (bean).
- Tech lead: Peanut — spec reviewed; owner confirmations collected.
- Delegation protocol per US-002 incident: implementer commits locally
  and reports; push only on explicit owner grant.

## Acceptance / Proof

- `bun run check` green; `bun test` green; existing tests untouched.
- New tests, at minimum:
  - `args.ts`: missing code/paths, stray structured fields hard-error
    with fix named, alias normalization, `timeoutMs` conversion.
  - `snapshot.ts` + `run-script.ts`: create/modify/delete declared
    paths; rollback restores bytes and deletes script-created files on
    nonzero exit; timeout kills; stdout/stderr caps + spill; `python3`
    missing → `python` fallback → `lang:"node"` hint error.
  - `diff.ts`: hunk rendering + unified patch vs fixtures; multi-file
    patch concatenation.
  - glue: `edit` registered when enabled, skipped under
    `disabledTools: ["edit"]`.
- Owner E2E smoke: real session — `edit` modifying two files, diff
  visible in transcript; rerun in a non-git directory → identical
  behavior; stray `path` field → hard error text correct.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | cores matrix above (tests/edit-*.test.ts) |
| Integration | glue: registration + disabledTools skip (mocked pi API) |
| E2E | owner smoke: script edit success, failure rollback, non-git dir parity |
| Platform | python3 present/missing paths; node path; Windows python absent → lang:"node" hint |
| Release | n/a |

## Open Questions

- None blocking. (Both resolved: `path`-in-script-mode → hard error,
  Peanut rec accepted by spec; steering → 1-line description +
  promptGuidelines, Peanut rec accepted.)
