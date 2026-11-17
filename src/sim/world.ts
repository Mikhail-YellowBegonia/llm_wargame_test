// Simulation core: units, platoon-level bot state machine, two-tier spotting, 10m mobility/garrison, combat, events.
// No I/O here; the world advances by fixed 1-second ticks and emits events.
import { CombatModifiers, GameMap, MobilityClass, TerrainId, UnitTrait, Vec, dist, rng } from "./map";

export type Side = "blue" | "red";
export type UnitType = "tank" | "ifv" | "infantry" | "atgm";
export type Roe = "fire_at_will" | "return_fire" | "hold_fire";
export type OrderKind = "hold" | "move" | "attack" | "withdraw";
export interface UnitGarrison {
  buildingId: string;
  floorLevel: number;
}
export interface Order { kind: OrderKind; dest?: Vec; destName?: string; garrison?: UnitGarrison }

export type BotState = "holding" | "moving" | "pinned" | "broken" | "destroyed";
export type DetectionLevel = "contact" | "visual";
export type WeaponSignatureClass = "small_arms" | "light_weapon" | "heavy_weapon";
export type OwnPerceptionLevel = "none" | DetectionLevel;

interface TypeStats {
  label: string;
  armored: boolean;
  mobility: MobilityClass;
  traits: ReadonlyArray<UnitTrait>;
  headcount: number;
  eyeHeight: number;
  baseSignature: number;
  weaponClass: WeaponSignatureClass;
  muzzleSignature: number;
  soft: number;
  hard: number; // firepower vs soft / armored targets
  range: number;
  spot: number; // meters
  baseSpeedKmH: number; // open-ground tactical speed (scaled by 10m terrain speedMultiplier)
}

export const STATS: Record<UnitType, TypeStats> = {
  tank: {
    label: "tank platoon",
    armored: true,
    mobility: "tracked",
    traits: ["vehicle", "armored", "tall_profile"],
    headcount: 0,
    eyeHeight: 2.8,
    baseSignature: 1.0,
    weaponClass: "heavy_weapon",
    muzzleSignature: 1.6,
    soft: 6,
    hard: 10,
    range: 2000,
    spot: 2000,
    baseSpeedKmH: 30,
  },
  ifv: {
    label: "mech infantry platoon",
    armored: true,
    mobility: "tracked",
    traits: ["vehicle", "armored", "tall_profile"],
    headcount: 0,
    eyeHeight: 2.6,
    baseSignature: 0.95,
    weaponClass: "light_weapon",
    muzzleSignature: 1.35,
    soft: 8,
    hard: 5,
    range: 1500,
    spot: 2000,
    baseSpeedKmH: 30,
  },
  infantry: {
    label: "infantry platoon",
    armored: false,
    mobility: "foot",
    traits: ["infantry", "low_profile"],
    headcount: 8,
    eyeHeight: 1.5,
    baseSignature: 0.5,
    weaponClass: "small_arms",
    muzzleSignature: 0.9,
    soft: 6,
    hard: 3,
    range: 600,
    spot: 1200,
    baseSpeedKmH: 4,
  },
  atgm: {
    label: "ATGM section",
    armored: false,
    mobility: "foot",
    traits: ["infantry", "low_profile"],
    headcount: 4,
    eyeHeight: 1.4,
    baseSignature: 0.45,
    weaponClass: "heavy_weapon",
    muzzleSignature: 1.5,
    soft: 1,
    hard: 9,
    range: 2500,
    spot: 2500,
    baseSpeedKmH: 4,
  },
};

export interface Unit {
  id: string;            // callsign, e.g. "Alpha 1"
  side: Side;
  type: UnitType;
  pos: Vec;
  strength: number;      // 0..100
  suppression: number;   // 0..100
  morale: number;        // 0..100
  roe: Roe;
  order: Order;
  state: BotState;
  commander?: string;    // id of the agent that commands this unit
  target?: string;       // enemy currently engaged
  lastFiredAt: number;
  lastHitAt: number;
  rally?: Vec;           // where it falls back to when broken
  mobility: MobilityClass;
  traits: UnitTrait[];
  headcount: number;
  eyeHeight: number;
  baseSignature: number;
  weaponClass: WeaponSignatureClass;
  muzzleSignature: number;
  garrison?: UnitGarrison;
  settledTicks: number;
  ownPerception: Map<string, OwnPerceptionLevel>;
}

