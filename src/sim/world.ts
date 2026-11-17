// Simulation core: units, platoon-level bot state machine, two-tier spotting, 10m mobility/garrison,
// Phase 2B own-optics accuracy, directional KE/CE armor, HE inverse-square law, infantry takeover,
// Phase 2C 4-tier morale, SuppressionFloor, Cowering, morale events, and vehicle patches.
import { ArmorValue, CombatModifiers, DEFAULT_BUILDING_ARMOR, DynamicOcclusionVolume, GameMap, MobilityClass, TerrainId, UnitTrait, Vec, dist, rng } from "./map";

export type { ArmorValue };
export type Side = "blue" | "red";
export type UnitType =
  | "tank" | "ifv" | "infantry" | "atgm" | "artillery" | "mlrs" | "recon"
  | "fob" | "supply_truck" | "shorad" | "sam" | "helicopter" | "aircraft";
export type ArtilleryAmmoType = "HE_Impact" | "HE_Airburst" | "Smoke" | "Direct_Self_Defense";
export type FlightAltitude = "low" | "high";
export type AirMissionProfile = "cap_loiter" | "strike_egress";
export type AirState = "ingress" | "on_station" | "egress" | "turnaround" | "at_base";
export type WeaponTargetDomain = "ground" | "air" | "both";
export interface TurnaroundTimers {
  refuelTime: number;
  repairTime: number;
  rearmTime: number;
}
export type Roe = "fire_at_will" | "return_fire" | "hold_fire";
export type OrderKind = "hold" | "move" | "attack" | "withdraw" | "fire_mission" | "withdraw_off_map" | "air_sortie";
export interface UnitGarrison {
  buildingId: string;
  floorLevel: number;
}
export interface Order {
  kind: OrderKind;
  dest?: Vec;
  destName?: string;
  garrison?: UnitGarrison;
  ammoType?: ArtilleryAmmoType;
  missionProfile?: AirMissionProfile;
}
export interface FireMissionState {
  targetPos: Vec;
  requestedAmmo: ArtilleryAmmoType;
  effectiveAmmo: Exclude<ArtilleryAmmoType, "Direct_Self_Defense">;
  phase: "ranging" | "ffe";
  rangingFired: number;
  rangingNeeded: number;
  dispersionRadius: number;
  salvoRemaining: number;
  cooldown: number;
  calibratedThisMission: boolean;
}
export interface IndirectProjectile {
  id: number;
  shooterId: string;
  side: Side;
  from: Vec;
  fromZ: number;
  to: Vec;
  toZ: number;
  ammo: Exclude<ArtilleryAmmoType, "Direct_Self_Defense">;
  timeRemaining: number;
  totalFlightTime: number;
  penContact: number;
  d0: number;
  yieldDamage: number;
  yieldSuppression: number;
  blastHeightOffset: number;
  smokeRadius?: number;
}
export interface SmokeVolume extends DynamicOcclusionVolume {
  id: number;
  expiresAt: number;
}

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
  maxAmmo: number;
  ammoRemaining: number;
  accuracy: number;        // baseline hit chance at Visual (100%)
  weaponClass: WeaponSignatureClass;
  muzzleSignature: number;
  targetDomain?: WeaponTargetDomain;
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
  weapon: Omit<WeaponSlot, "cooldown" | "ammoRemaining" | "maxAmmo">;
  cooldown: number;
  maxAmmo: number;
  ammoRemaining: number;
}

export interface InfantrySubRoster {
  personnel: Record<SpecialistRole, number>;
  wia: Record<SpecialistRole, number>;
  kia: Record<SpecialistRole, number>;
  selfRecoveryCap: number;
  selfAidProgress: number;
  fieldAidProgress: number;
  weapons: InfantryWeaponSlot[];
  abandonedWeapons: string[];
}

export interface AssignedInfantryWeapon {
  slot: InfantryWeaponSlot;
  operatorRole: SpecialistRole;
  crossManned: boolean;
  efficiency: number;
}

interface IndirectProfile {
  minRange: number;
  maxRange: number;
  baseDispersion: number;
  salvoCount: number;
  salvoIntervalSec: number;
  rangingIntervalSec: number;
  penContact: number;
  d0: number;
  yieldDamage: number;
  yieldSuppression: number;
  supportsCalibration: boolean;
  supportsAirburst: boolean;
  supportsSmoke: boolean;
  maxIndirectAmmo: number;
}

