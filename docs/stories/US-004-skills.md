# US-004 skills — self-improving skill layer (write side)

## Status

planned — spec revised 2026-09-15 after Peanut's investigation:
pi 0.85.1 ships a **native skills system**, so this spec covers only
the write/improve half of the loop. Ready for Peanut review → Mark.

## Lane

normal

## What Pi already provides (do NOT rebuild)

Native (`core/skills.ts`, verified live: 47/48 skills, 28KB index
rendered, works in peer sessions):

- recursive `SKILL.md` scan: `~/.pi/agent/skills/` (user) +
  `.pi/skills/` (project) + extension-contributed dirs
- `<available_skills>` XML index rendered into the system prompt
  (agentskills.io standard) — discovery + injection solved natively
- diagnostics, collision check, `/skill:name` slash command,
  `disable-model-invocation` frontmatter flag
- generic `read`/`bash`/`ls` already load any skill file

→ Store layout, index rendering, frontmatter base contract, discovery
and prompt injection are all native. We build nothing there.

## Goal

Close the self-improvement loop's **write half**: the agent can save
a learned procedure as a skill, patch a wrong/stale skill in place,
and delete one — through one guarded funnel. The read/recall half is
native.

```
learn → store (skill_write) → recall (native index → read) →
improve (skill_write patch) → repeat
```

## Scope

### In

- `skill_write` tool — ops: `create` / `patch` / `delete`, atomic
- read-before-write guard — enforced via read-tool-call tracking
  (see below; `skill_view` does NOT exist)
- frontmatter validation — minimal (native diagnostics own the
  format; we validate just enough to never write a broken file)
- path-guard — our `edit`/`write` overrides refuse
  `<skills_root>/**/SKILL.md` → "use skill_write"
- prompt rules block — small static section appended via
  `before_agent_start` (the hook ctx-kit already proves exists)
- optional iteration nudge — `skills.nudge_interval`, default off

### Out (deferred)

`skill_view`/list tool, custom index rendering, demotion, platform/
requires filtering (v2 via `before_agent_start` if needed),
project-local creation (`.pi/skills`), telemetry, curator, ledger,
write approval, security scan, hub/sync, batch `write_file` ops,
`absorbed_into`, `edit` full-rewrite op, background review fork.

## Owner decisions already settled (do not relitigate)

