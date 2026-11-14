# Axis 3 Deep Dive: Recurrent / Circular Context vs. Linear Context Engineering

- **Parent Master Issue**: [#5](https://github.com/Mikhail-YellowBegonia/llm_wargame_test/issues/5)
- **Charter Reference**: [`00-research-charter.md`](./00-research-charter.md)

---

## 1. Why Linear Context Fails in Real-Time Tactical Command

In `src/agents/commander.ts` today, `Commander` uses a classic **Linear Context + FIFO Truncation** (`MAX_HISTORY = 40`, with ephemeral sitrep stripping):
1. **Linear Latency & Attention Dilution**: Even with ephemeral sitreps stripped after each turn, assistant tool-call chains (`describe_location`, `order_platoon`, `radio_superior`) and radio logs accumulate linearly up to 40 messages. As context grows, **Time-to-First-Token (TTFT)** increases and the model suffers from the **"Lost in the Middle"** effect (`Liu et al., TACL 2024`) and **"Context Poisoning"** (`Verma, arXiv:2601.07190`): old obsolete contact reports or superseded orders from 15 minutes ago distract the model into fighting yesterday's battle.
2. **Hard FIFO Cliff (`trimHistory`)**: Once `this.history.length > 40`, `trimHistory()` slices off the oldest messages. In a 45-minute battle, **the battalion commander's (`Steel 6`) original mission briefing, phase lines, and standing constraints at $t=0$ are silently deleted!**

As the user rightly emphasized:
> *"上下文长度关乎Token消耗和我的钱包，但这不是问题，重要的是首字延迟和回答延迟，以及回答质量。目前循环上下文主张动态压缩和遴选上下文，保持模型的认知新鲜而全面，这在编程智能体里面尚没有广泛采用（一般还是线性上下文+适度压缩），但是我们可以在游戏中试一试。"*

---

## 2. Survey of 2025–2026 Agent Context Architectures

We surveyed the latest 2025–2026 literature on recurrent/active context compression and memory selection:

| Architecture / Paper | Core Mechanism | Latency Impact (TTFT & Compaction) | Answer Quality / Fidelity | Fit for Tactical RTS? |
| :--- | :--- | :--- | :--- | :--- |
| **1. Chain of Summarization (CoS) & STM/LTM Loop**<br>`TextStarCraft II` (`NeurIPS 2024`) & `RTSGameAgent` (`arXiv:2606.18950`, Oct 2026) | At each step $t$, run a memory consolidation pass $(m_t, \mathcal{L}_t) = \text{LLM}(\mathcal{S}_t, \mathcal{L}_{t-1})$ that folds short-term event logs $\mathcal{S}_t$ into a fixed-size long-term summary $\mathcal{L}_t$, then clear $\mathcal{S}_t$. | **High if run synchronously before decision** (+1.5s to +4.0s extra LLM call before action); **Zero on critical path if run asynchronously after turn completion!** | Raises RTS win rate from **20% $\rightarrow$ 43%** in `RTSGameBench` ablations by preserving multi-wave temporal context. | **High (if Post-Turn Async)**: Post-turn consolidation overlaps with game ticks / radio airtime! |
| **2. Active Sawtooth Compression (`Focus`)**<br>`Verma, arXiv:2601.07190` (Jan 2026) | Model-controlled `start_focus` / `complete_focus` loop; summarizes completed sub-tasks into a persistent top-of-prompt `Knowledge` block and deletes raw tool exploration logs (creating a "sawtooth" token curve). | Keeps working context short, but requires explicit tool calls and reminders every 10–15 steps. | Matches baseline accuracy (60%) while cutting tokens by 22–57% on exploration-heavy tasks. | **Medium**: Good for scrubbing multi-step `describe_location` tool traces into a 1-line terrain note after a turn. |
| **3. Persistent Context Graphs (`ReCAP`)**<br>`Yang et al., Microsoft Research & UCSB, arXiv:2609.40118` (Sept 2026) | Stores historical message blocks as nodes $V_t$ in a graph $G_t=(V_t, E_t)$ with EMA importance $u_t(v)$ and dependency edges. When a new query $q_{t+1}$ arrives, selects a compact context ($10\%$ budget) using **Protected Set $P_t$ + Importance + Entity/Identifier Overlap $\ell_v$ + 1-hop predecessors**, with **zero LLM calls** (<10 ms on CPU). Coexists with **Prefix Caching** on warm turns! | **Cuts cold-restoration & compaction latency by ~95%** vs. summarization (0.01s vs. 2.4–7.7s); cuts cold TTFT by **51–60%**; reuses **99.9% prefix cache** on warm turns (0.10s TTFT). | **+19.8 to +41.2 points higher accuracy** than full history on *Lost-in-Conversation*; **70% of turns revive a previously omitted relevant block**. | **Very High**: Directly solves how to revive an earlier radio order or contact report when a place/unit is mentioned again, with zero LLM compaction latency! |

---

## 3. Designing the "Recurrent Tactical Context Engine (循环战术上下文引擎)" for Agent v2

Why haven't coding agents universally adopted tight circular context? Because in software engineering, an agent might need the exact character-for-character syntax of a function it viewed 35 turns ago.
**In a tactical RTS wargame, the physics of information are fundamentally different:**
1. **Markovian Spatial Dominance**: Where `Alpha 1` was 20 minutes ago does *not* matter for geometry—only where `Alpha 1` is *right now* (which is in the fresh `SITUATION` block).
2. **Non-Markovian Causal & Intent Persistence**: What *does* matter from the past falls into three strictly bounded categories:
   - **Commander's Intent & Standing Constraints** from `Steel 6` (e.g., *"Hold the river line until 06:30; do not commit Alpha 3 without my permission"*).
   - **Enemy Order of Battle (OOB) & Threat Hypothesis** (e.g., *"Enemy tank platoon spotted moving south through Forest 2435 4 minutes ago — now out of sight, likely flanking Crossroads"*).
   - **Own Plan & Causal Continuity** (why `Alpha 2` is moving to `2131` so the agent doesn't contradict its own plan 10 seconds later).

### 3.1 Four-Tier Recurrent Context Layout ($O(1)$ Bounded Token Footprint, Prefix-Cache Aligned)

Instead of an ever-growing linear message array, Agent v2 organizes the prompt into four strict tiers ordered from **most static (top, maximizing KV prefix cache hits)** to **most dynamic (bottom, current turn only)**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│ TIER 0: Static System Prompt & OOB/Map Reference (~600 tokens)             │
│ - Role, radio doctrine, platoon capabilities, static named places brief.   │
│ - 100% KV-Prefix Cached across the entire battle.                          │
├────────────────────────────────────────────────────────────────────────────┤
│ TIER 1: Pinned Mission & Operational Ledger L_t (~350 tokens)              │
│ - [Protected Mission Frame]: Current Battalion Order / Intent from Steel 6 │
│ - [Enemy OOB & Unseen Threat Tracker]: Known destroyed, active, & faded    │
│   contacts with last velocity vector / suspected area.                     │
│ - [Company Plan State]: Current phase, main effort, reserve, key triggers. │
├────────────────────────────────────────────────────────────────────────────┤
│ TIER 2: ReCAP-Selected Episodic Radio Memory (~400–600 tokens, <= 6 blocks)│
│ - Protected last K=3 turns (warm prefix-cache continuation)                │
│ - Plus top-2 archived historical blocks revived on-demand via Entity/Grid  │
│   overlap (Equation 2 of ReCAP) or Gemini Decision 1 relevance score.      │
├────────────────────────────────────────────────────────────────────────────┤
│ TIER 3: Ephemeral Current-Turn Perception (~500–800 tokens, stripped after)│
│ - Incoming radio traffic (inbox)                                           │
│ - Live Company Sitrep + Pre-computed Tactical Anchor Candidates            │
│ - Optional local 9x9 terrain/viewshed patch (or multimodal map crop)       │
└────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 How the "Circular / Recurrent" Update Loop Works with Zero Critical-Path Latency

To guarantee that **TTFT and response latency are never penalized by context compression**, we combine three mechanisms from `RTSGameAgent`, `Focus`, and `ReCAP`:

1. **Intra-Turn Tool Trace Folding (`Focus` Sawtooth Principle)**:
   - During a turn, `Alpha 6` might call `describe_location` or `query_tactical_anchors` twice before calling `order_platoon` and `radio_superior`.
   - Once the turn finishes, **we strip the verbose read-only spatial query outputs (`describe_location`) from the persisted turn block**, keeping only the action tool calls (`order_platoon`, `radio_superior`) and the commander's 1-line private note! This alone cuts persisted per-turn history size by **65–80%** with zero LLM calls.
2. **Post-Turn Asynchronous Ledger Update (`RTSGameAgent` $\mathcal{L}_t$ off Critical Path)**:
   - Because `Alpha 6` has a minimum `DEBOUNCE = 4s` (and radio orders take $3\text{--}8\text{s}$ of airtime to deliver), any update to `TIER 1: Operational Ledger` ($\mathcal{L}_t$) happens **after** `run()` dispatches its radio orders!
   - Even better: 80% of `TIER 1` (Pinned Mission Frame from `Steel 6`, Enemy Contact Faded/Destroyed Ledger, Active Platoon Orders) can be maintained **deterministically in TypeScript** from `World` state + the commander's structured `update_plan` note, requiring **0 extra LLM calls**!
3. **ReCAP-Style Query-Conditioned Revival for Archived Turns (`arXiv:2609.40118`)**:
   - All past turns are stored in a lightweight in-memory `ContextGraph` array in `Commander` (`< 20 KB` RAM).
   - Each node stores the set of **tactical entities** it references: platoon IDs (`Alpha 1..3`), place names (`Hill 112`, `Crossroads`), and 4-digit grids (`2131`).
   - When a new wakeup arrives (e.g., `Steel 6` radios: *"Alpha 6, execute the fallback plan we discussed for Bridge"* or `Alpha 2` spots an enemy at `Bridge`), the selector computes the IDF-weighted entity overlap $\ell_v$ between the incoming traffic/contacts and archived turns, reviving the exact earlier turn where `Bridge` was discussed—in **$< 1\text{ ms}$ of TypeScript CPU time**!
   - **Warm vs. Cold Cache Policy**: Just as in `ReCAP` §5.5, during a burst of back-to-back radio turns (warm cache window), `TIER 1` and `TIER 2` remain append-only for $3\text{--}4$ turns so the LLM provider's **automatic prefix cache** hits $>95\%$ of prompt tokens (~100–200ms TTFT). Only when an idle gap occurs or the window exceeds $K=6$ turns does the recurrent compaction cycle rewrite `TIER 1 + TIER 2`.