interface TypeStats {
  label: string;
  armored: boolean;
  hasObserver: boolean;
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
  reinforceCost: number;
  supplyRadius?: number;
  supplyCapacity?: number;
  passengerCapacity?: number;
  hasFiringPorts?: boolean;
  isAirUnit?: boolean;
  isFixedWing?: boolean;
  maxFuel?: number;
  fuelBurnPerTick?: number;
  afterburnerMult?: number;
  indirect?: IndirectProfile;
  armor: ArmorProfile;
  weapons: ReadonlyArray<Omit<WeaponSlot, "cooldown" | "ammoRemaining">>;
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
    hasObserver: false,
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
    reinforceCost: 140,
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
        maxAmmo: 24,
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
        maxAmmo: 16,
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
        maxAmmo: 120,
        accuracy: 0.65,
        weaponClass: "small_arms",
        muzzleSignature: 0.9,
      },
    ],
  },
  ifv: {
    label: "mech infantry platoon",
    armored: true,
    hasObserver: false,
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
    reinforceCost: 90,
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
        maxAmmo: 6,
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
        maxAmmo: 45,
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
        maxAmmo: 100,
        accuracy: 0.65,
        weaponClass: "small_arms",
        muzzleSignature: 0.9,
      },
    ],
  },
  infantry: {
    label: "infantry platoon",
    armored: false,
    hasObserver: true,
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
    reinforceCost: 60,
    armor: SOFT_ARMOR,
    weapons: [],
  },
  atgm: {
    label: "ATGM section",
    armored: false,
    hasObserver: false,
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
    reinforceCost: 50,
    armor: SOFT_ARMOR,
    weapons: [],
  },
  artillery: {
    label: "SP artillery battery",
    armored: true,
    hasObserver: false,
    mobility: "tracked",
    traits: ["vehicle", "armored", "tall_profile"],
    headcount: 0,
    eyeHeight: 2.9,
    baseSignature: 1.05,
    weaponClass: "heavy_weapon",
    muzzleSignature: 1.9,
    range: 800,
    spot: 1500,
    baseSpeedKmH: 26,
    reinforceCost: 130,
    indirect: {
      minRange: 250,
      maxRange: 5000,
      baseDispersion: 120,
      salvoCount: 4,
      salvoIntervalSec: 2,
      rangingIntervalSec: 3,
      penContact: 12,
      d0: 8,
      yieldDamage: 36,
      yieldSuppression: 48,
      supportsCalibration: true,
      supportsAirburst: true,
      supportsSmoke: true,
      maxIndirectAmmo: 24,
    },
    armor: {
      front: { ke: 3, ce: 4 },
      side: { ke: 2, ce: 2 },
      rear: { ke: 1, ce: 1 },
      top: { ke: 1, ce: 1 },
    },
    weapons: [
      {
        id: "155mm_direct",
        name: "155mm Direct HEAT/AP",
        ammo: "HEAT",
        pen: 14,
        damage: 28,
        suppression: 18,
        range: 800,
        reloadSec: 8,
        maxAmmo: 6,
        accuracy: 0.58,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.8,
        mutexGroup: "spg_breech",
        mutexLockSec: 8,
      },
      {
        id: "spg_aa_mg",
        name: "7.62mm Defense MG",
        ammo: "AP",
        pen: 1.5,
        damage: 4,
        suppression: 7,
        range: 550,
        reloadSec: 1,
        maxAmmo: 50,
        accuracy: 0.6,
        weaponClass: "small_arms",
        muzzleSignature: 0.9,
      },
    ],
  },
  mlrs: {
    label: "MLRS battery",
    armored: true,
    hasObserver: false,
    mobility: "tracked",
    traits: ["vehicle", "armored", "tall_profile"],
    headcount: 0,
    eyeHeight: 3.0,
    baseSignature: 1.15,
    weaponClass: "heavy_weapon",
    muzzleSignature: 2.2,
    range: 500,
    spot: 1400,
    baseSpeedKmH: 24,
    reinforceCost: 150,
    indirect: {
      minRange: 400,
      maxRange: 6000,
      baseDispersion: 180,
      salvoCount: 6,
      salvoIntervalSec: 1,
      rangingIntervalSec: 1,
      penContact: 10,
      d0: 9,
      yieldDamage: 30,
      yieldSuppression: 44,
      supportsCalibration: false,
      supportsAirburst: false,
      supportsSmoke: true,
      maxIndirectAmmo: 12,
    },
    armor: {
      front: { ke: 2, ce: 3 },
      side: { ke: 1, ce: 2 },
      rear: { ke: 1, ce: 1 },
      top: { ke: 1, ce: 1 },
    },
    weapons: [
      {
        id: "mlrs_mg",
        name: "7.62mm Cab MG",
        ammo: "AP",
        pen: 1.2,
        damage: 4,
        suppression: 6,
        range: 500,
        reloadSec: 1,
        maxAmmo: 40,
        accuracy: 0.55,
        weaponClass: "small_arms",
        muzzleSignature: 0.85,
      },
    ],
  },
  recon: {
    label: "recon section",
    armored: true,
    hasObserver: true,
    mobility: "wheeled",
    traits: ["vehicle", "armored", "low_profile"],
    headcount: 0,
    eyeHeight: 2.5,
    baseSignature: 0.55,
    weaponClass: "light_weapon",
    muzzleSignature: 1.05,
    range: 1000,
    spot: 2800,
    baseSpeedKmH: 42,
    reinforceCost: 70,
    armor: {
      front: { ke: 3, ce: 4 },
      side: { ke: 2, ce: 2 },
      rear: { ke: 1, ce: 1 },
      top: { ke: 1, ce: 1 },
    },
    weapons: [
      {
        id: "20mm_autocannon",
        name: "20mm Autocannon",
        ammo: "AP",
        pen: 4.5,
        damage: 7,
        suppression: 10,
        range: 1000,
        reloadSec: 2,
        maxAmmo: 30,
        accuracy: 0.7,
        weaponClass: "light_weapon",
        muzzleSignature: 1.15,
      },
      {
        id: "recon_mg",
        name: "7.62mm Coax MG",
        ammo: "AP",
        pen: 1.2,
        damage: 4.5,
        suppression: 7,
        range: 600,
        reloadSec: 1,
        maxAmmo: 60,
        accuracy: 0.65,
        weaponClass: "small_arms",
        muzzleSignature: 0.9,
      },
    ],
  },
  fob: {
    label: "forward operating base",
    armored: false,
    hasObserver: false,
    mobility: "foot",
    traits: ["tall_profile"],
    headcount: 0,
    eyeHeight: 3.5,
    baseSignature: 1.4,
    weaponClass: "small_arms",
    muzzleSignature: 0.5,
    range: 0,
    spot: 1000,
    baseSpeedKmH: 0,
    reinforceCost: 200,
    supplyRadius: 220,
    supplyCapacity: Infinity,
    armor: {
      front: { ke: 5, ce: 6 },
      side: { ke: 5, ce: 6 },
      rear: { ke: 5, ce: 6 },
      top: { ke: 4, ce: 5 },
    },
    weapons: [],
  },
  supply_truck: {
    label: "supply truck",
    armored: false,
    hasObserver: false,
    mobility: "wheeled",
    traits: ["vehicle", "tall_profile"],
    headcount: 0,
    eyeHeight: 2.4,
    baseSignature: 0.9,
    weaponClass: "small_arms",
    muzzleSignature: 0.5,
    range: 0,
    spot: 1100,
    baseSpeedKmH: 36,
    reinforceCost: 40,
    supplyRadius: 150,
    supplyCapacity: 100,
    armor: SOFT_ARMOR,
    weapons: [],
  },
  shorad: {
    label: "SHORAD platoon",
    armored: true,
    hasObserver: false,
    mobility: "tracked",
    traits: ["vehicle", "armored", "tall_profile"],
    headcount: 0,
    eyeHeight: 2.8,
    baseSignature: 1.0,
    weaponClass: "heavy_weapon",
    muzzleSignature: 1.6,
    range: 2400,
    spot: 3200,
    baseSpeedKmH: 30,
    reinforceCost: 110,
    armor: {
      front: { ke: 4, ce: 5 },
      side: { ke: 2, ce: 3 },
      rear: { ke: 1, ce: 2 },
      top: { ke: 1, ce: 1 },
    },
    weapons: [
      {
        id: "shorad_sam",
        name: "SHORAD SAM",
        ammo: "HEAT",
        targetDomain: "air",
        pen: 6,
        damage: 38,
        suppression: 32,
        range: 2400,
        reloadSec: 4,
        maxAmmo: 10,
        accuracy: 0.74,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.7,
      },
      {
        id: "shorad_autocannon",
        name: "35mm Twin AA",
        ammo: "AP",
        targetDomain: "both",
        pen: 5,
        damage: 11,
        suppression: 14,
        range: 1600,
        reloadSec: 1,
        maxAmmo: 80,
        accuracy: 0.68,
        weaponClass: "light_weapon",
        muzzleSignature: 1.35,
      },
    ],
  },
  sam: {
    label: "area SAM battery",
    armored: true,
    hasObserver: false,
    mobility: "tracked",
    traits: ["vehicle", "armored", "tall_profile"],
    headcount: 0,
    eyeHeight: 3.4,
    baseSignature: 1.2,
    weaponClass: "heavy_weapon",
    muzzleSignature: 2.1,
    range: 5500,
    spot: 5500,
    baseSpeedKmH: 20,
    reinforceCost: 160,
    armor: {
      front: { ke: 3, ce: 4 },
      side: { ke: 2, ce: 2 },
      rear: { ke: 1, ce: 1 },
      top: { ke: 1, ce: 1 },
    },
    weapons: [
      {
        id: "area_sam",
        name: "Long-Range SAM",
        ammo: "HEAT",
        targetDomain: "air",
        pen: 10,
        damage: 58,
        suppression: 46,
        range: 5500,
        reloadSec: 6,
        maxAmmo: 8,
        accuracy: 0.8,
        weaponClass: "heavy_weapon",
        muzzleSignature: 2.1,
      },
    ],
  },
  helicopter: {
    label: "attack/transport helicopter",
    armored: false,
    hasObserver: false,
    isAirUnit: true,
    mobility: "amphibious",
    traits: ["vehicle", "tall_profile"],
    headcount: 0,
    eyeHeight: 35,
    baseSignature: 1.15,
    weaponClass: "heavy_weapon",
    muzzleSignature: 1.6,
    range: 2200,
    spot: 2800,
    baseSpeedKmH: 180,
    passengerCapacity: 1,
    reinforceCost: 140,
    armor: {
      front: { ke: 2, ce: 2 },
      side: { ke: 1, ce: 1 },
      rear: { ke: 1, ce: 1 },
      top: { ke: 1, ce: 1 },
    },
    weapons: [
      {
        id: "helo_atgm",
        name: "Heliborne ATGM",
        ammo: "HEAT",
        targetDomain: "both",
        pen: 18,
        damage: 32,
        suppression: 16,
        range: 2200,
        reloadSec: 6,
        maxAmmo: 8,
        accuracy: 0.76,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.6,
      },
      {
        id: "helo_cannon",
        name: "30mm Chain Gun",
        ammo: "AP",
        targetDomain: "both",
        pen: 4,
        damage: 8,
        suppression: 10,
        range: 1400,
        reloadSec: 1,
        maxAmmo: 50,
        accuracy: 0.68,
        weaponClass: "light_weapon",
        muzzleSignature: 1.25,
      },
    ],
  },
  aircraft: {
    label: "fixed-wing aircraft",
    armored: false,
    hasObserver: false,
    isAirUnit: true,
    isFixedWing: true,
    mobility: "amphibious",
    traits: ["vehicle", "low_profile"],
    headcount: 0,
    eyeHeight: 200,
    baseSignature: 1.25,
    weaponClass: "heavy_weapon",
    muzzleSignature: 1.8,
    range: 2800,
    spot: 4500,
    baseSpeedKmH: 600,
    maxFuel: 180,
    fuelBurnPerTick: 1.0,
    afterburnerMult: 3.5,
    reinforceCost: 180,
    armor: {
      front: { ke: 2, ce: 2 },
      side: { ke: 1, ce: 1 },
      rear: { ke: 1, ce: 1 },
      top: { ke: 1, ce: 1 },
    },
    weapons: [
      {
        id: "aam",
        name: "Air-to-Air Missile",
        ammo: "HEAT",
        targetDomain: "air",
        pen: 8,
        damage: 45,
        suppression: 35,
        range: 2800,
        reloadSec: 4,
        maxAmmo: 4,
        accuracy: 0.78,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.8,
      },
      {
        id: "agm_strike",
        name: "Air-to-Ground Ordnance",
        ammo: "HE",
        targetDomain: "ground",
        pen: 12,
        d0: 10,
        damage: 42,
        suppression: 34,
        range: 2200,
        reloadSec: 3,
        maxAmmo: 4,
        accuracy: 0.8,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.8,
      },
      {
        id: "air_cannon",
        name: "20mm Vulcan",
        ammo: "AP",
        targetDomain: "both",
        pen: 4,
        damage: 14,
        suppression: 14,
        range: 1200,
        reloadSec: 1,
        maxAmmo: 40,
        accuracy: 0.7,
        weaponClass: "light_weapon",
        muzzleSignature: 1.3,
      },
    ],
  },
};

function emptyRoles(): Record<SpecialistRole, number> {
  return { rifleman: 0, mg_specialist: 0, at_specialist: 0, marksman: 0, engineer: 0 };
}

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
        maxAmmo: 4,
        ammoRemaining: 4,
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
        maxAmmo: 40,
        ammoRemaining: 40,
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
        maxAmmo: 30,
        ammoRemaining: 30,
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
      wia: emptyRoles(),
      kia: emptyRoles(),
      selfRecoveryCap: 6,
      selfAidProgress: 0,
      fieldAidProgress: 0,
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
        maxAmmo: 6,
        ammoRemaining: 6,
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
        maxAmmo: 30,
        ammoRemaining: 30,
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
      wia: emptyRoles(),
      kia: emptyRoles(),
      selfRecoveryCap: 3,
      selfAidProgress: 0,
      fieldAidProgress: 0,
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
  hasObserver: boolean;
  isPositionCalibrated: boolean;
  fireMission?: FireMissionState;
  indirectAmmo: number;
  maxIndirectAmmo: number;
  supplyCarried: number;
  supplyCapacity: number;
  veterancy: number;
  offMapReconstituteAt?: number;
  reconstituteEntryPos?: Vec;
  flightAltitude?: FlightAltitude;
  missionProfile?: AirMissionProfile;
  airState?: AirState;
  fuel: number;
  maxFuel: number;
  afterburner: boolean;
  turnaroundTimers?: TurnaroundTimers;
  isLanded: boolean;
  isForcedLanding: boolean;
  sortieTarget?: Vec;
}

