# 0014 Retire standalone grep/glob tools; skill_write on by default

Date: 2026-10-02

## Status

Accepted

## Context

Decision 0008 shipped `grep` (built-in override) and `glob` as standalone
tools. Since US-001 the bash router runs provable `rg` / `grep` / `find`
commands on the same search cores, and the 2026-09-15 owner preference
already shipped both tools OFF by default. In practice the owner found the
dedicated tools no longer pay for their prompt surface.

US-004 shipped the skills layer (`skill_write` + smart index + nudge) opt-in
via `disabledTools: ["skill_write"]`. After use, the owner judged it good
enough to run by default.

## Decision

- Remove the `fs-search` extension (`grep` and `glob` tools and their
  renderers). The search cores (`src/fs-search/*`) stay: the bash router in
  `shell-bg` uses them. The settings-scaffold notice and spill cleanup move to
  `shell-bg`'s `session_start`.
- `grep` / `glob` leave `KNOWN_TOOLS`. Existing settings files still list them
  (the old scaffold wrote them), so they drop **silently** from
  `disabledTools` instead of warning on every session start.
- `DEFAULT_SETTINGS.disabledTools` becomes `[]`: `skill_write` (tool, index
  transform, nudge) is on by default. Existing settings files keep their
  explicit lists; nothing rewrites them.

## Alternatives Considered

1. Keep the tools, default-off — rejected: the code and docs carry a surface
   nobody enables.
2. Warn on retired names — rejected: every pre-existing settings file would
   warn on every start.

## Consequences

Positive:

- Smaller extension surface; one search path (bash routing).

Tradeoffs:

- Users who opted back into `grep` / `glob` lose them; Pi's built-in `grep` /
  `find` remain available through Pi's own tool settings.
- A settings file scaffolded before this change still lists `skill_write` in
  `disabledTools`, so the skills layer stays off there until the user removes it.
