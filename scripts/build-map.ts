// Offline GIS compiler: ingests OSM XML + Hessen DGM1 WCS + Copernicus COG DEM around Point Alpha (Fulda Gap)
// and emits a compact 10m static runtime MapAsset at src/sim/maps/fulda-point-alpha.json.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fromArrayBuffer } from "geotiff";
import {
  Building, BuildingFloor, MapAsset, Place, RoadEdge, RoadNetwork, RoadNode,
  TERRAIN_IDS, TerrainId, Vec,
} from "../src/sim/map";

const ORIGIN_E = 563500;
const ORIGIN_N = 5617200;
const MAP_SIZE = 4000;
const CELL = 10;
const GRID_N = MAP_SIZE / CELL; // 400

const CACHE_DIR = path.resolve("scratch/gis-test");
const OUT_PATH = path.resolve("src/sim/maps/fulda-point-alpha.json");
const TERRAIN_IDX = new Map<TerrainId, number>(TERRAIN_IDS.map((t, i) => [t, i]));

/** WGS84 (lat, lon) -> UTM Zone 32N (EPSG:25832) local map meters. */
function wgs84ToLocal(latDeg: number, lonDeg: number): Vec {
  const a = 6378137.0, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = (latDeg * Math.PI) / 180, lam = (lonDeg * Math.PI) / 180, lam0 = (9.0 * Math.PI) / 180;
  const sinP = Math.sin(phi), cosP = Math.cos(phi), tanP = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sinP * sinP);
  const T = tanP * tanP, C = ep2 * cosP * cosP, A = cosP * (lam - lam0);
  const M = a * (
    (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi)
  );
  const east = 500000 + k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120);
  const north = k0 * (M + N * tanP * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  return { x: east - ORIGIN_E, y: north - ORIGIN_N };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const inMap = (p: Vec) => p.x >= 0 && p.y >= 0 && p.x <= MAP_SIZE && p.y <= MAP_SIZE;

async function ensureSources() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const osmFile = path.join(CACHE_DIR, "fulda_4km.osm");
  const hessenFile = path.join(CACHE_DIR, "hessen_5m.tif");
  const copFile = path.join(CACHE_DIR, "copernicus_10m.tif");

  if (!fs.existsSync(osmFile)) {
    console.log("Fetching OSM data...");
    const res = await fetch("https://api.openstreetmap.org/api/0.6/map?bbox=9.898,50.702,9.958,50.740");
    if (!res.ok) throw new Error(`OSM fetch failed: ${res.status}`);
    fs.writeFileSync(osmFile, Buffer.from(await res.arrayBuffer()));
  }
  if (!fs.existsSync(hessenFile)) {
    console.log("Fetching Hessen 1m LiDAR DGM1 WCS...");
    const url = `https://inspire-hessen.de/raster/dgm1/ows?request=GetCoverage&service=WCS&version=2.0.1&coverageid=he_dgm1&FORMAT=image/tiff&SUBSET=E(${ORIGIN_E},${ORIGIN_E + MAP_SIZE})&SUBSET=N(${ORIGIN_N},${ORIGIN_N + MAP_SIZE})&SCALESIZE=E(800),N(800)`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Hessen WCS failed: ${res.status}`);
    fs.writeFileSync(hessenFile, Buffer.from(await res.arrayBuffer()));
  }
  if (!fs.existsSync(copFile)) {
    console.log("Clipping Copernicus DEM COG for Thüringen border fill...");
    execFileSync("gdalwarp", [
      "-overwrite", "-t_srs", "EPSG:25832",
      "-te", String(ORIGIN_E), String(ORIGIN_N), String(ORIGIN_E + MAP_SIZE), String(ORIGIN_N + MAP_SIZE),
      "-tr", "10", "10", "-r", "cubicspline",
      "/vsicurl/https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N50_00_E009_00_DEM/Copernicus_DSM_COG_10_N50_00_E009_00_DEM.tif",
      copFile,
    ], { stdio: "inherit" });
  }
  return { osmFile, hessenFile, copFile };
}

async function readGeoTiffBand(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const img = await tiff.getImage();
  const data = (await img.readRasters({ interleave: true })) as Float32Array | Float64Array;
  return { width: img.getWidth(), height: img.getHeight(), data };
}

async function buildElevationDm(hessenFile: string, copFile: string): Promise<Int16Array> {
  const hessen = await readGeoTiffBand(hessenFile);
  const cop = await readGeoTiffBand(copFile);
  const hessen10 = new Float32Array(GRID_N * GRID_N).fill(NaN);
  const cop10 = new Float32Array(GRID_N * GRID_N);

  const hScaleX = hessen.width / GRID_N, hScaleY = hessen.height / GRID_N;
  const cScaleX = cop.width / GRID_N, cScaleY = cop.height / GRID_N;
  let biasSum = 0, biasCount = 0;

  for (let fr = 0; fr < GRID_N; fr++) {
    const tifR_h = Math.min(hessen.height - 1, Math.floor((GRID_N - 1 - fr) * hScaleY));
    const tifR_c = Math.min(cop.height - 1, Math.floor((GRID_N - 1 - fr) * cScaleY));
    for (let fc = 0; fc < GRID_N; fc++) {
      const tifC_h = Math.min(hessen.width - 1, Math.floor(fc * hScaleX));
      const tifC_c = Math.min(cop.width - 1, Math.floor(fc * cScaleX));
      const cVal = cop.data[tifR_c * cop.width + tifC_c];
      cop10[fr * GRID_N + fc] = cVal;
      const hVal = hessen.data[tifR_h * hessen.width + tifC_h];
      if (Number.isFinite(hVal) && hVal > 100 && hVal < 2000) {
        hessen10[fr * GRID_N + fc] = hVal;
        biasSum += hVal - cVal;
        biasCount++;
      }
    }
  }
  const offset = biasCount > 0 ? biasSum / biasCount : 0;
  const out = new Int16Array(GRID_N * GRID_N);
  for (let i = 0; i < out.length; i++) {
    const elev = Number.isFinite(hessen10[i]) ? hessen10[i] : cop10[i] + offset;
    out[i] = Math.round(elev * 10);
  }
  return out;
}

interface OsmWay { id: string; refs: string[]; tags: Record<string, string> }
interface OsmRel { id: string; members: { type: string; ref: string; role: string }[]; tags: Record<string, string> }

function parseOsmXml(xml: string) {
  const nodes = new Map<string, { pos: Vec; tags: Record<string, string> }>();
  const ways = new Map<string, OsmWay>();
  const relations: OsmRel[] = [];

  const attr = (s: string, k: string) => {
    const m = s.match(new RegExp(`\\b${k}="([^"]*)"`));
    return m ? m[1] : "";
  };
  const lines = xml.split(/\r?\n/);
  let curKind: "node" | "way" | "rel" | null = null;
  let curId = "", curPos: Vec = { x: 0, y: 0 }, curTags: Record<string, string> = {};
  let curRefs: string[] = [], curMembers: OsmRel["members"] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("<node ")) {
      curId = attr(line, "id");
      curPos = wgs84ToLocal(Number(attr(line, "lat")), Number(attr(line, "lon")));
      curTags = {};
      if (line.endsWith("/>")) nodes.set(curId, { pos: curPos, tags: curTags });
      else curKind = "node";
    } else if (line.startsWith("</node>")) {
      nodes.set(curId, { pos: curPos, tags: curTags });
      curKind = null;
    } else if (line.startsWith("<way ")) {
      curKind = "way"; curId = attr(line, "id"); curRefs = []; curTags = {};
    } else if (line.startsWith("</way>")) {
      ways.set(curId, { id: curId, refs: curRefs, tags: curTags });
      curKind = null;
    } else if (line.startsWith("<relation ")) {
      curKind = "rel"; curId = attr(line, "id"); curMembers = []; curTags = {};
    } else if (line.startsWith("</relation>")) {
      relations.push({ id: curId, members: curMembers, tags: curTags });
      curKind = null;
    } else if (curKind === "way" && line.startsWith("<nd ")) {
      curRefs.push(attr(line, "ref"));
    } else if (curKind === "rel" && line.startsWith("<member ")) {
      curMembers.push({ type: attr(line, "type"), ref: attr(line, "ref"), role: attr(line, "role") });
    } else if (curKind && line.startsWith("<tag ")) {
      curTags[attr(line, "k")] = attr(line, "v");
    }
  }
  return { nodes, ways, relations };
}