export interface SupplyTransferEvent {
  id: number;
  t: number;
  fromId: string;
  toId: string;
  pos: Vec;
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
  artilleryAmmo?: ArtilleryAmmoType;
  blastHeightOffset?: number;
  smokeRadius?: number;
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
  weaponSlots: {
    id: string;
    name: string;
    ammo: AmmoType;
    cooldown: number;
    ammoRemaining: number;
    maxAmmo: number;
    mutexGroup?: string;
    mutexLocked: boolean;
  }[];
  subRoster?: {
    personnel: Record<SpecialistRole, number>;
    wia: Record<SpecialistRole, number>;
    kia: Record<SpecialistRole, number>;
    selfRecoveryCap: number;
    assignments: { weaponId: string; role: SpecialistRole; crossManned: boolean; efficiency: number }[];
    abandoned: string[];
  };
  hasObserver: boolean;
  isPositionCalibrated: boolean;
  fireMission?: FireMissionState;
  indirectAmmo: number;
  maxIndirectAmmo: number;
  supplyCarried: number;
  supplyCapacity: number;
  veterancy: number;
  offMapReconstituteAt?: number;
  flightAltitude?: FlightAltitude;
  missionProfile?: AirMissionProfile;
  airState?: AirState;
  fuel: number;
  maxFuel: number;
  afterburner: boolean;
  turnaroundTimers?: TurnaroundTimers;
  isLanded: boolean;
  isForcedLanding: boolean;
}

export interface SupplyTransferEvent {
  id: number;
  t: number;
  fromId: string;
  toId: string;
  pos: Vec;
}

export type EventKind =
  | "contact" | "under_fire" | "pinned" | "recovered" | "casualties"
  | "arrived" | "broken" | "destroyed" | "enemy_destroyed" | "fire_mission" | "forced_landing" | "air_sortie";
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

function cloneWeapons(ws: ReadonlyArray<Omit<WeaponSlot, "cooldown" | "ammoRemaining">>): WeaponSlot[] {
  return ws.map((w) => ({ ...w, cooldown: 0, ammoRemaining: w.maxAmmo }));
}

export class World {
  t = 0; // game seconds
  units: Unit[] = [];
  contacts: Record<Side, Map<string, Contact>> = { blue: new Map(), red: new Map() };
  events: SimEvent[] = [];
  shotEvents: CombatShotEvent[] = [];
  supplyNodes: SupplyNode[] = [];
  supplyEvents: SupplyTransferEvent[] = [];
  sideResources: Record<Side, number> = { blue: 500, red: 500 };
  indirectProjectiles: IndirectProjectile[] = [];
  smokeVolumes: SmokeVolume[] = [];
  private listeners: ((e: SimEvent) => void)[] = [];
  private random: () => number;
  private casualtyMarks = new Map<string, number>();
  private underFireReported = new Map<string, number>();
  private combatFeatUntil: Record<Side, number> = { blue: -1e9, red: -1e9 };
  private artilleryShockUntil = new Map<string, number>();
  private shotSeq = 0;
  private indirectSeq = 0;
  private smokeSeq = 0;
  private supplySeq = 0;

  constructor(readonly map: GameMap, seed = 1) { this.random = rng(seed); }

  private pushShotEvent(ev: Omit<CombatShotEvent, "id">) {
    this.shotEvents.push({ id: ++this.shotSeq, ...ev });
    if (this.shotEvents.length > 256) this.shotEvents.splice(0, this.shotEvents.length - 256);
  }

