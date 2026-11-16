# Stage 2 Phase 1 Spec: Map Metadata, Geo-Substrate & 3D Sightlines

> **Status**: **Locked & Ready for Sub-Issue Dispatch** (Staging Spec under `stage:2-rts-core`, Master Issue `#4`).  
> **Note on Rolling-Wave Planning**: Stage 2 is divided into 4 sequential phases. Only Phase 1 is locked here for immediate breakdown; later phases carry higher uncertainty and are treated as **directional baselines** to be re-evaluated before execution:
> 1. **Phase 1: Map & Scenario** (`Map Metadata & Geo-Substrate`) — **Locked & Ready for Sub-Issue Dispatch**
> 2. **Phase 2: Core Mechanics** (`Spotting/Concealment, Attack/Defense/Armor, 4-Tier Morale/Suppression, Mobility`) — *Directional Baseline (re-evaluate before execution)*
> 3. **Phase 3: Special Units & Support Mechanics** (`Indirect Fire HE/Smoke, Air Support / AA`) — *Directional Baseline (re-evaluate before execution)*
> 4. **Phase 4: Standard Units & Bot Optimization** (`Expanded OOB/Stats, Platoon FSM & Postures`) — *Directional Baseline (re-evaluate before execution)*

---

## 1. Geo-Substrate & Reference Region (`Fulda Gap — Point Alpha / Rasdorf–Geisa`)

### 1.1 Region, Scale & Dual-Layer Architecture
* **Reference Center**: **Point Alpha** (`50.7237° N, 9.9323° E`), covering the Cold War corridor between **Rasdorf (Hessen)** to the west and **Geisa (Thüringen)** to the east.
* **Battlefield Dimensions**: `3.5 km × 3.5 km` to `4 km × 4 km` operational area, providing sufficient depth for long-range direct fire (tank `2000m`, ATGM `2500m`) and indirect fire support.
* **Hybrid Spatial Representation ("Heavy Offline GIS Compiler -> Lean Runtime Schema")**:
  * **Raster Grid (`10m` cell resolution)**: Up to `400 × 400 = 160,000` cells stored in compact `TypedArray` channels (`elevation: Float32Array`, `slope: Float32Array`, `terrain: Uint8Array`, `buildingIdGrid: Int16Array`) for $O(1)$ zero-GC runtime queries and fast raymarching.
  * **Vector & Entity Topology**: Exact vector geometry for `RoadNetwork` (graph nodes, edges, polylines for road fast-march and tangent alignment) and discrete `Building[]` footprints (linked via `buildingIdGrid`).

### 1.2 Offline GIS Compiler & Post-Processing Pipeline
Raw geospatial data is sanitized offline rather than parsed in browser/simulation runtime:
* **Data Sources**: OpenStreetMap (OSM) vector features + 1m OpenData LiDAR DEM (Hessen HVBG DGM1 / Thüringen GDI-Th).
* **Schema Cleanup**: Strip irrelevant OSM tags, enforce topological validity, and fill missing defaults.
* **Tree Normalization**: Unify point features (`natural=tree`), linear features (`natural=tree_row`), and area features (`natural=wood`, `landuse=forest`) by buffering points/lines by canopy radius and rasterizing them consistently—preventing "visual trees with zero gameplay modifiers."
* **Waterway Scaling**: Differentiate narrow fordable brooks and drainage ditches (`waterway=stream` / `ditch` / narrow `width` -> `shallow_stream`, passable by `"foot"` and `"tracked"` units and offering `"low_profile"` micro-cover) from wide rivers/lakes (`waterway=river` -> `deep_water`, requiring bridges or `"amphibious"` capability).
* **Procedural Enrichment**:
  * Synthesize field-boundary hedgerows (`hedgerow`) and drainage micro-terrain along agricultural parcel borders (`landuse=farmland`).
  * Infer missing `building:levels`, construction archetype, and per-floor capacities from OSM footprint area and building tags (e.g., farm barns, residential blocks, tall church towers).
  * Horizontally partition oversized contiguous building footprints into tactical sub-buildings during preprocessing.

---

## 2. Standardized English Terminology & Terrain Schema (`TerrainDef`)

To avoid ambiguity, all simulation code uses standardized English enums and strictly distinguishes **Concealment** (`baseSignature`, `signatureMult` — reduces detection range) from **Cover** (`damageMult`, `suppressionMult` — reduces incoming damage and suppression).