function stitchOuterRings(wayIds: string[], ways: Map<string, OsmWay>, nodes: Map<string, { pos: Vec }>): Vec[][] {
  const chains = wayIds.map((id) => ways.get(id)?.refs).filter((r): r is string[] => !!r && r.length >= 2).map((r) => [...r]);
  const rings: Vec[][] = [];
  while (chains.length > 0) {
    let cur = chains.shift()!;
    let changed = true;
    while (changed && cur[0] !== cur[cur.length - 1]) {
      changed = false;
      for (let i = 0; i < chains.length; i++) {
        const c = chains[i], head = cur[0], tail = cur[cur.length - 1];
        if (c[0] === tail) cur = cur.concat(c.slice(1));
        else if (c[c.length - 1] === tail) cur = cur.concat([...c].reverse().slice(1));
        else if (c[c.length - 1] === head) cur = c.slice(0, -1).concat(cur);
        else if (c[0] === head) cur = [...c].reverse().slice(0, -1).concat(cur);
        else continue;
        chains.splice(i, 1); changed = true; break;
      }
    }
    const pts = cur.map((id) => nodes.get(id)?.pos).filter((p): p is Vec => !!p);
    if (pts.length >= 3) rings.push(pts);
  }
  return rings;
}

function polyArea(poly: ReadonlyArray<Vec>): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  return Math.abs(a) * 0.5;
}

