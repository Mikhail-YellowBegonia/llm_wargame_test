# Stage 2 Phase 5 Spec: RTS Core Refactor, True Pathfinding/Fundamentals & Direct-Manipulation UI/UX Overhaul

> **Status**: **Proposed Baseline** under `stage:2-rts-core` (Master Issue `#4`), slotted immediately after **Phase 4** (`phase4-units-and-bot-spec.md`) and prior to **Phase 6** (3D Models & VFX Polish).

---

## Context & Problem Statement

Following completion of Phases 1–3, direct inspection of the codebase (`src/sim/world.ts` at 3,259 LOC, `src/ui/App.tsx` at 1,355 LOC, `src/render/Sandtable3D.tsx` at 1,440 LOC) and live sandtable playtesting surfaced three structural bottlenecks:

1. **Cognitive Overload Beyond ~10 Units**:
   * All unit telemetry (strength, suppression, morale tier, morale events, weapon slots, sub-roster casualties) sits in a 265px scrolling text sidebar while the 3D map NATO sprites carry zero live status cues or proximity stacking. Players must visually cross-reference a 1D text list against 3D map pins.
2. **Clunky Three-Step Modal Ordering**:
   * Issuing a single command requires selecting one unit $\rightarrow$ clicking a modal button in the left panel $\rightarrow$ clicking the 3D terrain (without box-select, control groups, or context-sensitive right-click orders).
3. **Assertion-Driven Implementation Shortcuts ("70-Point" Core)**:
   * `src/sim/world.ts` has accumulated 3,259 lines in a single file.
   * Movement still uses a 7-angle greedy single-step probe instead of utilizing Phase 1's compiled `RoadNetwork` (with bridges) and `10m` `movementCost` raster for true hierarchical A* pathfinding.
   * Units lack multi-unit formation slots, local separation steering, reverse-armor movement, and chained composite transport/airlift orders.

---

## 1. Core Architecture Refactoring (`内核重构 — 模块化解耦与空间索引`)

### 1.1 Modular Decomposition of `src/sim/`
Break the monolithic `src/sim/world.ts` (3,259 LOC) into cohesive, single-responsibility modules while preserving `World`'s external API for `game.ts`, `perception/*`, and `scripts/headless.ts`:

| Target Module | Responsibility |
| :--- | :--- |
| `src/sim/types.ts` | Canonical Stage 2 types (`Side`, `UnitType`, `Unit`, `Order`, `ArmorProfile`, `WeaponSlot`, `InfantrySubRoster`, `SupportRequest`, `SimEvent`, `CombatShotEvent`). |
| `src/sim/units.ts` | `STATS` archetype definitions (NATO/Pact OOB), default weapon slots, and `InfantrySubRoster` constructors. |
| `src/sim/pathing.ts` | `SpatialHashGrid`, `RoadGraphPathfinder`, `GridAStarPathfinder`, formation slot generator (`FormationSlot`), and local separation steering. |
| `src/sim/spotting.ts` | 3D Beer-Lambert sightline wrappers, `bodySignature` vs `muzzleSignature` evaluation, and two-tier `Contact`/`Visual` maintenance. |
| `src/sim/combat.ts` | Direct fire resolution, 3-tier `ownPerception` accuracy, directional `KE`/`CE` & inverse-square `HE` penetration, 4-tier morale, `SuppressionFloor`, `Cowering`, and `InfantrySubRoster` casualty takeover. |
| `src/sim/support.ts` | Indirect fire (`Ranging`/`FFE`/`Smoke`), fixed-wing & helicopter lifecycles, `FOB`/`SupplyVehicle` transfers, `WIA`/`KIA` replenishment, and `SupportBroker`. |
| `src/sim/bot.ts` | `UnitTacticalContext` snapshot builder, `UnitBrainFn` interface, and deterministic `TacticalAction` executors. |
| `src/sim/world.ts` | Slim `< 500`-line `World` coordinator orchestrating tick order, event bus, and public command/telemetry APIs. |

### 1.2 Uniform `SpatialHashGrid` (`Int32Array` Linked-List Index)
* Replace $O(N^2)$ scans across `onMapAlive()` for target selection, spotting, AOE HE splash, supply aura checks, and local unit separation with a zero-GC `SpatialHashGrid` (e.g., `100m` bucket size using `Int32Array` head/next arrays), enabling smooth 30–100+ unit battles.

---

## 2. Fundamental RTS Mechanics Completion (`补齐基本功能 — 真寻路、编队与复合动作`)

### 2.1 Hierarchical Pathfinding (`RoadGraphPathfinder` + `GridAStarPathfinder`)
* **`GridAStarPathfinder` (`10m` Fine Grid A\*)**:
  * Replaces the 7-angle greedy probe with true A* over the `10m` raster using `TerrainDef.movementCost`, `isPassable(p, mobility)`, and slope constraints (`maxSlopeDeg`), automatically routing around `deep_water`, cliffs, and impassable footprints via valid crossings.
  * Caches waypoint paths per unit and only replans when blocked or re-ordered, keeping tick overhead negligible.