- Memory is out of scope (user's own system); skills hold
  task-class knowledge only.
- skills_root = `~/.pi/agent/skills` (native user dir).
- `skill_write` is the funnel — exists for guards + future hooks,
  not file-writing convenience.
- No background fork — prompt rules + optional counter nudge only.
- Supporting files (`references/` etc.) use generic file tools —
  `skill_write` guards `SKILL.md` only.

## Spec (the contract)

### `skill_write`

```ts
{ name, action: "create"|"patch"|"delete",
  category?, content?, old_string?, new_string?, replace_all? }
```

Single-op flat shape (batch ops deferred — script-`edit` covers
atomic multi-file if ever needed).

- `create`: write `<skills_root>/[<category>/]<name>/SKILL.md`.
  Exists → error naming `patch`. Parent dirs auto-created.
- `patch`: `old_string`→`new_string` on SKILL.md — same fuzzy-match
  semantics as our `patch` tool; `replace_all` optional.
- `delete`: remove the skill dir.
- every mutation: snapshot → write → verify; failure restores
  (reuse US-003 snapshot discipline).

### Read-before-write guard (no skill_view)

Track during session: a `read` tool call whose resolved path is a
`SKILL.md` under skills_root marks that skill "seen". `patch`/
`delete` on an unseen existing skill → error:

```
"Read the skill first: read(<path>) — writes must be based on
current content."
```

`create` needs no prior read. Bypass via `bash cat` stays refused —
same strictness as hermes (transcript quotes don't count); the
error message names the way out.

### Frontmatter validation (minimal — create only)

- content non-empty; starts with `---`; frontmatter closes; YAML
  parses to a mapping; body non-empty
- `name` + `description` present; `name` `^[a-z0-9][a-z0-9_-]*$`,
  ≤64 chars
- `category` if present: single dir name, same regex, no `/` `\`
- `description` >60 chars → **advisory warning** (not rejection):
  response includes `warning` + `index_preview` showing the exact
  rendered index line. (Native renders full descs — length is a
  prompt-bloat concern, not a routing blocker; keep it advisory.)
- unknown fields pass through (native flags like
  `disable-model-invocation` untouched)
- `patch`/`delete`: frontmatter checks skipped — existing skills
  stay maintainable; every rejection names the fix.

### Path-guard

In our `edit`/`write` overrides: resolved target matching
`<skills_root>/**/SKILL.md` → error `"SKILL.md is managed — use
skill_write (enforces format + read-before-write)"`. Generic tools
still freely touch `references/` and everything else.

### Prompt rules block

Appended via `before_agent_start` (same hook ctx-kit uses — proven
to exist):

```
## Skills
Skills under ~/.pi/agent/skills/ are your learned procedures — scan
<available_skills> and load any relevant one with read() before
starting. If a skill is wrong or missing steps, patch it with
skill_write before finishing. After a hard task or a user
correction, save the lesson as a skill: class-level name (never
"fix-X-today"), description = "Use when <trigger>", rules with
why — not a session log. ```

(If the injection hook can't append: same text lands in the
`skill_write` schema description instead — weaker but zero-API.)

### Nudge (optional)

`skills.nudge_interval` (default 0 = off). Count tool iterations
since last `skill_write`; at threshold append to next tool result:
`"[skills] N iters since last skill write — worth saving anything?"`

## Context Map

- new: `extensions/skill-write.ts` — tool registration (follow
  `extensions/edit.ts`: registry, schema, `droidToolRender`)
- new: `src/skills/` — frontmatter parse, guard tracking, write ops
- touch: `extensions/edit.ts` — path-guard (script-mode: check declared
  `paths` against skills_root prefix)
- new: thin `write` override (edit.ts registry pattern) — exists ONLY
  for the path-guard; repo has no write override today
- touch: `src/common/settings.ts` — `skills.nudge_interval`
  (skills_root fixed to native default; `skills.dir` only if bean
  wants override)
- read-tracking hook: whatever Pi exposes for tool-call events
  (ReadToolCallEvent per Peanut) — confirm exact API at impl time
- pi-droid-styling: check whether unknown tool names fall through
  its name-keyed renderer patch gracefully; `skill_write` is a new
  name so likely fine — verify, don't assume (same lesson as the
  edit.ts `(unknown)` bug)

## Coordination / Handoff

- spec: me → Peanut review → Mark implements
- push only after bean's live-test approval (US-003 flow)

## Acceptance / Proof

- create → file at `~/.pi/agent/skills/<name>/SKILL.md`; next-turn
  prompt index lists it (native does the render — verify, don't
  build)
- create with long desc → succeeds, response carries warning +
  `index_preview`
- patch on unviewed existing skill → read-before-write error; after
  `read()` → applies
- direct `write`/`edit` to a SKILL.md → path-guard error
- `bash cat` then patch → still refused (guard keys on read tool)
- delete → gone; bad frontmatter create → rejected with fixable
  message; failed multi-step → rolled back
- nudge off by default; with interval=3 fires after 3 iters

## Validation

- `bun run check` green; unit tests for frontmatter validation,
  read-before-write tracking, path-guard, snapshot rollback
- live smoke in real pi session (native index pickup is the proof
  that the loop closes)

## Open Questions — RESOLVED by Peanut review (2026-09-15)

- **Read tracking API (verified in pi 0.85.1 dist):**
  `pi.on("tool_call", handler)` — event is a discriminated union
  (`ToolCallEventBase { type: "tool_call", toolCallId }` +
  `toolName` + `input`). `ReadToolCallEvent` narrows to
  `{ toolName: "read", input: ReadToolInput }`. Track
  `resolve(input.path)` per call; optionally pair with
  `ToolResultEvent` to mark "seen" only on successful reads.
- **before_agent_start append (verified):** no append API — the
  result field is `systemPrompt?: string` with REPLACE semantics,
  chained across extensions. Append = return
  `{ systemPrompt: event.systemPrompt + rulesBlock }`. Pattern is
  proven live by pi-boomerang (index.ts before_agent_start handler
  does exactly this concat-then-return). Block lands after the
  native `<available_skills>` section — good placement.
