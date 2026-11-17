// Geo-substrate, 6D terrain registry, 10m multi-channel raster, road/building vectors, and 3D Beer-Lambert LoS.
// Coordinates are meters: x = easting, y = northing (y grows to the north).
import { createNoise2D } from "simplex-noise";

export type Terrain = "open" | "forest" | "town" | "road";
export interface Vec { x: number; y: number }
export interface Place { name: string; pos: Vec; kind: "town" | "hill" | "wood" | "bridge" | "crossroads" | "marker"; note?: string }

export const CELL = 50;      // legacy coarse cell size (meters)
export const FINE_CELL = 10; // Stage 2 fine raster cell size (meters)

export type MobilityClass = "foot" | "wheeled" | "tracked" | "amphibious";
export type UnitTrait = "infantry" | "vehicle" | "armored" | "low_profile" | "tall_profile";
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
  signatureMult?: number;
  damageMult?: number;
  suppressionMult?: number;
  attackMult?: number;
}

export interface TerrainDef {
  id: TerrainId;
  movementCost: number;
  speedMultiplier: number;
  baseSignature: number;
  transmittancePer100m: number;
  canopyHeight: number;
  meta: { name: string; colorHex: string; roughness: number };
  passability: { allowedMobility: ReadonlyArray<MobilityClass>; maxSlopeDeg: number };
  traitModifiers: Partial<Record<UnitTrait, CombatModifiers>>;
}

export const TERRAIN_IDS: readonly TerrainId[] = [
  "open",
  "tall_grass",
  "hedgerow",
  "light_forest",
  "dense_forest",
  "paved_road",
  "dirt_road",
  "shallow_stream",
  "deep_water",
  "urban_pavement",
  "marsh",
];

const TERRAIN_INDEX = new Map<TerrainId, number>(TERRAIN_IDS.map((id, i) => [id, i]));
const ALL_MOBILITY: readonly MobilityClass[] = ["foot", "wheeled", "tracked", "amphibious"];
const MOBILITY_MAX_SLOPE_DEG: Record<MobilityClass, number> = {
  foot: 45,
  wheeled: 20,
  tracked: 30,
  amphibious: 25,
};