export interface Contact {
  id: string;
  level: DetectionLevel;
  type?: UnitType;                    // populated only when level === "visual"
  weaponClass?: WeaponSignatureClass; // populated for contact detections
  pos: Vec;
  seenAt: number;
  seenBy: string;
  strength: number;
}

export interface UnitTelemetry {
  bodySignature: number;
  terrainId: TerrainId;
  modifiers: CombatModifiers;
  garrison?: UnitGarrison & { elevationOffset: number };
  ownPerception: { targetId: string; level: OwnPerceptionLevel }[];
}

export type EventKind =
  | "contact" | "under_fire" | "pinned" | "recovered" | "casualties"
  | "arrived" | "broken" | "destroyed" | "enemy_destroyed";
export interface SimEvent { t: number; kind: EventKind; unit: string; text: string }

const DMG_K = 0.03; // tune: strength lost per second per point of firepower
const SETTLE_THRESHOLD_TICKS = 15;
const MUZZLE_FLASH_WINDOW = 2; // seconds a firing flash remains detectable
const WEAPON_CLASS_RANK: Record<WeaponSignatureClass, number> = {
  small_arms: 1,
  light_weapon: 2,
  heavy_weapon: 3,
};

function higherWeaponClass(a?: WeaponSignatureClass, b?: WeaponSignatureClass): WeaponSignatureClass | undefined {
  if (!a) return b;
  if (!b) return a;
  return WEAPON_CLASS_RANK[a] >= WEAPON_CLASS_RANK[b] ? a : b;
}

export class World {
  t = 0; // game seconds
  units: Unit[] = [];
  /** What each side knows about enemy units (fused from all its units' spotting). */
  contacts: Record<Side, Map<string, Contact>> = { blue: new Map(), red: new Map() };
  events: SimEvent[] = [];
  private listeners: ((e: SimEvent) => void)[] = [];
  private random: () => number;
  private casualtyMarks = new Map<string, number>();
  private underFireReported = new Map<string, number>();

  constructor(readonly map: GameMap, seed = 1) { this.random = rng(seed); }

  on(fn: (e: SimEvent) => void) { this.listeners.push(fn); }
  private emit(kind: EventKind, u: Unit, text: string) {
    const e = { t: this.t, kind, unit: u.id, text };
    this.events.push(e);
    this.listeners.forEach((fn) => fn(e));
  }

  add(
    u: Omit<
      Unit,
      | "strength" | "suppression" | "morale" | "state" | "lastFiredAt" | "lastHitAt" | "roe" | "order"
      | "mobility" | "traits" | "headcount" | "eyeHeight" | "baseSignature" | "weaponClass" | "muzzleSignature"
      | "settledTicks" | "ownPerception"
    > & Partial<Unit>,
  ) {
    const st = STATS[u.type];
    const unit: Unit = {
      strength: 100,
      suppression: 0,
      morale: 80,
      state: "holding",
      roe: "fire_at_will",
      order: { kind: "hold" },
      lastFiredAt: -1e9,
      lastHitAt: -1e9,
      mobility: st.mobility,
      traits: [...st.traits],
      headcount: st.headcount,
      eyeHeight: st.eyeHeight,
      baseSignature: st.baseSignature,
      weaponClass: st.weaponClass,
      muzzleSignature: st.muzzleSignature,
      settledTicks: 0,
      ownPerception: new Map(),
      ...u,
    };
    this.units.push(unit);
    return unit;
  }

  get(id: string) { return this.units.find((u) => u.id.toLowerCase() === id.trim().toLowerCase()); }
  alive(side?: Side) { return this.units.filter((u) => u.state !== "destroyed" && (!side || u.side === side)); }

  /** Give an order to a unit (used by agents, scripts and direct player commands). */
  command(u: Unit, order: Order, roe?: Roe) {
    if (u.state === "destroyed") return "unit destroyed";
    if (u.state === "broken") return `${u.id} is broken and falling back, not responding to orders`;
    if (order.dest && u.garrison) this.vacateBuilding(u);
    u.order = order;
    if (roe) u.roe = roe;
    else if (order.kind === "attack") u.roe = "fire_at_will";
    else if (order.kind === "withdraw") u.roe = "return_fire";
    if (u.state !== "pinned") u.state = order.dest ? "moving" : "holding";
    return "ok";
  }

