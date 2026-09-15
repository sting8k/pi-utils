# 0013 Session-isolated job registry (shell-bg)

Date: 2026-09-15

## Context

Live incident (2026-09-15): two pi sessions working in the same directory
cross-delivered each other's background-shell output — one session's bash
results contained another session's file listings, docs reads, and CI-status
JSON, prepended to (and sometimes replacing) the real output. The owner had
seen the phenomenon before; this session captured it mid-diagnosis.

Root cause chain:

1. `extensions/shell-bg.ts` scoped the job-registry directory with
   `sessionKey(cwd)`, which preferred `process.env.PI_SESSION_ID` and fell
   back to `sha256(cwd)`.
2. pi injects `PI_SESSION_ID` only into **bash child processes**
   (`resolveSpawnEnvironment` in core/tools/bash), never into the extension
   host — so the env branch could never fire where it was read, and every
   session silently took the cwd hash.
3. Same cwd ⇒ same `tmpdir()/pi-utils-shell-bg/<cwdhash>/` ⇒ shared
   `logs/bg-N.log` paths, shared `<id>.json` sidecars, shared `delivered`
   flags, and one ID-counter space. Concurrent sessions then interleave:
   ID collisions make two jobs write one log file, and whichever session
   polls first delivers the other's finished jobs into its own conversation.

## Decision

- The registry key is `ctx.sessionManager.getSessionId()` — the same value
  pi itself uses for `PI_SESSION_ID` — with a last-resort fallback to the
  extension host's pid (unique per concurrent process, stable across
  `/reload`, which keeps the load-and-reconcile path working). The cwd is
  deliberately NOT part of the key.
- Implemented as pure helpers in `src/shell-bg/registry.ts`
  (`sessionKeyFor`, `gcSessionDirs`); the extension passes the session id
  from its context. No pi imports in `src/` (guardrail intact).
- Per-session dirs accumulate; `gcSessionDirs` sweeps siblings older than
  24 h at session start, always sparing the current session's dir. Best
  effort — failures wait for the next sweep.
- No migration: sessions upgrading mid-flight lose sight of their old
   cwd-hash dirs (jobs are transient; worst case an in-flight result is
  not delivered). One-time cost, accepted.

## Consequences

- Concurrent sessions in one directory no longer share any job state;
  cross-delivery is structurally impossible, not filtered.
- `/reload` behavior unchanged: same session id ⇒ same dir ⇒ jobs are
  reconciled as before.
- Anyone debugging by hand finds dirs keyed by session id (or `p<pid>`)
  under `tmpdir()/pi-utils-shell-bg/` — opaque, but GC keeps the set small.