  private pushSupplyEvent(fromId: string, toId: string, pos: Vec) {
    this.supplyEvents.push({ id: ++this.supplySeq, t: this.t, fromId, toId, pos: { ...pos } });
    if (this.supplyEvents.length > 64) this.supplyEvents.splice(0, this.supplyEvents.length - 64);
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
      | "ownPerception" | "armor" | "weapons" | "mutexCooldowns" | "hasObserver" | "isPositionCalibrated"
      | "indirectAmmo" | "maxIndirectAmmo" | "supplyCarried" | "supplyCapacity" | "veterancy"
      | "fuel" | "maxFuel" | "afterburner" | "isLanded" | "isForcedLanding"
    > & Partial<Unit>,
  ) {
    const st = STATS[u.type];
    const heading = u.heading ?? (u.side === "blue" ? 0 : Math.PI);
    const maxInd = st.indirect?.maxIndirectAmmo ?? 0;
    const cap = st.supplyCapacity ?? 0;
    const maxFuel = st.maxFuel ?? Infinity;
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
      hasObserver: st.hasObserver,
      isPositionCalibrated: false,
      indirectAmmo: maxInd,
      maxIndirectAmmo: maxInd,
      supplyCarried: cap === Infinity ? Infinity : 0, // SupplyVehicle enters empty (0 supply)
      supplyCapacity: cap,
      veterancy: 0,
      flightAltitude: st.isFixedWing ? (u.flightAltitude ?? "high") : undefined,
      missionProfile: st.isFixedWing ? (u.missionProfile ?? "cap_loiter") : undefined,
      airState: st.isFixedWing ? (u.airState ?? "on_station") : undefined,
      fuel: maxFuel,
      maxFuel,
      afterburner: false,
      isLanded: false,
      isForcedLanding: false,
      ...u,
    };
    this.units.push(unit);
    return unit;
  }

  /** Cleanly remove a unit and purge all building, transport, contact, and targeting references. */
  removeUnit(id: string): boolean {
    const u = this.get(id);
    if (!u) return false;
    if (u.garrison) this.vacateBuilding(u);
    if (u.embarkedIn) this.disembark(u);
    for (const pid of [...u.embarkedIds]) {
      const p = this.get(pid);
      if (p) this.disembark(p);
    }
    this.units = this.units.filter((x) => x.id !== u.id);
    for (const side of ["blue", "red"] as Side[]) {
      const map = this.contacts[side];
      map.delete(u.id);
      for (const [cid, c] of map) {
        if (c.seenBy === u.id) map.delete(cid);
      }
    }
    for (const other of this.units) {
      if (other.target === u.id) other.target = undefined;
      other.ownPerception.delete(u.id);
    }
    this.casualtyMarks.delete(u.id);
    this.underFireReported.delete(u.id);
    this.artilleryShockUntil.delete(u.id);
    return true;
  }

  get(id: string) { return this.units.find((u) => u.id.toLowerCase() === id.trim().toLowerCase()); }
  alive(side?: Side) { return this.units.filter((u) => u.state !== "destroyed" && (!side || u.side === side)); }
  onMapAlive(side?: Side) {
    return this.units.filter(
      (u) =>
        u.state !== "destroyed" &&
        u.offMapReconstituteAt === undefined &&
        u.airState !== "turnaround" &&
        u.airState !== "at_base" &&
        (!side || u.side === side),
    );
  }

  /** 2x linear (4x area) outer airspace bounds: [-0.5w, 1.5w] x [-0.5d, 1.5d]. */
  inAirBounds(p: Vec): boolean {
    return (
      p.x >= -this.map.width * 0.5 &&
      p.x <= this.map.width * 1.5 &&
      p.y >= -this.map.depth * 0.5 &&
      p.y <= this.map.depth * 1.5
    );
  }

  private airIngressOrigin(side: Side, targetPos: Vec): Vec {
    return {
      x: side === "blue" ? -this.map.width * 0.45 : this.map.width * 1.45,
      y: Math.min(this.map.depth * 1.25, Math.max(-this.map.depth * 0.25, targetPos.y)),
    };
  }

  private nearestAirExit(p: Vec): Vec {
    const minX = -this.map.width * 0.5;
    const maxX = this.map.width * 1.5;
    const minY = -this.map.depth * 0.5;
    const maxY = this.map.depth * 1.5;
    const candidates: Vec[] = [
      { x: minX, y: p.y },
      { x: maxX, y: p.y },
      { x: p.x, y: minY },
      { x: p.x, y: maxY },
    ];
    return candidates.sort((a, b) => dist(p, a) - dist(p, b))[0];
  }

  chooseFlightAltitude(side: Side, missionProfile: AirMissionProfile): FlightAltitude {
    const knownEnemies = [...this.contacts[side].values()];
    const hasAreaSam = knownEnemies.some((c) => c.type === "sam");
    const hasShorad = knownEnemies.some((c) => c.type === "shorad");
    const hasEnemyAir = knownEnemies.some((c) => c.type === "aircraft");
    if (missionProfile === "cap_loiter") {
      if (hasAreaSam && !hasEnemyAir && !hasShorad) return "low";
      return "high";
    }
    if (hasAreaSam) return "low";
    if (hasShorad) return "high";
    return "low";
  }

  /** Requisition or launch an available at-base fixed-wing sortie (zero cost on turnaround reuse). */
  callAirSortie(
    side: Side,
    targetPos: Vec,
    missionProfile: AirMissionProfile = "cap_loiter",
    opts?: { altitude?: FlightAltitude; id?: string; commander?: string },
  ): { ok: boolean; unit?: Unit; reason?: string } {
    const readyAtBase = this.units.find(
      (u) => u.side === side && u.type === "aircraft" && u.state !== "destroyed" && u.airState === "at_base",
    );
    const origin = this.airIngressOrigin(side, targetPos);
    const alt = opts?.altitude ?? this.chooseFlightAltitude(side, missionProfile);

    if (readyAtBase) {
      readyAtBase.pos = { ...origin };
      readyAtBase.prevPos = { ...origin };
      readyAtBase.heading = Math.atan2(targetPos.y - origin.y, targetPos.x - origin.x);
      readyAtBase.prevHeading = readyAtBase.heading;
      readyAtBase.flightAltitude = alt;
      readyAtBase.missionProfile = missionProfile;
      readyAtBase.airState = "ingress";
      readyAtBase.sortieTarget = { ...targetPos };
      readyAtBase.fuel = readyAtBase.maxFuel;
      readyAtBase.afterburner = false;
      readyAtBase.turnaroundTimers = undefined;
      readyAtBase.order = { kind: "air_sortie", dest: { ...targetPos }, missionProfile };
      readyAtBase.state = "moving";
      this.emit("air_sortie", readyAtBase, `${readyAtBase.id} launched free turnaround ${missionProfile} (${alt} alt)`);
      return { ok: true, unit: readyAtBase };
    }

    const cost = STATS.aircraft.reinforceCost;
    if (this.sideResources[side] < cost) {
      return { ok: false, reason: `insufficient requisition (${this.sideResources[side]}/${cost})` };
    }
    this.sideResources[side] -= cost;
    const seq = this.units.filter((u) => u.type === "aircraft").length + 1;
    const uid = opts?.id ?? `${side === "blue" ? "Blue" : "Red"} Air ${seq}`;
    const plane = this.add({
      id: uid,
      side,
      type: "aircraft",
      pos: origin,
      commander: opts?.commander,
      flightAltitude: alt,
      missionProfile,
      airState: "ingress",
      sortieTarget: { ...targetPos },
      order: { kind: "air_sortie", dest: { ...targetPos }, missionProfile },
      state: "moving",
    });
    plane.heading = Math.atan2(targetPos.y - origin.y, targetPos.x - origin.x);
    plane.prevHeading = plane.heading;
    this.emit("air_sortie", plane, `${plane.id} requisitioned (-${cost} req) for ${missionProfile} (${alt} alt)`);
    return { ok: true, unit: plane };
  }

  landHelicopter(u: Unit): string {
    if (u.state === "destroyed") return "unit destroyed";
    if (u.type !== "helicopter") return `${u.id} is not a helicopter`;
    if (u.isLanded) return "already landed";
    const nearFob = this.onMapAlive(u.side).some(
      (f) => f.type === "fob" && dist(u.pos, f.pos) <= (STATS.fob.supplyRadius ?? 220),
    );
    if (!nearFob && this.map.terrainIdAt(u.pos) !== "open") {
      return `cannot land on ${this.map.terrainIdAt(u.pos)} (requires open terrain or FOB)`;
    }
    u.isLanded = true;
    u.order = { kind: "hold" };
    u.state = "holding";
    return "ok";
  }

  takeoffHelicopter(u: Unit): string {
    if (u.state === "destroyed") return "unit destroyed";
    if (u.type !== "helicopter") return `${u.id} is not a helicopter`;
    if (!u.isLanded) return "already airborne";
    if (u.strength < 30) return `insufficient structural integrity (${Math.round(u.strength)}% < 30% flight threshold)`;
    u.isForcedLanding = false;
    u.isLanded = false;
    return "ok";
  }

  private nearestMapEdge(p: Vec): Vec {
    const edges: Vec[] = [
      { x: 15, y: p.y },
      { x: this.map.width - 15, y: p.y },
      { x: p.x, y: 15 },
      { x: p.x, y: this.map.depth - 15 },
    ];
    return edges.sort((a, b) => dist(p, a) - dist(p, b))[0];
  }

  hasFriendlyObserverSight(side: Side, targetPos: Vec): boolean {
    for (const o of this.onMapAlive(side)) {
      if (!o.hasObserver || o.embarkedIn) continue;
      const res = this.map.sightline(o.pos, this.unitEyeHeight(o), targetPos, 1.5, {
        ...(o.garrison ? { ignoreBuildingIds: [o.garrison.buildingId] } : {}),
        ...(this.smokeVolumes.length > 0 ? { dynamicVolumes: this.smokeVolumes } : {}),
      });
      if (!res.blocked && res.transmittance >= 0.05 && res.distance <= this.effectiveSpotRange(o)) {
        return true;
      }
    }
    return false;
  }

  private startFireMission(u: Unit, dest: Vec, ammoType?: ArtilleryAmmoType): string {
    const spec = STATS[u.type].indirect;
    if (!spec) return `${u.id} (${STATS[u.type].label}) cannot execute indirect fire missions`;
    const d = dist(u.pos, dest);
    if (d < spec.minRange || d > spec.maxRange) {
      return `target out of indirect range (${Math.round(d)}m; valid ${spec.minRange}–${spec.maxRange}m)`;
    }
    const requested: ArtilleryAmmoType = !ammoType || ammoType === "Direct_Self_Defense" ? "HE_Impact" : ammoType;
    let effectiveAmmo: Exclude<ArtilleryAmmoType, "Direct_Self_Defense">;
    let phase: "ranging" | "ffe" = "ffe";
    let rangingNeeded = 0;
    let dispersionRadius = spec.baseDispersion;

    if (requested === "Smoke" && spec.supportsSmoke) {
      effectiveAmmo = "Smoke";
      dispersionRadius = spec.baseDispersion * 0.5 * (u.isPositionCalibrated ? 0.75 : 1.0);
    } else if (!spec.supportsCalibration) {
      effectiveAmmo = requested === "HE_Airburst" ? "HE_Impact" : requested;
    } else {
      const observed = this.hasFriendlyObserverSight(u.side, dest);
      if (observed) {
        effectiveAmmo = requested;
        phase = "ranging";
        rangingNeeded = 2;
        dispersionRadius = spec.baseDispersion * (u.isPositionCalibrated ? 0.65 : 1.0);
      } else {
        effectiveAmmo = requested === "HE_Airburst" ? "HE_Impact" : requested;
        dispersionRadius = spec.baseDispersion * (u.isPositionCalibrated ? 0.6 : 1.0);
      }
    }

    u.fireMission = {
      targetPos: { ...dest },
      requestedAmmo: requested,
      effectiveAmmo,
      phase,
      rangingFired: 0,
      rangingNeeded,
      dispersionRadius,
      salvoRemaining: spec.salvoCount,
      cooldown: 0,
      calibratedThisMission: false,
    };
    u.heading = Math.atan2(dest.y - u.pos.y, dest.x - u.pos.x);
    this.emit(
      "fire_mission",
      u,
      `fire mission (${effectiveAmmo}${requested === "HE_Airburst" && effectiveAmmo === "HE_Impact" ? " degraded from Airburst" : ""}) at ${this.map.describe(dest)}: ${phase === "ranging" ? "2-round ranging" : u.isPositionCalibrated ? "calibrated FFE" : "uncalibrated FFE"}`,
    );
    return "ok";
  }

  command(u: Unit, order: Order, roe?: Roe) {
    if (u.state === "destroyed") return "unit destroyed";
    if (u.offMapReconstituteAt !== undefined) return `${u.id} is off-map reconstituting`;
    if (u.airState === "turnaround" || u.airState === "at_base") return `${u.id} is at airbase (${u.airState})`;
    if (u.type === "helicopter" && u.isForcedLanding) return `${u.id} is forced-landed (<30% HP) and awaiting field repair`;
    if (u.state === "broken") return `${u.id} is broken and falling back, not responding to orders`;
    if (u.type === "helicopter" && u.isLanded && order.dest) {
      if (u.strength < 30) return `${u.id} cannot take off below 30% HP`;
      u.isLanded = false;
    }
    if (order.kind === "air_sortie") {
      if (u.type !== "aircraft") return `${u.id} is not fixed-wing aircraft`;
      if (!order.dest) return "air_sortie requires dest";
      u.missionProfile = order.missionProfile ?? u.missionProfile ?? "cap_loiter";
      u.sortieTarget = { ...order.dest };
      u.airState = "on_station";
    }
    if (order.kind === "fire_mission") {
      if (!order.dest) return "fire_mission requires target dest";
      const fmRes = this.startFireMission(u, order.dest, order.ammoType);
      if (fmRes !== "ok") return fmRes;
      u.order = order;
      if (roe) u.roe = roe;
      if (u.state !== "pinned") u.state = "holding";
      return "ok";
    }
    if (order.kind === "withdraw_off_map") {
      if (STATS[u.type].baseSpeedKmH <= 0) return `${u.id} is immobile and cannot withdraw off-map`;
      const exitDest = order.dest ?? this.nearestMapEdge(u.pos);
      order = { ...order, dest: exitDest, destName: order.destName ?? "map edge" };
    }
    u.fireMission = undefined;
    if (order.dest && u.garrison) this.vacateBuilding(u);
    u.order = order;
    if (roe) u.roe = roe;
    else if (order.kind === "attack") u.roe = "fire_at_will";
    else if (order.kind === "withdraw" || order.kind === "withdraw_off_map") u.roe = "return_fire";
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
    if (u.type === "aircraft") return u.flightAltitude === "low" ? 120 : 450;
    if (u.type === "helicopter") return u.isLanded ? 1.8 : STATS.helicopter.eyeHeight;
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

  /** Embark an infantry unit onto a friendly APC/IFV or landed helicopter transport. */
  embark(passenger: Unit, transport: Unit): string {
    if (passenger.state === "destroyed" || transport.state === "destroyed") return "unit destroyed";
    if (!passenger.traits.includes("infantry")) return `${passenger.id} is not infantry`;
    if (passenger.side !== transport.side) return "cannot embark on enemy vehicle";
    if (transport.type === "helicopter" && !transport.isLanded) return `${transport.id} must be landed to embark infantry`;
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

  private restoreSubRosterWeapons(u: Unit, resetAmmo: boolean) {
    const roster = u.subRoster;
    if (!roster) return;
    const def = createDefaultSubRoster(u.type);
    if (!def) return;
    const byId = new Map(roster.weapons.map((w) => [w.id, w]));
    roster.weapons = def.weapons.map((dw) => {
      const existing = byId.get(dw.id);
      if (!existing) return dw;
      return resetAmmo ? { ...existing, ammoRemaining: existing.maxAmmo, cooldown: 0 } : existing;
    });
    roster.abandonedWeapons = [];
    this.reconcileSubRoster(u);
  }

  private healOneWia(u: Unit): boolean {
    const roster = u.subRoster;
    if (!roster) return false;
    const priority: readonly SpecialistRole[] = ["at_specialist", "mg_specialist", "marksman", "engineer", "rifleman"];
    const role = priority.find((r) => (roster.wia[r] ?? 0) > 0);
    if (!role) return false;
    roster.wia[role] -= 1;
    roster.personnel[role] += 1;
    this.restoreSubRosterWeapons(u, false);
    const baseCount = Math.max(1, STATS[u.type].headcount);
    u.strength = Math.min(100, (u.headcount / baseCount) * 100);
    return true;
  }

  /** Deterministically inflict casualties on a specific specialist role (syncs headcount, WIA/KIA & strength). */
  inflictRosterCasualty(u: Unit, role: SpecialistRole, count = 1, kind: "wia" | "kia" = "wia"): boolean {
    const roster = u.subRoster;
    if (!roster || (roster.personnel[role] ?? 0) <= 0) return false;
    const lost = Math.min(count, roster.personnel[role]);
    roster.personnel[role] -= lost;
    roster[kind][role] += lost;
    this.reconcileSubRoster(u);
    const baseCount = Math.max(1, STATS[u.type].headcount);
    u.strength = Math.max(0, (u.headcount / baseCount) * 100);
    if (u.headcount <= 0) {
      this.vacateBuilding(u);
      u.fireMission = undefined;
      u.state = "destroyed";
    }
    return true;
  }

  private syncRosterCasualtiesFromStrength(u: Unit, kiaRatio = u.state === "destroyed" ? 0.65 : 0.2) {
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
      if (this.random() < kiaRatio) roster.kia[pick] += 1;
      else roster.wia[pick] += 1;
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
          ammoRemaining: w.ammoRemaining,
          maxAmmo: w.maxAmmo,
          mutexGroup: w.weapon.mutexGroup,
          mutexLocked: false,
        }))
      : u.weapons.map((w) => ({
          id: w.id,
          name: w.name,
          ammo: w.ammo,
          cooldown: w.cooldown,
          ammoRemaining: w.ammoRemaining,
          maxAmmo: w.maxAmmo,
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
            wia: { ...u.subRoster.wia },
            kia: { ...u.subRoster.kia },
            selfRecoveryCap: u.subRoster.selfRecoveryCap,
            assignments: assignments.map((a) => ({
              weaponId: a.slot.id,
              role: a.operatorRole,
              crossManned: a.crossManned,
              efficiency: a.efficiency,
            })),
            abandoned: [...u.subRoster.abandonedWeapons],
          }
        : undefined,
      hasObserver: u.hasObserver,
      isPositionCalibrated: u.isPositionCalibrated,
      fireMission: u.fireMission ? { ...u.fireMission, targetPos: { ...u.fireMission.targetPos } } : undefined,
      indirectAmmo: u.indirectAmmo,
      maxIndirectAmmo: u.maxIndirectAmmo,
      supplyCarried: u.supplyCarried,
      supplyCapacity: u.supplyCapacity,
      veterancy: u.veterancy,
      offMapReconstituteAt: u.offMapReconstituteAt,
      flightAltitude: u.flightAltitude,
      missionProfile: u.missionProfile,
      airState: u.airState,
      fuel: u.fuel,
      maxFuel: u.maxFuel,
      afterburner: u.afterburner,
      turnaroundTimers: u.turnaroundTimers ? { ...u.turnaroundTimers } : undefined,
      isLanded: u.isLanded,
      isForcedLanding: u.isForcedLanding,
    };
  }

  step() {
    this.t += 1;
    for (const u of this.units) {
      u.prevPos = { ...u.pos };
      u.prevHeading = u.heading;
    }
    this.smokeVolumes = this.smokeVolumes.filter((v) => v.expiresAt > this.t);
    this.tickIndirectProjectiles();
    this.tickLogisticsAndRecovery();
    this.tickAviationAndTimers();
    const live = this.onMapAlive();
    this.spot(live);
    for (const u of live) this.tickCooldowns(u);
    for (const u of live) this.tickFireMission(u);
    for (const u of live) this.fire(u);
    for (const u of live) this.bot(u);
  }

  private tickAviationAndTimers() {
    const outerMinX = -this.map.width * 0.48;
    const outerMaxX = this.map.width * 1.48;
    const outerMinY = -this.map.depth * 0.48;
    const outerMaxY = this.map.depth * 1.48;

    for (const u of this.units) {
      if (u.state === "destroyed" || u.type !== "aircraft") continue;

      if (u.airState === "turnaround" && u.turnaroundTimers) {
        const tm = u.turnaroundTimers;
        if (tm.refuelTime > 0) tm.refuelTime -= 1;
        if (tm.repairTime > 0) tm.repairTime -= 1;
        if (tm.rearmTime > 0) tm.rearmTime -= 1;
        if (tm.refuelTime <= 0 && tm.repairTime <= 0 && tm.rearmTime <= 0) {
          u.airState = "at_base";
          u.turnaroundTimers = undefined;
          u.fuel = u.maxFuel;
          u.strength = 100;
          u.morale = 80;
          u.suppression = 0;
          u.afterburner = false;
          for (const w of u.weapons) { w.ammoRemaining = w.maxAmmo; w.cooldown = 0; }
          this.casualtyMarks.delete(u.id);
          this.emit("air_sortie", u, `${u.id} turnaround complete, ready at base`);
        }
        continue;
      }

      if (u.airState === "at_base") continue;

      const st = STATS.aircraft;
      const targetUnit = u.target ? this.get(u.target) : undefined;
      const enemyAirNearby = this.onMapAlive(u.side === "blue" ? "red" : "blue").some(
        (e) => e.type === "aircraft" && dist(u.pos, e.pos) <= 3000,
      );
      u.afterburner = (targetUnit?.type === "aircraft" || enemyAirNearby) && u.airState !== "egress";

      const burn = (st.fuelBurnPerTick ?? 1) * (u.afterburner ? (st.afterburnerMult ?? 3.5) : 1);
      u.fuel = Math.max(0, u.fuel - burn);

      const strikeSlot = u.weapons.find((w) => w.id === "agm_strike");
      const strikeExpended = u.missionProfile === "strike_egress" && !!strikeSlot && strikeSlot.ammoRemaining <= 0;
      const stressAbort = u.suppression >= 65 || u.morale < 30;
      const bingoFuel = u.fuel <= 35;

      if (u.airState !== "egress" && (stressAbort || bingoFuel || strikeExpended)) {
        u.airState = "egress";
        u.afterburner = false;
        const exit = this.nearestAirExit(u.pos);
        u.order = { kind: "air_sortie", dest: exit, missionProfile: u.missionProfile };
        if (stressAbort) {
          this.emit("broken", u, `${u.id} aborted mission under heavy pilot stress and is egressing`);
        } else if (bingoFuel) {
          this.emit("air_sortie", u, `${u.id} bingo fuel, egressing to base`);
        }
      }

      const dest = u.airState === "egress" ? (u.order.dest ?? this.nearestAirExit(u.pos)) : (u.sortieTarget ?? u.order.dest);
      if (dest) {
        const airStep = st.baseSpeedKmH / 3.6;
        const d = dist(u.pos, dest);
        if (u.airState === "egress") {
          const ang = Math.atan2(dest.y - u.pos.y, dest.x - u.pos.x);
          u.heading = ang;
          u.pos = d <= airStep ? { ...dest } : { x: u.pos.x + Math.cos(ang) * airStep, y: u.pos.y + Math.sin(ang) * airStep };
          const atOuterEdge = u.pos.x <= outerMinX || u.pos.x >= outerMaxX || u.pos.y <= outerMinY || u.pos.y >= outerMaxY || d <= airStep;
          if (atOuterEdge) {
            const totalMax = u.weapons.reduce((s, w) => s + w.maxAmmo, 0);
            const totalRem = u.weapons.reduce((s, w) => s + w.ammoRemaining, 0);
            const usedFrac = totalMax > 0 ? (totalMax - totalRem) / totalMax : 0;
            u.airState = "turnaround";
            u.afterburner = false;
            u.target = undefined;
            u.order = { kind: "hold" };
            u.state = "holding";
            u.turnaroundTimers = {
              refuelTime: Math.max(4, Math.ceil((1 - u.fuel / Math.max(1, u.maxFuel)) * 18)),
              repairTime: u.strength < 100 ? Math.max(3, Math.ceil((100 - u.strength) * 0.25)) : 0,
              rearmTime: usedFrac > 0 ? Math.max(4, Math.ceil(usedFrac * 16)) : 0,
            };
            this.emit("air_sortie", u, `${u.id} returned to base for turnaround`);
          }
        } else if (u.airState === "ingress" && d > 450) {
          const ang = Math.atan2(dest.y - u.pos.y, dest.x - u.pos.x);
          u.heading = ang;
          u.pos = { x: u.pos.x + Math.cos(ang) * airStep, y: u.pos.y + Math.sin(ang) * airStep };
        } else {
          u.airState = "on_station";
          // Orbit around sortieTarget
          const orbitR = 450;
          const curAng = Math.atan2(u.pos.y - dest.y, u.pos.x - dest.x);
          const nextAng = curAng + airStep / orbitR;
          const nextPos = { x: dest.x + Math.cos(nextAng) * orbitR, y: dest.y + Math.sin(nextAng) * orbitR };
          u.heading = Math.atan2(nextPos.y - u.pos.y, nextPos.x - u.pos.x);
          u.pos = nextPos;
        }
      }
    }
  }

  private rearmUnit(u: Unit, maxFrac: number, budget = Infinity): number {
    let spent = 0;
    const stepSlot = (cur: number, max: number) => {
      if (cur >= max || spent >= budget) return cur;
      const add = Math.min(max - cur, Math.max(1, Math.ceil(max * maxFrac)));
      spent += 0.5;
      return cur + add;
    };
    if (u.subRoster) {
      for (const w of u.subRoster.weapons) w.ammoRemaining = stepSlot(w.ammoRemaining, w.maxAmmo);
    } else {
      for (const w of u.weapons) w.ammoRemaining = stepSlot(w.ammoRemaining, w.maxAmmo);
    }
    if (u.indirectAmmo < u.maxIndirectAmmo && spent < budget) {
      const add = Math.min(u.maxIndirectAmmo - u.indirectAmmo, Math.max(1, Math.ceil(u.maxIndirectAmmo * maxFrac)));
      u.indirectAmmo += add;
      spent += Math.max(1, add * 0.5);
    }
    return spent;
  }

  private tickLogisticsAndRecovery() {
    const fobs = this.onMapAlive().filter((u) => u.type === "fob");
    const trucks = this.onMapAlive().filter((u) => u.type === "supply_truck");
    const fobRadius = STATS.fob.supplyRadius ?? 220;
    const truckRadius = STATS.supply_truck.supplyRadius ?? 150;

    // 1. FOB loads SupplyVehicles & directly supplies/heals frontline units inside radius
    const fobCovered = new Set<string>();
    for (const fob of fobs) {
      for (const u of this.onMapAlive(fob.side)) {
        if (u.id === fob.id || u.type === "fob" || dist(u.pos, fob.pos) > fobRadius) continue;
        if (u.type === "supply_truck") {
          if (u.supplyCarried < u.supplyCapacity) {
            u.supplyCarried = Math.min(u.supplyCapacity, u.supplyCarried + 25);
            this.pushSupplyEvent(fob.id, u.id, u.pos);
          }
          continue;
        }
        if (u.type === "helicopter" && !u.isLanded) continue;
        fobCovered.add(u.id);
        let transferred = this.rearmUnit(u, u.type === "helicopter" ? 0.5 : 0.35) > 0;
        if (!u.subRoster && u.strength < 100) {
          u.strength = Math.min(100, u.strength + (u.type === "helicopter" ? 10 : 8));
          if (u.type === "helicopter" && u.strength >= 30) u.isForcedLanding = false;
          transferred = true;
        }
        if (u.subRoster) {
          const wiaSum = SPECIALIST_ROLES.reduce((s, r) => s + u.subRoster!.wia[r], 0);
          if (wiaSum > 0) {
            u.subRoster.fieldAidProgress += 1.0;
            while (u.subRoster.fieldAidProgress >= 1 && this.healOneWia(u)) {
              u.subRoster.fieldAidProgress -= 1;
              transferred = true;
            }
          }
        }
        if (transferred) this.pushSupplyEvent(fob.id, u.id, u.pos);
      }
    }

    // 2. SupplyVehicles distribute ammo, repair vehicles, and heal WIA (consuming supplyCarried)
    for (const sv of trucks) {
      if (sv.supplyCarried <= 0) continue;
      for (const u of this.onMapAlive(sv.side)) {
        if (sv.supplyCarried <= 0) break;
        if (u.type === "fob" || u.type === "supply_truck" || u.type === "aircraft" || fobCovered.has(u.id) || dist(u.pos, sv.pos) > truckRadius) continue;
        if (u.type === "helicopter" && !u.isLanded) continue;
        let transferred = false;
        // SupplyVehicle CANNOT rearm helicopter weapons and caps helicopter repair at 50% HP
        if (u.type !== "helicopter") {
          const ammoSpent = this.rearmUnit(u, 0.25, sv.supplyCarried);
          if (ammoSpent > 0) {
            sv.supplyCarried = Math.max(0, sv.supplyCarried - ammoSpent);
            transferred = true;
          }
        }
        const repairCap = u.type === "helicopter" ? 50 : 100;
        if (!u.subRoster && u.strength < repairCap && sv.supplyCarried > 0) {
          const heal = Math.min(repairCap - u.strength, u.type === "helicopter" ? 4 : 2.5);
          u.strength += heal;
          if (u.type === "helicopter" && u.strength >= 30) u.isForcedLanding = false;
          sv.supplyCarried = Math.max(0, sv.supplyCarried - heal * 0.5);
          transferred = true;
        }
        if (u.subRoster && sv.supplyCarried > 0) {
          const wiaSum = SPECIALIST_ROLES.reduce((s, r) => s + u.subRoster!.wia[r], 0);
          if (wiaSum > 0) {
            u.subRoster.fieldAidProgress += 0.35;
            if (u.subRoster.fieldAidProgress >= 1 && this.healOneWia(u)) {
              u.subRoster.fieldAidProgress -= 1;
              sv.supplyCarried = Math.max(0, sv.supplyCarried - 3);
              transferred = true;
            }
          }
        }
        if (transferred) this.pushSupplyEvent(sv.id, u.id, u.pos);
      }
    }

    // 3. Out-of-combat infantry self-aid (slow, capped at selfRecoveryCap)
    for (const u of this.onMapAlive()) {
      const roster = u.subRoster;
      if (!roster) continue;
      const wiaSum = SPECIALIST_ROLES.reduce((s, r) => s + roster.wia[r], 0);
      if (
        wiaSum > 0 &&
        u.headcount < roster.selfRecoveryCap &&
        !u.target &&
        u.state !== "broken" &&
        u.state !== "pinned" &&
        this.t - u.lastHitAt >= 15 &&
        this.t - u.lastFiredAt >= 15
      ) {
        roster.selfAidProgress += 0.08;
        while (roster.selfAidProgress >= 1 && u.headcount < roster.selfRecoveryCap && this.healOneWia(u)) {
          roster.selfAidProgress -= 1;
        }
      }
    }

    // 4. Off-map KIA reconstitution return (veterancy preserved, ammo & morale reset)
    for (const u of this.units) {
      if (u.state === "destroyed" || u.offMapReconstituteAt === undefined) continue;
      if (this.t >= u.offMapReconstituteAt) {
        u.offMapReconstituteAt = undefined;
        u.pos = { ...(u.reconstituteEntryPos ?? u.rally ?? { x: 20, y: 1500 }) };
        u.prevPos = { ...u.pos };
        u.strength = 100;
        u.morale = 80;
        u.suppression = 0;
        u.state = "holding";
        u.order = { kind: "hold" };
        u.indirectAmmo = u.maxIndirectAmmo;
        for (const w of u.weapons) { w.ammoRemaining = w.maxAmmo; w.cooldown = 0; }
        if (u.subRoster) {
          const fresh = createDefaultSubRoster(u.type);
          if (fresh) u.subRoster = fresh;
          this.reconcileSubRoster(u);
        }
        this.casualtyMarks.delete(u.id);
        this.emit("arrived", u, `${u.id} reconstituted and returned to map (veterancy ${u.veterancy.toFixed(1)} preserved)`);
      }
    }
  }

  private tickIndirectProjectiles() {
    const remaining: IndirectProjectile[] = [];
    for (const p of this.indirectProjectiles) {
      p.timeRemaining -= 1;
      if (p.timeRemaining > 0) {
        remaining.push(p);
        continue;
      }
      const by = this.get(p.shooterId);
      if (p.ammo === "Smoke") {
        const radius = p.smokeRadius ?? 75;
        const groundZ = this.map.elevationAt(p.to);
        this.smokeVolumes.push({
          id: ++this.smokeSeq,
          center: { ...p.to },
          radius,
          minZ: groundZ,
          height: 18,
          transmittancePer100m: 0.005,
          expiresAt: this.t + 60,
        });
        this.pushShotEvent({
          t: this.t,
          shooterId: p.shooterId,
          from: { ...p.from },
          fromZ: p.fromZ,
          to: { ...p.to },
          toZ: groundZ,
          ammo: "HE",
          artilleryAmmo: "Smoke",
          smokeRadius: radius,
          weaponClass: "heavy_weapon",
          hit: true,
          penetrated: false,
          damageDealt: 0,
          blastRadius: radius,
        });
      } else {
        this.applyHeArtilleryBlast(
          p.to,
          p.penContact,
          p.d0,
          p.yieldDamage,
          p.yieldSuppression,
          p.blastHeightOffset,
          by,
          p.ammo,
          p.from,
          p.fromZ,
        );
      }
    }
    this.indirectProjectiles = remaining;
  }

  private tickFireMission(u: Unit) {
    const fm = u.fireMission;
    if (!fm || u.state === "destroyed" || u.state === "broken" || u.state === "pinned") return;
    if (fm.cooldown > 0) {
      fm.cooldown = Math.max(0, fm.cooldown - this.moraleRofRate(u));
      if (fm.cooldown > 0) return;
    }
    const spec = STATS[u.type].indirect;
    if (!spec) { u.fireMission = undefined; return; }
    if (u.indirectAmmo <= 0) {
      u.fireMission = undefined;
      if (u.order.kind === "fire_mission") u.order = { kind: "hold" };
      this.emit("fire_mission", u, `${u.id} out of indirect ammunition`);
      return;
    }
    u.indirectAmmo -= 1;

    u.heading = Math.atan2(fm.targetPos.y - u.pos.y, fm.targetPos.x - u.pos.x);
    const r = fm.dispersionRadius * Math.sqrt(this.random());
    const ang = this.random() * Math.PI * 2;
    const rawX = fm.targetPos.x + Math.cos(ang) * r;
    const rawY = fm.targetPos.y + Math.sin(ang) * r;
    const impactPos = {
      x: Math.min(this.map.width - 5, Math.max(5, rawX)),
      y: Math.min(this.map.depth - 5, Math.max(5, rawY)),
    };
    const flightTime = Math.max(2, Math.round(dist(u.pos, impactPos) / 300));
    const isAirburst = fm.effectiveAmmo === "HE_Airburst";
    const blastHeightOffset = isAirburst ? 15 : 0;
    const fromZ = this.map.elevationAt(u.pos) + this.unitEyeHeight(u);
    const toZ = this.map.elevationAt(impactPos) + blastHeightOffset;

    this.indirectProjectiles.push({
      id: ++this.indirectSeq,
      shooterId: u.id,
      side: u.side,
      from: { ...u.pos },
      fromZ,
      to: impactPos,
      toZ,
      ammo: fm.effectiveAmmo,
      timeRemaining: flightTime,
      totalFlightTime: flightTime,
      penContact: isAirburst ? spec.penContact * 0.5 : spec.penContact,
      d0: isAirburst ? spec.d0 * 5 : spec.d0,
      yieldDamage: spec.yieldDamage,
      yieldSuppression: spec.yieldSuppression,
      blastHeightOffset,
      smokeRadius: fm.effectiveAmmo === "Smoke" ? 75 : undefined,
    });

    u.lastFiredAt = this.t;
    u.weaponClass = "heavy_weapon";
    u.muzzleSignature = STATS[u.type].muzzleSignature;

    if (fm.phase === "ranging") {
      fm.rangingFired += 1;
      fm.dispersionRadius *= 0.5;
      fm.cooldown = spec.rangingIntervalSec;
      if (fm.rangingFired >= fm.rangingNeeded) {
        fm.phase = "ffe";
        fm.calibratedThisMission = true;
        if (spec.supportsCalibration) u.isPositionCalibrated = true;
      }
    } else {
      fm.salvoRemaining -= 1;
      fm.cooldown = spec.salvoIntervalSec;
      if (fm.salvoRemaining <= 0) {
        u.fireMission = undefined;
        if (u.order.kind === "fire_mission") u.order = { kind: "hold" };
      }
    }
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
    const hasOpts = ignoreBuildingIds.length > 0 || this.smokeVolumes.length > 0;
    return this.map.sightline(
      o.pos,
      this.unitEyeHeight(o),
      e.pos,
      this.unitEyeHeight(e),
      hasOpts
        ? {
            ...(ignoreBuildingIds.length > 0 ? { ignoreBuildingIds } : {}),
            ...(this.smokeVolumes.length > 0 ? { dynamicVolumes: this.smokeVolumes } : {}),
          }
        : undefined,
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

  private isAirborneTarget(u: Unit): boolean {
    if (u.type === "aircraft") return u.airState !== "turnaround" && u.airState !== "at_base";
    if (u.type === "helicopter") return !u.isLanded;
    return false;
  }

  private canWeaponEngageTarget(attacker: Unit, weapon: Pick<WeaponSlot, "id" | "targetDomain" | "range">, target: Unit, d: number): boolean {
    if (d > weapon.range) return false;
    const domain = weapon.targetDomain ?? "ground";
    const airborne = this.isAirborneTarget(target);
    if (airborne) {
      if (domain === "ground") return false;
      if (weapon.id === "shorad_autocannon" && target.type === "aircraft" && target.flightAltitude === "high") return false;
      if (attacker.type === "sam" && target.type === "aircraft" && target.flightAltitude === "low" && d > 2800) return false;
      return true;
    }
    return domain === "ground" || domain === "both";
  }

  private canAnyWeaponEngage(attacker: Unit, target: Unit, d: number): boolean {
    if (attacker.subRoster) {
      return !this.isAirborneTarget(target) && attacker.subRoster.weapons.some((w) => w.ammoRemaining > 0 && d <= w.weapon.range);
    }
    return attacker.weapons.some((w) => w.ammoRemaining > 0 && this.canWeaponEngageTarget(attacker, w, target, d));
  }

  // ---------- Phase 2B direct-fire combat, accuracy tiers, armor & penetration ----------
  computeSlotHitChance(attacker: Unit, slot: Pick<WeaponSlot, "accuracy" | "range"> & { id?: string }, target: Unit, distance: number, efficiency = 1.0): number {
    const perc = attacker.ownPerception.get(target.id) ?? "none";
    const opticsMult = OWN_PERCEPTION_ACCURACY[perc];
    const attMods = this.unitModifiers(attacker);
    const stateMult = attacker.type === "aircraft" ? 1.0 : attacker.state === "moving" ? 0.65 : attacker.state === "pinned" ? 0.45 : 1.0;
    const suppMult = Math.max(0.25, 1 - attacker.suppression / 160);
    const moraleAccMult = 0.5 + 0.5 * (attacker.morale / 100);
    const rangeMult = Math.max(0.5, 1 - 0.35 * (distance / Math.max(1, slot.range)));

    let airMult = 1.0;
    if (this.isAirborneTarget(target)) {
      if (attacker.type === "sam") {
        airMult = target.type === "aircraft" && target.flightAltitude === "high" ? 1.15 : 0.22;
      } else if (attacker.type === "shorad") {
        airMult = target.type === "aircraft" && target.flightAltitude === "high" ? 0.1 : 1.0;
      } else if (attacker.type === "aircraft" && target.type === "aircraft") {
        if (attacker.flightAltitude === "high" && target.flightAltitude === "low") airMult = 1.4;
        else if (attacker.flightAltitude === "low" && target.flightAltitude === "high") airMult = 0.75;
      }
    }

    const raw =
      slot.accuracy *
      opticsMult *
      efficiency *
      moraleAccMult *
      (attacker.strength / 100) *
      suppMult *
      stateMult *
      (attMods.attackMult ?? 1) *
      rangeMult *
      airMult;
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
    for (const e of this.onMapAlive()) {
      if (e.side === u.side || e.embarkedIn) continue;
      const d = dist(u.pos, e.pos);
      if (d > maxR || !this.canAnyWeaponEngage(u, e, d)) continue;
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
      (w) =>
        w.cooldown <= 0 &&
        w.ammoRemaining > 0 &&
        (!w.mutexGroup || (u.mutexCooldowns.get(w.mutexGroup) ?? 0) <= 0) &&
        this.canWeaponEngageTarget(u, w, target, d),
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
      slot: Omit<WeaponSlot, "cooldown" | "ammoRemaining">;
      efficiency: number;
      onFired: () => void;
    }[] = [];

    if (u.subRoster) {
      for (const a of this.assignInfantryWeapons(u)) {
        if (transport && a.slot.weapon.weaponClass === "heavy_weapon") continue; // no backblast weapons from firing ports
        const effRange = transport ? Math.min(a.slot.weapon.range * 0.5, 300) : a.slot.weapon.range;
        const portMult = transport ? 0.5 : 1.0;
        if (a.slot.cooldown <= 0 && a.slot.ammoRemaining > 0 && d <= effRange) {
          shots.push({
            slot: { ...a.slot.weapon, range: effRange, maxAmmo: a.slot.maxAmmo },
            efficiency: a.efficiency * portMult,
            onFired: () => {
              a.slot.ammoRemaining = Math.max(0, a.slot.ammoRemaining - 1);
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
            w.ammoRemaining = Math.max(0, w.ammoRemaining - 1);
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
    for (const o of this.onMapAlive(target.side)) {
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
    const targetH = this.isAirborneTarget(target) || target.garrison
      ? this.unitEyeHeight(target)
      : target.traits.includes("armored")
        ? 1.4
        : 0.8;
    for (const s of shots) {
      if (target.state === "destroyed") break;
      const hitChance = this.computeSlotHitChance(u, s.slot, target, d, s.efficiency);
      const hit = this.random() <= hitChance;
      const { penetrated, hitAspect, blastPos } = this.evaluateArmorPenetration(s.slot, u, target, d, hit);

      let dmg = 0;
      let supp = 0;
      if (penetrated) {
        let airDmgMult = 1.0;
        if (u.type === "aircraft" && target.type === "aircraft" && u.flightAltitude === "high" && target.flightAltitude === "low") {
          airDmgMult = 1.25;
        } else if (u.type === "sam" && target.type === "aircraft" && target.flightAltitude === "low") {
          airDmgMult = 0.6;
        } else if (u.type === "shorad" && target.type === "aircraft" && target.flightAltitude === "high") {
          airDmgMult = 0.4;
        }
        dmg = s.slot.damage * (0.85 + 0.3 * this.random()) * (targetMods.damageMult ?? 1) * airDmgMult;
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
    artilleryAmmo: ArtilleryAmmoType = blastHeightOffset > 0 ? "HE_Airburst" : "HE_Impact",
    fromPos?: Vec,
    fromZ?: number,
  ) {
    const maxRadius = Math.max(20, d0 * 6);
    let totalDmg = 0;
    let anyPen = false;
    for (const u of this.onMapAlive()) {
      if (u.embarkedIn) continue;
      const d = dist(u.pos, blastPos);
      if (d > maxRadius) continue;
      const falloff = 1 / (1 + (d / Math.max(0.5, d0)) ** 2);
      const mods = this.unitModifiers(u);
      const isFob = u.type === "fob";
      const fobDmgMult = isFob ? 0.25 : 1;
      const fobSuppMult = isFob ? 0.2 : 1;
      const isOpenUnarmored = !isFob && !u.traits.includes("armored") && !u.garrison && this.map.terrainIdAt(u.pos) === "open";

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
          u.traits.includes("armored") || isFob,
        );
        if (penRes.penetrated) anyPen = true;
        const dmg = penRes.penetrated ? yieldDamage * falloff * (mods.damageMult ?? 1) * fobDmgMult : 0;
        const supp = yieldSuppression * falloff * (mods.suppressionMult ?? 1) * fobSuppMult;
        totalDmg += dmg;
        this.hit(u, dmg, supp, by);
      }
    }
    const groundZ = this.map.elevationAt(blastPos);
    this.pushShotEvent({
      t: this.t,
      shooterId: by?.id ?? "Artillery",
      from: fromPos ? { ...fromPos } : { x: blastPos.x - 40, y: blastPos.y },
      fromZ: fromZ ?? groundZ + 120 + blastHeightOffset,
      to: { ...blastPos },
      toZ: groundZ + blastHeightOffset,
      ammo: "HE",
      artilleryAmmo,
      blastHeightOffset,
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
      if (by) {
        this.combatFeatUntil[by.side] = this.t + COMBAT_FEAT_WINDOW;
        by.veterancy = Math.min(5, by.veterancy + Math.min(0.15, dmg * 0.005));
      }
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
    // Helicopter ForcedLanding (< 30% HP) when remaining HP >= 8 and not burst-overkilled
    if (u.type === "helicopter" && !u.isLanded && !u.isForcedLanding && u.strength < 30 && u.strength >= 8 && dmg < 45) {
      u.isForcedLanding = true;
      u.isLanded = true;
      u.order = { kind: "hold" };
      u.state = "holding";
      for (const pid of [...u.embarkedIds]) {
        const p = this.get(pid);
        if (p) {
          this.disembark(p);
          if (p.state !== "destroyed") this.hit(p, 4, 12, by);
        }
      }
      this.emit("forced_landing", u, `${u.id} forced-landed (<30% HP); embarked infantry evacuated`);
      return;
    }

    if (u.strength < 8) {
      this.vacateBuilding(u);
      for (const pid of [...u.embarkedIds]) {
        const p = this.get(pid);
        if (p) this.disembark(p);
      }
      u.fireMission = undefined;
      u.state = "destroyed";
      this.syncRosterCasualtiesFromStrength(u, 0.7);
      this.emit("destroyed", u, `${u.id} has been destroyed`);
      if (by) {
        by.veterancy = Math.min(5, by.veterancy + 0.5);
        this.emit("enemy_destroyed", by, `destroyed enemy ${STATS[u.type].label}`);
      }
    } else if (dmg > 0) {
      this.syncRosterCasualtiesFromStrength(u, dmg >= 25 ? 0.45 : 0.2);
    }
  }

  // ---------- platoon bot (finite state machine) ----------
  private updateMoraleAndEvents(u: Unit, recentlyHit: boolean) {
    const events: MoraleEventKind[] = [];
    const fobR = STATS.fob.supplyRadius ?? 220;
    const svR = STATS.supply_truck.supplyRadius ?? 150;
    const inSupply =
      this.supplyNodes.some((n) => n.side === u.side && dist(u.pos, n.pos) <= n.radius) ||
      this.onMapAlive(u.side).some(
        (s) =>
          (s.type === "fob" && dist(u.pos, s.pos) <= fobR) ||
          (s.type === "supply_truck" && s.supplyCarried > 0 && s.id !== u.id && dist(u.pos, s.pos) <= svR),
      );
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
      const visibleEnemies = this.onMapAlive().filter(
        (e) => e.side !== u.side && !e.embarkedIn && (u.ownPerception.get(e.id) ?? "none") !== "none",
      ).length;
      const nearbyFriendlies = this.onMapAlive(u.side).filter((f) => !f.embarkedIn && dist(u.pos, f.pos) <= 600).length;
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

    const isAirExempt = u.type === "aircraft" || (u.type === "helicopter" && u.isForcedLanding);
    if (!isAirExempt && u.state !== "broken" && !u.embarkedIn && u.order.kind !== "withdraw_off_map" && (u.strength < 30 || u.morale < 20)) {
      if (u.garrison) this.vacateBuilding(u);
      u.fireMission = undefined;
      u.state = "broken";
      u.roe = "return_fire";
      u.order = { kind: "withdraw", dest: u.rally };
      this.emit("broken", u, "unit is combat ineffective and falling back on its own");
    }
    if (u.type === "aircraft") return;
    if (u.state === "moving" || u.state === "holding") {
      if (u.suppression > 60 && u.order.kind !== "withdraw" && u.order.kind !== "withdraw_off_map") {
        u.state = "pinned";
        this.emit("pinned", u, "pinned down, cannot move");
      }
    } else if (u.state === "pinned" && u.suppression < 30) {
      u.state = u.order.dest && u.order.kind !== "fire_mission" ? "moving" : "holding";
      this.emit("recovered", u, "no longer pinned, resuming orders");
    }
    if (!u.embarkedIn && (u.state === "moving" || u.state === "holding") && u.order.dest && u.order.kind !== "fire_mission") {
      const standoff =
        u.order.kind === "attack" &&
        this.onMapAlive().some(
          (e) =>
            e.side !== u.side &&
            dist(u.pos, e.pos) <= STATS[u.type].range * 0.75 &&
            (u.ownPerception.get(e.id) ?? "none") !== "none",
        );
      u.state = standoff ? "holding" : "moving";
    }

    if (!u.embarkedIn && !(u.type === "helicopter" && u.isLanded) && (u.state === "moving" || u.state === "broken") && u.order.dest && u.order.kind !== "fire_mission") {
      u.settledTicks = 0;
      this.move(u, u.order.dest);
    } else {
      u.settledTicks += 1;
    }
  }

  private canOccupy(u: Unit, p: Vec): boolean {
    if (u.type === "helicopter" && !u.isLanded) return this.map.inBounds(p);
    if (!this.map.inBounds(p) || !this.map.isPassable(p, u.mobility)) return false;
    const bld = this.map.buildingAt(p);
    if (!bld) return true;
    if (u.order.garrison?.buildingId === bld.id) return true;
    return this.map.buildingAt(u.pos)?.id === bld.id;
  }

  private exitOffMap(u: Unit) {
    const cost = STATS[u.type].reinforceCost;
    if (this.sideResources[u.side] < cost) {
      u.order = { kind: "hold" };
      if (u.state === "moving") u.state = "holding";
      this.emit("arrived", u, `insufficient requisition (${this.sideResources[u.side]}/${cost}) for reconstitution`);
      return;
    }
    this.sideResources[u.side] -= cost;
    if (u.garrison) this.vacateBuilding(u);
    u.target = undefined;
    u.reconstituteEntryPos = { ...u.pos };
    u.offMapReconstituteAt = this.t + 15;
    u.order = { kind: "hold" };
    u.state = "holding";
    for (const side of ["blue", "red"] as Side[]) {
      if (side !== u.side) this.contacts[side].delete(u.id);
    }
    for (const other of this.units) other.ownPerception.delete(u.id);
    this.emit("arrived", u, `${u.id} withdrew off-map for reconstitution (-${cost} req)`);
  }

  private move(u: Unit, dest: Vec) {
    if (u.garrison) this.vacateBuilding(u);
    u.isPositionCalibrated = false;
    u.fireMission = undefined;
    const d = dist(u.pos, dest);
    if (u.order.kind === "withdraw_off_map") {
      const nearEdge = u.pos.x <= 25 || u.pos.x >= this.map.width - 25 || u.pos.y <= 25 || u.pos.y >= this.map.depth - 25;
      if (nearEdge || d <= 20) {
        this.exitOffMap(u);
        return;
      }
    }
    const isFlyingHelo = u.type === "helicopter" && !u.isLanded;
    const speedMult = isFlyingHelo ? 1.0 : this.map.terrainDefAt(u.pos).speedMultiplier;
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
        if (u.order.kind === "withdraw_off_map") {
          this.exitOffMap(u);
          return;
        }
        u.order = { kind: "hold" };
        if (u.state === "moving") u.state = "holding";
        return;
      }
      u.heading = Math.atan2(dest.y - u.pos.y, dest.x - u.pos.x);
      u.pos = { ...dest };
      u.stuckTicks = 0;
      if (u.order.kind === "withdraw_off_map") {
        this.exitOffMap(u);
        return;
      }
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