  /** Order an infantry unit to move to a building and garrison a specific BuildingFloor on arrival. */
  orderGarrison(u: Unit, buildingId: string, level: number): string {
    if (u.state === "destroyed") return "unit destroyed";
    if (u.state === "broken") return `${u.id} is broken and cannot garrison`;
    if (!u.traits.includes("infantry")) return `${u.id} is not infantry and cannot garrison buildings`;
    if (!this.map.canGarrisonFloor(buildingId, level, u.headcount)) {
      return `cannot garrison ${buildingId} F${level} (invalid, gutted, or headcount ${u.headcount} exceeds capacity)`;
    }
    const bld = this.map.buildings.find((b) => b.id === buildingId);
    const floor = bld?.floors.find((f) => f.level === level);
    if (!bld || !floor) return `building floor ${buildingId} F${level} not found`;
    const used = floor.occupants
      .filter((id) => id !== u.id)
      .reduce((sum, id) => sum + (this.get(id)?.headcount ?? 0), 0);
    if (used + u.headcount > floor.capacity) {
      return `insufficient capacity on ${buildingId} F${level} (${used}/${floor.capacity} used)`;
    }
    if (dist(u.pos, bld.center) <= 25) {
      return this.garrisonFloor(u, buildingId, level);
    }
    return this.command(u, {
      kind: "move",
      dest: { ...bld.center },
      destName: `${buildingId} F${level}`,
      garrison: { buildingId, floorLevel: level },
    });
  }

  /** Garrison an infantry unit onto a specific BuildingFloor. */
  garrisonFloor(u: Unit, buildingId: string, level: number): string {
    if (u.state === "destroyed") return "unit destroyed";
    if (u.state === "broken") return `${u.id} is broken and cannot garrison`;
    if (!u.traits.includes("infantry")) return `${u.id} is not infantry and cannot garrison buildings`;
    if (!this.map.canGarrisonFloor(buildingId, level, u.headcount)) {
      return `cannot garrison ${buildingId} F${level} (invalid, gutted, or headcount ${u.headcount} exceeds capacity)`;
    }
    const bld = this.map.buildings.find((b) => b.id === buildingId);
    const floor = bld?.floors.find((f) => f.level === level);
    if (!bld || !floor) return `building floor ${buildingId} F${level} not found`;
    const used = floor.occupants
      .filter((id) => id !== u.id)
      .reduce((sum, id) => sum + (this.get(id)?.headcount ?? 0), 0);
    if (used + u.headcount > floor.capacity) {
      return `insufficient capacity on ${buildingId} F${level} (${used}/${floor.capacity} used)`;
    }
    if (u.garrison) this.vacateBuilding(u);
    if (!floor.occupants.includes(u.id)) floor.occupants.push(u.id);
    u.garrison = { buildingId, floorLevel: level };
    u.pos = { ...bld.center };
    u.order = { kind: "hold" };
    if (u.state !== "pinned") u.state = "holding";
    return "ok";
  }

  /** Remove a unit from its currently garrisoned BuildingFloor. */
  vacateBuilding(u: Unit): string {
    if (!u.garrison) return "not garrisoned";
    const { buildingId, floorLevel } = u.garrison;
    const floor = this.map.buildings.find((b) => b.id === buildingId)?.floors.find((f) => f.level === floorLevel);
    if (floor) floor.occupants = floor.occupants.filter((id) => id !== u.id);
    u.garrison = undefined;
    return "ok";
  }

  private unitFloor(u: Unit) {
    if (!u.garrison) return undefined;
    const floor = this.map.buildings
      .find((b) => b.id === u.garrison!.buildingId)
      ?.floors.find((f) => f.level === u.garrison!.floorLevel);
    if (!floor || floor.state === "gutted") return undefined;
    return floor;
  }

  unitEyeHeight(u: Unit): number {
    return this.unitFloor(u)?.elevationOffset ?? u.eyeHeight;
  }

  unitModifiers(u: Unit): CombatModifiers {
    return this.unitFloor(u)?.modifiers ?? this.map.getTerrainModifiers(u.pos, u.traits);
  }

