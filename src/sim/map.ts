// Terrain grid, named places, grid references and line-of-sight.
// Coordinates are meters: x = easting, y = northing (y grows to the north).
import { createNoise2D } from "simplex-noise";

export type Terrain = "open" | "forest" | "town" | "road";
export interface Vec { x: number; y: number }
export interface Place { name: string; pos: Vec; kind: "town" | "hill" | "wood" | "bridge" | "crossroads"; note?: string }

export const CELL = 50; // meters per cell

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

export class GameMap {
  readonly cols: number;
  readonly rows: number;
  readonly height: Float32Array;
  readonly terrain: Terrain[];
  places: Place[] = [];

  constructor(readonly width: number, readonly depth: number, seed: number) {
    this.cols = Math.floor(width / CELL);
    this.rows = Math.floor(depth / CELL);
    this.height = new Float32Array(this.cols * this.rows);
    this.terrain = new Array(this.cols * this.rows).fill("open");
    const hNoise = createNoise2D(rng(seed));
    const fNoise = createNoise2D(rng(seed + 1));
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const i = r * this.cols + c;
        this.height[i] = 20 + 15 * hNoise(c / 40, r / 40) + 5 * hNoise(c / 10, r / 10);
        if (fNoise(c / 15, r / 15) > 0.45) this.terrain[i] = "forest";
      }
  }

  idx(p: Vec) {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / CELL)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / CELL)));
    return r * this.cols + c;
  }
  terrainAt(p: Vec) { return this.terrain[this.idx(p)]; }
  heightAt(p: Vec) { return this.height[this.idx(p)]; }
  inBounds(p: Vec) { return p.x >= 0 && p.y >= 0 && p.x < this.width && p.y < this.depth; }

  // ---- scenario authoring helpers ----
  private forCells(center: Vec, radius: number, fn: (i: number, d: number) => void) {
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++) {
        const d = dist(center, { x: (c + 0.5) * CELL, y: (r + 0.5) * CELL });
        if (d <= radius) fn(r * this.cols + c, d);
      }
  }
  addHill(center: Vec, radius: number, rise: number) {
    this.forCells(center, radius * 2, (i, d) => (this.height[i] += rise * Math.exp(-((d / radius) ** 2))));
  }
  paint(center: Vec, radius: number, t: Terrain) { this.forCells(center, radius, (i) => (this.terrain[i] = t)); }
  road(a: Vec, b: Vec) {
    const n = Math.ceil(dist(a, b) / (CELL / 2));
    for (let k = 0; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      if (this.terrainAt(p) !== "town") this.terrain[this.idx(p)] = "road";
    }
  }

  // ---- grid references: 4 digits = 100 m square, 6 digits = 10 m ----
  toGrid(p: Vec, digits: 4 | 6 = 4) {
    const unit = digits === 4 ? 100 : 10;
    const w = digits / 2;
    const f = (v: number) => String(Math.floor(v / unit)).padStart(w, "0");
    return f(p.x) + f(p.y);
  }
  /** Resolve "2131", "213315" or a place name ("Hill 112") to a point. */
  resolve(ref: string): Vec | undefined {
    const s = ref.trim().replace(/^grid\s*/i, "").replace(/\s+/g, "");
    if (/^\d{4}$/.test(s)) return { x: +s.slice(0, 2) * 100 + 50, y: +s.slice(2) * 100 + 50 };
    if (/^\d{6}$/.test(s)) return { x: +s.slice(0, 3) * 10 + 5, y: +s.slice(3) * 10 + 5 };
    const key = ref.trim().toLowerCase();
    return this.places.find((pl) => pl.name.toLowerCase() === key)?.pos;
  }

  /** Human description of where a point is relative to the nearest named place. */
  describe(p: Vec) {
    let best: Place | undefined, bd = Infinity;
    for (const pl of this.places) { const d = dist(p, pl.pos); if (d < bd) { bd = d; best = pl; } }
    const grid = this.toGrid(p);
    if (!best) return `grid ${grid}`;
    if (bd < 150) return `grid ${grid} (${best.name})`;
    return `grid ${grid} (${Math.round(bd / 50) * 50}m ${bearingName(best.pos, p)} of ${best.name})`;
  }

  /** Line of sight between two ground positions. Forest/town cells in between block at +10 m. */
  los(a: Vec, b: Vec) {
    const d = dist(a, b);
    if (d < 200) return true; // close combat: grid-scale bumps don't hide anyone
    const ha = this.heightAt(a) + 3, hb = this.heightAt(b) + 3;
    const steps = Math.ceil(d / (CELL / 2));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const along = d * t;
      let ground = this.heightAt(p);
      const ter = this.terrainAt(p);
      // Vegetation/buildings block only away from both endpoints (units can see out of their own cover).
      if ((ter === "forest" || ter === "town") && along > 75 && d - along > 75) ground += 10;
      if (ground > ha + (hb - ha) * t) return false;
    }
    return true;
  }
}

export function bearingName(from: Vec, to: Vec) {
  const deg = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg + 360) % 360) / 45) % 8];
}