export const TERRAIN_DEFS: Record<TerrainId, TerrainDef> = {
  open: {
    id: "open",
    movementCost: 1.0,
    speedMultiplier: 1.0,
    baseSignature: 1.0,
    transmittancePer100m: 1.0,
    canopyHeight: 0,
    meta: { name: "Open Ground", colorHex: "#8da16b", roughness: 0.85 },
    passability: { allowedMobility: ALL_MOBILITY, maxSlopeDeg: 45 },
    traitModifiers: {},
  },
  tall_grass: {
    id: "tall_grass",
    movementCost: 1.15,
    speedMultiplier: 0.9,
    baseSignature: 1.0,
    transmittancePer100m: 0.65,
    canopyHeight: 1.5,
    meta: { name: "Tall Grass", colorHex: "#9fb063", roughness: 0.9 },
    passability: { allowedMobility: ALL_MOBILITY, maxSlopeDeg: 40 },
    traitModifiers: {
      infantry: { signatureMult: 0.5, suppressionMult: 0.9 },
      low_profile: { signatureMult: 0.5 },
      tall_profile: { signatureMult: 1.0 },
    },
  },
  hedgerow: {
    id: "hedgerow",
    movementCost: 2.2,
    speedMultiplier: 0.45,
    baseSignature: 0.5,
    transmittancePer100m: 0.08,
    canopyHeight: 3.0,
    meta: { name: "Hedgerow", colorHex: "#4f6d3a", roughness: 0.95 },
    passability: { allowedMobility: ["foot", "tracked", "amphibious"], maxSlopeDeg: 35 },
    traitModifiers: {
      infantry: { signatureMult: 0.6, damageMult: 0.65, suppressionMult: 0.6 },
      low_profile: { signatureMult: 0.65, damageMult: 0.75 },
      tall_profile: { signatureMult: 0.95 },
    },
  },
  light_forest: {
    id: "light_forest",
    movementCost: 1.8,
    speedMultiplier: 0.55,
    baseSignature: 0.55,
    transmittancePer100m: 0.25,
    canopyHeight: 10,
    meta: { name: "Light Forest", colorHex: "#557843", roughness: 0.92 },
    passability: { allowedMobility: ALL_MOBILITY, maxSlopeDeg: 35 },
    traitModifiers: {
      infantry: { signatureMult: 0.7, damageMult: 0.65, suppressionMult: 0.65 },
      vehicle: { signatureMult: 0.85, damageMult: 0.9 },
    },
  },
  dense_forest: {
    id: "dense_forest",
    movementCost: 2.5,
    speedMultiplier: 0.4,
    baseSignature: 0.35,
    transmittancePer100m: 0.05,
    canopyHeight: 12,
    meta: { name: "Dense Forest", colorHex: "#32522d", roughness: 0.96 },
    passability: { allowedMobility: ["foot", "tracked"], maxSlopeDeg: 35 },
    traitModifiers: {
      infantry: { signatureMult: 0.6, damageMult: 0.5, suppressionMult: 0.5 },
      armored: { damageMult: 0.85 },
    },
  },
  paved_road: {
    id: "paved_road",
    movementCost: 0.5,
    speedMultiplier: 1.5,
    baseSignature: 1.0,
    transmittancePer100m: 1.0,
    canopyHeight: 0,
    meta: { name: "Paved Road", colorHex: "#62666d", roughness: 0.55 },
    passability: { allowedMobility: ALL_MOBILITY, maxSlopeDeg: 45 },
    traitModifiers: {},
  },
  dirt_road: {
    id: "dirt_road",
    movementCost: 0.7,
    speedMultiplier: 1.25,
    baseSignature: 1.0,
    transmittancePer100m: 1.0,
    canopyHeight: 0,
    meta: { name: "Dirt Road", colorHex: "#9b8461", roughness: 0.8 },
    passability: { allowedMobility: ALL_MOBILITY, maxSlopeDeg: 45 },
    traitModifiers: {},
  },
  shallow_stream: {
    id: "shallow_stream",
    movementCost: 2.2,
    speedMultiplier: 0.45,
    baseSignature: 0.85,
    transmittancePer100m: 1.0,
    canopyHeight: 0,
    meta: { name: "Shallow Stream", colorHex: "#5d8aa8", roughness: 0.35 },
    passability: { allowedMobility: ["foot", "tracked", "amphibious"], maxSlopeDeg: 30 },
    traitModifiers: {
      infantry: { damageMult: 0.8, suppressionMult: 0.8 },
      low_profile: { signatureMult: 0.75, damageMult: 0.8 },
    },
  },
  deep_water: {
    id: "deep_water",
    movementCost: 4.0,
    speedMultiplier: 0.35,
    baseSignature: 1.0,
    transmittancePer100m: 1.0,
    canopyHeight: 0,
    meta: { name: "Deep Water", colorHex: "#2d5c88", roughness: 0.2 },
    passability: { allowedMobility: ["amphibious"], maxSlopeDeg: 25 },
    traitModifiers: {},
  },
  urban_pavement: {
    id: "urban_pavement",
    movementCost: 0.65,
    speedMultiplier: 1.2,
    baseSignature: 0.9,
    transmittancePer100m: 1.0,
    canopyHeight: 0,
    meta: { name: "Urban Pavement", colorHex: "#8c8982", roughness: 0.7 },
    passability: { allowedMobility: ALL_MOBILITY, maxSlopeDeg: 45 },
    traitModifiers: {
      infantry: { signatureMult: 0.85, damageMult: 0.85, suppressionMult: 0.85 },
    },
  },
  marsh: {
    id: "marsh",
    movementCost: 3.0,
    speedMultiplier: 0.3,
    baseSignature: 0.75,
    transmittancePer100m: 0.85,
    canopyHeight: 1.2,
    meta: { name: "Marsh", colorHex: "#627358", roughness: 0.75 },
    passability: { allowedMobility: ["foot", "amphibious"], maxSlopeDeg: 20 },
    traitModifiers: {
      infantry: { signatureMult: 0.75, damageMult: 0.85 },
      low_profile: { signatureMult: 0.75 },
    },
  },
};

export interface RoadNode {
  id: string;
  pos: Vec;
  kind?: "junction" | "bridge" | "endpoint";
}

