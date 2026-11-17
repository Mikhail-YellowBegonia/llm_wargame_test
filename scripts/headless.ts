// Headless run without any LLM: verifies Phase 1A geo-substrate invariants and runs Kessel scenario.
// Usage: npm run headless [-- seed]
import assert from "node:assert/strict";
import { GameMap, TERRAIN_DEFS, TERRAIN_IDS } from "../src/sim/map";
import { buildScenario } from "../src/sim/scenario";
import {
  MORALE_SHAKEN_MIDPOINT,
  MORALE_WORRIED_MIDPOINT,
  World,
  evaluateHePenetration,
  getMoraleTier,
  isCowering,
} from "../src/sim/world";
import { asciiMap } from "../src/render/ascii";

function verifyPhase1A() {
  assert.equal(TERRAIN_IDS.length, 11, "Expected 11 canonical TerrainId types");
  for (const id of TERRAIN_IDS) {
    const def = TERRAIN_DEFS[id];
    assert.ok(def && def.transmittancePer100m > 0 && def.transmittancePer100m <= 1, `Invalid terrain def ${id}`);
  }

  const m = new GameMap(1000, 1000, 1, { empty: true });

  // 1. tall_grass tag differentiation: infantry/low_profile concealed, tall_profile neutral
  m.paint({ x: 200, y: 200 }, 50, "tall_grass");
  assert.equal(m.terrainIdAt({ x: 200, y: 200 }), "tall_grass");
  assert.ok((m.getTerrainModifiers({ x: 200, y: 200 }, ["infantry"]).signatureMult ?? 1) < 1);
  assert.ok((m.getTerrainModifiers({ x: 200, y: 200 }, ["low_profile"]).signatureMult ?? 1) < 1);
  assert.equal(m.getTerrainModifiers({ x: 200, y: 200 }, ["tall_profile"]).signatureMult, 1.0);

  // 2. Passability checks
  m.paint({ x: 800, y: 800 }, 30, "shallow_stream");
  assert.equal(m.isPassable({ x: 800, y: 800 }, "foot"), true);
  assert.equal(m.isPassable({ x: 800, y: 800 }, "wheeled"), false);

  // 3. Beer-Lambert forest attenuation vs elevated ray over tall_grass / hedgerow + ridge defilade
  m.paint({ x: 500, y: 200 }, 50, "hedgerow"); // 3m canopy
  const highOverGrassAndHedge = m.sightline({ x: 100, y: 200 }, 5, { x: 700, y: 200 }, 5);
  assert.equal(highOverGrassAndHedge.blocked, false);
  assert.equal(highOverGrassAndHedge.transmittance, 1, "Elevated ray above 1.5m/3m canopy must pass unattenuated");

  const lowThroughHedge = m.sightline({ x: 400, y: 200 }, 1.5, { x: 600, y: 200 }, 1.5);
  assert.equal(lowThroughHedge.blocked, false);
  assert.ok(lowThroughHedge.transmittance > 0 && lowThroughHedge.transmittance < 0.2, "Low ray through hedgerow should attenuate");

  m.paint({ x: 500, y: 500 }, 100, "dense_forest");
  const forestRay = m.sightline({ x: 350, y: 500 }, 2, { x: 650, y: 500 }, 2);
  assert.equal(forestRay.blocked, false);
  assert.ok(forestRay.opticalDepth > 1 && forestRay.transmittance < 0.05, "Dense forest should accumulate Beer-Lambert attenuation");

  const smokeRay = m.sightline({ x: 100, y: 800 }, 2, { x: 400, y: 800 }, 2, {
    dynamicVolumes: [{ center: { x: 250, y: 800 }, radius: 50, height: 15, transmittancePer100m: 0.02 }],
  });
  assert.ok(smokeRay.transmittance < 0.05, "Dynamic smoke volume hook should attenuate sightline");

  m.addHill({ x: 500, y: 900 }, 40, 25);
  const hillBlocked = m.sightline({ x: 300, y: 900 }, 2, { x: 700, y: 900 }, 2);
  assert.equal(hillBlocked.blocked, true);
  assert.equal(hillBlocked.blockReason, "terrain");
  assert.equal(hillBlocked.transmittance, 0);

  // 4. Multi-story Building & conservative floor destruction
  m.addBuilding({
    id: "bld_1",
    footprint: [{ x: 480, y: 680 }, { x: 520, y: 680 }, { x: 520, y: 720 }, { x: 480, y: 720 }],
    center: { x: 500, y: 700 },
    groundElevation: 0,
    roofHeight: 11,
    floors: [
      { level: 1, elevationOffset: 1.5, capacity: 12, integrity: 100, state: "intact", occupants: [], modifiers: { damageMult: 0.5, signatureMult: 0.5 } },
      { level: 2, elevationOffset: 4.7, capacity: 10, integrity: 100, state: "intact", occupants: ["Alpha 1"], modifiers: { damageMult: 0.5, signatureMult: 0.6 } },
      { level: 3, elevationOffset: 7.9, capacity: 8, integrity: 100, state: "intact", occupants: [], modifiers: { damageMult: 0.6, signatureMult: 0.7 } },
    ],
  });
  assert.equal(m.canGarrisonFloor("bld_1", 2, 10), true);
  assert.equal(m.canGarrisonFloor("bld_1", 2, 15), false);
  const gut = m.gutBuildingFloor("bld_1", 2)!;
  assert.deepEqual(gut.evictedOccupants, ["Alpha 1"]);
  assert.ok(gut.casualtyDamage > 0 && gut.suppressionShock > 0);
  assert.equal(m.canGarrisonFloor("bld_1", 2, 4), false, "Gutted floor cannot be garrisoned");
  assert.equal(m.canGarrisonFloor("bld_1", 1, 8), true, "Floor 1 remains intact");
  assert.equal(m.canGarrisonFloor("bld_1", 3, 8), true, "Floor 3 remains accessible");
  assert.equal(m.buildings[0].floors[1].modifiers.damageMult, 1.0);
  const bldBlocked = m.sightline({ x: 300, y: 700 }, 2, { x: 700, y: 700 }, 2);
  assert.equal(bldBlocked.blocked, true);
  assert.equal(bldBlocked.blockReason, "building");
}

verifyPhase1A();
console.log("Phase 1A verification checks passed.");

const seed = Number(process.argv[2] ?? 7);
const { world, map, script, outcome } = buildScenario(seed);

