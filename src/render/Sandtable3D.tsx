import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import ms from "milsymbol";
import { Game } from "../game";
import { Building, BuildingFloor, TERRAIN_DEFS, TERRAIN_IDS, Vec } from "../sim/map";
import { CombatShotEvent, Unit, UnitType, WeaponSignatureClass, getMoraleTier, isCowering } from "../sim/world";

const WEAPON_TAG: Record<WeaponSignatureClass, string> = {
  small_arms: "SA",
  light_weapon: "LW",
  heavy_weapon: "HW",
};

const SIDC: Record<"blue" | "red", Record<UnitType, string>> = {
  blue: {
    tank: "10031000141205000000",
    ifv: "10031000141211020000",
    infantry: "10031000141211000000",
    atgm: "10031000131204000000",
    artillery: "10031000141303010000",
    mlrs: "10031000141305000000",
    recon: "10031000141213000000",
  },
  red: {
    tank: "10061000141205000000",
    ifv: "10061000141211020000",
    infantry: "10061000141211000000",
    atgm: "10061000131204000000",
    artillery: "10061000141303010000",
    mlrs: "10061000141305000000",
    recon: "10061000141213000000",
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

function getContactTexture(tag: string): THREE.Texture {
  const key = `contact:${tag}`;
  let tex = texCache.get(key);
  if (!tex) {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    // Red hostile diamond with crisp light outline
    ctx.save();
    ctx.translate(64, 52);
    ctx.beginPath();
    ctx.moveTo(0, -38);
    ctx.lineTo(38, 0);
    ctx.lineTo(0, 38);
    ctx.lineTo(-38, 0);
    ctx.closePath();
    ctx.fillStyle = "rgba(220, 38, 38, 0.92)";
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#f6f2e8";
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#450a0a";
    ctx.stroke();
    // Centered '?' inside diamond
    ctx.fillStyle = "#fff";
    ctx.font = "bold 38px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", 0, 2);
    ctx.restore();
    // High-contrast SA / LW / HW badge below diamond
    ctx.fillStyle = "#111827";
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(34, 88, 60, 30, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fde047";
    ctx.font = "bold 20px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(tag, 64, 104);

    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    texCache.set(key, tex);
  }
  return tex;
}

export interface LosObserver {
  pos: Vec;
  eyeHeight: number;
  label: string;
}

export interface SimClockState {
  tickAlpha: number;
  speed: number;
  paused: boolean;
}

interface Props {
  game: Game;
  god: boolean;
  markerMode: boolean;
  inspectorMode: boolean;
  orderTargetMode: boolean;
  allowBuildingSelect: boolean;
  selectedUnitId: string | null;
  losObserver: LosObserver | null;
  selectedBuilding: { building: Building; floorLevel: number } | null;
  simClockRef: React.RefObject<SimClockState>;
  onMapClick: (pos: Vec, grid4: string) => void;
  onHoverPos: (pos: Vec | null) => void;
  onSelectBuilding: (building: Building, floor: BuildingFloor) => void;
  onSelectUnit: (unitId: string) => void;
  onCancelOrder?: () => void;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

function makeCirclePoints(radius: number, y: number, segments = 24): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, y, -Math.sin(a) * radius));
  }
  return pts;
}

interface UnitRenderNode {
  root: THREE.Group;
  hullGroup: THREE.Group;
  hullMats: THREE.MeshStandardMaterial[];
  baseHex: string;
  wreckApplied: boolean;
  paxMeshes: THREE.Mesh[];
  frontalArc: THREE.Group;
  selRing: THREE.LineLoop;
  cowerRing: THREE.LineLoop;
  cowerMat: THREE.LineBasicMaterial;
  tether: THREE.Line;
  sprite: THREE.Sprite;
  orderLine: THREE.Line;
  smokeAcc: number;
}

