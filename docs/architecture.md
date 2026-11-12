# Architecture (As-Built)

> This document describes the **currently implemented** system only. Do not add unimplemented roadmap ideas here.

## 1. Overview

You (`Steel 6`, battalion commander) command a mechanized company (`Alpha 6`, an LLM agent) over a radio net. `Alpha 6` commands three platoon-level finite-state-machine (FSM) bots (`Alpha 1..3`) against a scripted red force in the 4×4 km **Kessel** scenario.

```
Player (Steel 6)
  │  Battalion Radio Net (queued airtime + data link sync on delivery)
  ▼
Company Commander LLM (Alpha 6, DeepSeek via Vercel AI SDK)
  │  Company Radio Net (queued airtime; orders intercepted + plotted for player after 10s)
  ▼
Platoon FSM Bots (Alpha 1, Alpha 2, Alpha 3)
  │  1-second deterministic ticks (LOS, spotting, fire, suppression, morale, movement)
  ▼
Simulation World (src/sim/)
```

## 2. Module Layout & Boundaries

| Path | Responsibility | Dependencies |
| :--- | :--- | :--- |
| `src/sim/map.ts` | 50m grid height/terrain (`open`, `forest`, `town`, `road`), 4/6-digit grid refs, named places/markers, raycast LOS. | `simplex-noise` |
| `src/sim/world.ts` | Platoon entities (`tank`, `ifv`, `infantry`, `atgm`), spotting, firepower/cover/suppression combat model, platoon FSM (`holding`, `moving`, `pinned`, `broken`, `destroyed`), event bus. | `src/sim/map.ts` |
| `src/sim/scenario.ts` | "Operation Kessel" map authoring, initial OOB, scripted red reserve trigger, win/loss check. | `src/sim/*` |
| `src/comms/radio.ts` | `RadioNet`: single-channel airtime queue (`1 + words/8` sec), delivery callbacks, optional structured payload (`data`). | None |
| `src/perception/sitrep.ts` | Converts `World` into text that `Alpha 6` is allowed to know (`companySitrep`, `describeLocation`, `placesBrief`). | `src/sim/*` |
| `src/perception/player.ts` | `PlayerPicture`: enforces player information rules (30s friendly position datalink, unit status + enemy contacts synced only on `Steel 6 <-> Alpha 6` radio delivery, company orders intercepted after 10s). | `src/sim/*` |
| `src/agents/commander.ts` | `Commander`: event-driven LLM runner (`describe_location`, `order_platoon`, `radio_superior`), ephemeral sitrep injection (stripped from history after turn). | `ai`, `zod`, `src/comms/*`, `src/perception/*` |
| `src/game.ts` | UI-agnostic coordinator wiring `World`, `RadioNet`s, `PlayerPicture`, and `Commander`. | All core modules |
| `src/render/PaperMap.tsx` | Full-screen SVG staff map: `d3-contour` elevation lines, terrain cells, `milsymbol` NATO APP-6 symbols, plotted orders, markers, zoom/pan. | `react`, `d3-contour`, `milsymbol` |
| `src/ui/App.tsx` | Floating windows over the map: clock/speed bar, Alpha Co. status overview, Battalion Net chat, and LLM Debug drawer. | `react`, `@ai-sdk/deepseek`, `src/game.ts` |
| `src/cli.ts` | Terminal prototype loop (`npm run play`). | Node `readline`, `src/game.ts` |
| `scripts/headless.ts` | Deterministic no-LLM combat runner (`npm run headless`). | `src/sim/*` |