function verifyPhase1B(loaded: GameMap) {
  assert.equal(loaded.width, 4000);
  assert.equal(loaded.depth, 4000);
  assert.equal(loaded.fineCellSize, 10);

  let hedgerowCount = 0, lightForestCount = 0, denseForestCount = 0;
  let streamCell: { x: number; y: number } | undefined;
  let waterCell: { x: number; y: number } | undefined;
  for (let fr = 0; fr < loaded.fineRows; fr++) {
    for (let fc = 0; fc < loaded.fineCols; fc++) {
      const p = { x: (fc + 0.5) * loaded.fineCellSize, y: (fr + 0.5) * loaded.fineCellSize };
      const tid = loaded.terrainIdAt(p);
      if (tid === "hedgerow") hedgerowCount++;
      else if (tid === "light_forest") lightForestCount++;
      else if (tid === "dense_forest") denseForestCount++;
      else if (tid === "shallow_stream" && !streamCell && loaded.slopeAt(p) <= 20) streamCell = p;
      else if (tid === "deep_water" && !waterCell && loaded.slopeAt(p) <= 20) waterCell = p;
    }
  }
  assert.ok(hedgerowCount > 0 && lightForestCount > 0 && denseForestCount > 0, "Tree/hedgerow normalization missing");
  assert.ok(streamCell, "Expected shallow_stream cells from OSM streams/ditches");
  assert.equal(loaded.isPassable(streamCell, "foot"), true, "shallow_stream must be foot-passable");
  assert.equal(loaded.isPassable(streamCell, "wheeled"), false, "shallow_stream must block wheeled");
  assert.ok(waterCell, "Expected deep_water cells from OSM Ulster river/water");
  assert.equal(loaded.isPassable(waterCell, "foot"), false);
  assert.equal(loaded.isPassable(waterCell, "amphibious"), true);

  const multi = loaded.buildings.find((b) => b.floors.length >= 2);
  assert.ok(multi && loaded.buildings.length > 100, "Expected populated multi-story OSM buildings");
  assert.equal(loaded.buildingAt(multi.center)?.id, multi.id, "buildingIdGrid must index building centers");
}

verifyPhase1B(map);
console.log("Phase 1B Fulda Gap asset checks passed.");

function verifyPhase2A() {
  // 1. 10m terrain speedMultiplier & isPassable() barriers (deep_water + shallow_stream for wheeled)
  const mobMap = new GameMap(1000, 1000, 1, { empty: true });
  mobMap.road({ x: 50, y: 200 }, { x: 400, y: 200 }, "paved_road");
  mobMap.paint({ x: 350, y: 500 }, 80, "deep_water");
  mobMap.paint({ x: 350, y: 700 }, 80, "shallow_stream");

  const mobWorld = new World(mobMap, 1);
  const roadTank = mobWorld.add({ id: "RoadTank", side: "blue", type: "tank", pos: { x: 60, y: 200 } });
  const openTank = mobWorld.add({ id: "OpenTank", side: "blue", type: "tank", pos: { x: 60, y: 350 } });
  const waterTank = mobWorld.add({ id: "WaterTank", side: "blue", type: "tank", pos: { x: 200, y: 500 } });
  const wheelCar = mobWorld.add({ id: "WheelCar", side: "blue", type: "ifv", mobility: "wheeled", pos: { x: 200, y: 700 } });

  mobWorld.command(roadTank, { kind: "move", dest: { x: 300, y: 200 } });
  mobWorld.command(openTank, { kind: "move", dest: { x: 300, y: 350 } });
  mobWorld.command(waterTank, { kind: "move", dest: { x: 450, y: 500 } });
  mobWorld.command(wheelCar, { kind: "move", dest: { x: 450, y: 700 } });

  for (let i = 0; i < 20; i++) mobWorld.step();
  assert.ok(roadTank.pos.x > openTank.pos.x + 40, "paved_road speedMultiplier (1.5x) must outpace open (1.0x)");
  assert.notEqual(mobMap.terrainIdAt(waterTank.pos), "deep_water", "Tracked unit must not enter deep_water");
  assert.notEqual(mobMap.terrainIdAt(wheelCar.pos), "shallow_stream", "Wheeled unit must not enter shallow_stream");

  // 2. Infantry BuildingFloor garrisoning: capacity check & elevated 3D sightline over 3m hedgerow
  const garMap = new GameMap(1000, 1000, 1, { empty: true });
  garMap.paint({ x: 300, y: 500 }, 40, "hedgerow"); // 3.0m canopy
  garMap.addBuilding({
    id: "gar_bld",
    footprint: [{ x: 190, y: 490 }, { x: 210, y: 490 }, { x: 210, y: 510 }, { x: 190, y: 510 }],
    center: { x: 200, y: 500 },
    groundElevation: 0,
    roofHeight: 8.5,
    floors: [
      { level: 1, elevationOffset: 1.5, capacity: 4, integrity: 100, state: "intact", occupants: [], modifiers: { damageMult: 0.5, signatureMult: 0.5 } },
      { level: 2, elevationOffset: 4.7, capacity: 10, integrity: 100, state: "intact", occupants: [], modifiers: { damageMult: 0.45, signatureMult: 0.6 } },
    ],
  });
  const garWorld = new World(garMap, 2);
  const squad = garWorld.add({ id: "Inf 1", side: "blue", type: "infantry", pos: { x: 150, y: 500 } });
  const targetTank = garWorld.add({ id: "Tgt", side: "red", type: "tank", pos: { x: 600, y: 500 }, roe: "hold_fire" });

  assert.notEqual(garWorld.garrisonFloor(squad, "gar_bld", 1), "ok", "8-man squad must be rejected from capacity-4 F1");
  assert.equal(garWorld.garrisonFloor(squad, "gar_bld", 2), "ok", "8-man squad must fit capacity-10 F2");
  assert.deepEqual(garMap.buildings[0].floors[1].occupants, ["Inf 1"]);
  assert.equal(garWorld.unitEyeHeight(squad), 4.7);
  garWorld.step();
  assert.equal(squad.ownPerception.get(targetTank.id), "visual", "Elevated F2 observer must see over 3m hedgerow");
  assert.equal(garWorld.vacateBuilding(squad), "ok");
  assert.deepEqual(garMap.buildings[0].floors[1].occupants, []);

  // 2b. Move-then-garrison from >25m & non-garrisoning building obstacle avoidance
  const passTank = garWorld.add({ id: "PassTank", side: "blue", type: "tank", pos: { x: 140, y: 500 } });
  garWorld.command(passTank, { kind: "move", dest: { x: 260, y: 500 } });
  for (let i = 0; i < 20; i++) {
    garWorld.step();
    assert.equal(garMap.buildingAt(passTank.pos), undefined, "Tank must steer around buildings instead of passing through");
  }
  squad.pos = { x: 150, y: 500 };
  assert.equal(garWorld.orderGarrison(squad, "gar_bld", 2), "ok");
  assert.equal(squad.garrison, undefined, "Distant garrison order must walk to building rather than teleporting");
  for (let i = 0; i < 60 && !squad.garrison; i++) garWorld.step();
  assert.deepEqual(squad.garrison, { buildingId: "gar_bld", floorLevel: 2 }, "Squad must garrison upon reaching building");
  assert.equal(garWorld.vacateBuilding(squad), "ok");

  // 3. Two-tier detection: muzzleSignature -> Contact (no UnitType), bodySignature -> Visual (with UnitType)
  const spotMap = new GameMap(3000, 1000, 1, { empty: true });
  spotMap.paint({ x: 1600, y: 500 }, 60, "light_forest");
  const spotWorld = new World(spotMap, 3);
  const obsTank = spotWorld.add({ id: "ObsTank", side: "blue", type: "tank", pos: { x: 650, y: 500 }, roe: "hold_fire" });
  const hiddenAtgm = spotWorld.add({ id: "HiddenATGM", side: "red", type: "atgm", pos: { x: 1600, y: 500 }, roe: "hold_fire" });

  // Settle infantry for 15 ticks out of sightline/visual range
  for (let i = 0; i < 16; i++) spotWorld.step();
  const baseBodySig = spotWorld.computeBodySignature(hiddenAtgm);
  assert.equal(spotWorld.contacts.blue.get(hiddenAtgm.id), undefined, "Concealed stationary ATGM at 1200m must stay undetected");
  assert.equal(obsTank.ownPerception.get(hiddenAtgm.id), "none");

  // Fire from concealment outside Visual range -> Contact with heavy_weapon, type undefined
  hiddenAtgm.roe = "fire_at_will";
  spotWorld.step();
  assert.equal(spotWorld.computeBodySignature(hiddenAtgm), baseBodySig, "Firing must not raise bodySignature");
  const contact = spotWorld.contacts.blue.get(hiddenAtgm.id);
  assert.ok(contact, "Firing muzzle flash must generate a Contact");
  assert.equal(contact.level, "contact");
  assert.equal(contact.weaponClass, "heavy_weapon");
  assert.equal(contact.type, undefined, "Contact must not reveal UnitType before Visual range");

  // Close within Visual threshold -> upgrades to Visual with UnitType === "atgm"
  obsTank.pos = { x: 1520, y: 500 };
  spotWorld.step();
  const visual = spotWorld.contacts.blue.get(hiddenAtgm.id);
  assert.ok(visual);
  assert.equal(visual.level, "visual");
  assert.equal(visual.type, "atgm");
  assert.equal(obsTank.ownPerception.get(hiddenAtgm.id), "visual");
}

