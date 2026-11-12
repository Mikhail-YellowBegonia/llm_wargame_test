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

## 3. Four-Stage Development Roadmap (`stage:*`)

All work is organized into four sequential/parallel stages so agents understand the intent and constraints of each Issue:

| Stage Label | Branch / Scope | Goal & Focus | What to Avoid |
| :--- | :--- | :--- | :--- |
| **`stage:1-stabilize`** | `main` | Fix obvious LLM scheduling quirks (debounce, step limits, in-flight order visibility) and basic platoon mechanics (standoff halt on attack) so the current baseline is stable and doesn't get in the way. | Do not redesign the agent architecture or add major new RTS mechanics here. |
| **`stage:2-rts-core`** | `feat/rts-core` (or `main` via atomic PRs) | Develop the pure RTS simulation core (`src/sim/`), decoupled from the LLM. Modeled on **Eugen Systems** tactical wargames (*Wargame / WARNO / Regiments*): stealth/recon spotting, terrain cover & road mobility, range tiers, 4-tier morale/suppression, and indirect fire (HE + smoke). Focus on **mechanics** over content. | Do not couple simulation mechanics to LLM prompts; everything must be testable via `npm run headless`. |
| **`stage:3-agent-v2`** | `feat/agent-v2` (research in parallel with Stage 2; code after Stage 2 stabilizes) | Survey how researchers/builders connect LLMs to RTS games (`docs/ai-survey.md`), finalize a concrete C2 & spatial-tool design once Stage 2 mechanics are locked, and implement the upgraded LLM commander. | Do not prematurely code complex agent tools while Stage 2 RTS mechanics are still shifting. |
| **`stage:4-polish`** | Post-merge of Stage 2 & 3 | Merge RTS core and Agent v2 branches; refine scenarios/content, visual art, UI/UX, bug fixes, and code cleanup. | No speculative plans beyond Stage 4. |

## 4. Issue Template & Label Taxonomy

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
