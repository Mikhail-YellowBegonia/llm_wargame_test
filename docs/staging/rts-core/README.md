# Stage 2 Domain Staging: RTS Simulation Core (`docs/staging/rts-core/`)

This directory holds intermediate mechanic design notes, Eugen-style (*Wargame / WARNO / Regiments*) formula drafts, and combat tuning logs during **Stage 2 (`stage:2-rts-core`, Master Issue `#4`)**.

## Lifecycle Rules
1. Keep notes focused on `src/sim/` mechanics (geo-substrate, spotting/stealth, combat/armor, 4-tier morale/suppression, indirect fire/aviation/logistics, and deterministic bot interfaces).
2. When a mechanic is implemented in `src/sim/`, reflect its final as-built behavior in `docs/architecture.md` and prune obsolete drafts here before Stage 4 merge.

---

## Stage 2 Specification Index (Rolling-Wave Roadmap)

> **Rolling-Wave Planning Principle**: Phases 1–3 are completed on `feat/rts-core`. Phase 4 is next for sub-issue dispatch, followed by Phase 5 (core architecture refactor, true pathfinding, and RTS UI/UX overhaul) and Phase 6 (3D models & VFX polish).

| Phase | Document | Status | Scope |
| :--- | :--- | :--- | :--- |
| **Phase 1** | [`phase1-map-spec.md`](./phase1-map-spec.md) | **Completed** | Fulda Gap (Point Alpha) OSM + 1m LiDAR DEM geo-substrate, 6-dimension `TerrainDef`, 3D Beer-Lambert sightlines, multi-story `Building`/`BuildingFloor`, 3D preview & LoS inspector (`1A` / `1B` / `1C`). |
| **Phase 2** | [`phase2-combat-spec.md`](./phase2-combat-spec.md) | **Completed** | Direct command sandbox, two-tier `Contact`/`Visual` detection, 3-tier own-optics accuracy, directional `ke`/`ce` armor & `HE` inverse-square law, 4-tier morale & `Cowering`, infantry weapon takeover, vehicle patches, 60 FPS interpolation bridge (`2A`–`2D`). |
| **Phase 3** | [`phase3-support-spec.md`](./phase3-support-spec.md) | **Completed** | Artillery (`HE_Impact`, `HE_Airburst`, `Smoke`, 2-round `Ranging`, `isPositionCalibrated`), 2× linear fixed-wing airspace & altitude/turnaround, helicopter forced landings, `FOB` vs. empty-on-entry `SupplyVehicle`, `WIA`/`KIA` recovery, Debug Spawner (`3A`–`3C`). |
| **Phase 4** | [`phase4-units-and-bot-spec.md`](./phase4-units-and-bot-spec.md) | **Next Up — Ready for Sub-Issues** | Minimal symmetric-asymmetric OOB (11 archetypes), zero-adaptation-cost `UnitTacticalContext -> TacticalAction` bot contract, `SupportBroker` request–response network, and hiding LLM UI by default. |
| **Phase 5** | [`phase5-refactor-and-ux-spec.md`](./phase5-refactor-and-ux-spec.md) | *Proposed Baseline* | Modularize `world.ts`, `SpatialHashGrid`, true `RoadNetwork` + `10m` grid A* pathfinding, `FormationSlot` & separation steering, diegetic map plates with `IconStacking`, `BoxSelect` + `ContextRightClick` + hotkeys. |
| **Phase 6** | *(Planned Post-Phase 5)* | *Deferred* | Dedicated 3D unit silhouettes, animations, and high-fidelity combat VFX replacing temporary placeholders. |

---

## Deterministic English Glossary (`确定性英文术语表`)

All Stage 2 simulation modules and docs standardize on the following canonical English identifiers and definitions to eliminate translation ambiguity.

### Phase 1 — Map, Geo-Substrate & 3D Sightlines

