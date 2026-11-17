import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import ms from "milsymbol";
import { Game } from "../game";
import { Building, BuildingFloor, TERRAIN_DEFS, TERRAIN_IDS, Vec } from "../sim/map";
import { UnitType } from "../sim/world";

const SIDC: Record<"blue" | "red", Record<UnitType, string>> = {
  blue: {
    tank: "10031000141205000000",
    ifv: "10031000141211020000",
    infantry: "10031000141211000000",
    atgm: "10031000131204000000",
  },
  red: {
    tank: "10061000141205000000",
    ifv: "10061000141211020000",
    infantry: "10061000141211000000",
    atgm: "10061000131204000000",
  },
};

const texCache = new Map<string, THREE.Texture>();
function getUnitTexture(side: "blue" | "red", type: UnitType, label: string): THREE.Texture {
  const key = `${side}:${type}:${label}`;
  let tex = texCache.get(key);
  if (!tex) {
    const sym = new ms.Symbol(SIDC[side][type], {
      size: 28,
      uniqueDesignation: label,
      outlineWidth: 3,
      outlineColor: "#f6f2e8",
    });
    const img = new Image();
    img.src = sym.toDataURL();
    tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    img.onload = () => { tex!.needsUpdate = true; };
    texCache.set(key, tex);
  }
  return tex;
}

export interface LosObserver {
  pos: Vec;
  eyeHeight: number;
  label: string;
}

interface Props {
  game: Game;
  god: boolean;
  markerMode: boolean;
  inspectorMode: boolean;
  losObserver: LosObserver | null;
  selectedBuilding: { building: Building; floorLevel: number } | null;
  onMapClick: (pos: Vec, grid4: string) => void;
  onHoverPos: (pos: Vec | null) => void;
  onSelectBuilding: (building: Building, floor: BuildingFloor) => void;
}

interface FloorInstanceMeta {
  building: Building;
  floor: BuildingFloor;
  baseColor: THREE.Color;
}

function buildingOrientedBox(footprint: ReadonlyArray<Vec>) {
  if (footprint.length < 2) return { angle: 0, w: 12, d: 12 };
  const p0 = footprint[0], p1 = footprint[1];
  const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of footprint) {
    const u = p.x * cos - p.y * sin;
    const v = p.x * sin + p.y * cos;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  return { angle, w: Math.max(4, maxU - minU), d: Math.max(4, maxV - minV) };
}

