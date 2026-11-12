---
name: Implementation / Research Sub-Issue
about: Structured, bounded task for autonomous agent execution
title: "[Stage X] "
labels: ["status:ready"]
---

## 1. Objective
- **Parent Master Issue**: #
- **Target Branch**: `feat/rts-core` | `feat/agent-v2` | `main`
- **Goal**: (1–2 sentences explaining what problem is solved and why)

## 2. Expected Changes
- `src/path/to/file.ts`:
  - In `functionName()`: exact logic/formula/signature change...

## 3. Blast Radius & Boundaries
- **Allowed files**: `src/...`
- **Out of scope**: Do NOT modify any other directories or add npm dependencies.
- **LOC budget**: ~XX lines added/modified.
- **Documentation**: Update `docs/architecture.md` only if as-built architecture changes; stage working notes (if any) go in `docs/staging/<domain>/`.

## 4. Dependencies
- **Parent**: #
- **Depends on**: None (or `#XX` — if open, label this issue `status:blocked`)
- **Blocks**: None

## 5. Verification
- [ ] `npm run typecheck` passes with 0 errors
- [ ] `npm run build` succeeds
- [ ] `npm run headless` completes and satisfies observable criteria: ...
- [ ] Post a 1–2 sentence progress comment with PR/commit link on the Parent Master Issue