export interface RoadEdge {
  id: string;
  from: string;
  to: string;
  kind: "paved_road" | "dirt_road";
  width: number;
  points: Vec[];
  isBridge?: boolean;
}

export interface RoadNetwork {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

export type FloorState = "intact" | "damaged" | "gutted";

export interface BuildingFloor {
  level: number;
  elevationOffset: number;
  capacity: number;
  integrity: number;
  state: FloorState;
  occupants: string[];
  modifiers: CombatModifiers;
}

export interface Building {
  id: string;
  footprint: Vec[];
  center: Vec;
  groundElevation: number;
  roofHeight: number;
  floors: BuildingFloor[];
}

export interface GutFloorResult {
  buildingId: string;
  level: number;
  evictedOccupants: string[];
  casualtyDamage: number;
  suppressionShock: number;
}

export interface DynamicOcclusionVolume {
  center: Vec;
  radius: number;
  minZ?: number;
  height: number;
  transmittancePer100m: number;
}

export interface SightlineOptions {
  stepMeters?: number;
  dynamicVolumes?: ReadonlyArray<DynamicOcclusionVolume>;
  ignoreBuildingIds?: ReadonlyArray<string>;
}

export interface SightlineResult {
  blocked: boolean;
  transmittance: number;
  opticalDepth: number;
  distance: number;
  blockReason?: "terrain" | "building";
}

export interface MapAsset {
  version: number;
  name: string;
  width: number;
  depth: number;
  fineCellSize: number;
  originUtm?: { easting: number; northing: number; zone: number };
  elevationDmB64: string;
  terrainB64: string;
  roadNetwork: RoadNetwork;
  buildings: Building[];
  places: Place[];
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Seeded PRNG (mulberry32) so maps and fights are reproducible. */
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function toLegacyTerrain(id: TerrainId): Terrain {
  if (id === "paved_road" || id === "dirt_road") return "road";
  if (id === "urban_pavement") return "town";
  if (id === "light_forest" || id === "dense_forest" || id === "hedgerow") return "forest";
  return "open";
}

function toTerrainId(t: Terrain | TerrainId): TerrainId {
  if (t === "forest") return "dense_forest";
  if (t === "town") return "urban_pavement";
  if (t === "road") return "paved_road";
  return t;
}

function pointInPolygon(p: Vec, poly: ReadonlyArray<Vec>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export class GameMap {
  readonly cols: number;
  readonly rows: number;
  readonly fineCellSize = FINE_CELL;
  readonly fineCols: number;
  readonly fineRows: number;

  // Legacy 50m raster views (kept synchronized for PaperMap, ascii, sitrep, and world)
  readonly height: Float32Array;
  readonly terrain: Terrain[];

  // Stage 2 10m multi-channel TypedArray geo-substrate
  readonly elevationGrid: Float32Array;
  readonly slopeGrid: Float32Array;
  readonly terrainGrid: Uint8Array;
  readonly buildingIdGrid: Int16Array;

  roadNetwork: RoadNetwork = { nodes: [], edges: [] };
  buildings: Building[] = [];
  places: Place[] = [];

  constructor(readonly width: number, readonly depth: number, seed = 1, opts?: { empty?: boolean }) {
    this.cols = Math.floor(width / CELL);
    this.rows = Math.floor(depth / CELL);
    this.fineCols = Math.floor(width / FINE_CELL);
    this.fineRows = Math.floor(depth / FINE_CELL);

    this.height = new Float32Array(this.cols * this.rows);
    this.terrain = new Array(this.cols * this.rows).fill("open");

    const fineCount = this.fineCols * this.fineRows;
    this.elevationGrid = new Float32Array(fineCount);
    this.slopeGrid = new Float32Array(fineCount);
    this.terrainGrid = new Uint8Array(fineCount); // 0 = "open"
    this.buildingIdGrid = new Int16Array(fineCount).fill(-1);

    if (!opts?.empty) {
      const hNoise = createNoise2D(rng(seed));
      const fNoise = createNoise2D(rng(seed + 1));
      const ratio = CELL / FINE_CELL;
      const forestIdx = TERRAIN_INDEX.get("dense_forest")!;
      for (let fr = 0; fr < this.fineRows; fr++) {
        for (let fc = 0; fc < this.fineCols; fc++) {
          const c = fc / ratio, r = fr / ratio;
          const fi = fr * this.fineCols + fc;
          this.elevationGrid[fi] = 20 + 15 * hNoise(c / 40, r / 40) + 5 * hNoise(c / 10, r / 10);
          if (fNoise(c / 15, r / 15) > 0.45) this.terrainGrid[fi] = forestIdx;
        }
      }
      this.recomputeSlopes();
      this.syncCoarseFromFine();
    }
  }

  /** Load a precompiled static MapAsset into 10m TypedArray channels and vector layers (zero runtime network I/O). */
  static fromAsset(asset: MapAsset): GameMap {
    const map = new GameMap(asset.width, asset.depth, 0, { empty: true });
    const elevBytes = decodeBase64(asset.elevationDmB64);
    const nElev = Math.min(map.elevationGrid.length, Math.floor(elevBytes.length / 2));
    for (let i = 0; i < nElev; i++) {
      const raw = (elevBytes[i * 2] | (elevBytes[i * 2 + 1] << 8)) << 16 >> 16;
      map.elevationGrid[i] = raw * 0.1;
    }
    const terBytes = decodeBase64(asset.terrainB64);
    map.terrainGrid.set(terBytes.subarray(0, map.terrainGrid.length));
    map.roadNetwork = {
      nodes: asset.roadNetwork.nodes.map((n) => ({ ...n, pos: { ...n.pos } })),
      edges: asset.roadNetwork.edges.map((e) => ({ ...e, points: e.points.map((p) => ({ ...p })) })),
    };
    map.places = asset.places.map((p) => ({ ...p, pos: { ...p.pos } }));
    for (const b of asset.buildings) {
      map.addBuilding({
        ...b,
        footprint: b.footprint.map((v) => ({ ...v })),
        center: { ...b.center },
        floors: b.floors.map((f) => ({ ...f, occupants: [...f.occupants], modifiers: { ...f.modifiers } })),
      });
    }
    map.recomputeSlopes();
    map.syncCoarseFromFine();
    return map;
  }

  idx(p: Vec) {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / CELL)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / CELL)));
    return r * this.cols + c;
  }

  fineIdx(p: Vec) {
    const fc = Math.min(this.fineCols - 1, Math.max(0, Math.floor(p.x / FINE_CELL)));
    const fr = Math.min(this.fineRows - 1, Math.max(0, Math.floor(p.y / FINE_CELL)));
    return fr * this.fineCols + fc;
  }

  terrainIdAt(p: Vec): TerrainId { return TERRAIN_IDS[this.terrainGrid[this.fineIdx(p)]] ?? "open"; }
  terrainDefAt(p: Vec): TerrainDef { return TERRAIN_DEFS[this.terrainIdAt(p)]; }
  slopeAt(p: Vec): number { return this.slopeGrid[this.fineIdx(p)]; }

  elevationAt(p: Vec): number {
    const gx = Math.min(this.fineCols - 1, Math.max(0, p.x / FINE_CELL - 0.5));
    const gy = Math.min(this.fineRows - 1, Math.max(0, p.y / FINE_CELL - 0.5));
    const c0 = Math.floor(gx), r0 = Math.floor(gy);
    const c1 = Math.min(this.fineCols - 1, c0 + 1), r1 = Math.min(this.fineRows - 1, r0 + 1);
    const tx = gx - c0, ty = gy - r0;
    const z00 = this.elevationGrid[r0 * this.fineCols + c0];
    const z10 = this.elevationGrid[r0 * this.fineCols + c1];
    const z01 = this.elevationGrid[r1 * this.fineCols + c0];
    const z11 = this.elevationGrid[r1 * this.fineCols + c1];
    return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
  }

  isPassable(p: Vec, mobility: MobilityClass): boolean {
    const def = this.terrainDefAt(p);
    if (!def.passability.allowedMobility.includes(mobility)) return false;
    const maxSlope = Math.min(def.passability.maxSlopeDeg, MOBILITY_MAX_SLOPE_DEG[mobility]);
    return this.slopeAt(p) <= maxSlope;
  }

  getTerrainModifiers(p: Vec, traits: ReadonlyArray<UnitTrait>): CombatModifiers {
    const def = this.terrainDefAt(p);
    let signatureMult = 1, damageMult = 1, suppressionMult = 1, attackMult = 1;
    for (const trait of traits) {
      const mod = def.traitModifiers[trait];
      if (!mod) continue;
      if (mod.signatureMult !== undefined) signatureMult *= mod.signatureMult;
      if (mod.damageMult !== undefined) damageMult *= mod.damageMult;
      if (mod.suppressionMult !== undefined) suppressionMult *= mod.suppressionMult;
      if (mod.attackMult !== undefined) attackMult *= mod.attackMult;
    }
    return { signatureMult, damageMult, suppressionMult, attackMult };
  }

  terrainAt(p: Vec): Terrain { return toLegacyTerrain(this.terrainIdAt(p)); }
  heightAt(p: Vec): number { return this.elevationAt(p); }
  inBounds(p: Vec) { return p.x >= 0 && p.y >= 0 && p.x < this.width && p.y < this.depth; }

  recomputeSlopes() {
    for (let fr = 0; fr < this.fineRows; fr++) {
      const rUp = Math.min(this.fineRows - 1, fr + 1), rDn = Math.max(0, fr - 1);
      const dy = (rUp - rDn) * FINE_CELL || FINE_CELL;
      for (let fc = 0; fc < this.fineCols; fc++) {
        const cRt = Math.min(this.fineCols - 1, fc + 1), cLt = Math.max(0, fc - 1);
        const dx = (cRt - cLt) * FINE_CELL || FINE_CELL;
        const dzdx = (this.elevationGrid[fr * this.fineCols + cRt] - this.elevationGrid[fr * this.fineCols + cLt]) / dx;
        const dzdy = (this.elevationGrid[rUp * this.fineCols + fc] - this.elevationGrid[rDn * this.fineCols + fc]) / dy;
        this.slopeGrid[fr * this.fineCols + fc] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      }
    }
  }

  syncCoarseFromFine() {
    const ratio = Math.max(1, Math.round(CELL / FINE_CELL));
    const half = Math.floor(ratio / 2);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        const fcCenter = Math.min(this.fineCols - 1, c * ratio + half);
        const frCenter = Math.min(this.fineRows - 1, r * ratio + half);
        this.height[i] = this.elevationGrid[frCenter * this.fineCols + fcCenter];

        let legacy: Terrain = toLegacyTerrain(TERRAIN_IDS[this.terrainGrid[frCenter * this.fineCols + fcCenter]] ?? "open");
        if (legacy === "open") {
          for (let dr = 0; dr < ratio && legacy === "open"; dr++) {
            for (let dc = 0; dc < ratio; dc++) {
              const t = toLegacyTerrain(TERRAIN_IDS[this.terrainGrid[(r * ratio + dr) * this.fineCols + (c * ratio + dc)]] ?? "open");
              if (t === "town" || t === "road") { legacy = t; break; }
            }
          }
        }
        this.terrain[i] = legacy;
      }
    }
  }

  // ---- building topology & floor operations ----
  addBuilding(b: Building): Building {
    const bIdx = this.buildings.length;
    this.buildings.push(b);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of b.footprint) {
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
    const cMin = Math.max(0, Math.floor(minX / FINE_CELL));
    const cMax = Math.min(this.fineCols - 1, Math.floor(maxX / FINE_CELL));
    const rMin = Math.max(0, Math.floor(minY / FINE_CELL));
    const rMax = Math.min(this.fineRows - 1, Math.floor(maxY / FINE_CELL));
    for (let fr = rMin; fr <= rMax; fr++) {
      for (let fc = cMin; fc <= cMax; fc++) {
        const center = { x: (fc + 0.5) * FINE_CELL, y: (fr + 0.5) * FINE_CELL };
        if (pointInPolygon(center, b.footprint)) this.buildingIdGrid[fr * this.fineCols + fc] = bIdx;
      }
    }
    return b;
  }

  buildingAt(p: Vec): Building | undefined {
    const id = this.buildingIdGrid[this.fineIdx(p)];
    return id >= 0 ? this.buildings[id] : undefined;
  }

  canGarrisonFloor(buildingId: string, level: number, headcount: number): boolean {
    const floor = this.buildings.find((b) => b.id === buildingId)?.floors.find((f) => f.level === level);
    return !!floor && floor.state !== "gutted" && headcount > 0 && headcount <= floor.capacity;
  }

  gutBuildingFloor(buildingId: string, level: number): GutFloorResult | undefined {
    const floor = this.buildings.find((b) => b.id === buildingId)?.floors.find((f) => f.level === level);
    if (!floor) return undefined;
    if (floor.state === "gutted") {
      return { buildingId, level, evictedOccupants: [], casualtyDamage: 0, suppressionShock: 0 };
    }
    const evictedOccupants = [...floor.occupants];
    floor.state = "gutted";
    floor.integrity = 0;
    floor.occupants = [];
    floor.modifiers = { signatureMult: 1.0, damageMult: 1.0, suppressionMult: 1.0, attackMult: 1.0 };
    return { buildingId, level, evictedOccupants, casualtyDamage: 25, suppressionShock: 50 };
  }

  // ---- scenario authoring helpers ----
  private forFineCells(center: Vec, radius: number, fn: (fi: number, d: number) => void) {
    const cMin = Math.max(0, Math.floor((center.x - radius) / FINE_CELL));
    const cMax = Math.min(this.fineCols - 1, Math.floor((center.x + radius) / FINE_CELL));
    const rMin = Math.max(0, Math.floor((center.y - radius) / FINE_CELL));
    const rMax = Math.min(this.fineRows - 1, Math.floor((center.y + radius) / FINE_CELL));
    for (let fr = rMin; fr <= rMax; fr++) {
      for (let fc = cMin; fc <= cMax; fc++) {
        const d = dist(center, { x: (fc + 0.5) * FINE_CELL, y: (fr + 0.5) * FINE_CELL });
        if (d <= radius) fn(fr * this.fineCols + fc, d);
      }
    }
  }

  addHill(center: Vec, radius: number, rise: number) {
    this.forFineCells(center, radius * 2, (fi, d) => {
      this.elevationGrid[fi] += rise * Math.exp(-((d / radius) ** 2));
    });
    this.recomputeSlopes();
    this.syncCoarseFromFine();
  }

  paint(center: Vec, radius: number, t: Terrain | TerrainId) {
    const tid = TERRAIN_INDEX.get(toTerrainId(t)) ?? 0;
    this.forFineCells(center, radius, (fi) => (this.terrainGrid[fi] = tid));
    this.syncCoarseFromFine();
  }

  road(a: Vec, b: Vec, kind: "paved_road" | "dirt_road" = "paved_road") {
    const tid = TERRAIN_INDEX.get(kind)!;
    const urbanIdx = TERRAIN_INDEX.get("urban_pavement")!;
    const n = Math.max(1, Math.ceil(dist(a, b) / (FINE_CELL / 2)));
    for (let k = 0; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      const fi = this.fineIdx(p);
      if (this.terrainGrid[fi] !== urbanIdx) this.terrainGrid[fi] = tid;
    }
    const seq = this.roadNetwork.edges.length;
    const nA: RoadNode = { id: `rn_${seq}_a`, pos: { ...a }, kind: "endpoint" };
    const nB: RoadNode = { id: `rn_${seq}_b`, pos: { ...b }, kind: "endpoint" };
    this.roadNetwork.nodes.push(nA, nB);
    this.roadNetwork.edges.push({ id: `re_${seq}`, from: nA.id, to: nB.id, kind, width: kind === "paved_road" ? 8 : 5, points: [{ ...a }, { ...b }] });
    this.syncCoarseFromFine();
  }

  // ---- grid references: 4 digits = 100 m square, 6 digits = 10 m ----
  toGrid(p: Vec, digits: 4 | 6 = 4) {
    const unit = digits === 4 ? 100 : 10;
    const w = digits / 2;
    const f = (v: number) => String(Math.floor(v / unit)).padStart(w, "0");
    return f(p.x) + f(p.y);
  }

  resolve(ref: string): Vec | undefined {
    const s = ref.trim().replace(/^grid\s*/i, "").replace(/\s+/g, "");
    if (/^\d{4}$/.test(s)) return { x: +s.slice(0, 2) * 100 + 50, y: +s.slice(2) * 100 + 50 };
    if (/^\d{6}$/.test(s)) return { x: +s.slice(0, 3) * 10 + 5, y: +s.slice(3) * 10 + 5 };
    const key = ref.trim().toLowerCase();
    return this.places.find((pl) => pl.name.toLowerCase() === key)?.pos;
  }

  describe(p: Vec) {
    let best: Place | undefined, bd = Infinity;
    for (const pl of this.places) { const d = dist(p, pl.pos); if (d < bd) { bd = d; best = pl; } }
    const grid = this.toGrid(p);
    if (!best) return `grid ${grid}`;
    if (bd < 150) return `grid ${grid} (${best.name})`;
    return `grid ${grid} (${Math.round(bd / 50) * 50}m ${bearingName(best.pos, p)} of ${best.name})`;
  }

  /** Unified 3D sightline with terrain defilade, building roofs, canopy-height Beer-Lambert attenuation, and dynamic smoke hook. */
  sightline(a: Vec, eyeHeightA: number, b: Vec, targetHeightB: number, opts?: SightlineOptions): SightlineResult {
    const zA = this.elevationAt(a) + eyeHeightA;
    const zB = this.elevationAt(b) + targetHeightB;
    const d2D = dist(a, b);
    const distance = Math.hypot(d2D, zB - zA);
    if (distance < 1e-6) return { blocked: false, transmittance: 1, opticalDepth: 0, distance: 0 };

    const stepMeters = Math.max(1, opts?.stepMeters ?? this.fineCellSize);
    const steps = Math.max(1, Math.ceil(d2D / stepMeters));
    const ds = distance / steps;
    const bIdA = this.buildingIdGrid[this.fineIdx(a)];
    const bIdB = this.buildingIdGrid[this.fineIdx(b)];
    const ignoreSet = opts?.ignoreBuildingIds ? new Set(opts.ignoreBuildingIds) : undefined;
    const volumes = opts?.dynamicVolumes;

    let opticalDepth = 0;
    for (let k = 1; k <= steps; k++) {
      const t = (k - 0.5) / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const zRay = zA + (zB - zA) * t;
      const zGround = this.elevationAt(p);

      const bIdx = this.buildingIdGrid[this.fineIdx(p)];
      if (bIdx >= 0 && bIdx !== bIdA && bIdx !== bIdB) {
        const bld = this.buildings[bIdx];
        if (bld && !ignoreSet?.has(bld.id) && zRay < bld.groundElevation + bld.roofHeight) {
          return { blocked: true, transmittance: 0, opticalDepth: Infinity, distance, blockReason: "building" };
        }
      }

      if (zRay < zGround - 1e-4) {
        return { blocked: true, transmittance: 0, opticalDepth: Infinity, distance, blockReason: "terrain" };
      }

      const def = this.terrainDefAt(p);
      if (def.canopyHeight > 0 && def.transmittancePer100m < 1 && zRay >= zGround - 1e-4 && zRay <= zGround + def.canopyHeight) {
        opticalDepth += (-Math.log(def.transmittancePer100m) / 100) * ds;
      }

      if (volumes) {
        for (const vol of volumes) {
          if (dist(p, vol.center) <= vol.radius && vol.transmittancePer100m < 1) {
            const minZ = vol.minZ ?? this.elevationAt(vol.center);
            if (zRay >= minZ && zRay <= minZ + vol.height) {
              opticalDepth += (-Math.log(Math.max(1e-6, vol.transmittancePer100m)) / 100) * ds;
            }
          }
        }
      }
    }

    return { blocked: false, transmittance: Math.exp(-opticalDepth), opticalDepth, distance };
  }

  /** Backward-compatible 2D/3D boolean LoS delegating through sightline(). */
  los(a: Vec, b: Vec): boolean {
    if (dist(a, b) < 200) return true;
    const res = this.sightline(a, 3, b, 3);
    return !res.blocked && res.transmittance >= 0.05;
  }
}

export function bearingName(from: Vec, to: Vec) {
  const deg = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg + 360) % 360) / 45) % 8];
}
