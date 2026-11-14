# Stage 3 Domain Staging: LLM Tactical Command (`docs/staging/agent-v2/`)

This directory holds individual paper/project breakdowns, spatial representation experiments, and prompt/tool design drafts during **Stage 3 (`stage:3-agent-v2`)**.

## Staged Research Documents
- [`00-research-charter.md`](./00-research-charter.md) — Verbatim problem statement (离散 vs 连续, 语言模型 vs 决策模型, 循环上下文 vs 线性上下文), research roadmap, and Stage 3 sub-issue index.
- [`01-spatial-discrete-vs-continuous-and-vlm.md`](./01-spatial-discrete-vs-continuous-and-vlm.md) — Continuous Eugen-style RTS vs. discrete LLM spatial cognition, adaptation cost, VLM map reading & reverse-slope ("反斜坡") viewshed overlays, and design feedback for Stage 2 (`src/sim/`).
- [`02-decision-models-vs-language-models.md`](./02-decision-models-vs-language-models.md) — Deep dive into Nov 2026 Decision Models (`Gemini Decision 1` & TypeSafe `Jev 1.14`), capability boundaries (conditional independence trap, "models make judgments, code makes decisions"), and our Dual-Process (System 1 + System 2) C2 architecture.
- [`03-recurrent-vs-linear-context-engineering.md`](./03-recurrent-vs-linear-context-engineering.md) — Survey of 2025–2026 agent context compression (`ReCAP`, `Focus`, `RTSGameAgent` STM/LTM) and design of the $O(1)$ Recurrent Tactical Context Engine.

## Lifecycle Rules
1. Use this folder to stage detailed notes on specific papers, benchmarks, or open-source RTS-LLM projects before synthesizing confirmed conclusions into `docs/ai-survey.md`.
2. Once Stage 2 RTS mechanics stabilize and the Agent v2 design is finalized in `docs/ai-survey.md` (and implemented in `src/agents/` + `src/perception/`), prune obsolete staging files before Stage 4 merge.
