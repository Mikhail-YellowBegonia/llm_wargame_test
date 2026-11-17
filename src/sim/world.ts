// Simulation core: units, platoon-level bot state machine, two-tier spotting, 10m mobility/garrison,
// Phase 2B own-optics accuracy, directional KE/CE armor, HE inverse-square law, infantry takeover,
// Phase 2C 4-tier morale, SuppressionFloor, Cowering, morale events, and vehicle patches.
import { ArmorValue, CombatModifiers, DEFAULT_BUILDING_ARMOR, GameMap, MobilityClass, TerrainId, UnitTrait, Vec, dist, rng } from "./map";

export type { ArmorValue };
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
export type MoraleTier = "calm" | "worried" | "shaken" | "panicked";
export type MoraleEventKind = "SupplyBonus" | "CombatFeatBonus" | "IsolationPenalty" | "ArtilleryShockPenalty";
export type DetectionLevel = "contact" | "visual";
export type WeaponSignatureClass = "small_arms" | "light_weapon" | "heavy_weapon";
export type OwnPerceptionLevel = "none" | DetectionLevel;

export type AmmoType = "AP" | "HEAT" | "HE";
export type ArmorAspect = "front" | "side" | "rear" | "top";
export interface ArmorProfile {
  front: ArmorValue;
  side: ArmorValue;
  rear: ArmorValue;
  top: ArmorValue;
}

export interface WeaponSlot {
  id: string;
  name: string;
  ammo: AmmoType;
  pen: number;             // AP point-blank KE pen, HEAT CE pen, or HE contact KE pen
  d0?: number;             // HE characteristic blast radius (meters)
  damage: number;
  suppression: number;
  range: number;
  reloadSec: number;
  cooldown: number;
  accuracy: number;        // baseline hit chance at Visual (100%)
  weaponClass: WeaponSignatureClass;
  muzzleSignature: number;
  mutexGroup?: string;
  mutexLockSec?: number;
}

export type SpecialistRole = "rifleman" | "mg_specialist" | "at_specialist" | "marksman" | "engineer";
export interface InfantryWeaponSlot {
  id: string;
  isSpecial: boolean;
  requiredRole?: SpecialistRole;
  abandonPriority: number; // Lower value = retained longer (AT=1, MG=2, Rifle=99)
  unskilledPenalty: number; // Multiplier (<1) applied when cross-manned
  weapon: Omit<WeaponSlot, "cooldown">;
  cooldown: number;
}

export interface InfantrySubRoster {
  personnel: Record<SpecialistRole, number>;
  weapons: InfantryWeaponSlot[];
  abandonedWeapons: string[];
}

export interface AssignedInfantryWeapon {
  slot: InfantryWeaponSlot;
  operatorRole: SpecialistRole;
  crossManned: boolean;
  efficiency: number;
}

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
  range: number;
  spot: number;
  baseSpeedKmH: number;
  passengerCapacity?: number;
  hasFiringPorts?: boolean;
  armor: ArmorProfile;
  weapons: ReadonlyArray<Omit<WeaponSlot, "cooldown">>;
}

const SOFT_ARMOR: ArmorProfile = {
  front: { ke: 0, ce: 0 },
  side: { ke: 0, ce: 0 },
  rear: { ke: 0, ce: 0 },
  top: { ke: 0, ce: 0 },
};

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
    range: 2000,
    spot: 2000,
    baseSpeedKmH: 30,
    armor: {
      front: { ke: 16, ce: 20 },
      side: { ke: 7, ce: 9 },
      rear: { ke: 3, ce: 4 },
      top: { ke: 2, ce: 2 },
    },
    weapons: [
      {
        id: "120mm_ap",
        name: "120mm APFSDS",
        ammo: "AP",
        pen: 20,
        damage: 32,
        suppression: 16,
        range: 2000,
        reloadSec: 6,
        accuracy: 0.78,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.6,
        mutexGroup: "tank_gun",
        mutexLockSec: 6,
      },
      {
        id: "120mm_he",
        name: "120mm HE",
        ammo: "HE",
        pen: 6,
        d0: 4,
        damage: 24,
        suppression: 26,
        range: 2000,
        reloadSec: 6,
        accuracy: 0.75,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.6,
        mutexGroup: "tank_gun",
        mutexLockSec: 6,
      },
      {
        id: "coax_mg",
        name: "7.62mm Coax MG",
        ammo: "AP",
        pen: 1.5,
        damage: 5,
        suppression: 8,
        range: 800,
        reloadSec: 1,
        accuracy: 0.65,
        weaponClass: "small_arms",
        muzzleSignature: 0.9,
      },
    ],
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
    range: 1800,
    spot: 2000,
    baseSpeedKmH: 30,
    passengerCapacity: 1,
    hasFiringPorts: true,
    armor: {
      front: { ke: 5, ce: 6 },
      side: { ke: 3, ce: 3 },
      rear: { ke: 2, ce: 2 },
      top: { ke: 1, ce: 1 },
    },
    weapons: [
      {
        id: "atgm_launcher",
        name: "TOW/ATGM",
        ammo: "HEAT",
        pen: 17,
        damage: 28,
        suppression: 14,
        range: 1800,
        reloadSec: 10,
        accuracy: 0.72,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.5,
        mutexGroup: "turret_loader",
        mutexLockSec: 4,
      },
      {
        id: "autocannon_30mm",
        name: "30mm Autocannon",
        ammo: "AP",
        pen: 7,
        damage: 9,
        suppression: 12,
        range: 1500,
        reloadSec: 2,
        accuracy: 0.7,
        weaponClass: "light_weapon",
        muzzleSignature: 1.35,
        mutexGroup: "turret_loader",
        mutexLockSec: 1,
      },
      {
        id: "hull_mg",
        name: "7.62mm Hull MG",
        ammo: "AP",
        pen: 1.2,
        damage: 5,
        suppression: 7,
        range: 600,
        reloadSec: 1,
        accuracy: 0.65,
        weaponClass: "small_arms",
        muzzleSignature: 0.9,
      },
    ],
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
    range: 600,
    spot: 1200,
    baseSpeedKmH: 4,
    armor: SOFT_ARMOR,
    weapons: [],
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
    range: 2500,
    spot: 2500,
    baseSpeedKmH: 4,
    armor: SOFT_ARMOR,
    weapons: [],
  },
};