function createUnitNode(u: Unit): UnitRenderNode {
  const root = new THREE.Group();
  const hullGroup = new THREE.Group();
  const baseHex = u.side === "blue" ? "#2f5d8c" : "#b91c1c";
  const accentHex = u.side === "blue" ? "#1e3a8a" : "#7f1d1d";
  const bodyMat = new THREE.MeshStandardMaterial({ color: baseHex, roughness: 0.65, metalness: 0.15 });
  const turretMat = new THREE.MeshStandardMaterial({ color: accentHex, roughness: 0.6, metalness: 0.2 });
  const darkMat = new THREE.MeshStandardMaterial({ color: "#1f2937", roughness: 0.85 });
  const hullMats = [bodyMat, turretMat, darkMat];
  const paxMeshes: THREE.Mesh[] = [];

  if (u.type === "tank") {
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(10.5, 1.8, 5.2), bodyMat);
    chassis.position.set(0, 1.1, 0);
    const trackL = new THREE.Mesh(new THREE.BoxGeometry(11.0, 1.2, 1.1), darkMat);
    trackL.position.set(0, 0.7, -2.5);
    const trackR = new THREE.Mesh(new THREE.BoxGeometry(11.0, 1.2, 1.1), darkMat);
    trackR.position.set(0, 0.7, 2.5);
    const turret = new THREE.Mesh(new THREE.BoxGeometry(5.0, 1.3, 3.6), turretMat);
    turret.position.set(0.2, 2.4, 0);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(6.8, 0.45, 0.45), darkMat);
    barrel.position.set(5.4, 2.5, 0);
    hullGroup.add(chassis, trackL, trackR, turret, barrel);
  } else if (u.type === "ifv") {
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(9.6, 2.0, 4.6), bodyMat);
    chassis.position.set(0, 1.2, 0);
    const trackL = new THREE.Mesh(new THREE.BoxGeometry(10.0, 1.1, 0.9), darkMat);
    trackL.position.set(0, 0.65, -2.2);
    const trackR = new THREE.Mesh(new THREE.BoxGeometry(10.0, 1.1, 0.9), darkMat);
    trackR.position.set(0, 0.65, 2.2);
    const turret = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.1, 2.8), turretMat);
    turret.position.set(0.4, 2.5, 0);
    const autocannon = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.3, 0.3), darkMat);
    autocannon.position.set(4.1, 2.55, 0);
    const pod = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.85, 1.0), turretMat);
    pod.position.set(0.4, 2.7, 1.9);
    hullGroup.add(chassis, trackL, trackR, turret, autocannon, pod);
  } else if (u.type === "artillery") {
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(10.8, 1.9, 5.0), bodyMat);
    chassis.position.set(0, 1.15, 0);
    const turret = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.8, 4.2), turretMat);
    turret.position.set(-1.4, 2.7, 0);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.45, 0.45), darkMat);
    barrel.position.set(3.2, 4.2, 0);
    barrel.rotation.z = 0.42;
    hullGroup.add(chassis, turret, barrel);
  } else if (u.type === "mlrs") {
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(10.5, 1.8, 4.8), bodyMat);
    chassis.position.set(0, 1.1, 0);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.7, 4.2), turretMat);
    cab.position.set(3.2, 2.5, 0);
    const launcher = new THREE.Mesh(new THREE.BoxGeometry(5.8, 2.1, 3.8), darkMat);
    launcher.position.set(-1.6, 3.2, 0);
    launcher.rotation.z = 0.45;
    hullGroup.add(chassis, cab, launcher);
  } else if (u.type === "recon") {
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(7.6, 1.5, 3.8), bodyMat);
    chassis.position.set(0, 1.1, 0);
    const turret = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.9, 2.4), turretMat);
    turret.position.set(0.2, 2.2, 0);
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 0.3), darkMat);
    mast.position.set(-1.2, 3.2, 0.8);
    hullGroup.add(chassis, turret, mast);
  } else {
    const count = Math.max(4, u.headcount || 4);
    const geo = new THREE.CylinderGeometry(0.6, 0.75, 2.5, 6);
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, i === 0 ? turretMat : bodyMat);
      const ang = (i / count) * Math.PI * 2;
      const rad = i === 0 ? 0 : 3.8;
      m.position.set(Math.cos(ang) * rad, 1.25, -Math.sin(ang) * rad);
      hullGroup.add(m);
      paxMeshes.push(m);
    }
    if (u.type === "atgm") {
      const tube = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.45, 0.45), darkMat);
      tube.position.set(1.6, 2.0, 0);
      hullGroup.add(tube);
    }
  }

  // Frontal armor arc (+/- 45 deg around +X) shown when selected
  const frontalArc = new THREE.Group();
  const arcColor = u.side === "blue" ? "#38bdf8" : "#f87171";
  const wedgeGeo = new THREE.RingGeometry(8, 28, 16, 1, -Math.PI / 4, Math.PI / 2);
  wedgeGeo.rotateX(-Math.PI / 2);
  const wedge = new THREE.Mesh(
    wedgeGeo,
    new THREE.MeshBasicMaterial({ color: arcColor, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
  );
  wedge.position.y = 1.2;
  const edgeGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(Math.cos(Math.PI / 4) * 28, 1.3, -Math.sin(Math.PI / 4) * 28),
    new THREE.Vector3(0, 1.3, 0),
    new THREE.Vector3(Math.cos(-Math.PI / 4) * 28, 1.3, -Math.sin(-Math.PI / 4) * 28),
  ]);
  const edges = new THREE.Line(edgeGeo, new THREE.LineBasicMaterial({ color: arcColor, transparent: true, opacity: 0.75 }));
  frontalArc.add(wedge, edges);
  frontalArc.visible = false;
  hullGroup.add(frontalArc);
  root.add(hullGroup);

  const selRing = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(makeCirclePoints(19, 1.4)),
    new THREE.LineBasicMaterial({ color: u.side === "blue" ? "#0284c7" : "#dc2626" }),
  );
  selRing.visible = false;
  root.add(selRing);

  const cowerMat = new THREE.LineBasicMaterial({ color: "#f59e0b" });
  const cowerRing = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(makeCirclePoints(14, 1.2)), cowerMat);
  cowerRing.visible = false;
  root.add(cowerRing);

  const tether = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 3, 0), new THREE.Vector3(0, 22, 0)]),
    new THREE.LineBasicMaterial({ color: u.side === "blue" ? "#1d4ed8" : "#b91c1c", transparent: true, opacity: 0.65 }),
  );
  root.add(tether);

  const prefix = u.id.replace("Alpha ", "A").replace("Blue ", "B").replace("Red ", "R");
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: getUnitTexture(u.side, u.type, prefix), depthTest: false }));
  sprite.position.set(0, 26, 0);
  sprite.scale.set(82, 82, 1);
  sprite.userData = { unitId: u.id, side: u.side };
  root.add(sprite);

  const orderLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: u.side === "blue" ? "#1d4ed8" : "#b91c1c" }),
  );
  orderLine.visible = false;

  return {
    root,
    hullGroup,
    hullMats,
    baseHex,
    wreckApplied: false,
    paxMeshes,
    frontalArc,
    selRing,
    cowerRing,
    cowerMat,
    tether,
    sprite,
    orderLine,
    smokeAcc: 0,
  };
}

