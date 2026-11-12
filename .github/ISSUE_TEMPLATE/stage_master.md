---
name: Stage Master Tracking Issue
about: Stage-level tracking board (do NOT implement directly as a monolithic PR)
title: "[Stage X Master] "
labels: ["type:master"]
---

> **Tracking Board Only**: This Master Issue indicates that Stage X is active.
> - **Do NOT** attempt to implement or close this Master Issue with a single monolithic PR.
> - Dispatch all concrete tasks as structured Sub-Issues (`implementation_task.md`) referencing this issue as `Parent: #<id>`.
> - Track progress by posting a **1–2 sentence comment + link** (`#sub-issue`, commit, or `docs/staging/` file) whenever a milestone completes.

## 1. Stage Scope & Branch
- **Branch**: `feat/...`
- **Staging Directory**: `docs/staging/...`
- **Permanent Doc Target**: `docs/...`

## 2. Planned Workstreams (Dispatched via Sub-Issues)
- [ ] Workstream 1: ...
- [ ] Workstream 2: ...
