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
| `src/sim/map.ts` | 10m multi-channel geo-substrate (`elevationGrid`, `slopeGrid`, `terrainGrid`, `buildingIdGrid`), `GameMap.fromAsset()` static loader, 6D `TERRAIN_DEFS` registry (11 terrain IDs), `RoadNetwork`, multi-story `Building`/`BuildingFloor` (`canGarrisonFloor`, `gutBuildingFloor`, `ArmorValue` structural resistance), 3D Beer-Lambert `sightline()` engine, and legacy 50m compatibility views. | `simplex-noise` |
| `src/sim/world.ts` | Platoon entities (`tank`, `ifv`, `infantry`, `atgm`) with Phase 1 metadata, 10m terrain/building-aware movement & floor garrisoning, instantaneous 3D `sightline()` two-tier detection (`Contact` vs `Visual`) with per-unit `ownPerception`, 3-tier own-optics direct-fire accuracy, directional `ArmorProfile` (`KE`/`CE`) & `HE` inverse-square blast penetration with building floor integrity depletion, multi-weapon `mutexGroup` concurrency, decoupled `InfantrySubRoster` casualty weapon takeover, platoon FSM, event bus. | `src/sim/map.ts` |
| `src/sim/scenario.ts` | Fulda Gap — Point Alpha (Rasdorf–Geisa) scenario loading `src/sim/maps/fulda-point-alpha.json`, initial OOB, scripted red reserve trigger, win/loss check. | `src/sim/*` |
| `scripts/build-map.ts` | Offline GIS compiler ingesting Point Alpha OSM XML, Hessen 1m LiDAR DGM1 WCS, and Copernicus DEM fallback into compact 10m `src/sim/maps/fulda-point-alpha.json`. | `geotiff`, `src/sim/map.ts` |
| `src/comms/radio.ts` | `RadioNet`: single-channel airtime queue (`1 + words/8` sec), delivery callbacks, optional structured payload (`data`). | None |
| `src/perception/sitrep.ts` | Converts `World` into text that `Alpha 6` is allowed to know (`companySitrep` with terrain cover, building garrison, suppression %, engaged target, in-flight orders, and `Contact` vs `Visual` enemy reporting; `describeLocation`; `placesBrief`). | `src/sim/*` |
| `src/perception/player.ts` | `PlayerPicture`: enforces player information rules (30s friendly position datalink, unit status + enemy contacts synced only on `Steel 6 <-> Alpha 6` radio delivery, company orders intercepted after 10s). | `src/sim/*` |
| `src/agents/commander.ts` | `Commander`: event-driven LLM runner (4s wakeup debounce, 6-step limit, tools: `describe_location`, `order_platoon`, `radio_superior`), ephemeral sitrep injection (stripped from history after turn). | `ai`, `zod`, `src/comms/*`, `src/perception/*` |
| `src/game.ts` | UI-agnostic coordinator wiring `World`, `RadioNet`s, `PlayerPicture`, and `Commander`, with `inspectorMode` pause toggle, `aiCommanderEnabled` toggle, and direct sandbox helpers (`directCommand`, `garrisonBuildingFloor`, `exitBuilding`). | All core modules |
| `src/render/Sandtable3D.tsx` | Full-screen Three.js 3D terrain sandtable: 10m terrain mesh with slope/contour shading, road ribbons, GPU-instanced canopies and multi-story buildings, clickable NATO sprites (rendering `Contact` markers tagged `SA`/`LW`/`HW` vs `Visual` types), orbit/top-down camera presets, and radial 3D Beer-Lambert LoS transmittance fan. | `react`, `three`, `milsymbol` |
| `src/ui/App.tsx` | Floating windows over the 3D sandtable: clock/speed bar, `AI Commander: ON/OFF` sandbox toggle, Map Inspector GIS/LoS HUD, clickable unit cards + direct order/ROE/garrison controls + live unit telemetry panel, Battalion Net chat, LLM Debug drawer, and browser `localStorage` DeepSeek API key input. | `react`, `@ai-sdk/deepseek`, `src/game.ts` |
| `src/cli.ts` | Terminal prototype loop (`npm run play`). | Node `readline`, `src/game.ts` |
| `scripts/headless.ts` | Deterministic no-LLM combat runner (`npm run headless`). | `src/sim/*` |
| `.github/workflows/ci.yml` | Automated CI gate (`typecheck`, `build`, `headless`) on pushes and PRs to `main` and `feat/**`. | GitHub Actions |
| `.github/workflows/deploy.yml` | Manual (`workflow_dispatch`) static build and deployment to GitHub Pages. | GitHub Actions / Pages |
