# Literature & Engineering Survey: LLMs & Decision Models in Tactical RTS (2024–2026)

This document synthesizes findings from academic papers, frontier model releases, and open-source prototypes to guide **Stage 3 (`stage:3-agent-v2`)** and inform **Stage 2 (`stage:2-rts-core`)** simulation interfaces. Detailed domain breakdowns live in [`docs/staging/agent-v2/`](./staging/agent-v2/README.md).

---

## 1. Key References Surveyed (2024–2026)

### 1.1 Spatial Reasoning, Continuous-to-Discrete Bridging & Multimodal Maps
- **`RTSGameBench` & `RTSGameAgent` (`arXiv:2606.18950v3`, Oct 2026)**: Large-scale VLM RTS benchmark built on *Beyond All Reason*. Ablations prove that per-unit continuous control fails (7% WR vs. 43% WR with group-level control), condition-dependent command trajectories sustain execution between sparse VLM calls (13% $\rightarrow$ 43% WR), and visual observations boost map control/vision coverage (`VC` 0.20 $\rightarrow$ 0.33) but require group-level spatial grounding.
- **`MapBench: Can Large Vision Language Models Read Maps like a Human?` (`arXiv:2503.14607`, 2025)**: Demonstrates that VLMs struggle with raw pixel map pathfinding and occlusion unless grounded by a **Map Space Scene Graph (MSSG)** encoding explicit `connect` (road), `adjacent`, and `observable` (LOS) edges.
- **`Learning to Draw ASCII Improves Spatial Reasoning` (`Text2Space`, `arXiv:2604.14641`, COLM 2026)** & **`Spatial Reasoning in LLM Game Agents` (`arXiv:2607.22732`, July 2026)**: Establish the **Read-Write Asymmetry** of symbolic grids (models read small local grids well but fail to mentally construct 2D geometry or raycast LOS from raw coordinates).
- **`COA-GPT` (`arXiv:2402.01786`), `WGSR-Bench` (`arXiv:2506.10264`), `WARBENCH` (`arXiv:2603.21280`), & Sean Goedecke’s `generals` (July 2025)**: Show that doctrinal posture commands, standing orders, and pre-computed terrain affordances outperform raw coordinate micro-stepping.

### 1.2 System-1 Decision Models vs. System-2 Generative LLMs
- **Google `Gemini Decision 1` (`gemini-decision-1`, Nov 11, 2026 Decisions API)**: Omni-modal (`text`, `image`, `audio`, `video`, `PDF`, 256K window) non-generative decision model that evaluates up to **1,000 independent questions** (`noul` Yes/No, `choice` 2–255 options, `score` ordered rubric) in a single forward pass with **150–250 ms E2E latency**, **0.0250 ECE calibration**, and **\$0.10/1M input tokens (\$0 output)**.
- **TypeSafe AI `Jev 1.14` (Sept–Nov 2026)**: Pioneered the "System One Model" pattern (*"Jev makes judgments, code makes decisions"*), demonstrating that deterministic arithmetic/rules (range, LOS, ammo) must remain in code while bounded contextual judgments are evaluated in parallel by the System-1 model.

### 1.3 Recurrent / Active Context Compression vs. Linear Context
- **`ReCAP: Persistent Context Graphs for Efficient Memory Compaction` (`arXiv:2609.40118`, Microsoft Research & UCSB, Sept 2026)**: Maintains an importance + dependency graph over history blocks and revives query-relevant blocks via entity/identifier overlap with **zero LLM calls** (<10 ms CPU), cutting cold-restoration latency by **95%** and beating full-history accuracy by **+19.8 to +41.2 points** while coexisting with KV prefix caching on warm turns.
- **`Focus: Active Context Compression` (`arXiv:2601.07190`, Jan 2026)** & **`Acon` (`arXiv:2510.00615`)**: Replace monotonic linear history with a "sawtooth" pattern that folds verbose intermediate tool traces into a persistent top-of-prompt knowledge block.

---

## 2. Three Core Architectural Decisions for Stage 2 & Stage 3

### 2.1 Discrete vs. Continuous & VLM Viewshed Grounding ([`01-spatial-discrete-vs-continuous-and-vlm.md`](./staging/agent-v2/01-spatial-discrete-vs-continuous-and-vlm.md))
1. **Continuous Core, Discrete Affordance Interface**:
   - The simulation (`src/sim/`) remains **continuous-time (1s ticks) and continuous-space (`Vec(x,y)`)** like *WARNO*.
   - To eliminate the LLM adaptation cost (适配代价), `src/perception/` bridges continuous space via a **Tactical Anchor Graph (TAG)**: deterministic TypeScript helpers sample and label candidate **Hull-Down Overwatch**, **Reverse-Slope Defilade (反斜坡阵地)**, **Treeline Edge (75m grazing buffer)**, and **Covered Approach** anchors around any objective or threat sector.