function polyCentroid(poly: ReadonlyArray<Vec>): Vec {
  let sx = 0, sy = 0;
  for (const p of poly) { sx += p.x; sy += p.y; }
  return { x: sx / poly.length, y: sy / poly.length };
}

function pointInPoly(p: Vec, poly: ReadonlyArray<Vec>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function clipHalfPlane(poly: Vec[], axis: "x" | "y", val: number, keepLess: boolean): Vec[] {
  const out: Vec[] = [];
  const inside = (p: Vec) => (keepLess ? p[axis] <= val : p[axis] >= val);
  const intersect = (a: Vec, b: Vec): Vec => {
    const t = (val - a[axis]) / (b[axis] - a[axis] + 1e-12);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[(i + poly.length - 1) % poly.length], b = poly[i];
    const inA = inside(a), inB = inside(b);
    if (inB) {
      if (!inA) out.push(intersect(a, b));
      out.push(b);
    } else if (inA) {
      out.push(intersect(a, b));
    }
  }
  return out;
}

function splitOversizedFootprint(poly: Vec[], maxDim = 45, depth = 0): Vec[][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX, h = maxY - minY;
  if ((w <= maxDim && h <= maxDim) || depth >= 3) return [poly];
  const axis: "x" | "y" = w >= h ? "x" : "y";
  const mid = axis === "x" ? (minX + maxX) / 2 : (minY + maxY) / 2;
  const left = clipHalfPlane(poly, axis, mid, true);
  const right = clipHalfPlane(poly, axis, mid, false);
  const out: Vec[][] = [];
  if (left.length >= 3 && polyArea(left) >= 18) out.push(...splitOversizedFootprint(left, maxDim, depth + 1));
  if (right.length >= 3 && polyArea(right) >= 18) out.push(...splitOversizedFootprint(right, maxDim, depth + 1));
  return out.length > 0 ? out : [poly];
}

function simplifyPolyline(pts: Vec[], tol = 2.0): Vec[] {
  if (pts.length <= 2) return pts;
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > tol) {
    return simplifyPolyline(pts.slice(0, idx + 1), tol).slice(0, -1).concat(simplifyPolyline(pts.slice(idx), tol));
  }
  return [a, b];
}