```ts
export type MobilityClass = "foot" | "wheeled" | "tracked" | "amphibious";

export type UnitTrait =
  | "infantry"
  | "vehicle"
  | "armored"
  | "low_profile"
  | "tall_profile";

export type TerrainId =
  | "open"
  | "tall_grass"
  | "hedgerow"
  | "light_forest"
  | "dense_forest"
  | "paved_road"
  | "dirt_road"
  | "shallow_stream"
  | "deep_water"
  | "urban_pavement"
  | "marsh";

export interface CombatModifiers {
  signatureMult?: number;   // Concealment modifier (<1 = harder to spot; e.g., tall_grass: 0.5 for infantry/low_profile, 1.0 for tall_profile)
  damageMult?: number;      // Cover modifier (<1 = reduces strength attrition)
  suppressionMult?: number; // Cover modifier (<1 = reduces incoming suppression)
  attackMult?: number;      // Firepower / firing-position modifier
}

export interface TerrainDef {
  id: TerrainId;

  // 1. Movement Cost (dimensionless pathfinding weight and speed multiplier)
  movementCost: number;     // Pathfinding cost weight (e.g., paved_road = 0.5, open = 1.0, forest = 2.5)
  speedMultiplier: number;  // Actual movement speed multiplier (e.g., paved_road = 1.5, open = 1.0, forest = 0.4)

  // 2. Concealment / Base Signature (exposure percentage in this terrain, 0..1)
  baseSignature: number;    // 1.0 = fully exposed (open/road), lower = better base concealment

  // 3. Optical Transmittance (Beer-Lambert attenuation parameter + canopy height)
  transmittancePer100m: number; // T in (0, 1]. Open terrain = 1.0 (linear decay only); dense foliage < 1.0
  canopyHeight: number;         // Effective obstacle/vegetation height in meters (e.g., tall_grass = 1.5, hedgerow = 3, forest = 12)

  // 4. Metadata (visual & descriptive properties)
  meta: {
    name: string;
    colorHex: string;
    roughness: number;
  };

  // 5. Passability (enumerated by MobilityClass + terrain slope limit)
  passability: {
    allowedMobility: ReadonlyArray<MobilityClass>;
    maxSlopeDeg: number;    // e.g., wheeled = 20°, tracked = 30°, foot = 45°
  };

  // 6. Tag-Based Extra Modifiers (enumerated by UnitTrait)
  traitModifiers: Partial<Record<UnitTrait, CombatModifiers>>;
}
```

---

## 3. Unified 3D Sightline & Optical Attenuation Model (`Beer-Lambert + Linear Decay`)

Visibility combines **3D terrain/building occlusion**, **canopy-height-aware Beer-Lambert optical attenuation** through intervening foliage/obstructions, and **linear distance scaling** across open ground.

### 3.1 Effective Target Signature ($S_E$)
$$S_E = S_{\text{unit}} \times \text{baseSignature}(\text{terrain}_E) \times \text{signatureMult}(\text{terrain}_E, \text{traits}_E) \times M_{\text{state}}$$
where $S_{\text{unit}}$ is the unit's inherent profile/stealth rating and $M_{\text{state}}$ captures dynamic state modifiers (e.g., moving, firing signature).

### 3.2 Optical Extinction & 3D Raymarching
For each terrain cell $k$, the extinction coefficient per meter is precomputed from `transmittancePer100m` ($T_{100\text{m}}$):
$$\mu_k = -\frac{\ln(T_{100\text{m}, k})}{100}$$
* For open terrain ($T_{100\text{m}} = 1.0$), $\mu_k = 0$ (no exponential attenuation; distance limit reduces to pure linear scaling).

When casting a 3D ray from observer eye position $(x_O, y_O, z_O)$ to target position $(x_E, y_E, z_E)$ in steps $\Delta s$:
1. **Terrain & Building Hard Block**:
   * If at any intermediate sample $z_{\text{ray}} < z_{\text{ground}}$ (terrain defilade / ridge mask), or the ray intersects a building volume (`buildingIdGrid`) below its `roofHeight` (excluding the observer's/target's own occupied building), the sightline is hard-blocked ($\mathcal{T} = 0$).
2. **Canopy Penetration (Beer-Lambert)**:
   * If $z_{\text{ground}} \le z_{\text{ray}} \le z_{\text{ground}} + h_{\text{canopy}, k}$ (the ray passes *through* tall grass, hedgerows, or forest canopy—and optionally dynamic smoke volumes in Phase 3), accumulate optical depth:
     $$\tau \mathrel{+}= \mu_k \cdot \Delta s$$
   * Rays elevated above $z_{\text{ground}} + h_{\text{canopy}, k}$ (e.g., observers on high ground or upper building floors looking *over* `1.5m` tall grass or `3m` hedgerows) incur zero attenuation from those lower obstacles.
