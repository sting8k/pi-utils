# 0009 Droid-Styling Render Adaptation

Date: 2026-09-14

## Status

Accepted

## Decision

pi-utils tools carry their own rendering by borrowing `@sting8k/pi-droid-styling`'s renderer primitives at runtime, instead of porting them or changing load order:

1. `@sting8k/pi-droid-styling` is an **optional peer** (never a hard dependency — it re-registers rendering for other tools, and forcing it on pi-utils users would restyle their UI).
2. At `session_start`, `src/render/droid.ts` dynamically imports `@sting8k/pi-droid-styling/tool-tags/common.js` (primitives: boxed calls, compact footers, boxed results, line rendering). Resolved → the tools re-register with droid-styled `renderCall`/`renderResult`; unresolvable → default rendering stays. The specifier is overridable (`PI_UTILS_DROID_MODULE`) for tests.
3. Resolution per install mode: dev here uses `devDependencies: "file:../pi-droid-styling"` (relative path, symlink); `pi install npm:` of both resolves as flat siblings under `~/.pi/agent/npm/node_modules`; anything else falls back gracefully.
4. Thin per-tool builders live in `src/render/tool-renderers.ts` (~20 lines per tool, droid's visual grammar); no absolute machine paths anywhere in the repo.

## Context

pi has no render-plugin API: a tool definition owns both `execute` and rendering, `getAllTools()` does not return either, and same-name registration is last-wins. droid-styling re-registers `bash`/`grep` with built-in `execute` plus its renderers, so any load order that lets it win would silently kill pi-utils behavior (`background` would vanish from the schema); any order where pi-utils wins (the current, verified state) drops the droid styling. Measured live in a real pi session.

## Alternatives Considered

1. Reorder so droid-styling owns rendering — rejected: it would own `execute` too and silently disable background bash and dsh grep semantics.
2. Port droid renderers into pi-utils (~300 lines) — rejected as bulky by the owner; duplicated design drifts.
3. Change droid-styling to wrap-instead-of-replace — its same-name re-registration is currently a no-op against extension-owned tools (observed live), so the composition point is unreliable without deeper pi internals; also touches the other repo.

## Consequences

Positive:

- One visual language across all tools; styling follows the user's droid config (`presentationStyle`, `dimToolOutput`, expand behavior) because the primitives read it internally.
- Zero hard dependency; absence of droid-styling degrades to pi's default rendering.

Tradeoffs:

- Depends on droid-styling's internal module path `tool-tags/common.js` (no `exports` field today); a future `exports` restriction or rename needs a small follow-up here.
- Tools re-register once at session_start (registration is idempotent last-wins).

## Follow-Up

- Reload pi in the droid-styled environment and visually confirm bash/grep/glob/shell_status/shell_kill boxes.
- If droid-styling ever adds an `exports` map, export the primitives publicly and update the import specifier.