verifyPhase2A();
console.log("Phase 2A spotting, mobility & garrison checks passed.");

function verifyPhase2B() {
  // 1. Directional KE/CE Armor: Frontal 30mm AP bounces off tank front (0 damage + suppression), flanking rear penetrates
  const armMap = new GameMap(2000, 1000, 1, { empty: true });
  const armWorld = new World(armMap, 10);
  const shooterIfv = armWorld.add({
    id: "FlankIFV",
    side: "blue",
    type: "ifv",
    pos: { x: 800, y: 500 },
    weapons: [
      {
        id: "autocannon_30mm",
        name: "30mm Autocannon",
        ammo: "AP",
        pen: 7,
        damage: 10,
        suppression: 12,
        range: 1500,
        reloadSec: 1,
        cooldown: 0,
        maxAmmo: 50,
        ammoRemaining: 50,
        accuracy: 1.0,
        weaponClass: "light_weapon",
        muzzleSignature: 1.35,
      },
    ],
  });
  // Target tank facing West (Math.PI) toward IFV at x=800 -> frontal aspect
  const targetTank = armWorld.add({
    id: "TargetMBT",
    side: "red",
    type: "tank",
    pos: { x: 1100, y: 500 },
    heading: Math.PI,
    roe: "hold_fire",
  });
  for (let i = 0; i < 6; i++) armWorld.step();
  assert.equal(targetTank.strength, 100, "Frontal 30mm AP (pen <= 7) must deal 0 HP damage to tank front KE 16");
  assert.ok(targetTank.suppression > 0, "Non-penetrating hits must still apply suppression");

  // Rotate target tank to face East (0) so IFV at x=800 strikes rear KE 3
  targetTank.heading = 0;
  for (let i = 0; i < 6; i++) armWorld.step();
  assert.ok(targetTank.strength < 100, "Flanking rear 30mm AP must penetrate tank rear KE 3");
  assert.ok(shooterIfv.state !== "destroyed");

  // 2. HE Inverse-Square Patch: Pen_contact / (1 + (d_z / d_0)^2) evaluated vs nearest of 4 armor zones
  const tankArmor = targetTank.armor;
  // Blast 1.5m above tank roof (top KE = 2): d_top = 1.5m -> Pen_HE = 6 / (1 + (1.5/2)^2) = 3.84 >= 2
  const airburstPen = evaluateHePenetration(tankArmor, { x: 500, y: 500 }, 0, { x: 500, y: 500 }, 4.0, 6, 2.0, true);
  assert.equal(airburstPen.penetrated, true, "HE burst above roof must penetrate weak top KE 2");
  assert.equal(airburstPen.bestZone, "top");

  // Blast 1m behind rear (rear KE = 3): d_rear = 1m -> Pen_HE = 6 / (1 + (1/2)^2) = 4.8 >= 3
  const rearNearMiss = evaluateHePenetration(tankArmor, { x: 500, y: 500 }, 0, { x: 495.8, y: 500 }, 0, 6, 2.0, true);
  assert.equal(rearNearMiss.penetrated, true, "Close rear HE near-miss must penetrate tank rear KE 3");
  assert.equal(rearNearMiss.bestZone, "rear");

  // Distant blast 12m in front (front KE = 16): fails all zones
  const farMiss = evaluateHePenetration(tankArmor, { x: 500, y: 500 }, 0, { x: 515.2, y: 500 }, 0, 6, 2.0, true);
  assert.equal(farMiss.penetrated, false, "Distant HE blast must fail to penetrate armor");

  // 3. Three-tier ownPerception accuracy scaling: none < contact < visual
  const accMap = new GameMap(2000, 1000, 1, { empty: true });
  const accWorld = new World(accMap, 11);
  const gunTank = accWorld.add({ id: "GunTank", side: "blue", type: "tank", pos: { x: 400, y: 500 } });
  const enemyTarget = accWorld.add({ id: "EnemyTgt", side: "red", type: "ifv", pos: { x: 1000, y: 500 }, roe: "hold_fire" });
  const slot = gunTank.weapons[0];

  gunTank.ownPerception.set(enemyTarget.id, "none");
  const pNone = accWorld.computeSlotHitChance(gunTank, slot, enemyTarget, 600);
  gunTank.ownPerception.set(enemyTarget.id, "contact");
  const pContact = accWorld.computeSlotHitChance(gunTank, slot, enemyTarget, 600);
  gunTank.ownPerception.set(enemyTarget.id, "visual");
  const pVisual = accWorld.computeSlotHitChance(gunTank, slot, enemyTarget, 600);
  assert.ok(pNone < pContact && pContact < pVisual, `ownPerception accuracy must scale monotonically (${pNone} < ${pContact} < ${pVisual})`);

  // 4. Vehicle mutexGroup concurrency lock & Building armor structural resistance
  const mtxWorld = new World(accMap, 12);
  const mtxIfv = mtxWorld.add({ id: "MtxIFV", side: "blue", type: "ifv", pos: { x: 400, y: 500 } });
  const enemyMbt = mtxWorld.add({ id: "EnemyMBT", side: "red", type: "tank", pos: { x: 1200, y: 500 }, roe: "hold_fire" });
  mtxWorld.step();
  assert.ok(mtxIfv.mutexCooldowns.get("turret_loader")! > 0, "Firing TOW/ATGM must lock turret_loader mutexGroup");
  assert.equal(mtxIfv.weapons.find((w) => w.id === "autocannon_30mm")!.cooldown, 0, "Locked autocannon must not fire while turret_loader mutex holds");
  assert.ok(enemyMbt.state !== "destroyed");

  // Building armor check: non-penetrating rifle fire deals 0 integrity loss, penetrating tank HE guts floor
  const bldMap = new GameMap(1000, 1000, 1, { empty: true });
  bldMap.addBuilding({
    id: "fort_bld",
    footprint: [{ x: 490, y: 490 }, { x: 510, y: 490 }, { x: 510, y: 510 }, { x: 490, y: 510 }],
    center: { x: 500, y: 500 },
    groundElevation: 0,
    roofHeight: 5,
    armor: { ke: 4, ce: 6 },
    floors: [
      { level: 1, elevationOffset: 1.5, capacity: 12, integrity: 20, state: "intact", occupants: [], modifiers: { damageMult: 0.4, signatureMult: 0.5 } },
    ],
  });
  const bldWorld = new World(bldMap, 13);
  const garrisonSquad = bldWorld.add({ id: "GarInf", side: "red", type: "infantry", pos: { x: 500, y: 500 }, roe: "hold_fire" });
  bldWorld.garrisonFloor(garrisonSquad, "fort_bld", 1);
  const rifleSquad = bldWorld.add({
    id: "RifleAtk",
    side: "blue",
    type: "infantry",
    pos: { x: 400, y: 500 },
    subRoster: {
      personnel: { rifleman: 4, mg_specialist: 0, at_specialist: 0, marksman: 0, engineer: 0 },
      wia: { rifleman: 0, mg_specialist: 0, at_specialist: 0, marksman: 0, engineer: 0 },
      kia: { rifleman: 0, mg_specialist: 0, at_specialist: 0, marksman: 0, engineer: 0 },
      selfRecoveryCap: 3,
      selfAidProgress: 0,
      fieldAidProgress: 0,
      weapons: [1, 2, 3, 4].map((i) => ({
        id: `r_${i}`,
        isSpecial: false,
        requiredRole: "rifleman" as const,
        abandonPriority: 99,
        unskilledPenalty: 1,
        cooldown: 0,
        maxAmmo: 30,
        ammoRemaining: 30,
        weapon: {
          id: `r_${i}`,
          name: "Rifle",
          ammo: "AP" as const,
          pen: 1,
          damage: 3,
          suppression: 3,
          range: 400,
          reloadSec: 1,
          accuracy: 1,
          weaponClass: "small_arms" as const,
          muzzleSignature: 0.9,
        },
      })),
      abandonedWeapons: [],
    },
  });
  bldWorld.step();
  assert.equal(bldMap.buildings[0].floors[0].integrity, 20, "Non-penetrating rifle AP (pen 1 < KE 4) must deal 0 integrity damage");
  rifleSquad.state = "destroyed";

  const heTank = bldWorld.add({
    id: "HETank",
    side: "blue",
    type: "tank",
    pos: { x: 350, y: 500 },
    weapons: [
      {
        id: "120mm_he",
        name: "120mm HE",
        ammo: "HE",
        pen: 8,
        d0: 4,
        damage: 60,
        suppression: 30,
        range: 2000,
        reloadSec: 1,
        cooldown: 0,
        maxAmmo: 20,
        ammoRemaining: 20,
        accuracy: 1.0,
        weaponClass: "heavy_weapon",
        muzzleSignature: 1.6,
      },
    ],
  });
  bldWorld.step();
  assert.equal(bldMap.buildings[0].floors[0].state, "gutted", "Penetrating HE must deplete floor integrity and gutBuildingFloor()");
  assert.equal(garrisonSquad.garrison, undefined, "Gutted floor must evict occupying squad");
  assert.ok(heTank.state !== "destroyed");

  // 5. InfantrySubRoster casualty weapon takeover
  const infWorld = new World(accMap, 14);
  const squad = infWorld.add({ id: "TakeoverInf", side: "blue", type: "infantry", pos: { x: 200, y: 200 } });
  const initialAssign = infWorld.assignInfantryWeapons(squad);
  assert.equal(initialAssign.find((a) => a.slot.id === "at_launcher")?.crossManned, false);

  // Kill at_specialist -> surviving rifleman drops a rifle to retain AT launcher with unskilledPenalty
  assert.equal(infWorld.inflictRosterCasualty(squad, "at_specialist", 1), true);
  assert.equal(squad.headcount, 7);
  assert.ok(squad.subRoster!.abandonedWeapons.some((id) => id.startsWith("rifle_")), "Primary rifle must be dropped first");
  const crossAssign = infWorld.assignInfantryWeapons(squad);
  const atAfterLoss = crossAssign.find((a) => a.slot.id === "at_launcher");
  assert.ok(atAfterLoss, "AT launcher must be retained");
  assert.equal(atAfterLoss.crossManned, true, "Rifleman must cross-man AT launcher");
  assert.equal(atAfterLoss.operatorRole, "rifleman");
  assert.ok(atAfterLoss.efficiency < 1, "Cross-manning must apply unskilledPenalty");

  // Reduce headcount to 1 (below 2 special weapons) -> MG (abandonPriority 2) dropped, AT (abandonPriority 1) kept
  infWorld.inflictRosterCasualty(squad, "mg_specialist", 1);
  infWorld.inflictRosterCasualty(squad, "rifleman", 5);
  assert.equal(squad.headcount, 1);
  assert.ok(squad.subRoster!.abandonedWeapons.includes("lmg"), "Higher abandonPriority special weapon (MG=2) must be abandoned before AT=1");
  assert.ok(squad.subRoster!.weapons.some((w) => w.id === "at_launcher"), "Lowest abandonPriority AT=1 must remain");
}

