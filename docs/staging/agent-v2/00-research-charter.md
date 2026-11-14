# Stage 3 Research Charter & Core Problem Statements (`stage:3-agent-v2`)

- **Parent Master Issue**: [#5 — [Stage 3 Master] LLM Tactical C2 Survey & Agent v2 Design](https://github.com/Mikhail-YellowBegonia/llm_wargame_test/issues/5)
- **Date Recorded**: 2026-11-13
- **Status**: Active Long-Horizon Research & Architecture Planning (running in parallel with Stage 2 `#4`)

---

## 1. Verbatim Problem Statement & Research Prompt (原样落盘)

> 请看 Issue #5 和它发起的调研任务，我们在做一个实验性质的，嵌入LLM指挥链的RTS战术游戏。
> 希望你从 Issue、同类实践和下面我说的内容出发，规划并组织调研，最终进行架构设计。注意我们的时间几乎是无限的，因为要等 Stage 2 的大量任务完成。因此好消息，这是一个长线调研和规划任务。
> 我们关切的几个核心问题如下：
>
> > 离散还是连续？
>
> AI会下棋，这个我们都知道。时间上的离散是指回合制，空间上的离散是指网格地图，很大程度上类似兵棋推演。
> 市面上主流的RTS游戏，比如 Eugen 的旧作 Wargame 系列，新作 WARNO，显然都是时间连续（实时），且空间连续的（没有网格）。
> 因此我们能提供的RTS内核，应该是“时间连续-空间连续”的。我们凭直觉认为，AI对离散空间的理解可能会比连续空间强一点。因此这里存在一个**适配代价**。
> 我们预期AI玩传统兵棋一定得心应手，玩“连续-连续”的现代RTS则很难说。所以要看看其他人如何评估、看待、解决这个问题，进而为我们提供启发，甚至修改RTS内核的设计准则。
>
> 关于这个思考，还引出另一个问题，现在很多模型都支持多模态，而且图像嵌入速度很快。图像能否作为一种可大规模使用的输入手段呢？会不会提升模型的空间理解能力呢？值得思考。一个很重要的例子就是通视分析，人类玩家可以很容易地想到诸如“这里是个反斜坡，可以看住xxx区域，而且不会被xx方向打到”，但我怀疑LLM有同等的觉悟，看看其他人怎么说吧！
>
> > 语言模型还是决策模型？
>
> 语言模型调用工具不再是唯一的选择，2026年11月，Google推出了决策模型，加上之前出现的Jev。决策模型是个新东西，就“Gemini Decision 1”来说，256k全模态输入，极快响应，并行回答1000个问题，支持高达255多选。我不知道它能在哪里用上，但它绝对是一个 Game-Changer，字面意义上的。
> 策略与战术游戏中有很多微操作，都是有限多选或Y/N问题，抓住这个风头用好决策模型。同时也应该承认，决策模型是个新东西，所以学界和社区可能还没搞懂怎么利用它，没搞懂它的能力边界。
>
> > 循环上下文还是线性上下文？
>
> 上下文长度关乎Token消耗和我的钱包，但这不是问题，重要的是首字延迟和回答延迟，以及回答质量。目前循环上下文主张动态压缩和遴选上下文，保持模型的认知新鲜而全面，这在编程智能体里面尚没有广泛采用（一般还是线性上下文+适度压缩），但是我们可以在游戏中试一试。这涉及到智能体工程，我们不能自己摸索，也要调研。
>
> 我说的这段话请你原样落盘，内容仅供参考，你可以按你认为有价值的方向组织并展开调研，发布Issue、子Issue或子智能体都可以。

---

## 2. Research Organization & Staging Map

To systematically answer the three core questions and translate them into both **Stage 2 RTS Core Design Criteria** (`feat/rts-core`) and **Stage 3 Agent v2 Architecture** (`feat/agent-v2`), our research is organized into three domain deep-dives in `docs/staging/agent-v2/`:

| Document | Core Question / Axis | Key Literature & Tech Covered (2024–2026) | Deliverable / Output |
| :--- | :--- | :--- | :--- |
| [`01-spatial-discrete-vs-continuous-and-vlm.md`](./01-spatial-discrete-vs-continuous-and-vlm.md) | **Axis 1: 离散还是连续？+ 多模态视觉与通视/反斜坡分析** | `RTSGameBench` (`arXiv:2606.18950`), `MapBench` / MSSG (`arXiv:2503.14607`), `Text2Space` (`arXiv:2604.14641`), `Spatial Reasoning in LLM Game Agents` (`arXiv:2607.22732`), Sean Goedecke's `generals`, `COA-GPT` | **Dual-Layer Spatial-Temporal Bridge**: Continuous sim core + discrete **Tactical Anchor Graph (TAG)** + pre-shaded **Viewshed/Defilade Visual Overlays**; reverse-requirements for Stage 2 (`src/sim/map.ts`). |
| [`02-decision-models-vs-language-models.md`](./02-decision-models-vs-language-models.md) | **Axis 2: 语言模型还是决策模型？ (`Gemini Decision 1` & `Jev`)** | Google `Gemini Decision 1` (Nov 2026 Decisions API: `noul`/`choice`/`score`, 1000-question single-pass batching, 150–250ms), TypeSafe AI `Jev 1.14` (Sept 2026 System-1 model), Kahneman Dual-Process C2 | **System 1 / System 2 Hybrid C2 Architecture**: System-2 LLM (`Alpha 6`) for COA, radio dialogue, and intent; System-1 Decision Model (`gemini-decision-1`) for 150ms interrupt triage, batched platoon micro-judgments, and candidate position ranking. |
| [`03-recurrent-vs-linear-context-engineering.md`](./03-recurrent-vs-linear-context-engineering.md) | **Axis 3: 循环上下文还是线性上下文？ (低延迟认知架构)** | Microsoft/UCSB `ReCAP` (`arXiv:2609.40118`), `Focus` Sawtooth Compression (`arXiv:2601.07190`), `Acon` (`arXiv:2510.00615`), `RTSGameAgent` STM/LTM (`arXiv:2606.18950`), `TextStarCraft II` CoS | **$O(1)$ Recurrent Tactical Context Engine**: Pinned Mission Frame + Off-Critical-Path Structured Tactical Ledger ($\mathcal{L}_t$) + Relevance-Gated Episodic Ring Buffer + Ephemeral Sitrep. |

---

## 3. Stage 3 Sub-Issue Roadmap (`Parent: #5`)

1. **Sub-Issue A (`status:ready`)**: **Spatial Affordance & Reverse-Slope Viewshed Specification** — Define the deterministic Tactical Anchor Graph (hull-down, reverse-slope defilade, avenue of approach, smoke screen lines) and optional VLM viewshed overlay contract between `src/sim/map.ts` and `src/perception/`.
2. **Sub-Issue B (`status:ready`)**: **System 1 (`Gemini Decision 1` / `Jev`) + System 2 Hybrid C2 Specification** — Design the `DecisionService` interface, batched 150ms tactical micro-judgment schemas (`noul`/`choice`/`score`), and handoff protocol with the System-2 `Commander`.
3. **Sub-Issue C (`status:ready`)**: **Recurrent Tactical Context & Prefix-Cache-Friendly Memory Specification** — Design the $O(1)$ bounded context loop (Pinned Intent + Async Tactical Ledger + Dependency/Relevance Episodic Selector) to keep cold/warm TTFT minimal across 60-minute battles.
4. **Sub-Issue D (`status:blocked` on Stage 2 `#4` & Sub-Issues A–C)**: **Agent v2 Implementation on `feat/agent-v2`** — Implement the locked perception, decision-model, and recurrent-context architecture in `src/perception/` and `src/agents/`.
