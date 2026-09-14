# 0008 Pi Extensions Architecture (fs-search + shell-bg)

Date: 2026-09-14

## Status

Accepted

## Context

This repo becomes a home for Pi coding-agent extensions. Research compared Pi's built-in
`grep`/`find` (source-verified) against the dsh `fs-search` design (notes in
Sec-lab/quick-research) and the `pifydev/shell-background` extension. The two first
extensions are `fs-search` (grep + glob) and `shell-bg` (background bash). Several
consequential choices had to be locked before scaffolding: tool naming, whether to
depend on third-party code for process management, settings layout, and distribution.

Full analysis and module layout live in `docs/pi-extensions-architecture-draft.md`
(now the design baseline; sections marked ĐÃ CHỐT are locked).

## Decision

1. One package `pi-utils` hosts both extensions; layering is `src/` (pure, no pi imports,
   unit-testable standalone) + `extensions/` (thin pi glue).
2. `grep` **overrides** the built-in with a merged design: fork Pi's streaming
   implementation (MIT) as base, add dsh flags (`--no-config`, `--no-ignore` + exclude
   `.git`, timeout 30s + grace 3s), schema superset (`include` alias, `noIgnore`
   default true). `glob` registers as a **new** tool name; built-in `find` stays
   untouched.
3. `shell-bg` is **self-implemented** following the pify pattern (MIT credit in header):
   override `bash` (same schema + `background` + `timeout`), plus `shell_status` /
   `shell_kill` tools, `/shell-bg` command, aboveEditor widget, followUp delivery,
   session-scoped JSON sidecar registry with pid reconciliation. No runtime dependency
   on `@pify/shell-background`.
4. Settings live in **one** auto-scaffolded file `~/.pi/agent/pi-utils.json`: created
   with full defaults on first `session_start`, missing keys merged without overwriting
   user edits, parse errors fall back to defaults with a UI warning. No per-extension
   or per-project settings files.
5. Distribution: local git only (`git init` + commit, **no push**), no npm publish in v1.

## Alternatives Considered

1. Separate tool names (`fs_grep`/`fs_glob`) running beside built-ins — rejected: model
   picks whatever is described; fewer overlapping tools is better.
2. Depending on `@pify/shell-background` — rejected: process management is the most
   sensitive infra to own; the core is ~600 lines and testable.
3. Per-extension / per-project settings files — rejected for v1: one scaffolded file is
   simpler; per-cwd overrides can be added inside the same file later if needed.
4. Bundling `@vscode/ripgrep` like dsh — rejected: Pi already manages rg/fd binaries in
   its agent bin dir; resolve PATH → Pi binDir → error hint (D3).

## Consequences

Positive:

- Built-in search keeps Pi's streaming/early-kill quality while gaining ignored-file
  discovery, mtime ordering (glob), and hard timeouts.
- Background bash works without external runtime deps and stays testable offline.

Tradeoffs:

- Overriding built-ins changes familiar semantics (`grep` no longer respects gitignore
  by default) — mitigated by `noIgnore` param and tool description.
- Forking Pi's grep implementation means tracking upstream changes manually.
- No project-level settings override in v1.

## Follow-Up

- Scaffold package + `src/common/` first; glob before grep; shell-bg core before glue.
- D3 (rg resolver) and D5 (tempfile spill, no versioned spill store) proceed on
  recommendation unless objected during implementation.
- Revisit npm publish / remote push when the extensions are stable in daily use.