verifyPhase2B();
console.log("Phase 2B accuracy, armor, HE inverse-square & infantry takeover checks passed.");

function verifyPhase2C() {
  // 1. SuppressionFloor & Cowering: sustained 0-damage non-penetrating fire stops at shaken midpoint (37.5)
  const morMap = new GameMap(2000, 1000, 1, { empty: true });
  morMap.paint({ x: 500, y: 800 }, 50, "dense_forest");
  const morWorld = new World(morMap, 20);
  const supIfv = morWorld.add({
    id: "SupIFV",
    side: "blue",
    type: "ifv",
    pos: { x: 400, y: 500 },
    weapons: [
      {
        id: "30mm_ap",
        name: "30mm AP",
        ammo: "AP",
        pen: 5,
        damage: 10,
        suppression: 18,
        range: 1500,
        reloadSec: 1,
        cooldown: 0,
        maxAmmo: 50,
        ammoRemaining: 50,
        accuracy: 1.0,
        weaponClass: "light_weapon",
        muzzleSignature: 1.35,
      },
    ],
  });
  const calmTank = morWorld.add({
    id: "CalmTank",
    side: "red",
    type: "tank",
    pos: { x: 900, y: 500 },
    heading: Math.PI,
    roe: "hold_fire",
    morale: 85,
  });
  const baseSig = morWorld.computeBodySignature(calmTank);
  const baseOptics = morWorld.effectiveSpotRange(calmTank);
  const baseDmgMult = morWorld.unitModifiers(calmTank).damageMult ?? 1;

  for (let i = 0; i < 40; i++) morWorld.step();
  assert.equal(calmTank.strength, 100, "Non-penetrating hits must deal 0 HP damage");
  assert.ok(
    calmTank.morale >= MORALE_SHAKEN_MIDPOINT - 1e-6,
    `SuppressionFloor must prevent 0-dmg suppression from dropping morale below ${MORALE_SHAKEN_MIDPOINT} (got ${calmTank.morale})`,
  );
  assert.equal(getMoraleTier(calmTank.morale), "shaken");
  assert.equal(isCowering(calmTank), true, "Entering shaken must trigger Cowering");
  assert.ok(morWorld.computeBodySignature(calmTank) < baseSig, "Cowering must lower bodySignature");
  assert.ok(morWorld.effectiveSpotRange(calmTank) < baseOptics, "Cowering must lower optics range");
  assert.ok((morWorld.unitModifiers(calmTank).damageMult ?? 1) < baseDmgMult, "Cowering must strengthen cover damageMult");
  assert.ok(!supIfv.activeMoraleEvents.includes("CombatFeatBonus"), "0-dmg non-penetrating hits must not trigger CombatFeatBonus");

  // Cover-linked suppression resistance check
  const openInf = morWorld.add({ id: "OpenInf", side: "blue", type: "infantry", pos: { x: 200, y: 200 }, roe: "hold_fire" });
  const forestInf = morWorld.add({ id: "ForestInf", side: "blue", type: "infantry", pos: { x: 500, y: 800 }, roe: "hold_fire" });
  assert.ok(
    morWorld.computeSuppressionResistance(forestInf) < morWorld.computeSuppressionResistance(openInf),
    "Hard cover must increase suppression resistance",
  );

  // 2. IsolationPenalty (halts at worried midpoint 62.5) vs ArtilleryShockPenalty (unbounded to panicked) + SupplyBonus
  const evtMap = new GameMap(2000, 1000, 1, { empty: true });
  const evtWorld = new World(evtMap, 21);
  const loneUnit = evtWorld.add({ id: "Lone", side: "blue", type: "infantry", pos: { x: 500, y: 500 }, morale: 85, roe: "hold_fire" });
  evtWorld.add({ id: "RedA", side: "red", type: "tank", pos: { x: 800, y: 500 }, roe: "hold_fire" });
  evtWorld.add({ id: "RedB", side: "red", type: "tank", pos: { x: 800, y: 550 }, roe: "hold_fire" });
  evtWorld.add({ id: "RedC", side: "red", type: "tank", pos: { x: 800, y: 450 }, roe: "hold_fire" });

  // Simulate active combat while outnumbered 3:1
  for (let i = 0; i < 45; i++) {
    loneUnit.lastHitAt = evtWorld.t; // keep combat active without taking HP damage
    evtWorld.step();
  }
  assert.ok(loneUnit.activeMoraleEvents.includes("IsolationPenalty"), "3:1 outnumbered unit in combat must incur IsolationPenalty");
  assert.ok(
    Math.abs(loneUnit.morale - MORALE_WORRIED_MIDPOINT) < 1.0,
    `IsolationPenalty must halt at worried midpoint (${MORALE_WORRIED_MIDPOINT}, got ${loneUnit.morale})`,
  );

  // Open-terrain unarmored infantry hit by HE artillery breaks to panicked via ArtilleryShockPenalty
  evtWorld.applyHeArtilleryBlast({ x: 505, y: 500 }, 8, 8, 50, 60, 0);
  assert.ok(loneUnit.activeMoraleEvents.includes("ArtilleryShockPenalty"), "Open-terrain HE must trigger ArtilleryShockPenalty");
  assert.equal(getMoraleTier(loneUnit.morale), "panicked", "Unbounded ArtilleryShockPenalty must break morale to panicked");

  // SupplyBonus accelerates morale recovery
  evtWorld.addSupplyNode({ id: "FOB_1", side: "blue", pos: { x: 500, y: 500 }, radius: 150 });
  const beforeSupply = loneUnit.morale;
  loneUnit.lastHitAt = -100;
  evtWorld.step();
  assert.ok(loneUnit.activeMoraleEvents.includes("SupplyBonus"));
  assert.ok(loneUnit.morale > beforeSupply + 1.0, "SupplyBonus must accelerate morale recovery");

  // 3. Vehicle minor patches: embarked firing ports, proportional damage/suppression transfer, wheeled stuck pivot
  const vehMap = new GameMap(1000, 1000, 1, { empty: true });
  vehMap.paint({ x: 400, y: 800 }, 60, "deep_water");
  const vehWorld = new World(vehMap, 22);
  const apc = vehWorld.add({ id: "APC", side: "blue", type: "ifv", pos: { x: 300, y: 300 }, roe: "hold_fire" });
  const embarked = vehWorld.add({ id: "PaxInf", side: "blue", type: "infantry", pos: { x: 250, y: 300 }, roe: "fire_at_will" });
  assert.equal(vehWorld.embark(embarked, apc), "ok");
  assert.deepEqual(apc.embarkedIds, ["PaxInf"]);

  const closeTarget = vehWorld.add({ id: "CloseRed", side: "red", type: "infantry", pos: { x: 500, y: 300 }, roe: "hold_fire" });
  const apcHunter = vehWorld.add({
    id: "Hunter",
    side: "red",
    type: "atgm",
    pos: { x: 700, y: 300 },
    roe: "fire_at_will",
  });
  const startPaxStr = embarked.strength;
  for (let i = 0; i < 12; i++) vehWorld.step();
  assert.ok(closeTarget.strength < 100 || closeTarget.suppression > 0, "Embarked infantry must fire through IFV firing ports within 300m");
  assert.ok(embarked.strength < startPaxStr && embarked.suppression > 0, "Transport hits must transfer proportional damage & suppression to embarked passengers");
  assert.ok(apcHunter.state !== "destroyed");

  // Wheeled stuck-recovery pivot fallback when pathing is blocked by deep_water
  const wheelCar = vehWorld.add({ id: "ReconCar", side: "blue", type: "ifv", mobility: "wheeled", pos: { x: 330, y: 800 }, heading: 0, roe: "hold_fire" });
  vehWorld.command(wheelCar, { kind: "move", dest: { x: 500, y: 800 } });
  const h0 = wheelCar.heading;
  for (let i = 0; i < 5; i++) vehWorld.step();
  assert.notEqual(wheelCar.heading, h0, "Wedged wheeled vehicle must trigger stuck-recovery pivot fallback");
}

