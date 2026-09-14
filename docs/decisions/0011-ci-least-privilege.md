# 0011 — CI: least-privilege GitHub Actions

Status: accepted
Date: 2026-09-14
Supersedes: —

## Context

pi-utils is a private remote (`github.com/sting8k/pi-utils`) with two dev-time gates: `bun run check` (biome --error-on-warnings + tsc) and `bun test`. The first CI runs caught a real lint error and a silent bug that local runs had masked (redirected biome output), so the pipeline earns its keep. The workflow must run on runners where the sibling checkout `../pi-droid-styling` does not exist — the devDependency `"@sting8k/pi-droid-styling": "file:../pi-droid-styling"` would fail `bun install`.

## Decision

`.github/workflows/ci.yml`, on push (main) and pull_request:

1. **Least privilege**: `permissions: contents: read`, `persist-credentials: false`, zero secrets anywhere; `pull_request` (never `pull_request_target`) so fork PRs stay read-only.
2. **Supply chain**: third-party actions pinned to commit SHAs (mutable tags are a re-pointing risk); `timeout-minutes: 10`; `concurrency` cancels superseded runs.
3. **Sibling stub**: check out pi-utils into a sub-path and create a minimal stand-in `pi-droid-styling/package.json` before `bun install`. CI never imports the real package (tests pin a stub or an unresolvable specifier), so the stand-in only satisfies the `file:` resolution.
4. **ripgrep**: `apt-get install ripgrep` before tests — fs-search tests exercise the real `rg` binary (PATH-first resolver).

## Consequences

- Any future workflow edit must keep the four properties above; adding a secret or un-pinning an action needs a new decision, not a silent diff.
- New dev-time deps with `file:` paths outside the repo will need the same sibling-stub treatment.
- Publish-time CI (npm pack/publish) is out of scope until decision 0008's revisit.

## Evidence

- First-run failures that the pipeline caught and their fixes: unsafe optional chaining + unwired `withTiming` (`41213f5`), missing runner ripgrep (`45f78b8`).
- Green runs on every commit since, latest `34811800448` (`42dd577`).