3. **Unified Detection Criterion**:
   * Total transmittance along the path is $\mathcal{T} = e^{-\tau}$.
   * Given observer optics range $R_{\text{optics}}$ and horizontal/3D distance $D$, detection succeeds when:
     $$D \le (R_{\text{optics}} \cdot S_E) \cdot e^{-\tau}$$

*(Note: The `sightline()` query interface should accept an optional list of dynamic occlusion volumes so Phase 3 smoke clouds integrate without refactoring `map.ts`.)*

---

## 4. Multi-Story Building Model (`Building` & `BuildingFloor`)

Buildings are discrete tactical structures supporting per-floor occupancy, elevated vantage points, and independent per-floor destruction.

```ts
export type FloorState = "intact" | "damaged" | "gutted";

export interface BuildingFloor {
  level: number;            // 1-indexed (1 = ground floor, 2 = 2nd floor, ...)
  elevationOffset: number;  // Height above groundElevation in meters (e.g., (level - 1) * 3.2 + 1.5)
  capacity: number;         // Max garrison headcount on this floor
  integrity: number;        // 0..100 structural durability
  state: FloorState;        // Single floor can be gutted independently of other floors
  occupants: string[];      // Unit IDs currently garrisoning this floor
  modifiers: CombatModifiers; // Material & elevation-based concealment, cover, and attack modifiers
}

export interface Building {
  id: string;
  footprint: Vec[];         // 2D polygon vertices (oversized buildings split horizontally offline)
  center: Vec;
  groundElevation: number;
  roofHeight: number;       // Total building obstruction height above ground (meters)
  floors: BuildingFloor[];
}
```

### Key Operational Rules
1. **Headcount-Based Capacity**:
   * Floor `capacity` is checked against unit `headcount` (total personnel in the unit/platoon/section), keeping the building model forward-compatible if infantry granularity is refined from platoons to squads/fireteams in Phase 4.
2. **Conservative Per-Floor Destruction (`"gutted"`)**:
   * Direct/indirect fire can degrade and destroy individual floors without collapsing the whole building.
   * When a floor transitions to `"gutted"`:
     * All defensive/concealment `modifiers` on that floor are stripped (reset to neutral `1.0`).
     * Occupying infantry immediately suffer a one-time fixed strength damage and suppression shock and must vacate/relocate from the gutted position.
     * **Vertical movement topology is preserved**: stairwell traversal between remaining intact/damaged floors above and below a gutted floor remains functional, and the building's external `roofHeight` LoS occlusion remains intact.

---

## 5. Planned Sub-Issue Breakdown (`1A`, `1B`, `1C`)

Phase 1 will be dispatched as three sequential/layered implementation sub-issues under Master Issue `#4` (targeting branch `feat/rts-core`, pending explicit user approval before issue creation):

| Sub-Issue | Scope | Primary Deliverables |
| :--- | :--- | :--- |
| **`1A`** | Core Data Structures & 3D Sightline Engine (`src/sim/map.ts`) | `MobilityClass`, `UnitTrait`, `TerrainDef` 6-dimension attribute registry, `10m` `TypedArray` raster channels, `Building`/`BuildingFloor` model with conservative floor destruction, and 3D Beer-Lambert `sightline()` engine (with dynamic occlusion hook). |
| **`1B`** | Offline OSM + DGM1 DEM ETL & Map Compiler (`scripts/build-map.ts`) | Pull & clip Fulda Gap (Point Alpha / Rasdorf–Geisa) OSM + 1m LiDAR DEM data; normalize point/line/polygon trees; differentiate `shallow_stream` vs `deep_water`; procedurally enrich hedgerows, inferred `building:levels`, and split large footprints; export compact runtime map asset. |
| **`1C`** | Lightweight 3D Sandtable & LoS Inspector (`src/render/`, `src/ui/`) | Introduce Three.js (`three`) 3D terrain mesh + `InstancedMesh` buildings/canopy; add **"Map Inspector"** mode allowing LLM & combat loops to be paused/disabled so terrain attributes, slope passability, building floor capacities, and 3D Beer-Lambert transmittance fans ($\mathcal{T}$) can be inspected directly on the Fulda map. |
