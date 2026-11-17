// Headless run without any LLM: verifies Phase 1A geo-substrate invariants and runs Kessel scenario.
// Usage: npm run headless [-- seed]
import assert from "node:assert/strict";
import { GameMap, TERRAIN_DEFS, TERRAIN_IDS } from "../src/sim/map";
import { buildScenario } from "../src/sim/scenario";
import { World } from "../src/sim/world";
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