interface ActiveProjectile {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  elapsed: number;
  duration: number;
  arcHeight: number;
  smokeTrail: boolean;
  smokeAcc: number;
  ev: CombatShotEvent;
}

interface ActiveBurst {
  obj: THREE.Object3D;
  mat: THREE.Material;
  elapsed: number;
  duration: number;
  vel?: THREE.Vector3;
  startScale: number;
  endScale: number;
  startOpacity: number;
}

function createVfxManager(vfxGroup: THREE.Group) {
  const sphereGeo = new THREE.SphereGeometry(1, 8, 6);
  const boltGeo = new THREE.BoxGeometry(1, 1, 5.5);
  const ringGeo = new THREE.RingGeometry(0.7, 1.0, 18);
  ringGeo.rotateX(-Math.PI / 2);

  const projectiles: ActiveProjectile[] = [];
  const bursts: ActiveBurst[] = [];
  let lastShotId = 0;

  const spawnBurst = (
    geo: THREE.BufferGeometry,
    color: string,
    pos: THREE.Vector3,
    duration: number,
    startScale: number,
    endScale: number,
    startOpacity = 0.9,
    vel?: THREE.Vector3,
    flatRotate = false,
  ) => {
    if (bursts.length >= 220) {
      const old = bursts.shift()!;
      vfxGroup.remove(old.obj);
      old.mat.dispose();
    }
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: startOpacity,
      depthWrite: false,
      side: flatRotate ? THREE.DoubleSide : THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(startScale);
    if (vel && !flatRotate) mesh.lookAt(pos.clone().add(vel));
    vfxGroup.add(mesh);
    bursts.push({ obj: mesh, mat, elapsed: 0, duration, vel, startScale, endScale, startOpacity });
  };

  const spawnShot = (ev: CombatShotEvent) => {
    const from = new THREE.Vector3(ev.from.x, ev.fromZ, -ev.from.y);
    const to = new THREE.Vector3(ev.to.x, ev.toZ, -ev.to.y);
    if (ev.artilleryAmmo) {
      if (ev.artilleryAmmo === "Smoke") {
        const sr = ev.smokeRadius ?? 60;
        spawnBurst(sphereGeo, "#f1f5f9", to, 1.4, 5, sr * 0.65, 0.6, new THREE.Vector3(0, 6, 0));
        spawnBurst(ringGeo, "#cbd5e1", to, 1.1, 4, sr, 0.65, undefined, true);
      } else if (ev.artilleryAmmo === "HE_Airburst") {
        const rScale = Math.max(8, (ev.blastRadius ?? 30) * 0.9);
        spawnBurst(sphereGeo, "#fef08a", to, 0.45, 3, rScale * 0.45, 0.95);
        spawnBurst(ringGeo, "#f97316", to, 0.75, 4, rScale * 1.4, 0.9, undefined, true);
        spawnBurst(boltGeo, "#fbbf24", to.clone().add(new THREE.Vector3(0, -7, 0)), 0.35, 1.5, 2.2, 0.7, new THREE.Vector3(0, -10, 0));
      } else {
        const rScale = Math.max(6, (ev.blastRadius ?? 8) * 2.2);
        spawnBurst(sphereGeo, "#f97316", to, 0.5, 3, rScale * 1.1, 0.95);
        spawnBurst(ringGeo, "#ef4444", to, 0.65, 2.5, rScale * 2.2, 0.85, undefined, true);
        spawnBurst(sphereGeo, "#52525b", to, 1.4, 3, rScale * 1.5, 0.55, new THREE.Vector3(0, 10, 0));
      }
      return;
    }
    // 1. Muzzle flash (~0.12s)
    spawnBurst(sphereGeo, "#fde047", from, 0.14, 2.2, 5.0, 0.95);
    spawnBurst(ringGeo, "#fb923c", from, 0.16, 1.5, 7.5, 0.8, undefined, true);

    // 2. In-flight projectile
    const d = from.distanceTo(to);
    const isAtgm = ev.ammo === "HEAT" && ev.weaponClass === "heavy_weapon";
    const speed = ev.ammo === "AP" ? 900 : isAtgm ? 280 : 450;
    const duration = Math.min(isAtgm ? 1.8 : 0.7, Math.max(isAtgm ? 0.15 : 0.08, d / speed));
    const color = ev.ammo === "AP" ? "#fef08a" : ev.ammo === "HEAT" ? "#fb923c" : "#f97316";
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(isAtgm ? sphereGeo : boltGeo, mat);
    mesh.position.copy(from);
    if (isAtgm) mesh.scale.setScalar(1.6);
    else {
      mesh.scale.set(0.65, 0.65, 1.4);
      mesh.lookAt(to);
    }
    vfxGroup.add(mesh);
    projectiles.push({
      mesh,
      from,
      to,
      elapsed: 0,
      duration,
      arcHeight: ev.ammo === "HE" ? Math.min(35, d * 0.06) : isAtgm ? 4 : 0,
      smokeTrail: isAtgm,
      smokeAcc: 0,
      ev,
    });
  };

  const spawnImpact = (ev: CombatShotEvent, pos: THREE.Vector3) => {
    if (ev.penetrated || ev.ammo === "HE") {
      const rScale = Math.max(4, (ev.blastRadius ?? 3.5) * 2.2);
      spawnBurst(sphereGeo, "#f97316", pos, 0.45, 2.5, rScale * 1.1, 0.95);
      spawnBurst(ringGeo, "#ef4444", pos, 0.6, 2.0, rScale * 2.4, 0.85, undefined, true);
      spawnBurst(sphereGeo, "#52525b", pos, 1.3, 3.0, rScale * 1.6, 0.55, new THREE.Vector3(0, 9, 0));
    } else if (ev.hit) {
      // Non-penetrating ricochet sparks (blue-white)
      const back = new THREE.Vector3(ev.from.x - ev.to.x, 0, -(ev.from.y - ev.to.y)).normalize();
      for (let i = 0; i < 3; i++) {
        const dir = new THREE.Vector3(
          back.x * 16 + (i - 1) * 14,
          14 + i * 6,
          back.z * 16 + (1 - i) * 12,
        );
        spawnBurst(boltGeo, "#e0f2fe", pos, 0.35, 0.5, 0.3, 0.95, dir);
      }
      spawnBurst(sphereGeo, "#38bdf8", pos, 0.2, 1.5, 4.0, 0.9);
    } else {
      // Miss dust plume
      spawnBurst(sphereGeo, "#d6c7a9", pos, 0.65, 2.0, 6.5, 0.5, new THREE.Vector3(0, 5, 0));
    }
  };

  const spawnWreckSmoke = (pos: THREE.Vector3) => {
    spawnBurst(sphereGeo, "#3f3f46", pos, 1.6, 2.4, 8.5, 0.52, new THREE.Vector3(1.5, 8.5, -1.0));
  };

  const update = (dt: number, world: Game["world"], isShotVisible: (ev: CombatShotEvent) => boolean) => {
    for (const ev of world.shotEvents) {
      if (ev.id <= lastShotId) continue;
      lastShotId = ev.id;
      if (isShotVisible(ev)) spawnShot(ev);
    }

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.elapsed += dt;
      const u = Math.min(1, p.elapsed / p.duration);
      p.mesh.position.lerpVectors(p.from, p.to, u);
      p.mesh.position.y += Math.sin(u * Math.PI) * p.arcHeight;
      if (p.smokeTrail) {
        p.smokeAcc += dt;
        if (p.smokeAcc >= 0.03) {
          p.smokeAcc = 0;
          spawnBurst(sphereGeo, "#cbd5e1", p.mesh.position.clone(), 0.45, 1.1, 2.8, 0.55);
        }
      }
      if (u >= 1) {
        vfxGroup.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        projectiles.splice(i, 1);
        spawnImpact(p.ev, p.to);
      }
    }

    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.elapsed += dt;
      const u = Math.min(1, b.elapsed / b.duration);
      if (b.vel) b.obj.position.addScaledVector(b.vel, dt);
      b.obj.scale.setScalar(lerp(b.startScale, b.endScale, u));
      (b.mat as THREE.MeshBasicMaterial).opacity = b.startOpacity * (1 - u);
      if (u >= 1) {
        vfxGroup.remove(b.obj);
        b.mat.dispose();
        bursts.splice(i, 1);
      }
    }
  };

  const dispose = () => {
    for (const p of projectiles) { vfxGroup.remove(p.mesh); (p.mesh.material as THREE.Material).dispose(); }
    for (const b of bursts) { vfxGroup.remove(b.obj); b.mat.dispose(); }
    projectiles.length = 0;
    bursts.length = 0;
    sphereGeo.dispose();
    boltGeo.dispose();
    ringGeo.dispose();
  };

  return { update, spawnWreckSmoke, dispose };
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
  const {
    game, god, markerMode, inspectorMode, orderTargetMode,
    selectedUnitId, losObserver, selectedBuilding,
  } = props;
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
    unitNodes: Map<string, UnitRenderNode>;
    hoveredIdx: number;
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
    const unitGroup = new THREE.Group();
    const orderGroup = new THREE.Group();
    const contactGroup = new THREE.Group();
    const indirectGroup = new THREE.Group();
    const smokeGroup = new THREE.Group();
    const vfxGroup = new THREE.Group();
    dynGroup.add(unitGroup, orderGroup, contactGroup, indirectGroup, smokeGroup, vfxGroup);
    scene.add(losGroup);
    scene.add(dynGroup);

    const unitNodes = new Map<string, UnitRenderNode>();
    const contactNodes = new Map<string, { sprite: THREE.Sprite; key: string }>();
    const vfx = createVfxManager(vfxGroup);
    const shellGeo = new THREE.SphereGeometry(2.6, 8, 6);
    const smokeSphereGeo = new THREE.SphereGeometry(1, 14, 10);
    const smokeMat = new THREE.MeshBasicMaterial({ color: "#e2e8f0", transparent: true, opacity: 0.42, depthWrite: false });

    sceneRef.current = { scene, camera, controls, terrainMesh, buildingMesh, floorMeta, losGroup, dynGroup, unitNodes, hoveredIdx: -1 };

    // Raycasting pointer handlers
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downPos = { x: 0, y: 0 };

    const getHit = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const selectableSprites: THREE.Sprite[] = [];
      for (const n of unitNodes.values()) {
        if (n.root.visible && n.sprite.visible && typeof n.sprite.userData?.unitId === "string") {
          selectableSprites.push(n.sprite);
        }
      }
      if (selectableSprites.length > 0 && !propsRef.current.orderTargetMode) {
        const sHits = raycaster.intersectObjects(selectableSprites, false);
        if (sHits.length > 0) {
          return { pos: { x: sHits[0].point.x, y: -sHits[0].point.z }, unitId: sHits[0].object.userData.unitId as string };
        }
      }
      if (buildingMesh) {
        const bHits = raycaster.intersectObject(buildingMesh, false);
        if (bHits.length > 0 && bHits[0].instanceId !== undefined) {
          const idx = bHits[0].instanceId;
          return { pos: { x: bHits[0].point.x, y: -bHits[0].point.z }, buildingMeta: floorMeta[idx], floorIdx: idx };
        }
      }
      const tHits = raycaster.intersectObject(terrainMesh, false);
      if (tHits.length > 0) {
        return { pos: { x: tHits[0].point.x, y: -tHits[0].point.z } };
      }
      return null;
    };

    const paintBuildings = (hoveredIdx: number) => {
      if (!buildingMesh) return;
      const selHi = new THREE.Color("#38bdf8");
      const hovHi = new THREE.Color("#fbbf24");
      const sel = propsRef.current.selectedBuilding;
      floorMeta.forEach((m, idx) => {
        const isSel = sel && m.building.id === sel.building.id && m.floor.level === sel.floorLevel;
        buildingMesh!.setColorAt(idx, isSel ? selHi : idx === hoveredIdx ? hovHi : m.baseColor);
      });
      if (buildingMesh.instanceColor) buildingMesh.instanceColor.needsUpdate = true;
    };

    const onDown = (e: PointerEvent) => { downPos = { x: e.clientX, y: e.clientY }; };
    const onMove = (e: PointerEvent) => {
      const hit = getHit(e);
      propsRef.current.onHoverPos(hit && map.inBounds(hit.pos) ? hit.pos : null);
      const nextHov = propsRef.current.allowBuildingSelect && hit?.floorIdx !== undefined ? hit.floorIdx : -1;
      if (sceneRef.current && sceneRef.current.hoveredIdx !== nextHov) {
        sceneRef.current.hoveredIdx = nextHov;
        paintBuildings(nextHov);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5) return;
      if (e.button === 2 && propsRef.current.orderTargetMode) {
        propsRef.current.onCancelOrder?.();
        return;
      }
      if (e.button !== 0) return;
      const hit = getHit(e);
      if (!hit) return;
      if (hit.unitId) {
        propsRef.current.onSelectUnit(hit.unitId);
        return;
      }
      if (!map.inBounds(hit.pos)) return;
      if (hit.buildingMeta && propsRef.current.allowBuildingSelect) {
        propsRef.current.onSelectBuilding(hit.buildingMeta.building, hit.buildingMeta.floor);
      } else {
        propsRef.current.onMapClick(hit.pos, map.toGrid(hit.pos, 4));
      }
    };
    const onContext = (e: MouseEvent) => {
      if (propsRef.current.orderTargetMode) e.preventDefault();
    };

    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("contextmenu", onContext);

    const onResize = () => {
      const nw = container.clientWidth || window.innerWidth;
      const nh = container.clientHeight || window.innerHeight;
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    };
    window.addEventListener("resize", onResize);

    // 60 FPS continuous render loop: entity interpolation, 3D hulls, VFX & landmark labels
    let raf = 0;
    let lastFrameMs = performance.now();
    const projVec = new THREE.Vector3();
    const syncScene60Fps = (dt: number) => {
      const cur = propsRef.current;
      const { world, picture } = cur.game;
      const liveBlue = cur.god || !cur.game.aiCommanderEnabled;
      const alpha = cur.simClockRef.current.paused ? cur.simClockRef.current.tickAlpha : Math.min(1, Math.max(0, cur.simClockRef.current.tickAlpha));

      const trackMap = new Map(picture.tracks.map((t) => [t.id, t.pos]));
      const orderMap = new Map(picture.orders.filter((o) => o.order.dest).map((o) => [o.unit, o.order.dest!]));

      for (const u of world.units) {
        let node = unitNodes.get(u.id);
        if (!node) {
          node = createUnitNode(u);
          unitNodes.set(u.id, node);
          unitGroup.add(node.root);
          orderGroup.add(node.orderLine);
        }

        const isBlue = u.side === "blue";
        const visibleUnit = isBlue || cur.god || (u.state === "destroyed" && world.contacts.blue.has(u.id));
        if (!visibleUnit || u.embarkedIn) {
          node.root.visible = false;
          node.orderLine.visible = false;
          continue;
        }
        node.root.visible = true;

        const interpPos =
          isBlue && !liveBlue
            ? (trackMap.get(u.id) ?? u.pos)
            : { x: lerp(u.prevPos.x, u.pos.x, alpha), y: lerp(u.prevPos.y, u.pos.y, alpha) };
        const interpHeading = isBlue && !liveBlue ? u.heading : lerpAngle(u.prevHeading, u.heading, alpha);
        const floorOff = u.garrison ? Math.max(0, world.unitEyeHeight(u) - 1.5) : 0;
        const elev = map.elevationAt(interpPos) + floorOff;

        node.root.position.set(interpPos.x, elev, -interpPos.y);
        node.hullGroup.rotation.y = interpHeading;

        if (node.paxMeshes.length > 0) {
          node.paxMeshes.forEach((m, idx) => { m.visible = u.state === "destroyed" ? idx < 2 : idx < u.headcount; });
        }

        if (u.state === "destroyed") {
          if (!node.wreckApplied) {
            node.wreckApplied = true;
            node.hullMats.forEach((m) => m.color.set("#27272a"));
          }
          node.sprite.visible = false;
          node.tether.visible = false;
          node.selRing.visible = false;
          node.frontalArc.visible = false;
          node.cowerRing.visible = false;
          node.orderLine.visible = false;
          node.smokeAcc += dt;
          if (node.smokeAcc >= 0.45) {
            node.smokeAcc = 0;
            vfx.spawnWreckSmoke(new THREE.Vector3(interpPos.x, elev + 2.5, -interpPos.y));
          }
          continue;
        }

        if (node.wreckApplied) {
          node.wreckApplied = false;
          node.hullMats[0].color.set(node.baseHex);
        }

        node.sprite.visible = true;
        node.tether.visible = true;
        const isSel = cur.selectedUnitId === u.id;
        node.selRing.visible = isSel;
        node.frontalArc.visible = isSel;

        const cower = isCowering(u);
        node.cowerRing.visible = cower;
        if (cower) {
          node.cowerMat.color.set(getMoraleTier(u.morale) === "panicked" ? "#ef4444" : "#f59e0b");
        }

        const dest = isBlue ? (liveBlue ? u.order?.dest : orderMap.get(u.id)) : cur.god ? u.order?.dest : undefined;
        if (dest) {
          node.orderLine.visible = true;
          const posAttr = node.orderLine.geometry.getAttribute("position") as THREE.BufferAttribute;
          posAttr.setXYZ(0, interpPos.x, elev + 6, -interpPos.y);
          posAttr.setXYZ(1, dest.x, map.elevationAt(dest) + 6, -dest.y);
          posAttr.needsUpdate = true;
        } else {
          node.orderLine.visible = false;
        }
      }

      // Prune removed units (Debug Deleter)
      const currentUnitIds = new Set(world.units.map((u) => u.id));
      for (const [uid, node] of unitNodes) {
        if (!currentUnitIds.has(uid)) {
          unitGroup.remove(node.root);
          orderGroup.remove(node.orderLine);
          node.root.traverse((obj) => {
            if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
              obj.geometry.dispose();
              (obj.material as THREE.Material).dispose();
            } else if (obj instanceof THREE.Sprite) {
              obj.material.dispose();
            }
          });
          node.orderLine.geometry.dispose();
          (node.orderLine.material as THREE.Material).dispose();
          unitNodes.delete(uid);
        }
      }

      // Sync live parabolic indirect arcs & flying shells
      while (indirectGroup.children.length > 0) {
        const ch = indirectGroup.children.pop()!;
        if (ch instanceof THREE.Line) {
          ch.geometry.dispose();
          (ch.material as THREE.Material).dispose();
        } else if (ch instanceof THREE.Mesh) {
          (ch.material as THREE.Material).dispose();
        }
      }
      for (const p of world.indirectProjectiles) {
        const shooter = world.get(p.shooterId);
        const visibleArc = cur.god || !cur.game.aiCommanderEnabled || shooter?.side === "blue" || world.contacts.blue.has(p.shooterId);
        if (!visibleArc) continue;
        const arcH = Math.min(260, Math.max(45, Math.hypot(p.to.x - p.from.x, p.to.y - p.from.y) * 0.16));
        const arcPts: THREE.Vector3[] = [];
        const segs = 14;
        for (let s = 0; s <= segs; s++) {
          const u = s / segs;
          arcPts.push(new THREE.Vector3(
            lerp(p.from.x, p.to.x, u),
            lerp(p.fromZ, p.toZ, u) + Math.sin(u * Math.PI) * arcH,
            -lerp(p.from.y, p.to.y, u),
          ));
        }
        const arcColor = p.ammo === "Smoke" ? "#cbd5e1" : p.ammo === "HE_Airburst" ? "#fde047" : "#f59e0b";
        indirectGroup.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(arcPts),
          new THREE.LineBasicMaterial({ color: arcColor, transparent: true, opacity: 0.55 }),
        ));
        const uNow = Math.min(1, Math.max(0, (p.totalFlightTime - p.timeRemaining + alpha) / Math.max(1, p.totalFlightTime)));
        const shell = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({ color: arcColor }));
        shell.position.set(
          lerp(p.from.x, p.to.x, uNow),
          lerp(p.fromZ, p.toZ, uNow) + Math.sin(uNow * Math.PI) * arcH,
          -lerp(p.from.y, p.to.y, uNow),
        );
        indirectGroup.add(shell);
      }

      // Sync translucent 3D smoke occlusion spheres
      while (smokeGroup.children.length > world.smokeVolumes.length) {
        smokeGroup.remove(smokeGroup.children[smokeGroup.children.length - 1]);
      }
      while (smokeGroup.children.length < world.smokeVolumes.length) {
        smokeGroup.add(new THREE.Mesh(smokeSphereGeo, smokeMat));
      }
      world.smokeVolumes.forEach((sv, idx) => {
        const mesh = smokeGroup.children[idx] as THREE.Mesh;
        mesh.position.set(sv.center.x, (sv.minZ ?? map.elevationAt(sv.center)) + sv.height * 0.45, -sv.center.y);
        mesh.scale.set(sv.radius, sv.height * 0.85, sv.radius);
      });

      // Sync fog-of-war enemy contacts (when God mode is OFF)
      const activeContactIds = new Set<string>();
      if (!cur.god) {
        const contactSource = !cur.game.aiCommanderEnabled ? [...world.contacts.blue.values()] : picture.contacts;
        for (const c of contactSource) {
          activeContactIds.add(c.id);
          const texKey = c.level === "visual" && c.type ? `vis:${c.type}:${c.id}` : `con:${c.weaponClass ?? "?"}`;
          let entry = contactNodes.get(c.id);
          const tex =
            c.level === "visual" && c.type
              ? getUnitTexture("red", c.type, c.id.replace("Red ", "R"))
              : getContactTexture(c.weaponClass ? WEAPON_TAG[c.weaponClass] : "?");
          if (!entry) {
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
            sp.scale.set(82, 82, 1);
            contactGroup.add(sp);
            entry = { sprite: sp, key: texKey };
            contactNodes.set(c.id, entry);
          } else if (entry.key !== texKey) {
            entry.key = texKey;
            entry.sprite.material.map = tex;
            entry.sprite.material.needsUpdate = true;
          }
          entry.sprite.visible = true;
          entry.sprite.position.set(c.pos.x, map.elevationAt(c.pos) + 26, -c.pos.y);
        }
      }
      for (const [id, entry] of contactNodes) {
        if (!activeContactIds.has(id)) entry.sprite.visible = false;
      }

      // Step sub-second ballistics & combat VFX
      vfx.update(dt, world, (ev) => {
        if (cur.god || !cur.game.aiCommanderEnabled) return true;
        const sh = world.get(ev.shooterId);
        const tg = ev.targetId ? world.get(ev.targetId) : undefined;
        return sh?.side === "blue" || tg?.side === "blue" || world.contacts.blue.has(ev.shooterId) || (!!ev.targetId && world.contacts.blue.has(ev.targetId));
      });
    };

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.08, Math.max(0.001, (now - lastFrameMs) / 1000));
      lastFrameMs = now;
      syncScene60Fps(dt);
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
      vfx.dispose();
      shellGeo.dispose();
      smokeSphereGeo.dispose();
      smokeMat.dispose();
      while (indirectGroup.children.length > 0) {
        const ch = indirectGroup.children.pop()!;
        if (ch instanceof THREE.Line) { ch.geometry.dispose(); (ch.material as THREE.Material).dispose(); }
        else if (ch instanceof THREE.Mesh) { (ch.material as THREE.Material).dispose(); }
      }
      for (const n of unitNodes.values()) {
        n.root.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
            obj.geometry.dispose();
            (obj.material as THREE.Material).dispose();
          } else if (obj instanceof THREE.Sprite) {
            obj.material.dispose();
          }
        });
        n.orderLine.geometry.dispose();
        (n.orderLine.material as THREE.Material).dispose();
      }
      unitNodes.clear();
      for (const c of contactNodes.values()) c.sprite.material.dispose();
      contactNodes.clear();
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("contextmenu", onContext);
      controls.dispose();
      terrainTex.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [map]);

  // Highlight selected or hovered building floor
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx?.buildingMesh) return;
    const hi = new THREE.Color("#38bdf8");
    const hov = new THREE.Color("#fbbf24");
    ctx.floorMeta.forEach((m, idx) => {
      const isSel = selectedBuilding && m.building.id === selectedBuilding.building.id && m.floor.level === selectedBuilding.floorLevel;
      ctx.buildingMesh!.setColorAt(idx, isSel ? hi : idx === ctx.hoveredIdx ? hov : m.baseColor);
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
            const res = map.sightline(losObserver.pos, losObserver.eyeHeight, { x: px, y: py }, 1.5, {
              stepMeters: 25,
              dynamicVolumes: propsRef.current.game.world.smokeVolumes,
            });
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
      <div ref={mountRef} style={{ width: "100%", height: "100%", cursor: markerMode || inspectorMode || orderTargetMode ? "crosshair" : "grab" }} />

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