verifyPhase2C();
console.log("Phase 2C morale, SuppressionFloor, Cowering, morale events & vehicle patches passed.");

function verifyPhase2D() {
  const vfxMap = new GameMap(2000, 1000, 1, { empty: true });
  const vfxWorld = new World(vfxMap, 25);
  const mover = vfxWorld.add({ id: "GlideTank", side: "blue", type: "tank", pos: { x: 300, y: 500 }, heading: Math.PI / 2 });
  const target = vfxWorld.add({ id: "TargetTank", side: "red", type: "tank", pos: { x: 800, y: 500 }, heading: Math.PI, roe: "hold_fire" });

  vfxWorld.command(mover, { kind: "move", dest: { x: 400, y: 500 } });
  vfxWorld.step();
  assert.equal(mover.prevPos.x, 300, "prevPos must capture start-of-tick position");
  assert.equal(mover.prevHeading, Math.PI / 2, "prevHeading must capture start-of-tick heading");
  assert.ok(mover.pos.x > 300, "pos must advance during step()");
  assert.ok(Math.abs(mover.heading) < 0.01, "heading must rotate toward destination");
  assert.ok(vfxWorld.shotEvents.length > 0, "fire() must append CombatShotEvent entries");
  const ev = vfxWorld.shotEvents[0];
  assert.equal(ev.shooterId, "GlideTank");
  assert.equal(ev.targetId, "TargetTank");
  assert.ok(ev.fromZ >= 0 && ev.toZ >= 0);

  vfxWorld.applyHeArtilleryBlast({ x: 800, y: 500 }, 8, 5, 30, 40);
  const artEv = vfxWorld.shotEvents[vfxWorld.shotEvents.length - 1];
  assert.equal(artEv.ammo, "HE");
  assert.equal(artEv.blastRadius, 5);
  assert.ok(target.state !== "destroyed");
}

