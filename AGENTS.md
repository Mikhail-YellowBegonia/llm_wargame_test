# Agent & Contributor Guidelines (`AGENTS.md`)

This repository is an experimental browser tactical RTS with an LLM chain of command.
Most implementation tasks are dispatched as GitHub Issues and executed autonomously by coding agents.

## 1. Golden Rules for Agents Executing Issues

1. **Respect Dependency Locks (`status:blocked`)**:
   - Never start work on an Issue labeled `status:blocked` or whose `Depends on` issues are still open.
   - When an Issue you finish unblocks downstream Issues, note it in your PR/closing comment.
2. **Strict Blast Radius (`Allowed files`)**:
   - Every Issue specifies **Allowed files** and **Out of scope** boundaries.
   - Do **NOT** touch files outside the allowed list unless required to fix a direct TypeScript compile break caused by your change.
   - Do **NOT** add new npm dependencies unless the Issue explicitly asks for one.
   - Respect the **LOC budget**: keep solutions compact, direct, and free of speculative abstractions.
3. **Verification Gate**:
   - Before committing or closing an Issue, all three must pass:
     ```bash
     npm run typecheck
     npm run build
     npm run headless
     ```

## 2. Documentation Lifecycle (Anti-Bloat Policy)

Only **three** permanent documentation files exist in this repository:

| File | Purpose | Update Rule |
| :--- | :--- | :--- |
| `AGENTS.md` | Rules for agents, Issue contract, and workflow | Update only when repo governance changes |
| `docs/architecture.md` | **As-built** system architecture, module boundaries, and data flow | Update in the same commit whenever implemented architecture changes |
| `docs/ai-survey.md` | Literature survey & Stage 3 design notes for LLM tactical command | Update during Stage 3 research/design |

- **Temporary Documents**: Never commit scratch notes, one-off plans, or investigation dumps to git. Put temporary files in `scratch/` (gitignored) or directly in GitHub Issue comments.

## 3. Issue Template & Label Taxonomy

### Labels
- **Module (`area:*`)**: `area:sim`, `area:agent`, `area:ui`, `area:docs`
- **Stage (`stage:*`)**: `stage:1-stabilize`, `stage:2-rts-core`, `stage:3-agent-v2`, `stage:4-polish`
- **State (`status:*`)**: `status:ready`, `status:blocked`

### Required Issue Sections
Every Issue must contain:
1. **Objective** — What problem is being solved and why.
2. **Expected Changes** — Exact files, functions, and logic to add/modify.
3. **Blast Radius & Boundaries** — Allowed files, out-of-scope areas, and approximate LOC budget.
4. **Dependencies** — `Depends on: #...` and `Blocks: #...`.
5. **Verification** — Concrete commands and observable criteria.