| Term / Identifier | Symbol / Type | Deterministic Definition |
| :--- | :--- | :--- |
| `MobilityClass` | `"foot" \| "wheeled" \| "tracked" \| "amphibious"` | Locomotion category determining terrain/waterway passability and slope limits. |
| `UnitTrait` | `"infantry" \| "vehicle" \| "armored" \| "low_profile" \| "tall_profile"` | Physical unit profile tags used to look up tag-specific terrain `CombatModifiers`. |
| `TerrainId` | Union of 11 terrain IDs | Canonical cell terrain classification (`open`, `tall_grass`, `hedgerow`, `light_forest`, `dense_forest`, `paved_road`, `dirt_road`, `shallow_stream`, `deep_water`, `urban_pavement`, `marsh`). |
| `TerrainDef` | Interface | Complete 6-dimension terrain definition (`movementCost`/`speedMultiplier`, `baseSignature`, `transmittancePer100m`/`canopyHeight`, `meta`, `passability`, `traitModifiers`). |
| `movementCost` | `number` | Dimensionless pathfinding edge weight for a terrain type. |
| `speedMultiplier` | `number` | Dimensionless scalar applied to unit tactical speed over that terrain. |
| `baseSignature` | `number` $\in [0, 1]$ | Baseline **Concealment** exposure factor of a unit occupying that terrain (`1.0` = fully exposed). |
| `transmittancePer100m` | $T_{100\text{m}} \in (0, 1]$ | Optical transmittance through `100m` of terrain canopy (`1.0` = open terrain, linear decay only). |
| `opticalExtinction` | $\mu = -\ln(T_{100\text{m}})/100$ | Beer-Lambert attenuation coefficient per meter inside canopy height (`0` for open terrain). |
| `canopyHeight` | $h_{\text{canopy}}$ (`number`, meters) | Vertical height above ground up to which foliage attenuates passing 3D sightlines. |
| `passability` | `{ allowedMobility, maxSlopeDeg }` | Hard traversal filter by `MobilityClass` and maximum negotiable terrain slope in degrees. |
| `traitModifiers` | `Partial<Record<UnitTrait, CombatModifiers>>` | Distinguishes **Concealment** (`signatureMult`) from **Cover** (`damageMult`, `suppressionMult`) and `attackMult` per `UnitTrait`. |
| `Building` | Interface | Discrete structure with 2D vector `footprint`, `groundElevation`, `roofHeight`, and `BuildingFloor[]`. |
| `BuildingFloor` | Interface | Individual story (`level`, `elevationOffset`, `capacity`, `integrity`, `state`, `occupants`, `modifiers`). |
| `FloorState` | `"intact" \| "damaged" \| "gutted"` | Per-floor structural state; `"gutted"` strips floor `modifiers` and deals one-time damage/suppression to occupants without blocking stairwell traversal. |
| `headcount` / `capacity` | `number` | Unit living personnel count checked against a `BuildingFloor`'s `capacity` for garrisoning. |

### Phase 2 — Spotting, Direct Fire, Armor, Morale & Squad Patches