verifyPhase2D();
console.log("Phase 2D interpolation snapshots & CombatShotEvent checks passed.");

function verifyPhase3A() {
  const m = new GameMap(4000, 3000, 1, { empty: true });
  // Place a 2-story building to verify removeUnit() garrison cleanup
  m.addBuilding({
    id: "B_Clean",
    footprint: [
      { x: 980, y: 980 },
      { x: 1020, y: 980 },
      { x: 1020, y: 1020 },
      { x: 980, y: 1020 },
    ],
    center: { x: 1000, y: 1000 },
    groundElevation: 0,
    roofHeight: 8,
    floors: [
      { level: 1, elevationOffset: 1.8, capacity: 12, integrity: 100, state: "intact", occupants: [], modifiers: { damageMult: 0.4, suppressionMult: 0.45 } },
    ],
  });

  const w = new World(m, 31);
  const spg = w.add({ id: "SPG1", side: "blue", type: "artillery", pos: { x: 200, y: 1500 }, roe: "hold_fire" });
  const mlrs = w.add({ id: "MLRS1", side: "blue", type: "mlrs", pos: { x: 200, y: 1800 }, roe: "hold_fire" });
  const recon = w.add({ id: "Recon1", side: "blue", type: "recon", pos: { x: 1600, y: 1500 }, roe: "hold_fire" });
  const tgtVisible = w.add({ id: "RedVis", side: "red", type: "infantry", pos: { x: 2400, y: 1500 }, roe: "hold_fire" });
  const tgtBlind = { x: 2400, y: 2700 };

  assert.equal(recon.hasObserver, true);
  assert.equal(spg.hasObserver, false);

  // 1. Observer-assisted HE_Airburst: 2 Ranging rounds halving dispersion, then FFE + isPositionCalibrated
  assert.equal(w.command(spg, { kind: "fire_mission", dest: tgtVisible.pos, ammoType: "HE_Airburst" }), "ok");
  assert.equal(spg.fireMission?.phase, "ranging");
  assert.equal(spg.fireMission?.effectiveAmmo, "HE_Airburst");
  assert.equal(spg.fireMission?.rangingNeeded, 2);
  const disp0 = spg.fireMission!.dispersionRadius;
  w.step(); // fires 1st ranging round
  assert.equal(spg.fireMission?.rangingFired, 1);
  assert.ok(Math.abs(spg.fireMission!.dispersionRadius - disp0 * 0.5) < 1e-6, "1st ranging round must halve dispersion");
  for (let i = 0; i < 4; i++) w.step(); // completes 2nd ranging round
  assert.equal(spg.fireMission?.phase, "ffe");
  assert.equal(spg.isPositionCalibrated, true, "Completed ranging must calibrate firing position");

  // Wait for Airburst shells to impact and confirm elevated +15m burst event with 5x d0
  for (let i = 0; i < 15; i++) w.step();
  const airEv = w.shotEvents.find((e) => e.shooterId === "SPG1" && e.artilleryAmmo === "HE_Airburst");
  assert.ok(airEv, "Observed HE_Airburst must resolve elevated burst event");
  assert.equal(airEv!.blastHeightOffset, 15);
  assert.equal(airEv!.blastRadius, 40);

  // 2. Registration-point ("放空炮") target shift to blind target preserves calibration bonus, then move resets it
  w.removeUnit("Recon1"); // remove observer so next target is unobserved
  assert.equal(w.hasFriendlyObserverSight("blue", tgtBlind), false);
  assert.equal(w.command(spg, { kind: "fire_mission", dest: tgtBlind, ammoType: "HE_Airburst" }), "ok");
  assert.equal(spg.fireMission?.phase, "ffe", "Blind fire must skip ranging");
  assert.equal(spg.fireMission?.effectiveAmmo, "HE_Impact", "Blind fire must degrade HE_Airburst to HE_Impact");
  assert.ok(spg.fireMission!.dispersionRadius < 120, "Calibrated battery shifting to blind target must retain partial accuracy bonus");

  // Moving resets isPositionCalibrated
  w.command(spg, { kind: "move", dest: { x: 260, y: 1500 } });
  w.step();
  assert.equal(spg.isPositionCalibrated, false, "Displacing battery must reset isPositionCalibrated");

  // 3. MLRS never calibrates or conducts ranging
  const recon2 = w.add({ id: "Recon2", side: "blue", type: "recon", pos: { x: 1600, y: 1500 }, roe: "hold_fire" });
  assert.equal(w.command(mlrs, { kind: "fire_mission", dest: tgtVisible.pos, ammoType: "HE_Airburst" }), "ok");
  assert.equal(mlrs.fireMission?.phase, "ffe");
  assert.equal(mlrs.fireMission?.effectiveAmmo, "HE_Impact");
  assert.equal(mlrs.isPositionCalibrated, false);
  for (let i = 0; i < 8; i++) w.step();
  assert.equal(mlrs.isPositionCalibrated, false);

  // 4. Smoke mission: 0 ranging, half dispersion, spawns DynamicOcclusionVolume blocking 3D sightline() & Visual
  const smokeTarget = { x: 2000, y: 1500 };
  assert.equal(w.command(spg, { kind: "fire_mission", dest: smokeTarget, ammoType: "Smoke" }), "ok");
  assert.equal(spg.fireMission?.phase, "ffe");
  assert.equal(spg.fireMission?.rangingNeeded, 0);
  assert.equal(spg.fireMission?.dispersionRadius, 60, "Smoke must receive intrinsic 2x accuracy bonus (half dispersion)");
  for (let i = 0; i < 12; i++) w.step();
  assert.ok(w.smokeVolumes.length > 0, "Smoke impact must spawn DynamicOcclusionVolume");
  const sv = w.smokeVolumes[0];
  const sightThroughSmoke = m.sightline(
    { x: sv.center.x - 150, y: sv.center.y },
    2,
    { x: sv.center.x + 150, y: sv.center.y },
    2,
    { dynamicVolumes: w.smokeVolumes },
  );
  assert.ok(sightThroughSmoke.transmittance < 0.05, "Smoke volume must attenuate 3D sightline transmittance");
  // Place observer & target directly across smoke cloud and verify Visual spotting is suppressed
  recon2.pos = { x: sv.center.x - 200, y: sv.center.y };
  tgtVisible.pos = { x: sv.center.x + 200, y: sv.center.y };
  w.step();
  assert.notEqual(recon2.ownPerception.get("RedVis"), "visual", "Smoke occlusion must block Visual detection across cloud");

  // 5. removeUnit() cleans garrison, embarked, contacts, and target references
  const garInf = w.add({ id: "GarInf", side: "blue", type: "infantry", pos: { x: 1000, y: 1000 }, roe: "hold_fire" });
  assert.equal(w.garrisonFloor(garInf, "B_Clean", 1), "ok");
  const ifv = w.add({ id: "TmpIfv", side: "blue", type: "ifv", pos: { x: 500, y: 500 }, roe: "hold_fire" });
  const pax = w.add({ id: "TmpPax", side: "blue", type: "infantry", pos: { x: 500, y: 500 }, roe: "hold_fire" });
  assert.equal(w.embark(pax, ifv), "ok");
  recon2.target = "RedVis";
  assert.equal(w.removeUnit("GarInf"), true);
  assert.equal(m.buildings[0].floors[0].occupants.includes("GarInf"), false, "removeUnit must clear BuildingFloor.occupants");
  assert.equal(w.removeUnit("TmpIfv"), true);
  assert.equal(pax.embarkedIn, undefined, "removeUnit on transport must clear passenger embarkedIn");
  assert.equal(w.removeUnit("RedVis"), true);
  assert.equal(recon2.target, undefined, "removeUnit must clear target references on other units");
  assert.equal(w.contacts.blue.has("RedVis"), false, "removeUnit must clear contacts references");
}

