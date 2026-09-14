# 0010 — shell-bg jobs widget presentation

Status: accepted
Date: 2026-09-14
Supersedes: —

## Context

The shell-bg extension renders a live widget above the editor (`ctx.ui.setWidget`, placement `aboveEditor`). The first version was a plain `string[]` of per-job headers plus a log-tail line; elapsed time was frozen between events because re-render only happened on spawn/exit/delivery. Owner review asked for pi-tasks' presentation idiom — clean, one line per job, not a full clone of pi-tasks (no cycling, no settings).

## Decision

1. **Layering**: `src/shell-bg/format.ts` exports `widgetModel(jobs, now?)` — a pure, synchronous model (running count, ≤ 5 rows, hidden overflow, elapsed text). The extension paints it with pi's theme via the component overload of `ctx.ui.setWidget((tui, theme) => ({ render, invalidate }))`. No pi imports in `src/`.
2. **Layout** (pi-tasks idiom, `accent`/`dim` palette):
   - `• Jobs · N running` — small marker at column 0, `Jobs` bold accent at column 2, mirroring the transcript's tool rows (reasonix renders `✓ ToolName …`, name at col 2), so the widget aligns with the transcript without magic numbers.
   - Branch rows indented one level (col 4) with tree connectors `├─` / `└─` (dim), last row gets `└─`; overflow beyond 5 jobs collapses to a final `└─ ⋯ and N more` branch.
   - Command clipping follows **droid-styling's row mechanism** (see `renderReasonixInlineFooter` / `boxLineWithRight` / `getReasonixCollapsedRowWidth`): rows budget at 80% of the widget width (full width only ≤ 40 cols); the meta ("· elapsed" + optional "(auto)") is the right part — measured first with `visibleWidth`, never clipped; the command gets the remainder, truncated with pi-tui `truncateToWidth` (dim " …" ellipsis) and **padded to its budget** so meta aligns on one column across all rows. `@earendil-works/pi-tui` is a declared devDependency for this.
3. **Lifecycle**: a 1 s interval re-renders while any job runs (elapsed ticks; model is sync so ticks do no file IO); the interval stops and the widget clears when the last job settles, and on `session_shutdown`.
4. **No tail lines in the widget** — one line per job; output remains available via `shell_status`, the delivery message, and `logs/bg-N.log`.

## Consequences

- Future pi-utils widgets should follow the same shape: pure model in `src/`, painter in the extension, pi-tasks idiom, alignment derived from the transcript's own row structure.
- Widgets must never read logs on their tick path; anything needing file IO belongs to tool results, not the above-editor render.

## Evidence

- Owner-approved live checks: 1/2/3-job states, connector flip when the last-but-one settles, count updates, clean clear on last settle, tick smoothness (session log, 2026-09-14).
- `tests/shell-bg.test.ts` — widgetModel: running-only rows, elapsed formatting, 5-row cap + hidden, empty-model clear, auto flag. 56 tests green; CI runs `34811800448` (`42dd577`).