2. **Pre-Shaded Viewshed Crops Over Raw Contour Maps**:
   - Neither LLMs nor VLMs can reliably perform 3D elevation raycasting from raw contour lines to spot a reverse slope.
   - When feeding visual crops to a VLM or `Gemini Decision 1`, the renderer must bake in **WARNO-style LOS / Viewshed Shading** (Red = enemy LOS/fire envelope, Cyan = reverse-slope dead ground masked by a topographic crest with short-range LOS into a kill zone, plus `[A]..[Z]` candidate anchor badges).
3. **Stage 2 Simulation Requirements (`src/sim/map.ts` & `src/sim/world.ts`)**:
   - Distinguish hard **elevation crest masking** from **forest/town concealment** in LOS queries so reverse slopes can be identified mathematically.
   - Add **local cover/crest micro-snapping ($\le 75\text{ m}$)** in the platoon FSM so 4-digit grid orders automatically settle into adjacent treeline edges or reverse slopes.

### 2.2 Dual-Process C2: System-1 Decision Model + System-2 LLM ([`02-decision-models-vs-language-models.md`](./staging/agent-v2/02-decision-models-vs-language-models.md))
We separate tactical command into two complementary cognitive loops:
1. **System 1 (`Gemini Decision 1` / `Jev` — 150–250 ms Tactical Reflex & Scoring Plane)**:
   - Evaluates a single shared input (compact sitrep + optional viewshed image crop) against **20–100 parallel typed questions** in one pass (\$0.0002/call):
     - **Wakeup & Interrupt Gate (`noul` + `score`)**: Decides in 150ms whether battlefield changes invalidate `Alpha 6`'s plan or require reporting to `Steel 6`.
     - **Platoon Micro-Judgments (`noul` + `choice`)**: Triggers emergency defensive smoke, target prioritization among visible contacts, ambush fire-discipline (`hold_fire` vs. `open_fire_now`), and local crest pullback.
     - **255-Way Tactical Anchor Scorer (`choice` / `score`)**: Scores up to 64–255 engine-sampled candidate hull-down / reverse-slope / smoke positions in a single pass, feeding the top-ranked candidates to System 2.
   - **Guardrail Against Conditional Independence**: Because parallel questions in `Gemini Decision 1` cannot see each other's answers, multi-platoon role assignment is either orchestrated by System 2 or resolved by deterministic code over System 1's probability matrix.
2. **System 2 (`Alpha 6` Generative LLM — Event-Triggered Deliberative Commander)**:
   - Formulates multi-platoon Courses of Action (COA), maintains Commander's Intent, communicates naturally over the Battalion Radio Net with `Steel 6`, and issues doctrinal posture orders (`attack_by_fire`, `reverse_slope_ambush`, `move_covered`, `recon`, `smoke_barrage`).

### 2.3 $O(1)$ Recurrent Tactical Context Engine ([`03-recurrent-vs-linear-context-engineering.md`](./staging/agent-v2/03-recurrent-vs-linear-context-engineering.md))
To guarantee minimal TTFT, zero "Lost in the Middle" degradation, and zero critical-path summarization lag across hour-long battles, Agent v2 replaces linear FIFO history with a **4-Tier Recurrent Context Layout**:
1. **Tier 0 — Static System & Map Reference (~600 tokens)**: 100% KV-prefix cached.
2. **Tier 1 — Pinned Mission Frame & Operational Ledger $\mathcal{L}_t$ (~350 tokens)**: Never-evicted Battalion Intent from `Steel 6` + deterministic Enemy OOB / faded-contact tracker + active company plan state (updated *post-turn* off the critical path).
3. **Tier 2 — ReCAP-Selected Episodic Radio Buffer (~400–600 tokens)**: Retains the last $K=3$ turns (preserving warm prefix-cache hits during active radio exchanges) plus up to 2 older turns revived in $<1\text{ ms}$ via entity/grid overlap ($\ell_v$) when a place or unit is referenced again. Verbose read-only tool outputs (`describe_location`) are folded out immediately after each turn (`Focus` sawtooth rule).
4. **Tier 3 — Ephemeral Turn Perception (~500–800 tokens)**: Live radio inbox + Company Sitrep + top-ranked Tactical Anchor candidates (stripped immediately after the turn).
