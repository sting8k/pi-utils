# US-001 Bash search auto-routing

## Status

planned

## Lane

normal

## Goal

When the agent runs a standalone, pure filesystem-search command through the
`bash` tool (`rg` / `grep` / `egrep` / `fgrep` / `find`), it executes via the
optimized fs-search cores (`runGrep` / `runGlob`) instead of a raw shell —
giving it the caps, spill files, and formatted rows the dedicated tools have.
Anything the matcher cannot prove 1:1 falls through to real bash, unchanged.

## Scope

In scope:

- New pure module `src/fs-search/bash-router.ts`: `matchBashSearch(command)`
  returning `RoutedSearch | null` (grep/glob params), no pi imports.
- Glue in `extensions/shell-bg.ts` `runBash`: route only when
  `!params.background && params.timeout === undefined`; routed result gets a
  one-line note prefix + `details.routed`.
- Unit tests `tests/bash-router.test.ts` (accept matrix asserts exact params;
  reject matrix covers every danger case below).
- Decision 0012 + README feature bullet.

Out of scope:

- Piped/chained/substituted commands (always fall through — semantics differ:
  stdin-filtering grep, downstream transforms, shell glob expansion).
- Prompt-level nudges (option 3 from the design discussion — owner chose
  router only).
- `fd`, `rg --files`, `rg -w/-S/-t/-l`, `grep -v/-o/-c/-h`, `find -type/-mtime/
  -maxdepth/-exec/-iname`, multi-path `find`, `-name` values containing `/`.
  All rejected → bash.

## Context Map

- Read first: `extensions/fs-search.ts` (param shapes, `rg()` helper pattern),
  `src/fs-search/grep-core.ts` + `glob-core.ts` (interfaces `GrepParams`,
  `GlobParams`, results), `extensions/shell-bg.ts` `runBash` (line ~261),
  `src/common/rg-resolver.ts`.
- Affected docs: README (feature bullet), `docs/decisions/0012` (new).
- Guardrails: **no pi imports in `src/`**; matcher must be conservative to a
  fault — unknown flag, weird quoting, any shell metachar ⇒ `null`; zero
  behavior change for non-matching commands (existing 56 tests stay green).

## Matcher spec (the contract)

1. **Reject whole command** if it contains ANY of: `|` `&` `;` `<` `>` backtick
   `$` `~` `(` `)` newline — anywhere, including inside quotes (v1 simplicity;
   losses like `rg '\$\d+'` fall to bash, acceptable).