async function main() {
  const { osmFile, hessenFile, copFile } = await ensureSources();
  console.log("Compiling elevation raster...");
  const elevDm = await buildElevationDm(hessenFile, copFile);
  const terrainGrid = new Uint8Array(GRID_N * GRID_N); // 0 = open

  console.log("Parsing OSM features...");
  const { nodes, ways, relations } = parseOsmXml(fs.readFileSync(osmFile, "utf8"));

  const paintCircle = (p: Vec, rad: number, t: TerrainId) => {
    const tid = TERRAIN_IDX.get(t)!;
    const c0 = Math.max(0, Math.floor((p.x - rad) / CELL)), c1 = Math.min(GRID_N - 1, Math.floor((p.x + rad) / CELL));
    const r0 = Math.max(0, Math.floor((p.y - rad) / CELL)), r1 = Math.min(GRID_N - 1, Math.floor((p.y + rad) / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (Math.hypot((c + 0.5) * CELL - p.x, (r + 0.5) * CELL - p.y) <= rad) terrainGrid[r * GRID_N + c] = tid;
    }
  };
  const paintLine = (pts: Vec[], rad: number, t: TerrainId) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
      for (let k = 0; k <= steps; k++) paintCircle({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps }, rad, t);
    }
  };
  const paintPoly = (poly: Vec[], t: TerrainId) => {
    const tid = TERRAIN_IDX.get(t)!;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of poly) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const c0 = Math.max(0, Math.floor(minX / CELL)), c1 = Math.min(GRID_N - 1, Math.floor(maxX / CELL));
    const r0 = Math.max(0, Math.floor(minY / CELL)), r1 = Math.min(GRID_N - 1, Math.floor(maxY / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (pointInPoly({ x: (c + 0.5) * CELL, y: (r + 0.5) * CELL }, poly)) terrainGrid[r * GRID_N + c] = tid;
    }
  };

  const wayPts = (w: OsmWay) => w.refs.map((id) => nodes.get(id)?.pos).filter((p): p is Vec => !!p);
  const polygonsWithTag = (pred: (tags: Record<string, string>) => boolean): { poly: Vec[]; tags: Record<string, string> }[] => {
    const out: { poly: Vec[]; tags: Record<string, string> }[] = [];
    for (const w of ways.values()) {
      if (pred(w.tags) && w.refs.length >= 4 && w.refs[0] === w.refs[w.refs.length - 1]) {
        const poly = wayPts(w);
        if (poly.length >= 3) out.push({ poly, tags: w.tags });
      }
    }
    for (const rel of relations) {
      if (rel.tags.type === "multipolygon" && pred(rel.tags)) {
        const outers = rel.members.filter((m) => m.type === "way" && m.role !== "inner").map((m) => m.ref);
        for (const poly of stitchOuterRings(outers, ways, nodes)) out.push({ poly, tags: rel.tags });
      }
    }
    return out;
  };

  // 1. Base landcover (grassland / wetland / urban) + procedural farmland hedgerows
  for (const { poly } of polygonsWithTag((t) => t.natural === "grassland" || t.landuse === "grass")) paintPoly(poly, "tall_grass");
  for (const { poly } of polygonsWithTag((t) => t.natural === "wetland")) paintPoly(poly, "marsh");
  for (const { poly } of polygonsWithTag((t) => ["residential", "industrial", "commercial", "retail"].includes(t.landuse ?? ""))) {
    paintPoly(poly, "urban_pavement");
  }
  for (const { poly } of polygonsWithTag((t) => t.landuse === "farmland")) {
    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i], b = poly[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const hash = Math.abs(Math.sin(a.x * 12.9898 + b.y * 78.233) * 43758.5453) % 1;
      if (len > 45 && hash < 0.42) paintLine([a, b], 4, "hedgerow");
    }
  }

  // 2. Tree normalization: forest polygons, scrub, tree_row lines, individual tree points
  for (const { poly } of polygonsWithTag((t) => t.natural === "scrub")) paintPoly(poly, "hedgerow");
  for (const { poly, tags } of polygonsWithTag((t) => t.landuse === "forest" || t.natural === "wood")) {
    paintPoly(poly, tags.leaf_type === "coniferous" || polyArea(poly) > 12000 ? "dense_forest" : "light_forest");
  }
  for (const w of ways.values()) {
    if (w.tags.natural === "tree_row") paintLine(wayPts(w), 6, "hedgerow");
  }
  for (const n of nodes.values()) {
    if (n.tags.natural === "tree" && inMap(n.pos)) paintCircle(n.pos, 6, "light_forest");
  }

  // 3. Waterway scaling: streams/ditches -> shallow_stream; rivers/lakes -> deep_water
  for (const w of ways.values()) {
    if (w.tags.waterway === "stream" || w.tags.waterway === "ditch" || w.tags.waterway === "drain") {
      paintLine(wayPts(w), 5, "shallow_stream");
    } else if (w.tags.waterway === "river") {
      paintLine(wayPts(w), 11, "deep_water");
    }
  }
  for (const { poly } of polygonsWithTag((t) => t.natural === "water" || t.waterway === "riverbank")) {
    paintPoly(poly, "deep_water");
  }

  // 4. RoadNetwork & Road rasterization (bridges overwrite waterways)
  const roadKinds = new Set(["primary", "secondary", "tertiary", "unclassified", "residential", "service", "track"]);
  const roadNodes = new Map<string, RoadNode>();
  const roadEdges: RoadEdge[] = [];
  const bridgePlaces: Place[] = [];

  for (const w of ways.values()) {
    const hw = w.tags.highway;
    if (!hw || !roadKinds.has(hw)) continue;
    const rawPts = wayPts(w);
    if (rawPts.length < 2 || !rawPts.some(inMap)) continue;
    const isDirt = hw === "track" || ["unpaved", "gravel", "dirt", "grass"].includes(w.tags.surface ?? "");
    const kind: "paved_road" | "dirt_road" = isDirt ? "dirt_road" : "paved_road";
    const isBridge = w.tags.bridge === "yes";
    paintLine(rawPts, kind === "paved_road" ? 6 : 5, kind);

    const startId = `n_${w.refs[0]}`, endId = `n_${w.refs[w.refs.length - 1]}`;
    if (!roadNodes.has(startId)) roadNodes.set(startId, { id: startId, pos: { x: r1(rawPts[0].x), y: r1(rawPts[0].y) }, kind: isBridge ? "bridge" : "junction" });
    if (!roadNodes.has(endId)) roadNodes.set(endId, { id: endId, pos: { x: r1(rawPts[rawPts.length - 1].x), y: r1(rawPts[rawPts.length - 1].y) }, kind: isBridge ? "bridge" : "junction" });
    roadEdges.push({
      id: `e_${w.id}`,
      from: startId,
      to: endId,
      kind,
      width: kind === "paved_road" ? (hw === "primary" || hw === "secondary" ? 8 : 6) : 4,
      points: simplifyPolyline(rawPts, 2.0).map((p) => ({ x: r1(p.x), y: r1(p.y) })),
      ...(isBridge ? { isBridge: true } : {}),
    });
    if (isBridge && hw === "secondary" && w.tags.name && bridgePlaces.length < 2) {
      const mid = rawPts[Math.floor(rawPts.length / 2)];
      if (inMap(mid)) bridgePlaces.push({ name: `${w.tags.name} Bridge`, pos: { x: r1(mid.x), y: r1(mid.y) }, kind: "bridge", note: "Ulster crossing" });
    }
  }
  const roadNetwork: RoadNetwork = { nodes: [...roadNodes.values()], edges: roadEdges };

  // 5. Buildings: infer levels/capacity/modifiers & horizontally subdivide oversized buildings
  const buildings: Building[] = [];
  let bSeq = 0;
  for (const { poly, tags } of polygonsWithTag((t) => !!t.building && t.building !== "no")) {
    const clean = poly.slice(0, -1);
    const center = polyCentroid(clean);
    if (center.x < 15 || center.x > MAP_SIZE - 15 || center.y < 15 || center.y > MAP_SIZE - 15) continue;
    const rawArea = polyArea(clean);
    if (rawArea < 20) continue;

    const parts = splitOversizedFootprint(clean, 45);
    for (const part of parts) {
      const area = polyArea(part);
      if (area < 18) continue;
      const c = polyCentroid(part);
      const fc = Math.min(GRID_N - 1, Math.max(0, Math.floor(c.x / CELL)));
      const fr = Math.min(GRID_N - 1, Math.max(0, Math.floor(c.y / CELL)));
      const groundElevation = r1(elevDm[fr * GRID_N + fc] * 0.1);

      const parsedLevels = Number(tags["building:levels"]);
      const bType = tags.building;
      let levels = Number.isFinite(parsedLevels) && parsedLevels >= 1 ? Math.min(6, Math.round(parsedLevels))
        : bType === "apartments" || bType === "commercial" ? 3
        : bType === "church" || bType === "chapel" ? 3
        : bType === "garage" || bType === "garages" || bType === "shed" ? 1
        : area > 110 ? 2 : 1;
      const floorH = bType === "industrial" || bType === "warehouse" || bType === "barn" ? 4.0 : 3.2;
      const cap = Math.max(4, Math.min(32, Math.round(area / 18)));
      const floors: BuildingFloor[] = [];
      for (let lv = 1; lv <= levels; lv++) {
        floors.push({
          level: lv,
          elevationOffset: r1((lv - 1) * floorH + 1.5),
          capacity: cap,
          integrity: 100,
          state: "intact",
          occupants: [],
          modifiers: {
            damageMult: 0.45,
            suppressionMult: 0.5,
            signatureMult: lv >= 2 ? 0.65 : 0.5,
            attackMult: lv >= 2 ? 1.1 : 1.0,
          },
        });
      }
      buildings.push({
        id: `bld_${++bSeq}`,
        footprint: part.map((p) => ({ x: r1(p.x), y: r1(p.y) })),
        center: { x: r1(c.x), y: r1(c.y) },
        groundElevation,
        roofHeight: r1(levels * floorH + 1.2),
        floors,
      });
      if (terrainGrid[fr * GRID_N + fc] === 0) terrainGrid[fr * GRID_N + fc] = TERRAIN_IDX.get("urban_pavement")!;
    }
  }

  // 6. Named tactical landmarks around Point Alpha
  const clampPlace = (name: string, lat: number, lon: number, kind: Place["kind"], note: string): Place => {
    const p = wgs84ToLocal(lat, lon);
    return {
      name,
      pos: { x: r1(Math.min(MAP_SIZE - 50, Math.max(50, p.x))), y: r1(Math.min(MAP_SIZE - 50, Math.max(50, p.y))) },
      kind,
      note,
    };
  };
  const places: Place[] = [
    clampPlace("Point Alpha", 50.7237, 9.9323, "hill", "Observation Post Alpha overlooking the Rasdorf-Geisa corridor"),
    clampPlace("Rasdorf Approach", 50.7175, 9.9045, "crossroads", "western highway approach from Rasdorf (Hessen)"),
    clampPlace("Geisa", 50.7145, 9.9498, "town", "eastern border town on the Ulster valley floor (Thüringen)"),
    clampPlace("Waldhof", 50.7324, 9.9327, "town", "northern farmstead complex along the patrol road"),
    clampPlace("Sissenberg", 50.7112, 9.9231, "hill", "southern wooded ridge overlooking Point Alpha"),
    ...bridgePlaces,
  ];

  const elevBytes = Buffer.alloc(elevDm.length * 2);
  for (let i = 0; i < elevDm.length; i++) elevBytes.writeInt16LE(elevDm[i], i * 2);

  const asset: MapAsset = {
    version: 1,
    name: "Fulda Gap — Point Alpha (Rasdorf-Geisa)",
    width: MAP_SIZE,
    depth: MAP_SIZE,
    fineCellSize: CELL,
    originUtm: { easting: ORIGIN_E, northing: ORIGIN_N, zone: 32 },
    elevationDmB64: elevBytes.toString("base64"),
    terrainB64: Buffer.from(terrainGrid).toString("base64"),
    roadNetwork,
    buildings,
    places,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(asset));
  const stats = fs.statSync(OUT_PATH);

  const counts: Partial<Record<TerrainId, number>> = {};
  for (let i = 0; i < terrainGrid.length; i++) {
    const id = TERRAIN_IDS[terrainGrid[i]];
    counts[id] = (counts[id] ?? 0) + 1;
  }
  console.log(`Compiled ${OUT_PATH} (${(stats.size / 1024).toFixed(1)} KB)`);
  console.log(`Buildings: ${buildings.length}, Road edges: ${roadEdges.length}, Places: ${places.length}`);
  console.log("Terrain cell counts:", counts);
}

main().catch((err) => { console.error(err); process.exit(1); });
