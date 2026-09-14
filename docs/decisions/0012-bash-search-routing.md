# 0012 — bash search auto-routing

Status: accepted
Date: 2026-09-14
Supersedes: —

## Context

The `bash` tool (shell-bg override) frequently receives standalone search commands (`rg` / `grep` / `find`) that bypass the optimized fs-search cores, so they miss the caps, spill files, and formatted rows the dedicated `grep` / `glob` tools have. Design settled with the owner in the work packet [US-001](../stories/US-001-bash-search-routing.md) (the binding contract, including the full matcher spec); this record captures the decisions future work must inherit.

## Decision

1. **Layering**: `src/fs-search/bash-router.ts` exports `matchBashSearch(command) → RoutedSearch | null` — a pure matcher, no pi imports (repo rule). `RoutedSearch` is `{ kind: "grep", params: GrepParams } | { kind: "glob", params: GlobParams }`, reusing the core param shapes. Glue lives in the extension: `extensions/shell-bg.ts` `runBash` routes only when `!params.background && params.timeout === undefined` (background/timeout calls keep the job lifecycle); a `null` match is a zero-behavior-change fall-through to real bash.
2. **Routed result**: one-line note prefix — `[fs-search] bash routed to <kind> semantics — hidden+gitignored files included, caps + spill apply.` (honest: dsh semantics search hidden+gitignored files, a superset of plain rg/grep) — plus `details: { routed: true, kind, ...core counts }` (grep: `matchCount`/`fileCount`/`matchLimitReached`/`spillPath`; glob: `total`/`spillPath`). Routed searches never create a shell-bg job and skip auto-background; the cores' own 30 s timeout applies. A core error (e.g. `SEARCH_FAILED` for a missing path) is surfaced as an error result with `routed: true` — never a silent bash fallback.
3. **Conservatism beyond the literal spec list** (all still "reject ⇒ fall through", never route): backslash inside double quotes, quote-glued text (`'a'b`), empty quoted tokens, tokens starting with `#` (comments), `=` rejected uniformly outside the sanctioned `--include=` / `--color=auto|never` forms (so quoted patterns like `'a=b'` also fall through), combined short flags (`-rn`), unquoted braces (brace expansion), `-`/`!`-leading glob and `-name` values. `rg -g` accepts a single glob only (a second `-g` rejects). Combined shorts and `rg 'key=value'`-style patterns are known routing losses — owner-approved: losses are acceptable, wrong routes are not.
4. **Matcher must not be widened** without a new owner decision (packet rule). Out of scope stays out: pipes/chains/substitution, `fd`, `rg --files/-w/-S/-t/-l`, `grep -v/-o/-c/-h`, `find -type/-mtime/-maxdepth/-exec/-iname`, multi-path `find`.

## Consequences

- Any new flag/glob-form support means extending the accept matrices in `tests/bash-router.test.ts` (accept cases assert exact params) plus a fresh owner decision.
- The routed note is the model's only signal that ignore semantics were supersets and caps applied — keep it honest if core semantics ever change.

## Evidence

- `bun run check` green; `bun test` 168 pass / 0 fail (all 56 pre-existing tests untouched; +110 router matrix tests, +2 glue tests covering routed execute and the background/timeout/non-search fall-throughs).
- Unit: `tests/bash-router.test.ts` (accept + reject matrices incl. every spec danger case); glue: `tests/glue.test.ts` (routed note + `details.routed`, non-routing paths unchanged).
- Integration/E2E live smoke and packet Status flip: owner (bean), per the US-001 handoff.