* **`RoadGraphPathfinder` (`RoadNetwork` Graph A\*)**:
  * For `road_march` orders (or long cross-map moves), routes from origin $\rightarrow$ nearest accessible `RoadNode` $\rightarrow$ shortest `RoadEdge` chain (including `isBridge: true` river crossings) $\rightarrow$ final `10m` A* leg to destination.

### 2.2 Multi-Unit `FormationSlot` & Separation Steering
* When issuing a group order to $N$ selected units toward `dest`, compute non-overlapping `FormationSlot` offsets (`line`, `column`, or `spread` staggered spacing ~40–60m) oriented along the approach vector.
* Apply continuous local separation steering between nearby ground units on the same side so platoons naturally spread across treelines/ridges instead of stacking on identical coordinates.

### 2.3 Composite Orders & Core Tactical Postures
* **Chained Transport / Airlift Orders**: Selecting infantry + right-clicking a friendly APC/IFV/Helicopter (or commanding an airlift drop) executes a seamless composite chain (`Fly/Drive to Pickup -> Land -> Embark -> Transit -> Land -> Disembark`) without 5 separate manual button clicks.
* **Essential RTS Command Postures**:
  * `AttackMove` (`Q`): Move along path and halt automatically at optimal engagement range on enemy `Visual`/`Contact`.
  * `ReverseMove` (`G`): Short tactical withdrawal keeping the unit's **`front` armor `heading`** oriented toward the active threat.
  * `RoadMarch` (`R`): Prioritize `RoadGraphPathfinder` for maximum strategic speed (`speedMultiplier`).

---

## 3. RTS UI/UX & Information Hierarchy Overhaul (`UI/UX 优化 — 空间化标牌、图标聚合与直觉操控`)

### 3.1 Diegetic On-Map Unit Plates & Camera-Distance `IconStacking`
Eliminate split-attention reliance on the 1D text sidebar by surfacing battle-critical state directly on the 3D map NATO symbols:
* **Compact Diegetic Unit Plate**:
  * Crisp **Strength Bar** + **Suppression/Morale Color Ring/Backing** (flashes amber/red when under fire or `Cowering`, dims when `broken`);
  * Compact status glyphs for **Out-of-Ammo**, **Loading/Aiming**, **Embarking**, or **Moving/Attacking** vectors;
  * Optional mini `WIA` / `Airborne Altitude` badge.
* **Camera-Distance `IconStacking`**:
  * When zoomed out beyond tactical overview threshold, adjacent friendly units within screen/world proximity (`< 120m`) automatically cluster into a single clean stack badge (showing unit count & composite strength bar), expanding cleanly on hover or zoom-in so 40+ units remain visually scannable.

### 3.2 Standard RTS Mouse & Hotkey Ergonomics (`BoxSelect` + `ContextRightClick`)
Replace the three-step modal left-panel workflow with immediate direct manipulation:
* **Selection**:
  * **`BoxSelect`**: Left-click + drag draws a 2D screen marquee rectangle to select multiple friendly units (`Shift` adds/toggles);
  * **`Double-Click` Unit**: Selects all visible friendly units of the same `UnitType` within screen bounds;
  * **`Ctrl+1..9` / `1..9`**: Assign and recall unit control groups.
* **`ContextRightClick` (One-Click Orders)**:
  * **Right-Click Empty Terrain**: `Move` selected group to `FormationSlot` destinations (or `RoadMarch` if clicking directly on a road or holding `Alt`/`R`);
  * **Right-Click Enemy Unit/Contact**: `Attack` target;
  * **Right-Click Building (with Infantry selected)**: Auto-move and garrison best available intact upper floor;
  * **Right-Click Friendly Transport / Helicopter (with Infantry selected)**: Auto-move and embark (chaining helicopter landing if needed).
* **Dedicated Camera Bindings**:
  * Pan with `WASD` / Arrow keys / Middle-Mouse Drag (or edge-scroll optional); Orbit with `Alt+Drag` or Middle-Mouse + `Shift`; preserve Left-Drag strictly for `BoxSelect` and Right-Click strictly for orders (with brief drag threshold separating Right-Click orders from camera actions if enabled).
* **Hotkeys**: `Q` (`AttackMove`), `G` (`ReverseMove`), `R` (`RoadMarch`), `F` (HE Fire Mission), `B` (Smoke Mission), `U` (Unload/Exit Building), `H` (`Hold`), `Space` (Pause/Resume).

### 3.3 Decluttered HUD & Hidden LLM Panels
* **Hide LLM UI by Default** (initiated immediately in Phase 4A and finalized in Phase 5): Remove/collapse `BATTALION NET`, `API Key`, and `LLM Debug` drawers behind an optional `Legacy LLM Command` toggle so the screen belongs cleanly to the RTS battlefield.
* **Compact Bottom/Left Category Bar + On-Demand Telemetry Drawer**:
  * Replace the long scrolling card list with a compact category summary / control-group strip (`Armor / Inf / Recon / Arty / Air / Logi`) and multi-unit selection tray.
  * Move the verbose 30-line monospace telemetry block into a collapsible **`Debug Telemetry`** drawer toggled only when inspecting raw formulas.