function createDefaultSubRoster(type: UnitType): InfantrySubRoster | undefined {
  if (type === "infantry") {
    const weapons: InfantryWeaponSlot[] = [
      {
        id: "at_launcher",
        isSpecial: true,
        requiredRole: "at_specialist",
        abandonPriority: 1,
        unskilledPenalty: 0.55,
        cooldown: 0,
        weapon: {
          id: "at_launcher",
          name: "AT Launcher",
          ammo: "HEAT",
          pen: 12,
          damage: 26,
          suppression: 14,
          range: 500,
          reloadSec: 6,
          accuracy: 0.72,
          weaponClass: "heavy_weapon",
          muzzleSignature: 1.4,
        },
      },
      {
        id: "lmg",
        isSpecial: true,
        requiredRole: "mg_specialist",
        abandonPriority: 2,
        unskilledPenalty: 0.7,
        cooldown: 0,
        weapon: {
          id: "lmg",
          name: "Light MG",
          ammo: "HE",
          pen: 2,
          d0: 1.5,
          damage: 5,
          suppression: 11,
          range: 600,
          reloadSec: 1,
          accuracy: 0.65,
          weaponClass: "small_arms",
          muzzleSignature: 1.0,
        },
      },
    ];
    for (let i = 1; i <= 6; i++) {
      weapons.push({
        id: `rifle_${i}`,
        isSpecial: false,
        requiredRole: "rifleman",
        abandonPriority: 99,
        unskilledPenalty: 1.0,
        cooldown: 0,
        weapon: {
          id: `rifle_${i}`,
          name: "Assault Rifle",
          ammo: "AP",
          pen: 1,
          damage: 2.2,
          suppression: 3,
          range: 450,
          reloadSec: 1,
          accuracy: 0.62,
          weaponClass: "small_arms",
          muzzleSignature: 0.9,
        },
      });
    }
    return {
      personnel: { rifleman: 6, mg_specialist: 1, at_specialist: 1, marksman: 0, engineer: 0 },
      weapons,
      abandonedWeapons: [],
    };
  }
  if (type === "atgm") {
    const weapons: InfantryWeaponSlot[] = [
      {
        id: "atgm_launcher",
        isSpecial: true,
        requiredRole: "at_specialist",
        abandonPriority: 1,
        unskilledPenalty: 0.55,
        cooldown: 0,
        weapon: {
          id: "atgm_launcher",
          name: "ATGM Launcher",
          ammo: "HEAT",
          pen: 18,
          damage: 34,
          suppression: 16,
          range: 2500,
          reloadSec: 8,
          accuracy: 0.78,
          weaponClass: "heavy_weapon",
          muzzleSignature: 1.5,
        },
      },
    ];
    for (let i = 1; i <= 3; i++) {
      weapons.push({
        id: `carbine_${i}`,
        isSpecial: false,
        requiredRole: "rifleman",
        abandonPriority: 99,
        unskilledPenalty: 1.0,
        cooldown: 0,
        weapon: {
          id: `carbine_${i}`,
          name: "Carbine",
          ammo: "AP",
          pen: 1,
          damage: 2,
          suppression: 3,
          range: 400,
          reloadSec: 1,
          accuracy: 0.6,
          weaponClass: "small_arms",
          muzzleSignature: 0.8,
        },
      });
    }
    return {
      personnel: { rifleman: 2, mg_specialist: 0, at_specialist: 2, marksman: 0, engineer: 0 },
      weapons,
      abandonedWeapons: [],
    };
  }
  return undefined;
}

export interface Unit {
  id: string;
  side: Side;
  type: UnitType;
  pos: Vec;
  prevPos: Vec;
  heading: number; // radians (0 = East, Math.PI/2 = North)
  prevHeading: number;
  strength: number;
  suppression: number;
  morale: number;
  roe: Roe;
  order: Order;
  state: BotState;
  commander?: string;
  target?: string;
  lastFiredAt: number;
  lastHitAt: number;
  rally?: Vec;
  mobility: MobilityClass;
  traits: UnitTrait[];
  headcount: number;
  eyeHeight: number;
  baseSignature: number;
  weaponClass: WeaponSignatureClass;
  muzzleSignature: number;
  garrison?: UnitGarrison;
  settledTicks: number;
  stuckTicks: number;
  embarkedIn?: string;
  embarkedIds: string[];
  activeMoraleEvents: MoraleEventKind[];
  ownPerception: Map<string, OwnPerceptionLevel>;
  armor: ArmorProfile;
  weapons: WeaponSlot[];
  mutexCooldowns: Map<string, number>;
  subRoster?: InfantrySubRoster;
}

export interface CombatShotEvent {
  id: number;
  t: number;
  shooterId: string;
  targetId?: string;
  from: Vec;
  fromZ: number;
  to: Vec;
  toZ: number;
  ammo: AmmoType;
  weaponClass: WeaponSignatureClass;
  hit: boolean;
  penetrated: boolean;
  hitAspect?: ArmorAspect;
  damageDealt: number;
  blastRadius?: number;
  guttedFloor?: number;
}

export interface SupplyNode {
  id: string;
  side: Side;
  pos: Vec;
  radius: number;
}

export interface Contact {
  id: string;
  level: DetectionLevel;
  type?: UnitType;
  weaponClass?: WeaponSignatureClass;
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
  armor: ArmorProfile;
  morale: number;
  moraleTier: MoraleTier;
  cowering: boolean;
  suppression: number;
  activeMoraleEvents: MoraleEventKind[];
  embarkedIn?: string;
  embarkedIds: string[];
  weaponSlots: { id: string; name: string; ammo: AmmoType; cooldown: number; mutexGroup?: string; mutexLocked: boolean }[];
  subRoster?: {
    personnel: Record<SpecialistRole, number>;
    assignments: { weaponId: string; role: SpecialistRole; crossManned: boolean; efficiency: number }[];
    abandoned: string[];
  };
}

export type EventKind =
  | "contact" | "under_fire" | "pinned" | "recovered" | "casualties"
  | "arrived" | "broken" | "destroyed" | "enemy_destroyed";
export interface SimEvent { t: number; kind: EventKind; unit: string; text: string }

const SETTLE_THRESHOLD_TICKS = 15;
const MUZZLE_FLASH_WINDOW = 2;
const FRIENDLY_CONTACT_SHARE_WINDOW = 15;
const COMBAT_FEAT_WINDOW = 12;
const ARTILLERY_SHOCK_WINDOW = 10;
export const MORALE_WORRIED_MIDPOINT = 62.5;
export const MORALE_SHAKEN_MIDPOINT = 37.5;
const COWERING_SIG_MULT = 0.65;
const COWERING_OPTICS_MULT = 0.6;
const COWERING_COVER_DMG_MULT = 0.7;