| Term / Identifier | Symbol / Type | Deterministic Definition |
| :--- | :--- | :--- |
| `DetectionLevel` | `"contact" \| "visual"` | Instantaneous deterministic two-tier intelligence state. `contact` = position + weapon class only; `visual` = position + exact unit type. |
| `bodySignature` | $S_{\text{body}}$ (`number`) | Physical silhouette/concealment signature determining `visual` detection (increased when moving; reduced when settled infantry or `Cowering`). |
| `muzzleSignature` | $S_{\text{muzzle}}$ (`number`) | Transient firing flash signature determining `contact` detection; firing does **not** raise `bodySignature`. |
| `WeaponSignatureClass` | `"small_arms" \| "light_weapon" \| "heavy_weapon"` | Coarse weapon audio/flash tier reported on `contact` (larger class overrides smaller class). |
| `ownPerception` | `"none" \| "contact" \| "visual"` | Shooter's **own-optics** perception of the target, governing the 3-tier direct-fire accuracy rule (`none` = heavy penalty, `contact` = small penalty, `visual` = `100%` accuracy). |
| `ArmorProfile` | `{ front, side, rear, top }` | Four-aspect directional armor zones on units. |
| `ArmorValue` | `{ ke: number; ce: number }` | Kinetic (`ke`) and Chemical (`ce`) armor ratings (used for both units and `Building` structural resistance). |
| `AmmoType` | `"AP" \| "HEAT" \| "HE"` | Direct/blast ammunition categories (`AP` vs `ke`, `HEAT` vs `ce`, `HE` isotropic `ke` vs nearest armor zone). |
| `Pen_HE` | $\text{Pen}_{\text{contact}} / (1 + (d_z / d_0)^2)$ | Contact-clamped inverse-square `HE` penetration evaluated at nearest distance $d_z$ to each of the 4 armor zones (penetrates if any zone fails). |
| `mutexGroup` | `string?` | Optional weapon concurrency lock on vehicles (e.g., BMP-3 locking coaxial `30mm` while reloading `100mm` main gun). |
| `MoraleTier` | `"calm" \| "worried" \| "shaken" \| "panicked"` | Four-stage morale state governing combat penalties and passive recovery. |
| `SuppressionFloor` | Midpoint of `shaken` | Maximum morale loss achievable by non-damaging suppression alone; reaching `panicked` requires HP damage or `ArtilleryShockPenalty`. |
| `Cowering` | State at `shaken`+ | Defensive reaction reducing `bodySignature` and `optics` while increasing cover damage reduction. |
| `SupplyBonus` | Morale Event | Accelerated morale recovery inside friendly `FOB` or `SupplyVehicle` radius. |
| `CombatFeatBonus` | Morale Event | Morale recovery bonus triggered by recent friendly actual HP damage (suppression excluded). |
| `IsolationPenalty` | Morale Event | Continuous morale drain during combat when visible enemies heavily outnumber friendlies, floored at the midpoint of `worried`. |
| `ArtilleryShockPenalty` | Morale Event | Unbounded suppression and yield-scaled morale loss inflicted on unarmored units in `open` terrain under `HE` bombardment. |
| `InfantrySubRoster` | `{ personnel, weapons }` | Decoupled pool of living `SpecialistRole` headcounts and carried weapon slots (max 2 carried, 1 fired per soldier). |
| `SpecialistRole` | `"rifleman" \| "mg_specialist" \| "at_specialist" \| "marksman" \| "engineer"` | Soldier specialty tags for penalty-free operation of matching special weapons. |
| `unskilledPenalty` | Modifier | Accuracy/reload debuff applied when a non-specialist operates a special weapon after specialist casualties. |
| `abandonPriority` | `number` | Deterministic drop order when surviving headcount falls below special weapon count (primary rifles dropped first). |

### Phase 3 — Artillery, Aviation, Logistics & Replenishment

| Term / Identifier | Symbol / Type | Deterministic Definition |
| :--- | :--- | :--- |
| `ArtilleryAmmoType` | `"HE_Impact" \| "HE_Airburst" \| "Smoke" \| "Direct_Self_Defense"` | Indirect/self-defense artillery shell modes (`HE_Airburst` = `0.5×` contact pen, `5×` $d_0$ blast radius, requires `>= 1` valid `Ranging` round). |
| `Ranging` | Calibration Phase | Default **2 rounds** fired by 1 gun onto an observer-visible target, halving dispersion radius per round before `FFE`. |
| `FireForEffect` (`FFE`) | Salvo Phase | Full-battery sustained barrage (skipped to immediately with `HE_Airburst -> HE_Impact` degradation when blind-firing without an observer). |
| `hasObserver` | `boolean` | Capability flag (recon vehicles, recon squads, standard infantry) enabling artillery `Ranging` calibration and `HE_Airburst`. |
| `isPositionCalibrated` | `boolean` | Battery systematic-error flag cleared by `Ranging` (via direct or registration-point `"放空炮"` fire); grants partial bonus on target shifts until the battery moves. |
| `FlightAltitude` | `"low" \| "high"` | Fixed-wing altitude posture chosen by aircraft bot on ingress (`low` evades `AreaAirDefense` but risks `SHORAD`; `high` reverses risk and grants dogfight energy advantage). |
| `AreaAirDefense` / `SHORAD` | Air Threat Tiers | Long-range area SAMs (strong vs `high`, also covers 2× linear outer airspace) vs. short-range AAA/MANPADS (strong vs `low`). |
| `Afterburner` | State / Fuel Multiplier | Automatically engaged during fixed-wing dogfights, steeply increasing fuel consumption. |
| `TurnaroundTimers` | `{ refuelTime, repairTime, rearmTime }` | Three independent zero-cost post-sortie reconditioning timers for fixed-wing aircraft. |
| `ForcedLanding` | `< 30% HP` Rotorcraft State | Helicopter descent state when HP falls below `30%` with remaining HP; evacuates embarked infantry and can take off to FOB after `50%`-capped field repair. |
| `FOB` | Immobile Logistics Node | Infinite supply output, rapid transfer, `100%` aircraft/vehicle repair + helo rearm, and extra artillery resistance. |
| `SupplyVehicle` | Mobile Logistics Unit | Trucks/APCs/Helos entering empty (`0` supply); loads at `FOB` to distribute ammo, repair vehicles (helo capped at `50%`, no helo ammo), and heal `WIA`. |
| `WIA` | Wounded in Action | Non-lethal infantry casualties recoverable via out-of-combat self-aid (slow, capped ceiling), `SupplyVehicle`, or `FOB`. |
| `KIA` | Killed in Action | Fatal infantry casualties unrecoverable on-map; requires off-map formation withdrawal + paid reconstitution (preserves veterancy, resets ammo/morale). |

