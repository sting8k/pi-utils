# US-002 Per-tool disable list (disabledTools)

## Status

planned

## Lane

normal

## Goal

A single top-level settings key `disabledTools: string[]` in
`<agentDir>/pi-utils.json` that disables individual pi-utils tools at
registration time. Pi already toggles whole extensions (coarse, per file in
`package.json → "pi".extensions`); this is the fine-grained layer inside
pi-utils: turn off one tool, keep the rest of the module running.

## Scope

In scope:

- `src/common/settings.ts`: new top-level field `disabledTools: string[]`
  (default `[]`), exported `KNOWN_TOOLS` constant, parse + validation.
- `extensions/fs-search.ts`: skip `pi.registerTool` for a disabled tool.
- `extensions/shell-bg.ts`: skip `pi.registerTool` per disabled tool; skip
  widget wiring when `bash` is disabled.
- README settings documentation + layering note.
- Unit tests for settings validation; glue tests for skip-registration.

Out of scope:

- Runtime toggling (settings are read once at startup — `/reload` applies,
  same as every other pi-utils setting).
- Per-section `enabled` flags (one disable mechanism only — two places
  deciding the same thing is a bug farm).
- Unregistering tools mid-session.

## Owner decisions already settled (do not relitigate)

- **`bash` is a cluster head** — disabling it pulls the widget, bash routing,
  and background jobs along. There is intentionally NO way to disable the
  bash override but keep the widget. (Owner, 2026-09-14: "rõ ràng rồi, bình
  thường mà".)

## Spec (the contract)

1. **Settings shape** (`src/common/settings.ts`):
   - `PiUtilsSettings` gains top-level `disabledTools: string[]`.
   - `DEFAULT_SETTINGS.disabledTools = []`.
   - Export `KNOWN_TOOLS = ["grep", "glob", "bash", "shell_status",
     "shell_kill"] as const` (single source of truth; extensions must NOT
     hardcode their own copy — import it).
2. **Parse semantics** in `loadSettings`:
   - Key missing → keep default `[]` **silently** (pre-existing files must
     not start warning — same precedent as bashRouter Amendment A1).
   - Not an array → warning `` `disabledTools invalid (…)— using default` ``
     + default.
   - Entry is a string but not in `KNOWN_TOOLS` → warning (typo protection,
     name the bad entry) + drop that entry, keep the valid rest.
   - Entry not a string → same as above (warn + drop).
   - Duplicates → dedupe silently.
   - Warnings flow through the existing `warnings[]` channel (surfaced via
     `ctx.ui.notify` by the extension layer as today).
3. **Extension behavior**:
   - `extensions/fs-search.ts` `registerTools()`: if `"grep"` disabled, skip
     the `pi.registerTool({ name: "grep", … })` call at line ~78; same for
     `"glob"` at ~177. Independent of each other.
   - `extensions/shell-bg.ts` `registerTools()`: same per-tool skip for
     `"bash"` (~512), `"shell_status"` (~549), `"shell_kill"` (~592).
   - `"bash"` disabled → additionally do not wire the Jobs widget (widget
     shows jobs; with the override off no jobs can exist).
   - Disabling an override means pi's native tool (if any) stays in charge;
     for tools pi has no native equivalent of, the tool is simply absent.
     README must state both cases.
4. **No behavior change** for anyone whose settings have no
   `disabledTools` key or an empty list.

## Context Map

- Read first: `src/common/settings.ts` (whole file — parse patterns
  `applyNum`/`applyBool`, the bashRouter section is the closest precedent
  for optional-array parsing), `extensions/fs-search.ts`
  (`registerTools`, line ~77), `extensions/shell-bg.ts` (`registerTools`,
  line ~511 — note it is called twice: once eagerly with `null` at ~235 and
  once after droid renderers load at ~235; keep BOTH call sites gated, not
  just one).
- Affected docs: README (settings block + layering note), this packet.
- Guardrails: no pi imports in `src/` (settings stays pure); existing tests
  untouched; biome + tsc clean.

## Coordination / Handoff

- Integrating owner: main pi-utils session (bean).
- Delegated scope and actor: Xi — implementation + tests + docs +
  commit/push.
- Current state: design approved by owner 2026-09-14 (this packet is the
  contract); no code written yet.
- Next action: Xi implements; main session verifies acceptance and flips
  Status to `implemented`.

## Acceptance / Proof

- `bun run check` green; `bun test` green (all existing tests untouched).
- New tests, at minimum:
  - settings: valid list parses; missing key → `[]` silent (no warning);
    non-array → warning + default; unknown entry → warning naming it +
    dropped while valid siblings survive; dedupe.
  - glue (extensions): with `"grep"` disabled, grep is not registered while
    glob still is; with `"bash"` disabled, bash/status/kill are not
    registered (mock the `pi` extension API the way existing glue tests do).
- README documents the settings key, the `bash` cluster semantics, and the
  layering: whole module → pi's extension toggle; single tool →
  `disabledTools`.
- Committed + pushed; CI green.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | settings validation matrix (tests/common-settings.test.ts additions) |
| Integration | glue: registration skipped per tool (tests/ extension-level, mocked pi API) |
| E2E | owner smoke: set `"disabledTools": ["glob"]`, `/reload`, glob tool absent, grep still pi-utils |
| Platform | n/a |
| Release | n/a |

## Open Questions

- None. (Whether pi has a native `glob` tool — affecting only README
  wording about "tool absent vs native fallback" — is a fact Xi verifies
  while writing the README, not a design question.)
