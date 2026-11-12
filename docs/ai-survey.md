# Literature & Engineering Survey: LLMs in Tactical RTS & Wargames (2024–2026)

This document records findings from academic papers and open-source prototypes to guide **Stage 3 (`stage:3-agent-v2`)** after the Stage 2 RTS core (`stage:2-rts-core`) stabilizes.

## 1. Key References Surveyed
- **TextStarCraft II / Chain of Summarization (2024–2025)**: Hierarchical text abstraction and ephemeral state injection.
- **COA-GPT & Military C2 Agents (2024–2026)**: Course-of-action generation using doctrinal terrain semantics and simulation-in-the-loop feedback.
- **Sean Goedecke’s Generals / RTS Agent Prototype (July 2025)**: Tactical posture commands and localized terrain views.
- **WGSR-Bench (`arXiv:2506.10264`), HIMA (`2025`), MASMP (`arXiv:2510.18395`), RTSGameBench (`arXiv:2606.18950`)**: Multi-agent hierarchical planning, order thrashing failure modes, and spatial reasoning bottlenecks.
- **Read-Write Asymmetry in ASCII Maps (`arXiv:2604.14641`) & Spatial Reasoning in LLM Game Agents (`arXiv:2607.22732`)**: Empirical limits of raw coordinates and large ASCII grids vs. pre-computed geometric affordances.

## 2. Core Engineering Principles for Stage 3

1. **Never Make the LLM Do Raycasting or Blind Coordinate Guessing**:
   - Raw 4-digit grids are fine as tool arguments, but LLMs cannot reliably infer line-of-sight (LOS), elevation masking, or intervening forest corridors from a list of landmark coordinates.
   - Deterministic TypeScript helpers should pre-compute candidate **hull-down / overwatch positions** (cover + LOS to target) and **defilade / staging positions** (masked from target LOS) around any queried location.
2. **Small Local Terrain Patches vs. Full-Map ASCII**:
   - Large (`40×40`) ASCII maps cause row/column offset hallucinations and waste tokens.
   - A compact local patch (`9×9` at 100m resolution) paired with explicit candidate coordinates gives local topological intuition without token bloat.
3. **Tactical Postures Over Raw Euclidean Waypoints**:
   - Subordinate platoon FSMs should execute doctrinal postures (`attack_by_fire` / standoff halt, `move_covered`, `recon` / halt-on-contact, `road_march`) so the LLM commands *intent* rather than micro-stepping waypoints.
4. **Ephemeral Sitrep + Debounced Event Wakeups**:
   - Inject full sitreps only on the active turn and strip them from message history (already implemented in `commander.ts`).
   - Coalesce bursty combat events over a short window (e.g., 4 game seconds) and surface in-flight radio orders in the sitrep to prevent duplicate order thrashing.
5. **Avoid Obsolete 2023–2024 Scaffolding**:
   - Do not build multi-agent internal debate committees ("Intel LLM -> Planner LLM -> Critic LLM") for a single commander; modern native tool-calling models handle multi-step assessment and order dispatch in a single loop at a fraction of the latency.