2. **Tokenize** by whitespace; `'...'` → literal; `"..."` → literal but reject
   if it contains `$` or backtick (still expands in shell); bare tokens honor
   `\X` escapes (lone trailing `\` ⇒ reject); unbalanced quote ⇒ reject.
3. **Unquoted token containing `*` `?` `[`** ⇒ reject (shell glob expansion
   changes semantics). Quoted is fine (literal).
4. **First token** must be exactly `rg|grep|ggrep|egrep|fgrep` (grep route) or
   `find` (glob route). No path prefixes; any token with `=` ⇒ reject (env
   assignment).
5. **rg accepted flags** (1:1 param mapping only): `-i`/`--ignore-case` →
   `ignoreCase`; `-F`/`--fixed-strings` → `literal`; `-C N`/`-CN`/`--context N`
   → `context`; `-g`/`--glob <glob>` → `include` iff single positive glob (not
   starting `!`); `-n` `--line-number` `--no-config` `--hidden` `-u` `-uu`
   `-uuu` → accept-ignore. **Everything else rejects** (notably `-w -S -s -t
   -l -a -A -B -o -v -c --files --type --smart-case -e`, any unknown).
   Positionals: first = `pattern`, rest = `path`(s); single path only, else
   reject; no pattern ⇒ reject.
6. **grep/egrep/fgrep accepted flags**: `-r` `-R` `--recursive` `-n` `-E`
   `--color` `--color=auto` `--color=never` → accept-ignore (`-E` OK because
   core regex is a superset; backrefs error loudly via
   SEARCH_INVALID_PATTERN, never silently wrong); `-i`/`--ignore-case` →
   `ignoreCase`; `-F` → `literal` (and `fgrep` implies literal); `-e <pat>` →
   pattern source; `--include=<glob>` → `include` iff positive single glob.
   **Reject**: `-l -o -c -w -v -h -A -B -P --exclude --exclude-dir`, unknown.
   Positionals: first = pattern, rest = single path. No path AND no `-r` ⇒
   reject (stdin mode). No pattern ⇒ reject.
7. **find**: at most one path positional (reject if it has glob chars or starts
   with `-`); exactly one `-name <value>` (value must NOT contain `/` — find
   matches basenames, our glob anchors on `/`; semantics differ ⇒ reject);
   `-print` accept-ignore; everything else rejects (incl. `-o`, `-a`, `-not`,
   second `-name`, no `-name` at all). Zero paths ⇒ path omitted (core defaults
   to cwd). find's `-name`-any-depth semantics match our glob's
   pattern-without-`/` exactly.
8. **Note prefix** on routed result text, one line, e.g.:
   `[fs-search] bash routed to grep semantics — hidden+gitignored included,
   caps + spill apply.` (wording flexible; must state routing + superset
   ignore semantics + caps/spill).
9. **details**: `{ routed: true, kind, ...core counts }` (grep:
   matchCount/fileCount/matchLimitReached/spillPath; glob: total/spillPath).
10. **Wrapper unwrap (Amendment A1, 2026-09-14)**: pi-ctx-kit rewrites bash
    commands through the rtk CLI before execution (its `tui.ts` `tool_call`
    handler mutates `input.command`: `rg foo` -> `rtk rg foo`). The router
    therefore strips **exactly one** leading token when it is in a whitelist,
    BEFORE applying rules 1-9 to the remainder:
    - Whitelist source: settings `bashRouter.unwrapPrefixes: string[]`,
      DEFAULT `["rtk"]` (owner daily-driver; revisit default `[]` before npm
      publish).
    - Explicit whitelist, never blind-stripping: `sudo grep x /root/f` must
      stay null (routing would drop sudo -> wrong semantics).
    - Single unwrap only — `rtk rtk rg x` => null. Unknown wrappers (`foo
      rg x`) => null. Unwrap applies before the dangerous-char scan; the
      stripped token itself is not scanned.
    - Non-search wrappers pass through untouched: `rtk read X` -> `read X` =>
      null => bash runs `rtk read X` as before.
    - Evidence rtk passthrough for search is loss-free: session logs 2026-09-14
      show `rtk rg`/`rtk grep` return raw command output.
    - API: `matchBashSearch(command, unwrapPrefixes?: readonly string[])`;
      default `[]` keeps the pure-function tests hermetic.

## Coordination / Handoff

- Integrating owner: main pi-utils session (bean).
- Delegated scope and actor: Sam — implementation + tests + docs + commit/push.
- Current state: design settled with owner (this packet is the contract);
  no code written yet.
- Next action or owner: Sam implements; main session verifies acceptance and
  flips Status to `implemented`.
- Blockers or open gaps: none.

## Acceptance / Proof

- `bun run check` green and `bun test` green — all 56 existing tests
  untouched + new router tests (every accept case asserts exact mapped params;
  every reject case from the spec matrix has a test).
- Glue is reachable only via `runBash` with `!background && timeout===undefined`;
  routed execution returns note-prefixed text + `details.routed`.
- Zero behavior change when matcher returns null (unchanged code path).
- Amendment A1: with `unwrapPrefixes: ["rtk"]`, `bash: rg <pattern> <path>`
  on a machine with the rtk rewriter active returns the routed note (the
  live smoke that failed on 2026-09-14). Unwrap matrix tested: prefixed
  searches route; `sudo ...`, double-prefix, unknown wrapper, `rtk read`, and
  empty-list configs all stay null.
- Decision 0012 written; README bullet added; pushed; CI green.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | router accept/reject matrix (tests/bash-router.test.ts) |
| Integration | routed execute through runBash (extension-level, verified by owner smoke test) |
| E2E | owner live smoke: `bash rg <pattern>` shows routed note |
| Platform | n/a |
| Release | n/a |

## Open Questions

- None — semantics settled in design discussion (2026-09-14); do not widen the
  matcher without a new owner decision.

- OWNER DECISION PENDING (cosmetic, out of pi-utils scope): after routing,
  pi-ctx-kit's `tool_result` filter (`searchResultGrouping` on
  `isSearchCommand`) re-processes routed output and stacks the
  `RTK compact output` note on top of the `[fs-search] routed` note.
  Routed results are already capped/formatted; owner may disable that one
  technique in pi-ctx-kit config. Packet records it; pi-utils does not
  touch pi-ctx-kit.