  /** Decoupled body signature S_body governing Visual detection (unaffected by firing). */
  computeBodySignature(u: Unit): number {
    const floor = this.unitFloor(u);
    const terBase = floor ? 1.0 : this.map.terrainDefAt(u.pos).baseSignature;
    const sigMult = (floor ? floor.modifiers.signatureMult : this.map.getTerrainModifiers(u.pos, u.traits).signatureMult) ?? 1;
    const moveMult =
      u.state === "moving"
        ? 1.35
        : u.traits.includes("infantry") && u.settledTicks >= SETTLE_THRESHOLD_TICKS
          ? 0.75
          : 1.0;
    return u.baseSignature * terBase * sigMult * moveMult;
  }

  getUnitTelemetry(u: Unit): UnitTelemetry {
    const floor = this.unitFloor(u);
    return {
      bodySignature: this.computeBodySignature(u),
      terrainId: this.map.terrainIdAt(u.pos),
      modifiers: this.unitModifiers(u),
      garrison: floor && u.garrison ? { ...u.garrison, elevationOffset: floor.elevationOffset } : undefined,
      ownPerception: [...u.ownPerception.entries()].map(([targetId, level]) => ({ targetId, level })),
    };
  }

  step() {
    this.t += 1;
    const live = this.alive();
    this.spot(live);
    for (const u of live) this.fire(u);
    for (const u of live) this.bot(u);
  }

  // ---------- two-tier instantaneous 3D spotting ----------
  private sightlineBetween(o: Unit, e: Unit) {
    const ignoreBuildingIds: string[] = [];
    if (o.garrison) ignoreBuildingIds.push(o.garrison.buildingId);
    if (e.garrison) ignoreBuildingIds.push(e.garrison.buildingId);
    return this.map.sightline(
      o.pos,
      this.unitEyeHeight(o),
      e.pos,
      this.unitEyeHeight(e),
      ignoreBuildingIds.length > 0 ? { ignoreBuildingIds } : undefined,
    );
  }

  private evaluatePerception(o: Unit, e: Unit): OwnPerceptionLevel {
    const res = this.sightlineBetween(o, e);
    if (res.blocked) return "none";
    const spotRange = STATS[o.type].spot;
    if (res.distance <= spotRange * this.computeBodySignature(e) * res.transmittance) {
      return "visual";
    }
    if (this.t - e.lastFiredAt <= MUZZLE_FLASH_WINDOW) {
      if (res.distance <= spotRange * e.muzzleSignature * res.transmittance) {
        return "contact";
      }
    }
    return "none";
  }

  private recordContact(
    side: Side,
    enemy: Unit,
    level: DetectionLevel,
    observerId: string,
    weaponClass?: WeaponSignatureClass,
  ) {
    const known = this.contacts[side];
    const prev = known.get(enemy.id);
    if (level === "visual") {
      if (!prev || this.t - prev.seenAt > 120 || prev.level !== "visual") {
        const obs = this.get(observerId);
        if (obs) this.emit("contact", obs, `spotted ${STATS[enemy.type].label} at ${this.map.describe(enemy.pos)}`);
      }
      known.set(enemy.id, {
        id: enemy.id,
        level: "visual",
        type: enemy.type,
        weaponClass: higherWeaponClass(prev?.weaponClass, weaponClass),
        pos: { ...enemy.pos },
        seenAt: this.t,
        seenBy: observerId,
        strength: enemy.strength,
      });
    } else {
      const wc = higherWeaponClass(prev?.weaponClass, weaponClass ?? enemy.weaponClass);
      if (!prev || this.t - prev.seenAt > 120) {
        const obs = this.get(observerId);
        if (obs) {
          this.emit("contact", obs, `detected ${wc?.replace(/_/g, " ") ?? "enemy"} contact at ${this.map.describe(enemy.pos)}`);
        }
      }
      known.set(enemy.id, {
        id: enemy.id,
        level: "contact",
        weaponClass: wc,
        pos: { ...enemy.pos },
        seenAt: this.t,
        seenBy: observerId,
        strength: enemy.strength,
      });
    }
  }

  private spot(live: Unit[]) {
    for (const o of live) o.ownPerception.clear();

    for (const side of ["blue", "red"] as Side[]) {
      const known = this.contacts[side];
      const observers = live.filter((o) => o.side === side);
      for (const e of live) {
        if (e.side === side) continue;
        let visualObserver: Unit | undefined;
        let contactObserver: Unit | undefined;

        for (const o of observers) {
          const level = this.evaluatePerception(o, e);
          o.ownPerception.set(e.id, level);
          if (level === "visual" && !visualObserver) visualObserver = o;
          else if (level === "contact" && !contactObserver) contactObserver = o;
        }

        if (visualObserver) {
          this.recordContact(side, e, "visual", visualObserver.id);
        } else if (contactObserver) {
          this.recordContact(side, e, "contact", contactObserver.id, e.weaponClass);
        }
      }

      for (const [id, c] of known) {
        const u = this.units.find((x) => x.id === id);
        if (u?.state === "destroyed" && this.t - c.seenAt > 5) known.delete(id);
      }
    }
  }