verifyPhase3A();
console.log("Phase 3A artillery, ranging/calibration, 3D smoke LoS & removeUnit checks passed.");

function verifyPhase3B() {
  const m = new GameMap(3000, 2000, 1, { empty: true });
  const w = new World(m, 42);

  // 1. Finite ammo depletion & empty-on-entry SupplyVehicle -> FOB loading -> frontline rearm & repair
  const fob = w.add({ id: "FOB1", side: "blue", type: "fob", pos: { x: 400, y: 1000 } });
  const truck = w.add({ id: "Truck1", side: "blue", type: "supply_truck", pos: { x: 1200, y: 1000 } });
  assert.equal(truck.supplyCarried, 0, "SupplyVehicle must spawn empty (0 supply)");

  const tank = w.add({ id: "Tank1", side: "blue", type: "tank", pos: { x: 1250, y: 1000 }, roe: "fire_at_will" });
  const dummy = w.add({ id: "RedTarget", side: "red", type: "tank", pos: { x: 1800, y: 1000 }, roe: "hold_fire" });
  // Deplete all ammo on Tank1 and damage it
  for (const ws of tank.weapons) ws.ammoRemaining = 0;
  tank.strength = 70;
  for (let i = 0; i < 4; i++) w.step();
  assert.equal(dummy.strength, 100, "Depleted unit must not fire until resupplied");
  assert.equal(tank.strength, 70, "Empty SupplyVehicle (0 supply) must not repair or rearm");

  // Send truck to FOB to load supply, then back to Tank1
  w.command(truck, { kind: "move", dest: { x: 450, y: 1000 } });
  for (let i = 0; i < 120; i++) w.step();
  assert.ok(truck.supplyCarried >= 80, "SupplyVehicle must load supply at FOB");
  w.command(truck, { kind: "move", dest: { x: 1230, y: 1000 } });
  for (let i = 0; i < 130; i++) w.step();
  assert.ok(tank.weapons.some((ws) => ws.ammoRemaining > 0), "Loaded SupplyVehicle must rearm frontline unit");
  assert.ok(tank.strength > 70, "Loaded SupplyVehicle must repair damaged vehicle strength");
  assert.ok(truck.supplyCarried < 100, "Resupplying/repairing must consume SupplyVehicle supplyCarried");
  assert.ok(dummy.strength < 100, "Rearmed tank must resume firing");
  w.removeUnit("RedTarget");
  w.removeUnit("Tank1");
  w.removeUnit("Truck1");

  // 2. WIA self-aid ceiling vs SupplyVehicle/FOB vs KIA off-map reconstitution preserving veterancy
  const inf = w.add({ id: "Inf1", side: "blue", type: "infantry", pos: { x: 1400, y: 1000 }, veterancy: 2.5, roe: "hold_fire" });
  // Inflict 4 WIA (headcount drops 8 -> 4, selfRecoveryCap = 6) and 1 KIA (cannot heal on-map)
  w.inflictRosterCasualty(inf, "rifleman", 3, "wia");
  w.inflictRosterCasualty(inf, "at_specialist", 1, "wia");
  w.inflictRosterCasualty(inf, "mg_specialist", 1, "kia");
  assert.equal(inf.headcount, 3);
  assert.equal(inf.subRoster!.selfRecoveryCap, 6);

  // Out-of-combat self-aid heals WIA slowly up to selfRecoveryCap (6), leaving 1 WIA + 1 KIA unhealed
  w.t += 20;
  for (let i = 0; i < 65; i++) w.step();
  assert.equal(inf.headcount, 6, "Out-of-combat self-aid must cap at selfRecoveryCap");
  const remWia = Object.values(inf.subRoster!.wia).reduce((a, b) => a + b, 0);
  const remKia = Object.values(inf.subRoster!.kia).reduce((a, b) => a + b, 0);
  assert.equal(remWia, 1);
  assert.equal(remKia, 1);

  // Move infantry into FOB: heals remaining 1 WIA rapidly, leaves 1 KIA untouched
  inf.pos = { x: 450, y: 1000 };
  for (let i = 0; i < 4; i++) w.step();
  assert.equal(inf.headcount, 7, "FOB must heal all WIA");
  assert.equal(Object.values(inf.subRoster!.wia).reduce((a, b) => a + b, 0), 0);
  assert.equal(Object.values(inf.subRoster!.kia).reduce((a, b) => a + b, 0), 1, "FOB must never heal KIA");

  // Withdraw off-map to reconstitute KIA with veterancy preserved and ammo/morale reset
  inf.pos = { x: 50, y: 1000 };
  inf.morale = 45;
  inf.subRoster!.weapons[0].ammoRemaining = 0;
  const reqBefore = w.sideResources.blue;
  assert.equal(w.command(inf, { kind: "withdraw_off_map" }), "ok");
  let reconstituted = false;
  for (let i = 0; i < 60; i++) {
    w.step();
    if (w.events.some((e) => e.unit === "Inf1" && e.text.includes("reconstituted"))) {
      reconstituted = true;
      break;
    }
  }
  assert.ok(reconstituted, "Unit must reconstitute after off-map withdrawal");
  assert.ok(w.sideResources.blue < reqBefore, "Off-map reconstitution must deduct requisition");
  assert.equal(inf.offMapReconstituteAt, undefined, "Unit must return after reconstitution cooldown");
  assert.equal(inf.headcount, 8, "Off-map reconstitution must replenish KIA losses");
  assert.equal(Object.values(inf.subRoster!.kia).reduce((a, b) => a + b, 0), 0);
  assert.equal(inf.veterancy, 2.5, "Reconstitution must preserve veterancy");
  assert.ok(Math.abs(inf.morale - 80) <= 0.5, "Reconstitution must reset morale");
  assert.equal(inf.subRoster!.weapons[0].ammoRemaining, inf.subRoster!.weapons[0].maxAmmo, "Reconstitution must refill ammo");

  // 3. FOB resists artillery bombardment damage/suppression compared to open infantry
  const openInf = w.add({ id: "OpenInf", side: "blue", type: "infantry", pos: { x: 2200, y: 1000 }, roe: "hold_fire" });
  const fobStart = fob.strength;
  w.applyHeArtilleryBlast(fob.pos, 12, 12, 40, 50, 0);
  w.applyHeArtilleryBlast(openInf.pos, 12, 12, 40, 50, 0);
  const fobLoss = fobStart - fob.strength;
  const infLoss = 100 - openInf.strength;
  assert.ok(fobLoss < infLoss && fob.suppression < openInf.suppression, "FOB must take reduced artillery damage and suppression");
}

verifyPhase3B();
console.log("Phase 3B logistics (FOB/SupplyVehicle), finite ammo, WIA/KIA & reconstitution checks passed.");

const objective = map.resolve("Geisa")!;
for (const u of world.alive("blue")) world.command(u, { kind: "attack", dest: objective, destName: "Geisa" });

const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
world.on((e) => console.log(`[${fmt(e.t)}] ${e.unit}: ${e.text}`));

console.log(asciiMap(world, "blue", true));
let result;
while (!(result = outcome()) && world.t < 3600) { world.step(); script(); }
console.log(`\nResult: ${result ?? "timeout"} at ${fmt(world.t)}`);
for (const u of world.units) console.log(`${u.id.padEnd(8)} ${u.state.padEnd(10)} str ${u.strength.toFixed(0).padStart(3)} ${map.describe(u.pos)}`);
console.log(asciiMap(world, "blue", true));
