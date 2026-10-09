# US-005 skills — organization + two-tier index

## Status

implemented — design approved 2026-10-09.

## Lane

normal

## Problem

- `category` is optional on create and nothing tells the agent which
  categories exist → with a few hundred learned skills, nearly all
  pile up at the skills root.
- US-004 smart index demotes whole categories when over
  `indexFullLimit`; with most skills in the root bucket a fresh
  session shows ZERO descriptions (probe: 80 root skills, limit 70 →
  0 full, 80 demoted).
- Reading one skill re-expands its category → the system prompt
  changes mid-session → prompt-cache bust.
- The native full index grows with every description; names-only is
  ~10× smaller and class-level names already carry signal.

## Goal

Skills organized by **work context**, and an index that is small,
**session-stable** (cache-safe), and still surfaces what the agent
needs, best-effort.

## Design

### Layout

- `skills/<category>/<name>/SKILL.md`, exactly one category level.
- ~10–13 categories, 10–35 skills each, split by the context the agent
  is in when it needs the skill (not by skill type), e.g. `testing`,
  `git-release`, `ui-render`. The user picks the set.
- No category config key: the valid set = existing category dirs on
  disk. Root-level skills are legacy (shown under `uncategorized`).

### skill_write

- `create`: `category` required — an existing category dir, or a new
  one with `new_category: true`. Error lists categories with counts on
  one line, e.g. `categories: git-release(14) testing(22) …`.
- `patch` / `delete`: locate the skill by `name` alone (unique across
  the skills root); `category` optional, ignored if consistent, error
  if it contradicts. Ambiguous name → error listing locations.
- `move`: `name` + target `category` (+ `new_category` for a new one);
  snapshot/rollback discipline as US-003; read-before-write guard
  applies (same as patch/delete). Seen-map entry follows the move.
- Tool description + rules block: one short sentence — pick the
  category by the context the skill is used in.

### Index — tier 1: stable catalog (system prompt)

- Computed ONCE per session (first `before_agent_start`), reused
  verbatim every turn → no mid-session system-prompt change.
- Same visibility filters as US-004 (platforms / requires / dirs /
  disable-model-invocation); same root grouping + collision rules.
- Per category one line: `<category name="…">a, b, c</category>`.
- `core` group: up to N (default 15, setting `skills.coreLimit`) most
  used skills with descriptions truncated to ~100 chars (first
  sentence when shorter). Usage = successful `read()` of a SKILL.md,
  counted across sessions in a small JSON file under the agent dir
  (decay or 30-day window; implementer's choice, documented).
- Drop US-004 step 5 (recently-used re-expansion) — it is the cache
  buster. Keep quality flags only where they cost ~nothing.
- Budget: ≈2–2.5k tok for a few hundred skills.

### Index — tier 2: per-turn hint (cache-safe)

- `before_agent_start` returns `message` (custom message appended to
  the conversation, not the system prompt).
- Rank skills lexically (BM25-ish, pure, no embeddings) against: the
  user prompt + cwd segments + recently touched file paths / tool
  names. Score over name tokens, description, tags.
- Emit up to 3–4 above a threshold, desc truncated ~120 chars; nothing
  when none qualifies. Never re-hint a skill already hinted or read
  this session. Target 0–150 tok per turn.
- Caveat: prompts are often Vietnamese, descriptions English →
  language-neutral signals (cwd, paths, tool/command names, proper
  nouns) carry most of the weight. Best-effort.
- Setting to disable (`skills.hint: false`).

### Implementation notes — tiers 1–2

- **Usage file** `~/.pi/agent/pi-utils-skill-usage.json`:
  `{skills:{<name>:{score,ts}}}`, keyed by skill NAME (survives moving
  a skill between categories). Exponential decay, half-life 30 days
  (`score` = decayed use-count as of `ts`; a use adds 1; entries below
  0.05 are pruned on write). A skill counts once per session
  (re-reads add nothing). Corrupt/unreadable → warning toast, empty
  usage; the next use rewrites a fresh file. Cold start → no `core`
  group (no padding with arbitrary skills). Read-merge-write + atomic
  rename; concurrent sessions can lose at most one tick.
- **Catalog** layout: `# core (most used)` entries carry
  `category="…"`; `# categories in <root> — file =
  <category>/<name>/SKILL.md` then one `<category>` line each (all
  names, sorted, core members included; root-level skills show as
  `uncategorized`). Skills outside the skills root keep a per-root
  group with ≤100-char descriptions. `skills.indexFullLimit` is gone.
  Dropped the `overlap` / `missing description` flags (token cost per
  occurrence); kept malformed (`name⚠`).
- **Hint**: BM25F-lite, fields name×3 / tags×2 / description×1, k1 1.2,
  b 0.75, tiny suffix stemmer + English stopword list (kebab names
  contain "is/for/in"). Query = prompt ∪ cwd's last 2 segments ∪ last
  12 touched paths (dir+file name) ∪ non-builtin tool names and bash
  command heads. Floor: score ≥ 7 and ≥ half the best score, max 4.
  Calibrated by hand on a real set of a few hundred skills: rare name word ≈6–9, rare
  description-only word ≈3–5, incidental single words 4–6. Rides on
  the smart index (candidates = the catalog's visible skills,
  computed once per session); `skills.index: native` → no hint.
  Delivered as `message` `{customType:"skill-hint", display:false}`.
  Hinted names reset per session (a resumed session may re-hint).
- **Measured** on a real set of a few hundred skills: tier 1 is ≈11%
  of the native block (≈2.3k tok with a 15-skill core, ≈1.8k without,
  chars/4). Hint is 0 tok when nothing qualifies, otherwise ≈50–140 tok
  for 1–3 hints and ≈150–200 for 4. Probe: "release a new version and
  publish to npm" → release/publish skills; "explain how this function
  works" → none.

### Existing skills

Moving an existing flat skills dir into categories is a one-off,
user-side step (back up first; `skill_write` `move` covers single
skills). It is not shipped in this package.

## Acceptance

- [x] create without category → error with the one-line category list;
      `new_category` creates; existing category works.
- [x] patch/delete/move find a skill by name in any category; guard
      still enforced; move rolls back on failure.
- [x] tier-1 block identical across turns of one session even after
      reads (test asserts byte-identical system prompt on turn 2).
- [x] core group respects limit + truncation; usage file survives
      restart; corrupt file → ignored with warning, not a crash.
- [x] hint: relevant prompt yields ≤4 skills; unrelated prompt yields no
      message; no repeats within a session.
- [x] token budget measured on a real skill set and recorded.
- [x] `bun test` + `npm run check` green; US-004 doc updated where its
      contract changed (step 5 removed).