  // ---------- combat ----------
  private fire(u: Unit) {
    if (u.roe === "hold_fire" || u.state === "broken") return;
    if (u.roe === "return_fire" && this.t - u.lastHitAt > 30) return;
    const st = STATS[u.type];
    let target: Unit | undefined;
    let best = Infinity;
    for (const e of this.alive()) {
      if (e.side === u.side) continue;
      const d = dist(u.pos, e.pos);
      if (d > st.range) continue;
      const perc = u.ownPerception.get(e.id) ?? "none";
      if (perc === "none") continue;
      const score = e.id === u.target ? d * 0.5 : d;
      if (score < best) { best = score; target = e; }
    }
    u.target = target?.id;
    if (!target) return;

    const d = dist(u.pos, target.pos);
    const ts = STATS[target.type];
    const attackerMods = this.unitModifiers(u);
    const targetMods = this.unitModifiers(target);

    let dmg = (ts.armored ? st.hard : st.soft) * DMG_K;
    dmg *= u.strength / 100;
    dmg *= 1 - u.suppression / 150;
    dmg *= u.state === "moving" ? 0.5 : u.state === "pinned" ? 0.4 : 1;
    dmg *= attackerMods.attackMult ?? 1;
    dmg *= 1 - (0.5 * d) / st.range;
    dmg *= targetMods.damageMult ?? 1;
    if (target.state === "holding") dmg *= 0.75; // hasty fighting positions
    dmg *= 0.5 + this.random();
    u.lastFiredAt = this.t;

    // Immediate muzzle-flash Contact check for observers on the target's side
    for (const o of this.alive(target.side)) {
      const level = this.evaluatePerception(o, u);
      if (level !== "none") {
        const prev = o.ownPerception.get(u.id) ?? "none";
        if (prev === "none" || level === "visual") o.ownPerception.set(u.id, level);
        const sideKnown = this.contacts[target.side].get(u.id);
        if (level === "visual") {
          this.recordContact(target.side, u, "visual", o.id, u.weaponClass);
        } else if (!sideKnown || sideKnown.seenAt < this.t) {
          this.recordContact(target.side, u, "contact", o.id, u.weaponClass);
        }
      }
    }

    this.hit(target, dmg, u, 1 - d / st.range);
  }

  private hit(u: Unit, dmg: number, by: Unit, closeness: number) {
    u.strength = Math.max(0, u.strength - dmg);
    const suppMult = this.unitModifiers(u).suppressionMult ?? 1;
    const supp = (dmg * 6 + 0.8 * closeness) * (STATS[u.type].armored ? 0.5 : 1) * suppMult;
    u.suppression = Math.min(100, u.suppression + supp);
    u.morale = Math.max(0, u.morale - dmg * 0.6);
    u.lastHitAt = this.t;

    // Taking fire or suppression reveals at least a Contact on the attacker to the victim's side
    const sideKnown = this.contacts[u.side].get(by.id);
    if (!sideKnown || sideKnown.seenAt < this.t) {
      this.recordContact(u.side, by, "contact", u.id, by.weaponClass);
    }

    if (this.t - (this.underFireReported.get(u.id) ?? -1e9) > 90) {
      this.underFireReported.set(u.id, this.t);
      this.emit("under_fire", u, `taking fire from the ${bearingWord(u.pos, by.pos)}`);
    }
    for (const mark of [75, 50, 25]) {
      if (u.strength < mark && (this.casualtyMarks.get(u.id) ?? 100) > mark) {
        this.casualtyMarks.set(u.id, mark);
        this.emit("casualties", u, `casualties, now at about ${mark}% strength`);
      }
    }
    if (u.strength < 8) {
      this.vacateBuilding(u);
      u.state = "destroyed";
      this.emit("destroyed", u, `${u.id} has been destroyed`);
      this.emit("enemy_destroyed", by, `destroyed enemy ${STATS[u.type].label}`);
    }
  }

