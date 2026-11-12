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
| `docs/ai-survey.md` | Synthesized literature survey & finalized Stage 3 design for LLM tactical command | Update when Stage 3 research milestones are consolidated |

### Staging & Temporary Directories
- **Domain Staging Directories (`docs/staging/rts-core/` and `docs/staging/agent-v2/`)**:
  - Used during Stage 2 and Stage 3 to hold working domain notes, mechanic breakdowns, or individual paper/project analyses before they are synthesized into `docs/ai-survey.md`, `docs/architecture.md`, or implementation Issues.
  - Files in `docs/staging/*/` have a **stage-bound lifecycle**: once their insights are distilled into permanent docs or completed Issues (and before Stage 4 merge), obsolete staging files must be pruned.
- **Local Scratch (`scratch/`, gitignored)**:
  - Never commit one-off debugging dumps or throwaway scripts to git. Put local throwaway files in `scratch/`.

## 3. Four-Stage Development Roadmap (`stage:*`)

All work is organized into four sequential/parallel stages so agents understand the intent and constraints of each Issue:

| Stage Label | Branch / Scope | Goal & Focus | What to Avoid |
| :--- | :--- | :--- | :--- |
| **`stage:1-stabilize`** | `main` | Fix obvious LLM scheduling quirks (debounce, step limits, in-flight order visibility) and basic platoon mechanics (standoff halt on attack) so the current baseline is stable and doesn't get in the way. | Do not redesign the agent architecture or add major new RTS mechanics here. |
| **`stage:2-rts-core`** | `feat/rts-core` | Develop the pure RTS simulation core (`src/sim/`), decoupled from the LLM. Modeled on **Eugen Systems** tactical wargames (*Wargame / WARNO / Regiments*): stealth/recon spotting, terrain cover & road mobility, range tiers, 4-tier morale/suppression, and indirect fire (HE + smoke). Focus on **mechanics** over content.Staging notes live in `docs/staging/rts-core/`. | Do not couple simulation mechanics to LLM prompts; everything must be testable via `npm run headless`. |
| **`stage:3-agent-v2`** | `feat/agent-v2` (research in parallel with Stage 2; code after Stage 2 stabilizes) | Survey how researchers/builders connect LLMs to RTS games (`docs/staging/agent-v2/` $\rightarrow$ `docs/ai-survey.md`), finalize a concrete C2 & spatial-tool design once Stage 2 mechanics are locked, and implement the upgraded LLM commander. | Do not prematurely code complex agent tools while Stage 2 RTS mechanics are still shifting. |
| **`stage:4-polish`** | Post-merge of Stage 2 & 3 into `main` | Merge `feat/rts-core` and `feat/agent-v2`; prune `docs/staging/`; refine scenarios/content, visual art, UI/UX, bug fixes, and code cleanup. | No speculative plans beyond Stage 4. |

## 4. Rules for Authoring & Managing Issues

We distinguish between **Stage Master Issues (Tracking Boards)** and **Implementation Sub-Issues (Executable Tasks)**:

### 4.1 Stage Master Issues (Tracking Boards Only)
- Each active stage has a single open **Master Issue** (e.g., `[Stage 2 Master] ...`, `[Stage 3 Master] ...`) labeled `type:master`.
- **Purpose**: Indicates that the stage is currently in progress and serves as the index/log for that stage.
- **Strict Rule**: Agents must **NEVER** attempt to "solve" or close a Master Issue directly with a monolithic PR.
- **Progress Updates**: Whenever a sub-issue, research note, or milestone is completed under a stage, post a **brief comment (1–2 sentences + issue/commit/file link)** on the Master Issue to record progress.
- **Dispatching Work**: All concrete coding or research execution must be published as separate, structured **Sub-Issues** that reference the Master Issue (`Parent: #<master-id>`).

### 4.2 Authoring Implementation & Research Sub-Issues
When proposing or creating an executable Sub-Issue (using `.github/ISSUE_TEMPLATE/implementation_task.md`), the author **must**:
1. **Foresee Exact Changes**: Inspect the codebase first and list the specific files, functions, data structures, and formulas to be added or modified. Do not publish vague "figure out how to do X" implementation issues.
2. **Define a Strict Blast Radius**: Explicitly list `Allowed files`, `Out of scope` exclusions, Target Branch (`feat/rts-core`, `feat/agent-v2`, or `main`), and a tight `LOC budget`.
3. **Declare Dependency Locks**: Set `Parent: #<master-id>`, `Depends on: #...`, and `Blocks: #...`. If any `Depends on` issue is still open, label the new issue `status:blocked`; otherwise label it `status:ready`.
4. **Specify Observable Verification**: Include deterministic commands (`npm run typecheck`, `npm run build`, `npm run headless`) and concrete behavioral checks.

### 4.3 Label Taxonomy
- **Module (`area:*`)**: `area:sim`, `area:agent`, `area:ui`, `area:docs`
- **Stage (`stage:*`)**: `stage:1-stabilize`, `stage:2-rts-core`, `stage:3-agent-v2`, `stage:4-polish`
- **State (`status:*`)**: `status:ready`, `status:blocked`, `type:master`

### 4.4 Required Sub-Issue Sections
Every executable Sub-Issue must contain:
1. **Objective** — What problem is being solved and why (plus `Parent: #<master>` and `Target branch: ...`).
2. **Expected Changes** — Exact files, functions, and logic to add/modify.
3. **Blast Radius & Boundaries** — Allowed files, out-of-scope areas, and approximate LOC budget.
4. **Dependencies** — `Parent: #...`, `Depends on: #...`, and `Blocks: #...`.
5. **Verification** — Concrete commands and observable criteria.