export const Sandtable3D: React.FC<Props> = (props) => {
  const { game, god, markerMode, inspectorMode, losObserver, selectedBuilding, onMapClick, onHoverPos, onSelectBuilding } = props;
  const { map } = game.world;

  const mountRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const [camPreset, setCamPreset] = useState<"3d" | "top">("3d");

  const propsRef = useRef(props);
  propsRef.current = props;

  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    terrainMesh: THREE.Mesh;
    buildingMesh: THREE.InstancedMesh | null;
    floorMeta: FloorInstanceMeta[];
    losGroup: THREE.Group;
    dynGroup: THREE.Group;
  } | null>(null);

  // Build static 3D terrain, roads, instanced canopies & multi-story buildings once per GameMap
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#b8cad8");
    scene.fog = new THREE.FogExp2("#b8cad8", 0.00012);

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const camera = new THREE.PerspectiveCamera(45, w / h, 5, 18000);
    const centerElev = map.elevationAt({ x: map.width * 0.54, y: map.depth * 0.48 });
    camera.position.set(map.width * 0.54 - 750, centerElev + 1450, -map.depth * 0.48 + 1950);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(map.width * 0.54, centerElev, -map.depth * 0.48);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.485;
    controls.minDistance = 80;
    controls.maxDistance = 6500;
    controls.update();

    scene.add(new THREE.HemisphereLight("#e6f0fa", "#5c5346", 0.95));
    const sun = new THREE.DirectionalLight("#fff7e8", 1.25);
    sun.position.set(1600, 2600, 1200);
    scene.add(sun);

    // 1. 10m Terrain Mesh (smooth elevation + crisp non-interpolated NearestFilter DataTexture colors)
    const cols = map.fineCols, rows = map.fineRows, cell = map.fineCellSize;
    const vertCount = cols * rows;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const texData = new Uint8Array(vertCount * 4);
    const tmpColor = new THREE.Color();

    for (let fr = 0; fr < rows; fr++) {
      for (let fc = 0; fc < cols; fc++) {
        const fi = fr * cols + fc;
        const elev = map.elevationGrid[fi];
        const slope = map.slopeGrid[fi];
        const tid = TERRAIN_IDS[map.terrainGrid[fi]] ?? "open";
        const x = (fc + 0.5) * cell;
        const z = -((fr + 0.5) * cell);
        positions[fi * 3] = x;
        positions[fi * 3 + 1] = elev;
        positions[fi * 3 + 2] = z;
        uvs[fi * 2] = (fc + 0.5) / cols;
        uvs[fi * 2 + 1] = (fr + 0.5) / rows;

        tmpColor.set(TERRAIN_DEFS[tid].meta.colorHex);
        const slopeShade = 1 - Math.min(0.28, slope / 55);
        const contour = Math.abs(elev % 50) < 0.9 ? 0.76 : Math.abs(elev % 10) < 0.6 ? 0.88 : 1.0;
        const shade = slopeShade * contour;
        texData[fi * 4] = Math.round(tmpColor.r * shade * 255);
        texData[fi * 4 + 1] = Math.round(tmpColor.g * shade * 255);
        texData[fi * 4 + 2] = Math.round(tmpColor.b * shade * 255);
        texData[fi * 4 + 3] = 255;
      }
    }

    const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let ptr = 0;
    for (let fr = 0; fr < rows - 1; fr++) {
      for (let fc = 0; fc < cols - 1; fc++) {
        const a = fr * cols + fc;
        const b = a + 1;
        const c = (fr + 1) * cols + fc;
        const d = c + 1;
        indices[ptr++] = a; indices[ptr++] = b; indices[ptr++] = d;
        indices[ptr++] = a; indices[ptr++] = d; indices[ptr++] = c;
      }
    }

    const terrainTex = new THREE.DataTexture(texData, cols, rows, THREE.RGBAFormat);
    terrainTex.colorSpace = THREE.SRGBColorSpace;
    terrainTex.magFilter = THREE.NearestFilter;
    terrainTex.minFilter = THREE.NearestFilter;
    terrainTex.needsUpdate = true;

    const terrainGeo = new THREE.BufferGeometry();
    terrainGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    terrainGeo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    terrainGeo.setIndex(new THREE.BufferAttribute(indices, 1));
    terrainGeo.computeVertexNormals();
    const terrainMat = new THREE.MeshStandardMaterial({ map: terrainTex, roughness: 0.92, metalness: 0.04 });
    const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
    scene.add(terrainMesh);

    // 2. RoadNetwork vector ribbons (2 draw calls: paved + dirt), subdivided at 10m to hug DEM contours
    const inRect = (p: Vec) => p.x >= 0 && p.x <= map.width && p.y >= 0 && p.y <= map.depth;
    const buildRoadMesh = (kind: "paved_road" | "dirt_road", colorHex: string) => {
      const verts: number[] = [];
      for (const edge of map.roadNetwork.edges) {
        if (edge.kind !== kind || edge.points.length < 2) continue;
        const halfW = edge.width * 0.55;
        const lift = edge.isBridge ? 1.15 : 0.55;
        for (let i = 0; i < edge.points.length - 1; i++) {
          const p0 = edge.points[i], p1 = edge.points[i + 1];
          if (!inRect(p0) || !inRect(p1)) continue;
          const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
          if (segLen < 0.5) continue;
          const nx = (-(p1.y - p0.y) / segLen) * halfW, ny = ((p1.x - p0.x) / segLen) * halfW;
          const steps = Math.max(1, Math.ceil(segLen / 10));
          for (let s = 0; s < steps; s++) {
            const t0 = s / steps, t1 = (s + 1) / steps;
            const a = { x: p0.x + (p1.x - p0.x) * t0, y: p0.y + (p1.y - p0.y) * t0 };
            const b = { x: p0.x + (p1.x - p0.x) * t1, y: p0.y + (p1.y - p0.y) * t1 };
            const za = map.elevationAt(a) + lift;
            const zb = map.elevationAt(b) + lift;
            const ax0 = a.x + nx, az0 = -(a.y + ny), ax1 = a.x - nx, az1 = -(a.y - ny);
            const bx0 = b.x + nx, bz0 = -(b.y + ny), bx1 = b.x - nx, bz1 = -(b.y - ny);
            verts.push(ax0, za, az0, bx0, zb, bz0, bx1, zb, bz1, ax0, za, az0, bx1, zb, bz1, ax1, za, az1);
          }
        }
      }
      if (verts.length === 0) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      g.computeVertexNormals();
      scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.75, side: THREE.DoubleSide })));
    };
    buildRoadMesh("paved_road", "#4c525c");
    buildRoadMesh("dirt_road", "#947d5b");

    // 3. GPU-Instanced Foliage Canopies (forests & hedgerows)
    const forestCells: { x: number; y: number; z: number; h: number; dark: boolean }[] = [];
    const hedgeCells: { x: number; y: number; z: number; h: number }[] = [];
    for (let fr = 0; fr < rows; fr++) {
      for (let fc = 0; fc < cols; fc++) {
        const fi = fr * cols + fc;
        const tid = TERRAIN_IDS[map.terrainGrid[fi]];
        const x = (fc + 0.5) * cell, y = (fr + 0.5) * cell, z = map.elevationGrid[fi];
        if (tid === "dense_forest" || tid === "light_forest") {
          forestCells.push({ x, y, z, h: TERRAIN_DEFS[tid].canopyHeight, dark: tid === "dense_forest" });
        } else if (tid === "hedgerow") {
          hedgeCells.push({ x, y, z, h: TERRAIN_DEFS[tid].canopyHeight });
        }
      }
    }

    const dummy = new THREE.Object3D();
    if (forestCells.length > 0) {
      const cone = new THREE.ConeGeometry(4.6, 1, 5);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
      const inst = new THREE.InstancedMesh(cone, mat, forestCells.length);
      const cDark = new THREE.Color("#294824"), cLight = new THREE.Color("#496e39");
      forestCells.forEach((f, idx) => {
        const h1 = Math.sin(f.x * 12.9898 + f.y * 78.233) * 43758.5453;
        const h2 = Math.sin(f.x * 39.346 + f.y * 11.135) * 24634.6345;
        const rx = ((h1 - Math.floor(h1)) - 0.5) * 7.2;
        const ry = ((h2 - Math.floor(h2)) - 0.5) * 7.2;
        const sVar = 0.8 + ((h1 * 3.1 - Math.floor(h1 * 3.1)) * 0.45);
        dummy.position.set(f.x + rx, f.z + (f.h * sVar) * 0.5, -(f.y + ry));
        dummy.rotation.set(0, (idx * 1.7 + rx) % (Math.PI * 2), 0);
        dummy.scale.set(0.85 + sVar * 0.2, f.h * sVar, 0.85 + sVar * 0.2);
        dummy.updateMatrix();
        inst.setMatrixAt(idx, dummy.matrix);
        inst.setColorAt(idx, f.dark ? cDark : cLight);
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      scene.add(inst);
    }

    if (hedgeCells.length > 0) {
      const box = new THREE.BoxGeometry(7.2, 1, 7.2);
      const mat = new THREE.MeshStandardMaterial({ color: "#436330", roughness: 0.95 });
      const inst = new THREE.InstancedMesh(box, mat, hedgeCells.length);
      hedgeCells.forEach((hd, idx) => {
        dummy.position.set(hd.x, hd.z + hd.h * 0.5, -hd.y);
        dummy.rotation.set(0, (idx * 0.9) % Math.PI, 0);
        dummy.scale.set(1, hd.h, 1);
        dummy.updateMatrix();
        inst.setMatrixAt(idx, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      scene.add(inst);
    }

    // 4. GPU-Instanced Multi-Story Buildings
    const floorMeta: FloorInstanceMeta[] = [];
    for (const b of map.buildings) {
      for (const fl of b.floors) {
        const hex = fl.state === "gutted" ? "#374151" : fl.state === "damaged" ? "#9ca3af" : fl.level === b.floors.length ? "#b8745c" : "#d8d0c3";
        floorMeta.push({ building: b, floor: fl, baseColor: new THREE.Color(hex) });
      }
    }

    let buildingMesh: THREE.InstancedMesh | null = null;
    if (floorMeta.length > 0) {
      const bGeo = new THREE.BoxGeometry(1, 1, 1);
      const bMat = new THREE.MeshStandardMaterial({ roughness: 0.78 });
      buildingMesh = new THREE.InstancedMesh(bGeo, bMat, floorMeta.length);
      let idx = 0;
      for (const b of map.buildings) {
        const { angle, w: bw, d: bd } = buildingOrientedBox(b.footprint);
        const fh = (b.roofHeight - 0.4) / Math.max(1, b.floors.length);
        for (let fi = 0; fi < b.floors.length; fi++) {
          dummy.position.set(b.center.x, b.groundElevation + (fi + 0.5) * fh, -b.center.y);
          dummy.rotation.set(0, angle, 0);
          dummy.scale.set(bw, fh * 0.9, bd);
          dummy.updateMatrix();
          buildingMesh.setMatrixAt(idx, dummy.matrix);
          buildingMesh.setColorAt(idx, floorMeta[idx].baseColor);
          idx++;
        }
      }
      buildingMesh.instanceMatrix.needsUpdate = true;
      if (buildingMesh.instanceColor) buildingMesh.instanceColor.needsUpdate = true;
      scene.add(buildingMesh);
    }

    const losGroup = new THREE.Group();
    const dynGroup = new THREE.Group();
    scene.add(losGroup);
    scene.add(dynGroup);

    sceneRef.current = { scene, camera, controls, terrainMesh, buildingMesh, floorMeta, losGroup, dynGroup };

    // Raycasting pointer handlers
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downPos = { x: 0, y: 0 };

    const getHit = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      if (buildingMesh) {
        const bHits = raycaster.intersectObject(buildingMesh, false);
        if (bHits.length > 0 && bHits[0].instanceId !== undefined) {
          const meta = floorMeta[bHits[0].instanceId];
          return { pos: { x: bHits[0].point.x, y: -bHits[0].point.z }, buildingMeta: meta };
        }
      }
      const tHits = raycaster.intersectObject(terrainMesh, false);
      if (tHits.length > 0) {
        return { pos: { x: tHits[0].point.x, y: -tHits[0].point.z } };
      }
      return null;
    };

    const onDown = (e: PointerEvent) => { downPos = { x: e.clientX, y: e.clientY }; };
    const onMove = (e: PointerEvent) => {
      const hit = getHit(e);
      propsRef.current.onHoverPos(hit && map.inBounds(hit.pos) ? hit.pos : null);
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;
      const hit = getHit(e);
      if (!hit || !map.inBounds(hit.pos)) return;
      if (hit.buildingMeta && propsRef.current.inspectorMode) {
        propsRef.current.onSelectBuilding(hit.buildingMeta.building, hit.buildingMeta.floor);
      } else {
        propsRef.current.onMapClick(hit.pos, map.toGrid(hit.pos, 4));
      }
    };

    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);

    const onResize = () => {
      const nw = container.clientWidth || window.innerWidth;
      const nh = container.clientHeight || window.innerHeight;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    };
    window.addEventListener("resize", onResize);

    // Animation loop + projected landmark labels
    let raf = 0;
    const projVec = new THREE.Vector3();
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);

      const overlay = labelsRef.current;
      if (overlay) {
        const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
        const children = overlay.children;
        for (let i = 0; i < children.length; i++) {
          const el = children[i] as HTMLElement;
          const wx = Number(el.dataset.x), wy = Number(el.dataset.y), wz = Number(el.dataset.z);
          projVec.set(wx, wy, wz).project(camera);
          if (projVec.z > 1) { el.style.display = "none"; continue; }
          el.style.display = "block";
          el.style.transform = `translate(-50%, -100%) translate(${(projVec.x * 0.5 + 0.5) * cw}px, ${(-projVec.y * 0.5 + 0.5) * ch}px)`;
        }
      }
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      terrainTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [map]);

  // Highlight selected building floor
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx?.buildingMesh) return;
    const hi = new THREE.Color("#38bdf8");
    ctx.floorMeta.forEach((m, idx) => {
      const isSel = selectedBuilding && m.building.id === selectedBuilding.building.id && m.floor.level === selectedBuilding.floorLevel;
      ctx.buildingMesh!.setColorAt(idx, isSel ? hi : m.baseColor);
    });
    if (ctx.buildingMesh.instanceColor) ctx.buildingMesh.instanceColor.needsUpdate = true;
  }, [selectedBuilding]);

  // Rebuild 3D Beer-Lambert Transmittance (T) LoS Fan when observer changes
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    const { losGroup } = ctx;
    while (losGroup.children.length > 0) {
      const child = losGroup.children.pop()!;
      if ((child as THREE.Mesh).geometry) (child as THREE.Mesh).geometry.dispose();
    }
    if (!losObserver) return;

    const obsZ = map.elevationAt(losObserver.pos) + losObserver.eyeHeight;
    const pinGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(losObserver.pos.x, map.elevationAt(losObserver.pos), -losObserver.pos.y),
      new THREE.Vector3(losObserver.pos.x, obsZ + 6, -losObserver.pos.y),
    ]);
    losGroup.add(new THREE.Line(pinGeo, new THREE.LineBasicMaterial({ color: "#0284c7" })));

    const rays = 120;
    const rings = 16;
    const maxRange = 2000;
    const verts: number[] = [];
    const cols: number[] = [];
    const gridPos: { x: number; y: number; z: number; r: number; g: number; b: number }[][] = [];

    for (let ai = 0; ai < rays; ai++) {
      const theta = (ai / rays) * Math.PI * 2;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      const row: { x: number; y: number; z: number; r: number; g: number; b: number }[] = [];
      let blockedYet = false;
      for (let ri = 0; ri <= rings; ri++) {
        const distM = ri === 0 ? 15 : (ri / rings) * maxRange;
        const px = Math.min(map.width - 1, Math.max(1, losObserver.pos.x + cos * distM));
        const py = Math.min(map.depth - 1, Math.max(1, losObserver.pos.y + sin * distM));
        const pz = map.elevationAt({ x: px, y: py }) + 1.8;

        let r = 0.13, g = 0.77, b = 0.37; // T = 1 (clear green)
        if (ri > 0) {
          if (blockedYet) {
            r = 0.55; g = 0.12; b = 0.12;
          } else {
            const res = map.sightline(losObserver.pos, losObserver.eyeHeight, { x: px, y: py }, 1.5, { stepMeters: 25 });
            if (res.blocked || res.transmittance < 0.02) {
              blockedYet = true;
              r = 0.94; g = 0.27; b = 0.27; // T = 0 (hard block red)
            } else if (res.transmittance < 0.98) {
              const t = res.transmittance;
              r = 0.96 - t * 0.4; g = 0.45 + t * 0.35; b = 0.08; // 0 < T < 1 (amber/orange)
            }
          }
        }
        row.push({ x: px, y: pz, z: -py, r, g, b });
      }
      gridPos.push(row);
    }

    for (let ai = 0; ai < rays; ai++) {
      const r0 = gridPos[ai], r1 = gridPos[(ai + 1) % rays];
      for (let ri = 0; ri < rings; ri++) {
        const a = r0[ri], b = r1[ri], c = r0[ri + 1], d = r1[ri + 1];
        verts.push(a.x, a.y, a.z, b.x, b.y, b.z, d.x, d.y, d.z, a.x, a.y, a.z, d.x, d.y, d.z, c.x, c.y, c.z);
        cols.push(a.r, a.g, a.b, b.r, b.g, b.b, d.r, d.g, d.b, a.r, a.g, a.b, d.r, d.g, d.b, c.r, c.g, c.b);
      }
    }

    const fanGeo = new THREE.BufferGeometry();
    fanGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    fanGeo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    const fanMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.56, side: THREE.DoubleSide, depthWrite: false });
    const fanMesh = new THREE.Mesh(fanGeo, fanMat);
    fanMesh.renderOrder = 2;
    losGroup.add(fanMesh);
  }, [losObserver, map]);

  // Sync unit NATO sprites & plotted order vectors
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;
    const { dynGroup } = ctx;
    while (dynGroup.children.length > 0) {
      const child = dynGroup.children.pop()!;
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      } else if (child instanceof THREE.Sprite) {
        child.material.dispose();
      }
    }

    const { world, picture } = game;
    const bluePos = new Map<string, Vec>();
    if (god) {
      for (const u of world.units) if (u.side === "blue" && u.state !== "destroyed") bluePos.set(u.id, u.pos);
    } else {
      for (const t of picture.tracks) bluePos.set(t.id, t.pos);
    }

    for (const u of world.units) {
      if (u.side !== "blue" || u.state === "destroyed") continue;
      const pos = bluePos.get(u.id) ?? u.pos;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: getUnitTexture("blue", u.type, u.id.replace("Alpha ", "A")), depthTest: false }));
      sp.position.set(pos.x, map.elevationAt(pos) + 26, -pos.y);
      sp.scale.set(90, 90, 1);
      dynGroup.add(sp);
    }

    const orders = god
      ? world.units.filter((u) => u.side === "blue" && u.order?.dest).map((u) => ({ unit: u.id, dest: u.order!.dest! }))
      : picture.orders.filter((o) => o.order.dest).map((o) => ({ unit: o.unit, dest: o.order.dest! }));
    for (const o of orders) {
      const from = bluePos.get(o.unit);
      if (!from) continue;
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(from.x, map.elevationAt(from) + 10, -from.y),
        new THREE.Vector3(o.dest.x, map.elevationAt(o.dest) + 10, -o.dest.y),
      ]);
      dynGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: "#1d4ed8" })));
    }

    const reds = god
      ? world.units.filter((u) => u.side === "red" && u.state !== "destroyed").map((u) => ({ id: u.id, type: u.type, pos: u.pos }))
      : picture.contacts.map((c) => ({ id: c.id, type: c.type, pos: c.pos }));
    for (const r of reds) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: getUnitTexture("red", r.type, r.id.replace("Red ", "R")), depthTest: false }));
      sp.position.set(r.pos.x, map.elevationAt(r.pos) + 26, -r.pos.y);
      sp.scale.set(90, 90, 1);
      dynGroup.add(sp);
    }
  });

  const applyCameraPreset = (preset: "3d" | "top") => {
    setCamPreset(preset);
    const ctx = sceneRef.current;
    if (!ctx) return;
    const cx = map.width * 0.5, cz = -map.depth * 0.5;
    const cy = map.elevationAt({ x: cx, y: map.depth * 0.5 });
    ctx.controls.target.set(cx, cy, cz);
    if (preset === "top") ctx.camera.position.set(cx, cy + 4200, cz + 60);
    else ctx.camera.position.set(cx - 900, cy + 1350, cz + 1850);
    ctx.controls.update();
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%", cursor: markerMode || inspectorMode ? "crosshair" : "grab" }} />

      {/* Projected 2D labels for places & player markers */}
      <div ref={labelsRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
        {map.places.map((pl) => (
          <div
            key={pl.name}
            data-x={pl.pos.x}
            data-y={map.elevationAt(pl.pos) + 18}
            data-z={-pl.pos.y}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              padding: "2px 6px",
              borderRadius: 4,
              background: pl.kind === "marker" ? "rgba(180, 83, 9, 0.9)" : "rgba(248, 244, 234, 0.85)",
              color: pl.kind === "marker" ? "#fff" : "#2b2620",
              border: "1px solid rgba(90, 80, 65, 0.45)",
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            {pl.name}
          </div>
        ))}
      </div>

      {/* Camera preset switcher */}
      <div style={{ position: "absolute", bottom: 18, left: 20, display: "flex", gap: 6 }}>
        {(["3d", "top"] as const).map((p) => (
          <button
            key={p}
            onClick={() => applyCameraPreset(p)}
            style={{
              padding: "5px 10px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 4,
              border: "1px solid #9e9381",
              background: camPreset === p ? "#2f5d8c" : "rgba(248, 244, 234, 0.92)",
              color: camPreset === p ? "#fff" : "#2b2620",
              cursor: "pointer",
            }}
          >
            {p === "3d" ? "3D Ridge View" : "Top-Down Staff View"}
          </button>
        ))}
      </div>
    </div>
  );
};