  // ---------- platoon bot (finite state machine) ----------
  private bot(u: Unit) {
    if (u.state === "destroyed") return;
    if (u.garrison && !this.unitFloor(u)) u.garrison = undefined;

    const recentlyHit = this.t - u.lastHitAt < 15;
    u.suppression = Math.max(0, u.suppression - (recentlyHit ? 0.7 : 3));

    if (u.state !== "broken" && (u.strength < 30 || u.morale < 20)) {
      if (u.garrison) this.vacateBuilding(u);
      u.state = "broken";
      u.roe = "return_fire";
      u.order = { kind: "withdraw", dest: u.rally };
      this.emit("broken", u, "unit is combat ineffective and falling back on its own");
    }
    if (u.state === "moving" || u.state === "holding") {
      if (u.suppression > 60 && u.order.kind !== "withdraw") {
        u.state = "pinned";
        this.emit("pinned", u, "pinned down, cannot move");
      }
    } else if (u.state === "pinned" && u.suppression < 30) {
      u.state = u.order.dest ? "moving" : "holding";
      this.emit("recovered", u, "no longer pinned, resuming orders");
    }
    if ((u.state === "moving" || u.state === "holding") && u.order.dest) {
      const standoff =
        u.order.kind === "attack" &&
        this.alive().some(
          (e) =>
            e.side !== u.side &&
            dist(u.pos, e.pos) <= STATS[u.type].range * 0.75 &&
            (u.ownPerception.get(e.id) ?? "none") !== "none",
        );
      u.state = standoff ? "holding" : "moving";
    }

    if ((u.state === "moving" || u.state === "broken") && u.order.dest) {
      u.settledTicks = 0;
      this.move(u, u.order.dest);
    } else {
      u.settledTicks += 1;
    }
  }

  private canOccupy(u: Unit, p: Vec): boolean {
    if (!this.map.inBounds(p) || !this.map.isPassable(p, u.mobility)) return false;
    const bld = this.map.buildingAt(p);
    if (!bld) return true;
    if (u.order.garrison?.buildingId === bld.id) return true;
    return this.map.buildingAt(u.pos)?.id === bld.id;
  }

  private move(u: Unit, dest: Vec) {
    if (u.garrison) this.vacateBuilding(u);
    const d = dist(u.pos, dest);
    const speedMult = this.map.terrainDefAt(u.pos).speedMultiplier;
    const kmh = STATS[u.type].baseSpeedKmH * speedMult;
    const step = (kmh / 3.6) * (u.suppression > 30 ? 0.5 : 1);
    if (step <= 0) return;

    const pendingGarrison = u.order.garrison;
    if (pendingGarrison && d <= Math.max(step, 15)) {
      const res = this.garrisonFloor(u, pendingGarrison.buildingId, pendingGarrison.floorLevel);
      if (res === "ok") {
        this.emit("arrived", u, `garrisoned ${pendingGarrison.buildingId} F${pendingGarrison.floorLevel}`);
      } else {
        u.order = { kind: "hold" };
        if (u.state === "moving") u.state = "holding";
      }
      return;
    }

    if (d <= step) {
      if (!this.canOccupy(u, dest)) {
        u.order = { kind: "hold" };
        if (u.state === "moving") u.state = "holding";
        return;
      }
      u.pos = { ...dest };
      const was = u.order;
      u.order = { kind: "hold" };
      if (u.state === "moving") {
        u.state = "holding";
        this.emit("arrived", u, `arrived at ${was.destName ?? this.map.describe(dest)}, holding`);
      }
      return;
    }

    const baseAngle = Math.atan2(dest.y - u.pos.y, dest.x - u.pos.x);
    const probeDist = Math.max(step, this.map.fineCellSize * 1.2);
    for (const offset of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
      const ang = baseAngle + offset;
      const nextPos = { x: u.pos.x + Math.cos(ang) * step, y: u.pos.y + Math.sin(ang) * step };
      const probePos = offset === 0 ? nextPos : { x: u.pos.x + Math.cos(ang) * probeDist, y: u.pos.y + Math.sin(ang) * probeDist };
      if (this.canOccupy(u, nextPos) && this.canOccupy(u, probePos)) {
        u.pos = nextPos;
        return;
      }
    }
  }
}

function bearingWord(from: Vec, to: Vec) {
  const deg = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(((deg + 360) % 360) / 45) % 8];
}