### Phase 4 — Standard Units, Bot Interface & Support Network

| Term / Identifier | Symbol / Type | Deterministic Definition |
| :--- | :--- | :--- |
| `UnitTacticalContext` | Interface | Standardized per-tick snapshot (`self`, `environment`, `threatsAndTargets`) consumed identically by deterministic FSMs or AI decision models. |
| `TacticalAction` | Tagged Union | Atomic deterministic maneuver/action returned by `UnitBrainFn` and executed cleanly by simulation physics. |
| `UnitBrainFn` | `(ctx: UnitTacticalContext) => TacticalAction` | Swappable decision function signature enabling zero-adaptation-cost AI replacement of Stage 2 FSM logic. |
| `SupportRequestKind` | Union of Request Types | Ticket types emitted by frontline units (`artillery_he`, `artillery_smoke`, `air_strike`, `resupply_repairs`, reserved `transport_pickup`, `armor_support`). |
| `SupportRequest` | Interface | Prioritized tactical ticket (`requesterId`, `kind`, `targetPos`, `urgency`, `hasObserverSight`, `ttl`). |
| `SupportBroker` | Scheduler Component | Virtual dispatcher matching `SupportRequest` tickets to autonomous support units based on urgency, range, supply, and survivability. |

### Phase 5 — Core Refactor, Pathfinding, Fundamentals & Direct-Manipulation UI/UX

| Term / Identifier | Symbol / Type | Deterministic Definition |
| :--- | :--- | :--- |
| `SpatialHashGrid` | TypedArray Index | `Int32Array`-backed uniform spatial bucket index replacing $O(N^2)$ unit proximity queries. |
| `RoadGraphPathfinder` | Pathfinding Module | Graph A* over Phase 1's `RoadNetwork` nodes/edges (including `isBridge` crossings) for fast road marches. |
| `GridAStarPathfinder` | Pathfinding Module | `10m` raster A* using `TerrainDef.movementCost`, `isPassable()`, and slope constraints to route around water/cliffs. |
| `FormationSlot` | Vec Offset Slot | Computed non-overlapping group arrival coordinates (`line` / `column` / `spread`) paired with separation steering. |
| `IconStacking` | Camera-Distance UI | Automatic screen/world proximity clustering of adjacent unit plates when zoomed out, expanding on zoom-in or hover. |
| `BoxSelect` | Mouse Gesture | Left-click marquee drag selecting multiple friendly units (`Shift` appends, `Ctrl+1..9` binds control groups). |
| `ContextRightClick` | Mouse Gesture | Single right-click dispatches context-aware orders (`Move` on ground, `Attack` on enemy, `Garrison` on building, `Embark` on transport). |
| `ReverseMove` | Tactical Order (`G`) | Short tactical withdrawal preserving the unit's `front` armor `heading` toward the active threat. |
| `AttackMove` | Tactical Order (`Q`) | Advance along path and automatically halt to engage upon acquiring enemy `Visual`/`Contact` within weapon range. |