export function getMoraleTier(morale: number): MoraleTier {
  if (morale >= 75) return "calm";
  if (morale >= 50) return "worried";
  if (morale >= 25) return "shaken";
  return "panicked";
}

export function isCowering(u: Pick<Unit, "morale">): boolean {
  const tier = getMoraleTier(u.morale);
  return tier === "shaken" || tier === "panicked";
}

export const OWN_PERCEPTION_ACCURACY: Record<OwnPerceptionLevel, number> = {
  none: 0.25,
  contact: 0.7,
  visual: 1.0,
};

const WEAPON_CLASS_RANK: Record<WeaponSignatureClass, number> = {
  small_arms: 1,
  light_weapon: 2,
  heavy_weapon: 3,
};

const SPECIALIST_ROLES: readonly SpecialistRole[] = [
  "rifleman", "mg_specialist", "at_specialist", "marksman", "engineer",
];

function higherWeaponClass(a?: WeaponSignatureClass, b?: WeaponSignatureClass): WeaponSignatureClass | undefined {
  if (!a) return b;
  if (!b) return a;
  return WEAPON_CLASS_RANK[a] >= WEAPON_CLASS_RANK[b] ? a : b;
}

export function normalizeAngle(rad: number): number {
  let a = rad % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function resolveImpactAspect(targetPos: Vec, targetHeading: number, shooterPos: Vec): "front" | "side" | "rear" {
  const angToShooter = Math.atan2(shooterPos.y - targetPos.y, shooterPos.x - targetPos.x);
  const delta = Math.abs(normalizeAngle(angToShooter - targetHeading));
  if (delta <= Math.PI / 4) return "front";
  if (delta >= (3 * Math.PI) / 4) return "rear";
  return "side";
}

export function computeApPenetration(basePen: number, distance: number, maxRange: number): number {
  return basePen * Math.max(0.5, 1 - 0.35 * (distance / Math.max(1, maxRange)));
}

export function computeHeZoneDistances(
  targetPos: Vec,
  targetHeading: number,
  blastPos: Vec,
  blastHeightOffset = 0,
  armored = true,
): Record<ArmorAspect, number> {
  const L = armored ? 3.2 : 1.0;
  const W = armored ? 1.6 : 1.0;
  const H = armored ? 2.5 : 1.5;
  const dx = blastPos.x - targetPos.x;
  const dy = blastPos.y - targetPos.y;
  const cos = Math.cos(-targetHeading);
  const sin = Math.sin(-targetHeading);
  const fx = dx * cos - dy * sin;
  const sy = dx * sin + dy * cos;
  const clampBox = (v: number, lim: number) => Math.max(0, Math.abs(v) - lim);
  const clampZ = (z: number) => (z < 0 ? -z : z > H ? z - H : 0);

  return {
    front: Math.hypot(fx - L, clampBox(sy, W), clampZ(blastHeightOffset)),
    rear: Math.hypot(fx + L, clampBox(sy, W), clampZ(blastHeightOffset)),
    side: Math.hypot(clampBox(fx, L), Math.abs(Math.abs(sy) - W), clampZ(blastHeightOffset)),
    top: Math.hypot(clampBox(fx, L), clampBox(sy, W), blastHeightOffset - H),
  };
}

export function evaluateHePenetration(
  armor: ArmorProfile,
  targetPos: Vec,
  targetHeading: number,
  blastPos: Vec,
  blastHeightOffset: number,
  penContact: number,
  d0: number,
  armored = true,
): { penetrated: boolean; bestZone: ArmorAspect; bestPen: number; distances: Record<ArmorAspect, number> } {
  const distances = computeHeZoneDistances(targetPos, targetHeading, blastPos, blastHeightOffset, armored);
  const safeD0 = Math.max(0.5, d0);
  let penetrated = false;
  let bestZone: ArmorAspect = "top";
  let bestMargin = -Infinity;
  let bestPen = 0;

  for (const zone of ["front", "side", "rear", "top"] as const) {
    const dz = distances[zone];
    const pen = penContact / (1 + (dz / safeD0) ** 2);
    const margin = pen - armor[zone].ke;
    if (margin >= 0) penetrated = true;
    if (margin > bestMargin) {
      bestMargin = margin;
      bestZone = zone;
      bestPen = pen;
    }
  }
  return { penetrated, bestZone, bestPen, distances };
}

function cloneArmor(a: ArmorProfile): ArmorProfile {
  return { front: { ...a.front }, side: { ...a.side }, rear: { ...a.rear }, top: { ...a.top } };
}

function cloneWeapons(ws: ReadonlyArray<Omit<WeaponSlot, "cooldown">>): WeaponSlot[] {
  return ws.map((w) => ({ ...w, cooldown: 0 }));
}

export class World {
  t = 0; // game seconds
  units: Unit[] = [];
  contacts: Record<Side, Map<string, Contact>> = { blue: new Map(), red: new Map() };
  events: SimEvent[] = [];
  shotEvents: CombatShotEvent[] = [];
  supplyNodes: SupplyNode[] = [];
  private listeners: ((e: SimEvent) => void)[] = [];
  private random: () => number;
  private casualtyMarks = new Map<string, number>();
  private underFireReported = new Map<string, number>();
  private combatFeatUntil: Record<Side, number> = { blue: -1e9, red: -1e9 };
  private artilleryShockUntil = new Map<string, number>();
  private shotSeq = 0;

  constructor(readonly map: GameMap, seed = 1) { this.random = rng(seed); }

  private pushShotEvent(ev: Omit<CombatShotEvent, "id">) {
    this.shotEvents.push({ id: ++this.shotSeq, ...ev });
    if (this.shotEvents.length > 256) this.shotEvents.splice(0, this.shotEvents.length - 256);
  }

  addSupplyNode(node: SupplyNode) { this.supplyNodes.push(node); }

  on(fn: (e: SimEvent) => void) { this.listeners.push(fn); }
  private emit(kind: EventKind, u: Unit, text: string) {
    const e = { t: this.t, kind, unit: u.id, text };
    this.events.push(e);
    this.listeners.forEach((fn) => fn(e));
  }

  add(
    u: Omit<
      Unit,
      | "prevPos" | "heading" | "prevHeading" | "strength" | "suppression" | "morale" | "state" | "lastFiredAt" | "lastHitAt" | "roe" | "order"
      | "mobility" | "traits" | "headcount" | "eyeHeight" | "baseSignature" | "weaponClass" | "muzzleSignature"
      | "settledTicks" | "stuckTicks" | "embarkedIds" | "activeMoraleEvents"
      | "ownPerception" | "armor" | "weapons" | "mutexCooldowns"
    > & Partial<Unit>,
  ) {
    const st = STATS[u.type];
    const heading = u.heading ?? (u.side === "blue" ? 0 : Math.PI);
    const unit: Unit = {
      prevPos: { ...u.pos },
      heading,
      prevHeading: heading,
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
      stuckTicks: 0,
      embarkedIds: [],
      activeMoraleEvents: [],
      ownPerception: new Map(),
      armor: cloneArmor(st.armor),
      weapons: cloneWeapons(st.weapons),
      mutexCooldowns: new Map(),
      subRoster: createDefaultSubRoster(u.type),
      ...u,
    };
    this.units.push(unit);
    return unit;
  }

  get(id: string) { return this.units.find((u) => u.id.toLowerCase() === id.trim().toLowerCase()); }
  alive(side?: Side) { return this.units.filter((u) => u.state !== "destroyed" && (!side || u.side === side)); }

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
    if (dist(u.pos, bld.center) <= 25) return this.garrisonFloor(u, buildingId, level);
    return this.command(u, {
      kind: "move",
      dest: { ...bld.center },
      destName: `${buildingId} F${level}`,
      garrison: { buildingId, floorLevel: level },
    });
  }

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

  private baseCoverModifiers(u: Unit): CombatModifiers {
    return this.unitFloor(u)?.modifiers ?? this.map.getTerrainModifiers(u.pos, u.traits);
  }

  unitModifiers(u: Unit): CombatModifiers {
    const base = this.baseCoverModifiers(u);
    if (!isCowering(u)) return base;
    return {
      ...base,
      damageMult: (base.damageMult ?? 1) * COWERING_COVER_DMG_MULT,
    };
  }

  effectiveSpotRange(u: Unit): number {
    return STATS[u.type].spot * (isCowering(u) ? COWERING_OPTICS_MULT : 1.0);
  }

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
    const cowerMult = isCowering(u) ? COWERING_SIG_MULT : 1.0;
    return u.baseSignature * terBase * sigMult * moveMult * cowerMult;
  }

  /** Embark an infantry unit onto a friendly APC/IFV transport. */
  embark(passenger: Unit, transport: Unit): string {
    if (passenger.state === "destroyed" || transport.state === "destroyed") return "unit destroyed";
    if (!passenger.traits.includes("infantry")) return `${passenger.id} is not infantry`;
    if (passenger.side !== transport.side) return "cannot embark on enemy vehicle";
    const cap = STATS[transport.type].passengerCapacity ?? 0;
    if (cap <= 0) return `${transport.id} has no passenger capacity`;
    if (transport.embarkedIds.length >= cap) return `${transport.id} is full`;
    if (passenger.embarkedIn) this.disembark(passenger);
    if (passenger.garrison) this.vacateBuilding(passenger);
    passenger.embarkedIn = transport.id;
    passenger.pos = { ...transport.pos };
    passenger.order = { kind: "hold" };
    passenger.state = "holding";
    transport.embarkedIds.push(passenger.id);
    return "ok";
  }

  /** Disembark a passenger unit from its current transport. */
  disembark(passenger: Unit): string {
    if (!passenger.embarkedIn) return "not embarked";
    const tr = this.get(passenger.embarkedIn);
    if (tr) {
      tr.embarkedIds = tr.embarkedIds.filter((id) => id !== passenger.id);
      passenger.pos = { ...tr.pos };
    }
    passenger.embarkedIn = undefined;
    return "ok";
  }

  // ---------- InfantrySubRoster casualty & assignment ----------
  reconcileSubRoster(u: Unit) {
    const roster = u.subRoster;
    if (!roster) return;
    const living = SPECIALIST_ROLES.reduce((s, r) => s + Math.max(0, roster.personnel[r] ?? 0), 0);
    u.headcount = living;

    const specials = roster.weapons
      .filter((w) => w.isSpecial)
      .sort((a, b) => a.abandonPriority - b.abandonPriority);
    const primaries = roster.weapons.filter((w) => !w.isSpecial);

    // Rule 2 & 4: Drop primary rifles first when headcount shrinks; abandon excess specials in ascending abandonPriority
    const keptSpecials = specials.slice(0, living);
    for (const dropped of specials.slice(living)) {
      if (!roster.abandonedWeapons.includes(dropped.id)) roster.abandonedWeapons.push(dropped.id);
    }
    const maxPrimaries = Math.max(0, living - keptSpecials.length);
    const keptPrimaries = primaries.slice(0, maxPrimaries);
    for (const dropped of primaries.slice(maxPrimaries)) {
      if (!roster.abandonedWeapons.includes(dropped.id)) roster.abandonedWeapons.push(dropped.id);
    }
    roster.weapons = [...keptSpecials, ...keptPrimaries];
  }

  assignInfantryWeapons(u: Unit): AssignedInfantryWeapon[] {
    const roster = u.subRoster;
    if (!roster) return [];
    const avail: Record<SpecialistRole, number> = { ...roster.personnel };
    const specials = roster.weapons.filter((w) => w.isSpecial).sort((a, b) => a.abandonPriority - b.abandonPriority);
    const primaries = roster.weapons.filter((w) => !w.isSpecial);
    const assigned: AssignedInfantryWeapon[] = [];

    const takeAnySoldier = (): SpecialistRole | undefined => {
      if (avail.rifleman > 0) { avail.rifleman--; return "rifleman"; }
      for (const r of SPECIALIST_ROLES) {
        if (avail[r] > 0) { avail[r]--; return r; }
      }
      return undefined;
    };

    const unassignedSpecials: InfantryWeaponSlot[] = [];
    // Rule 1: matching specialist operates special weapon at 100% efficiency
    for (const w of specials) {
      if (w.requiredRole && avail[w.requiredRole] > 0) {
        avail[w.requiredRole]--;
        assigned.push({ slot: w, operatorRole: w.requiredRole, crossManned: false, efficiency: 1.0 });
      } else {
        unassignedSpecials.push(w);
      }
    }
    // Rule 3: missing specialist triggers cross-manning with unskilledPenalty
    for (const w of unassignedSpecials) {
      const role = takeAnySoldier();
      if (!role) break;
      assigned.push({ slot: w, operatorRole: role, crossManned: true, efficiency: w.unskilledPenalty });
    }
    // Remaining living soldiers operate primary rifles
    for (const w of primaries) {
      const role = takeAnySoldier();
      if (!role) break;
      assigned.push({ slot: w, operatorRole: role, crossManned: false, efficiency: 1.0 });
    }
    return assigned;
  }

  /** Deterministically inflict casualties on a specific specialist role (syncs headcount & strength). */
  inflictRosterCasualty(u: Unit, role: SpecialistRole, count = 1): boolean {
    const roster = u.subRoster;
    if (!roster || (roster.personnel[role] ?? 0) <= 0) return false;
    const lost = Math.min(count, roster.personnel[role]);
    roster.personnel[role] -= lost;
    this.reconcileSubRoster(u);
    const baseCount = Math.max(1, STATS[u.type].headcount);
    u.strength = Math.max(0, (u.headcount / baseCount) * 100);
    if (u.headcount <= 0) {
      this.vacateBuilding(u);
      u.state = "destroyed";
    }
    return true;
  }

  private syncRosterCasualtiesFromStrength(u: Unit) {
    const roster = u.subRoster;
    if (!roster) return;
    const baseCount = STATS[u.type].headcount;
    if (baseCount <= 0) return;
    const targetLiving = u.state === "destroyed" ? 0 : Math.max(1, Math.ceil((u.strength / 100) * baseCount));
    let living = SPECIALIST_ROLES.reduce((s, r) => s + roster.personnel[r], 0);
    while (living > targetLiving) {
      const pool: SpecialistRole[] = [];
      for (const r of SPECIALIST_ROLES) {
        for (let i = 0; i < roster.personnel[r]; i++) pool.push(r);
      }
      if (pool.length === 0) break;
      const pick = pool[Math.floor(this.random() * pool.length)];
      roster.personnel[pick] -= 1;
      living--;
    }
    this.reconcileSubRoster(u);
  }

  getUnitTelemetry(u: Unit): UnitTelemetry {
    const floor = this.unitFloor(u);
    const assignments = u.subRoster ? this.assignInfantryWeapons(u) : undefined;
    const weaponSlots = u.subRoster
      ? u.subRoster.weapons.map((w) => ({
          id: w.id,
          name: w.weapon.name,
          ammo: w.weapon.ammo,
          cooldown: w.cooldown,
          mutexGroup: w.weapon.mutexGroup,
          mutexLocked: false,
        }))
      : u.weapons.map((w) => ({
          id: w.id,
          name: w.name,
          ammo: w.ammo,
          cooldown: w.cooldown,
          mutexGroup: w.mutexGroup,
          mutexLocked: !!w.mutexGroup && (u.mutexCooldowns.get(w.mutexGroup) ?? 0) > 0,
        }));
    return {
      bodySignature: this.computeBodySignature(u),
      terrainId: this.map.terrainIdAt(u.pos),
      modifiers: this.unitModifiers(u),
      garrison: floor && u.garrison ? { ...u.garrison, elevationOffset: floor.elevationOffset } : undefined,
      ownPerception: [...u.ownPerception.entries()].map(([targetId, level]) => ({ targetId, level })),
      armor: u.armor,
      morale: u.morale,
      moraleTier: getMoraleTier(u.morale),
      cowering: isCowering(u),
      suppression: u.suppression,
      activeMoraleEvents: [...u.activeMoraleEvents],
      embarkedIn: u.embarkedIn,
      embarkedIds: [...u.embarkedIds],
      weaponSlots,
      subRoster: u.subRoster && assignments
        ? {
            personnel: { ...u.subRoster.personnel },
            assignments: assignments.map((a) => ({
              weaponId: a.slot.id,
              role: a.operatorRole,
              crossManned: a.crossManned,
              efficiency: a.efficiency,
            })),
            abandoned: [...u.subRoster.abandonedWeapons],
          }
        : undefined,
    };
  }

  step() {
    this.t += 1;
    for (const u of this.units) {
      u.prevPos = { ...u.pos };
      u.prevHeading = u.heading;
    }
    const live = this.alive();
    this.spot(live);
    for (const u of live) this.tickCooldowns(u);
    for (const u of live) this.fire(u);
    for (const u of live) this.bot(u);
  }

  private moraleRofRate(u: Unit): number {
    return 0.5 + 0.5 * (u.morale / 100);
  }

  private tickCooldowns(u: Unit) {
    const rate = this.moraleRofRate(u);
    for (const w of u.weapons) {
      if (w.cooldown > 0) w.cooldown = Math.max(0, w.cooldown - rate);
    }
    for (const [grp, cd] of u.mutexCooldowns) {
      const next = cd - rate;
      if (next <= 0) u.mutexCooldowns.delete(grp);
      else u.mutexCooldowns.set(grp, next);
    }
    if (u.subRoster) {
      for (const w of u.subRoster.weapons) {
        if (w.cooldown > 0) w.cooldown = Math.max(0, w.cooldown - rate);
      }
    }
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
    const spotRange = this.effectiveSpotRange(o);
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
        if (e.side === side || e.embarkedIn) continue;
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

  // ---------- Phase 2B direct-fire combat, accuracy tiers, armor & penetration ----------
  computeSlotHitChance(attacker: Unit, slot: Pick<WeaponSlot, "accuracy" | "range">, target: Unit, distance: number, efficiency = 1.0): number {
    const perc = attacker.ownPerception.get(target.id) ?? "none";
    const opticsMult = OWN_PERCEPTION_ACCURACY[perc];
    const attMods = this.unitModifiers(attacker);
    const stateMult = attacker.state === "moving" ? 0.65 : attacker.state === "pinned" ? 0.45 : 1.0;
    const suppMult = Math.max(0.25, 1 - attacker.suppression / 160);
    const moraleAccMult = 0.5 + 0.5 * (attacker.morale / 100);
    const rangeMult = Math.max(0.5, 1 - 0.35 * (distance / Math.max(1, slot.range)));
    const raw =
      slot.accuracy *
      opticsMult *
      efficiency *
      moraleAccMult *
      (attacker.strength / 100) *
      suppMult *
      stateMult *
      (attMods.attackMult ?? 1) *
      rangeMult;
    return Math.min(0.95, Math.max(0.04, raw));
  }

  private maxWeaponRange(u: Unit): number {
    if (u.subRoster) {
      const r = u.subRoster.weapons.reduce((m, w) => Math.max(m, w.weapon.range), 0);
      return u.embarkedIn ? Math.min(r * 0.5, 300) : r;
    }
    return u.weapons.reduce((m, w) => Math.max(m, w.range), STATS[u.type].range);
  }

  private selectTarget(u: Unit): Unit | undefined {
    const maxR = this.maxWeaponRange(u);
    let target: Unit | undefined;
    let best = Infinity;
    for (const e of this.alive()) {
      if (e.side === u.side || e.embarkedIn) continue;
      const d = dist(u.pos, e.pos);
      if (d > maxR) continue;
      const own = u.ownPerception.get(e.id) ?? "none";
      if (own === "none") {
        const shared = this.contacts[u.side].get(e.id);
        if (!shared || this.t - shared.seenAt > FRIENDLY_CONTACT_SHARE_WINDOW) continue;
        if (this.sightlineBetween(u, e).blocked) continue;
      }
      const score = e.id === u.target ? d * 0.5 : d;
      if (score < best) { best = score; target = e; }
    }
    return target;
  }

  private selectVehicleSlotsToFire(u: Unit, target: Unit, d: number): WeaponSlot[] {
    const ready = u.weapons.filter(
      (w) => w.cooldown <= 0 && (!w.mutexGroup || (u.mutexCooldowns.get(w.mutexGroup) ?? 0) <= 0) && d <= w.range,
    );
    const chosen: WeaponSlot[] = [];
    const seenMutex = new Set<string>();
    const tgtArmored = target.traits.includes("armored");

    for (const w of ready) {
      if (!w.mutexGroup) {
        chosen.push(w);
        continue;
      }
      if (seenMutex.has(w.mutexGroup)) continue;
      seenMutex.add(w.mutexGroup);
      const group = ready.filter((x) => x.mutexGroup === w.mutexGroup);
      group.sort((a, b) => {
        const score = (s: WeaponSlot) => {
          if (tgtArmored) return (s.ammo === "AP" || s.ammo === "HEAT" ? 100 : 10) + s.pen;
          return (s.ammo === "HE" ? 100 : s.ammo === "AP" && s.pen < 3 ? 60 : 20) + s.damage;
        };
        return score(b) - score(a);
      });
      chosen.push(group[0]);
    }
    return chosen;
  }

  private evaluateArmorPenetration(
    slot: Pick<WeaponSlot, "ammo" | "pen" | "d0" | "range">,
    attacker: Unit,
    target: Unit,
    d: number,
    hit: boolean,
  ): { penetrated: boolean; hitAspect?: ArmorAspect; blastPos: Vec } {
    if (slot.ammo === "HE") {
      const blastPos = hit
        ? { ...target.pos }
        : { x: target.pos.x + (this.random() - 0.5) * 6, y: target.pos.y + (this.random() - 0.5) * 6 };
      const res = evaluateHePenetration(
        target.armor,
        target.pos,
        target.heading,
        blastPos,
        0,
        slot.pen,
        slot.d0 ?? 3,
        target.traits.includes("armored"),
      );
      return { penetrated: res.penetrated, hitAspect: res.bestZone, blastPos };
    }
    if (!hit) return { penetrated: false, blastPos: { ...target.pos } };
    const aspect = resolveImpactAspect(target.pos, target.heading, attacker.pos);
    if (slot.ammo === "AP") {
      return { penetrated: computeApPenetration(slot.pen, d, slot.range) >= target.armor[aspect].ke, hitAspect: aspect, blastPos: { ...target.pos } };
    }
    return { penetrated: slot.pen >= target.armor[aspect].ce, hitAspect: aspect, blastPos: { ...target.pos } };
  }

  private evaluateBuildingArmorPenetration(slot: Pick<WeaponSlot, "ammo" | "pen" | "range">, buildingArmor: ArmorValue, d: number): boolean {
    if (slot.ammo === "HEAT") return slot.pen >= buildingArmor.ce;
    if (slot.ammo === "AP") return computeApPenetration(slot.pen, d, slot.range) >= buildingArmor.ke;
    return slot.pen >= buildingArmor.ke;
  }

  private fire(u: Unit) {
    if (u.roe === "hold_fire" || u.state === "broken") return;
    if (u.roe === "return_fire" && this.t - u.lastHitAt > 30) return;

    const transport = u.embarkedIn ? this.get(u.embarkedIn) : undefined;
    if (u.embarkedIn) {
      if (!transport || transport.state === "destroyed" || !STATS[transport.type].hasFiringPorts) {
        u.target = undefined;
        return;
      }
      u.pos = { ...transport.pos };
    }

    const target = this.selectTarget(u);
    u.target = target?.id;
    if (!target) return;

    const d = dist(u.pos, target.pos);
    if (!transport && u.state !== "moving") u.heading = Math.atan2(target.pos.y - u.pos.y, target.pos.x - u.pos.x);

    const shots: {
      slot: Omit<WeaponSlot, "cooldown">;
      efficiency: number;
      onFired: () => void;
    }[] = [];

    if (u.subRoster) {
      for (const a of this.assignInfantryWeapons(u)) {
        if (transport && a.slot.weapon.weaponClass === "heavy_weapon") continue; // no backblast weapons from firing ports
        const effRange = transport ? Math.min(a.slot.weapon.range * 0.5, 300) : a.slot.weapon.range;
        const portMult = transport ? 0.5 : 1.0;
        if (a.slot.cooldown <= 0 && d <= effRange) {
          shots.push({
            slot: { ...a.slot.weapon, range: effRange },
            efficiency: a.efficiency * portMult,
            onFired: () => {
              a.slot.cooldown = Math.ceil(a.slot.weapon.reloadSec / Math.max(0.25, a.efficiency));
            },
          });
        }
      }
    } else if (!transport) {
      for (const w of this.selectVehicleSlotsToFire(u, target, d)) {
        shots.push({
          slot: w,
          efficiency: 1.0,
          onFired: () => {
            w.cooldown = w.reloadSec;
            if (w.mutexGroup) u.mutexCooldowns.set(w.mutexGroup, w.mutexLockSec ?? w.reloadSec);
          },
        });
      }
    }

    if (shots.length === 0) return;

    let highestClass: WeaponSignatureClass | undefined;
    let maxMuzzle = 0;
    for (const s of shots) {
      s.onFired();
      highestClass = higherWeaponClass(highestClass, s.slot.weaponClass);
      if (s.slot.muzzleSignature > maxMuzzle) maxMuzzle = s.slot.muzzleSignature;
    }
    u.lastFiredAt = this.t;
    if (highestClass) u.weaponClass = highestClass;
    if (maxMuzzle > 0) u.muzzleSignature = maxMuzzle;

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

    const targetMods = this.unitModifiers(target);
    const fromZ = this.map.elevationAt(u.pos) + this.unitEyeHeight(u);
    const targetH = target.garrison ? this.unitEyeHeight(target) : target.traits.includes("armored") ? 1.4 : 0.8;
    for (const s of shots) {
      if (target.state === "destroyed") break;
      const hitChance = this.computeSlotHitChance(u, s.slot, target, d, s.efficiency);
      const hit = this.random() <= hitChance;
      const { penetrated, hitAspect, blastPos } = this.evaluateArmorPenetration(s.slot, u, target, d, hit);

      let dmg = 0;
      let supp = 0;
      if (penetrated) {
        dmg = s.slot.damage * (0.85 + 0.3 * this.random()) * (targetMods.damageMult ?? 1);
        supp = s.slot.suppression * (targetMods.suppressionMult ?? 1);
      } else if (hit || s.slot.ammo === "HE") {
        // Non-penetration: 0 HP damage, suppression only
        supp = s.slot.suppression * (target.traits.includes("armored") ? 0.5 : 0.8) * (targetMods.suppressionMult ?? 1);
      } else {
        supp = s.slot.suppression * 0.15 * (targetMods.suppressionMult ?? 1);
      }

      let guttedFloor: number | undefined;
      if (hit && target.garrison) {
        const bld = this.map.buildings.find((b) => b.id === target.garrison!.buildingId);
        const floor = bld?.floors.find((f) => f.level === target.garrison!.floorLevel);
        if (bld && floor && floor.state !== "gutted") {
          const bldArmor = bld.armor ?? DEFAULT_BUILDING_ARMOR;
          if (this.evaluateBuildingArmorPenetration(s.slot, bldArmor, d)) {
            floor.integrity = Math.max(0, floor.integrity - Math.max(4, s.slot.damage * 0.45));
            if (floor.integrity <= 0) {
              const gut = this.map.gutBuildingFloor(bld.id, floor.level);
              if (gut) {
                guttedFloor = gut.level;
                for (const occId of gut.evictedOccupants) {
                  const occ = this.get(occId);
                  if (occ && occ.state !== "destroyed") {
                    occ.garrison = undefined;
                    this.hit(occ, gut.casualtyDamage, gut.suppressionShock, u);
                  }
                }
              }
            }
          }
        }
      }

      this.pushShotEvent({
        t: this.t,
        shooterId: u.id,
        targetId: target.id,
        from: { ...u.pos },
        fromZ,
        to: blastPos,
        toZ: this.map.elevationAt(blastPos) + targetH,
        ammo: s.slot.ammo,
        weaponClass: s.slot.weaponClass,
        hit,
        penetrated,
        hitAspect,
        damageDealt: dmg,
        blastRadius: s.slot.ammo === "HE" ? (s.slot.d0 ?? 3) : undefined,
        guttedFloor,
      });

      this.hit(target, dmg, supp, u);
    }
  }

  /** Cover-linked suppression resistance: reduces incoming suppression based on (1 - cover damageMult). */
  computeSuppressionResistance(u: Unit): number {
    const baseDmgMult = this.baseCoverModifiers(u).damageMult ?? 1;
    const coverReduction = Math.max(0, Math.min(0.85, 1 - baseDmgMult));
    return 1 - 0.6 * coverReduction;
  }

  /** Apply an HE indirect blast (supports Phase 2C ArtilleryShockPenalty and Phase 3 artillery). */
  applyHeArtilleryBlast(
    blastPos: Vec,
    penContact: number,
    d0: number,
    yieldDamage = 35,
    yieldSuppression = 45,
    blastHeightOffset = 0,
    by?: Unit,
  ) {
    const maxRadius = Math.max(20, d0 * 6);
    let totalDmg = 0;
    let anyPen = false;
    for (const u of this.alive()) {
      if (u.embarkedIn) continue;
      const d = dist(u.pos, blastPos);
      if (d > maxRadius) continue;
      const falloff = 1 / (1 + (d / Math.max(0.5, d0)) ** 2);
      const mods = this.unitModifiers(u);
      const isOpenUnarmored = !u.traits.includes("armored") && !u.garrison && this.map.terrainIdAt(u.pos) === "open";

      if (isOpenUnarmored) {
        const supp = yieldSuppression * falloff;
        const shock = yieldDamage * falloff * 1.4;
        const hp = yieldDamage * falloff * 0.5;
        totalDmg += hp;
        anyPen = true;
        this.artilleryShockUntil.set(u.id, this.t + ARTILLERY_SHOCK_WINDOW);
        if (!u.activeMoraleEvents.includes("ArtilleryShockPenalty")) {
          u.activeMoraleEvents.push("ArtilleryShockPenalty");
        }
        this.hit(u, hp, supp, by, { unboundedMoraleDrain: shock });
      } else {
        const penRes = evaluateHePenetration(
          u.armor,
          u.pos,
          u.heading,
          blastPos,
          blastHeightOffset,
          penContact,
          d0,
          u.traits.includes("armored"),
        );
        if (penRes.penetrated) anyPen = true;
        const dmg = penRes.penetrated ? yieldDamage * falloff * (mods.damageMult ?? 1) : 0;
        const supp = yieldSuppression * falloff * (mods.suppressionMult ?? 1);
        totalDmg += dmg;
        this.hit(u, dmg, supp, by);
      }
    }
    const groundZ = this.map.elevationAt(blastPos);
    this.pushShotEvent({
      t: this.t,
      shooterId: by?.id ?? "Artillery",
      from: { x: blastPos.x - 40, y: blastPos.y },
      fromZ: groundZ + 120 + blastHeightOffset,
      to: { ...blastPos },
      toZ: groundZ + blastHeightOffset,
      ammo: "HE",
      weaponClass: "heavy_weapon",
      hit: true,
      penetrated: anyPen,
      damageDealt: totalDmg,
      blastRadius: d0,
    });
  }

  private hit(u: Unit, dmg: number, supp: number, by?: Unit, opts?: { unboundedMoraleDrain?: number }) {
    if (u.state === "destroyed") return;
    const resistedSupp = supp * this.computeSuppressionResistance(u);
    u.strength = Math.max(0, u.strength - dmg);
    u.suppression = Math.min(100, u.suppression + resistedSupp);
    u.lastHitAt = this.t;

    if (opts?.unboundedMoraleDrain !== undefined) {
      u.morale = Math.max(0, u.morale - opts.unboundedMoraleDrain);
    } else if (dmg > 0) {
      u.morale = Math.max(0, u.morale - dmg * 0.6);
      if (by) this.combatFeatUntil[by.side] = this.t + COMBAT_FEAT_WINDOW;
    } else if (resistedSupp > 0 && u.morale > MORALE_SHAKEN_MIDPOINT) {
      // SuppressionFloor: non-damaging suppression cannot push morale below shaken midpoint
      u.morale = Math.max(MORALE_SHAKEN_MIDPOINT, u.morale - resistedSupp * 0.25);
    }

    // Vehicle minor patch: proportional damage & suppression transfer to embarked passengers
    if (u.embarkedIds.length > 0) {
      for (const pid of [...u.embarkedIds]) {
        const passenger = this.get(pid);
        if (passenger && passenger.state !== "destroyed") {
          this.hit(passenger, dmg * 0.35, resistedSupp * 0.5, by);
        }
      }
    }

    if (by) {
      const sideKnown = this.contacts[u.side].get(by.id);
      if (!sideKnown || sideKnown.seenAt < this.t) {
        this.recordContact(u.side, by, "contact", u.id, by.weaponClass);
      }
      if (this.t - (this.underFireReported.get(u.id) ?? -1e9) > 90) {
        this.underFireReported.set(u.id, this.t);
        this.emit("under_fire", u, `taking fire from the ${bearingWord(u.pos, by.pos)}`);
      }
    }
    for (const mark of [75, 50, 25]) {
      if (u.strength < mark && (this.casualtyMarks.get(u.id) ?? 100) > mark) {
        this.casualtyMarks.set(u.id, mark);
        this.emit("casualties", u, `casualties, now at about ${mark}% strength`);
      }
    }
    if (u.strength < 8) {
      this.vacateBuilding(u);
      for (const pid of [...u.embarkedIds]) {
        const p = this.get(pid);
        if (p) this.disembark(p);
      }
      u.state = "destroyed";
      this.syncRosterCasualtiesFromStrength(u);
      this.emit("destroyed", u, `${u.id} has been destroyed`);
      if (by) this.emit("enemy_destroyed", by, `destroyed enemy ${STATS[u.type].label}`);
    } else if (dmg > 0) {
      this.syncRosterCasualtiesFromStrength(u);
    }
  }

  // ---------- platoon bot (finite state machine) ----------
  private updateMoraleAndEvents(u: Unit, recentlyHit: boolean) {
    const events: MoraleEventKind[] = [];
    const inSupply = this.supplyNodes.some((n) => n.side === u.side && dist(u.pos, n.pos) <= n.radius);
    if (inSupply) {
      events.push("SupplyBonus");
      u.morale = Math.min(100, u.morale + 1.2);
      u.suppression = Math.max(0, u.suppression - 1.5);
    }
    if (this.t <= this.combatFeatUntil[u.side]) {
      events.push("CombatFeatBonus");
      u.morale = Math.min(100, u.morale + 0.8);
    }

    const inCombat = recentlyHit || !!u.target;
    if (inCombat) {
      const visibleEnemies = this.alive().filter(
        (e) => e.side !== u.side && !e.embarkedIn && (u.ownPerception.get(e.id) ?? "none") !== "none",
      ).length;
      const nearbyFriendlies = this.alive(u.side).filter((f) => !f.embarkedIn && dist(u.pos, f.pos) <= 600).length;
      if (visibleEnemies >= 2 && visibleEnemies >= Math.max(1, nearbyFriendlies) * 2) {
        events.push("IsolationPenalty");
        if (u.morale > MORALE_WORRIED_MIDPOINT) {
          u.morale = Math.max(MORALE_WORRIED_MIDPOINT, u.morale - 0.8);
        }
      }
    }

    if (this.t <= (this.artilleryShockUntil.get(u.id) ?? -1e9)) {
      events.push("ArtilleryShockPenalty");
    }

    // Passive morale recovery when out of heavy pressure
    if (!recentlyHit && u.suppression < 30 && !events.includes("IsolationPenalty")) {
      u.morale = Math.min(100, u.morale + 0.35);
    } else if (!recentlyHit && !events.includes("IsolationPenalty")) {
      u.morale = Math.min(100, u.morale + 0.15);
    }

    // Sustained heavy suppression caps morale drain at SuppressionFloor (shaken midpoint)
    if (u.suppression > 50 && u.morale > MORALE_SHAKEN_MIDPOINT) {
      u.morale = Math.max(MORALE_SHAKEN_MIDPOINT, u.morale - 0.2);
    }
    u.activeMoraleEvents = events;
  }

  private bot(u: Unit) {
    if (u.state === "destroyed") return;
    if (u.embarkedIn) {
      const tr = this.get(u.embarkedIn);
      if (!tr || tr.state === "destroyed") this.disembark(u);
      else u.pos = { ...tr.pos };
    }
    if (u.garrison && !this.unitFloor(u)) u.garrison = undefined;

    const recentlyHit = this.t - u.lastHitAt < 15;
    u.suppression = Math.max(0, u.suppression - (recentlyHit ? 0.7 : 3));
    this.updateMoraleAndEvents(u, recentlyHit);

    if (u.state !== "broken" && !u.embarkedIn && (u.strength < 30 || u.morale < 20)) {
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
    if (!u.embarkedIn && (u.state === "moving" || u.state === "holding") && u.order.dest) {
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

    if (!u.embarkedIn && (u.state === "moving" || u.state === "broken") && u.order.dest) {
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
    const moraleSpeedMult = u.state === "broken" ? 1.0 : 0.65 + 0.35 * (u.morale / 100);
    const kmh = STATS[u.type].baseSpeedKmH * speedMult * moraleSpeedMult;
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
      u.stuckTicks = 0;
      return;
    }

    if (d <= step) {
      if (!this.canOccupy(u, dest)) {
        u.order = { kind: "hold" };
        if (u.state === "moving") u.state = "holding";
        return;
      }
      u.heading = Math.atan2(dest.y - u.pos.y, dest.x - u.pos.x);
      u.pos = { ...dest };
      u.stuckTicks = 0;
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
        u.heading = ang;
        u.pos = nextPos;
        u.stuckTicks = 0;
        return;
      }
    }

    // Wheeled stuck-recovery pivot-in-place fallback when forward pathing cannot advance
    u.stuckTicks += 1;
    if (u.mobility === "wheeled" && u.stuckTicks >= 2) {
      for (const offset of [2.1, -2.1, 2.6, -2.6, Math.PI]) {
        const ang = baseAngle + offset;
        const backPos = { x: u.pos.x + Math.cos(ang) * step, y: u.pos.y + Math.sin(ang) * step };
        if (this.canOccupy(u, backPos)) {
          u.heading = ang;
          u.pos = backPos;
          u.stuckTicks = 0;
          return;
        }
      }
      u.heading = normalizeAngle(u.heading + Math.PI / 2);
    }
  }
}

function bearingWord(from: Vec, to: Vec) {
  const deg = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(((deg + 360) % 360) / 45) % 8];
}
