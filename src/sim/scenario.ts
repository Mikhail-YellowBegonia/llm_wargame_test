// Fulda Gap — Point Alpha (Rasdorf–Geisa) scenario loaded from precompiled 10m static MapAsset.
import { GameMap, MapAsset, Vec, dist } from "./map";
import { World } from "./world";
import fuldaAsset from "./maps/fulda-point-alpha.json";

export const PLAYER = "Steel 6";     // player's callsign (battalion commander)
export const COMPANY = "Alpha 6";    // LLM company commander

export type ScenarioPreset = "combined_arms" | "skirmish";

export function buildScenario(seed = 7, preset: ScenarioPreset = "combined_arms") {
  const map = GameMap.fromAsset(fuldaAsset as MapAsset);
  const P = (x: number, y: number): Vec => ({ x, y });

  const rasdorf = map.resolve("Rasdorf Approach") ?? P(352, 1600);
  const pointAlpha = map.resolve("Point Alpha") ?? P(2306, 2314);
  const geisa = map.resolve("Geisa") ?? P(3555, 1307);

  const world = new World(map, seed);
  const blue = { side: "blue" as const, commander: COMPANY, rally: rasdorf };
  world.add({ ...blue, id: "Alpha 1", type: "ifv", pos: P(1450, 1950) });
  world.add({ ...blue, id: "Alpha 2", type: "ifv", pos: P(1600, 2150) });
  world.add({ ...blue, id: "Alpha 3", type: "tank", pos: P(1350, 2100) });

  const red = { side: "red" as const, rally: P(3850, 1600) };
  world.add({ ...red, id: "Red 1", type: "infantry", pos: P(3480, 1350) });
  world.add({ ...red, id: "Red 2", type: "infantry", pos: P(3620, 1260) });
  world.add({ ...red, id: "Red 3", type: "atgm", pos: P(pointAlpha.x, pointAlpha.y) });
  world.add({ ...red, id: "Red 4", type: "tank", pos: P(3750, 1750), roe: "hold_fire" });

  if (preset === "combined_arms") {
    // Blue combined-arms attachments: infantry, recon, tube/rocket artillery, SHORAD, FOB, empty SupplyVehicle & helo
    world.add({ ...blue, id: "Alpha 4", type: "infantry", pos: P(1420, 2030) });
    world.add({ ...blue, id: "Recon 1", type: "recon", pos: P(1820, 2060) });
    world.add({ ...blue, id: "SPG 1", type: "artillery", pos: P(720, 1740) });
    world.add({ ...blue, id: "MLRS 1", type: "mlrs", pos: P(640, 1820) });
    world.add({ ...blue, id: "AD 1", type: "shorad", pos: P(1120, 1840) });
    world.add({ ...blue, id: "NATO FOB", type: "fob", pos: P(430, 1620) });
    world.add({ ...blue, id: "Supply 1", type: "supply_truck", pos: P(520, 1660) });
    world.add({ ...blue, id: "Helo 1", type: "helicopter", pos: P(560, 1520) });

    // Red combined-arms attachments: forward recon/IFV + rear artillery, area SAM, FOB & empty SupplyVehicle
    world.add({ ...red, id: "Red Recon", type: "recon", pos: P(2800, 1650) });
    world.add({ ...red, id: "Red IFV", type: "ifv", pos: P(3120, 1520) });
    world.add({ ...red, id: "Red SPG", type: "artillery", pos: P(3880, 620) });
    world.add({ ...red, id: "Red SAM", type: "sam", pos: P(3840, 2080) });
    world.add({ ...red, id: "Red FOB", type: "fob", pos: P(3880, 2180) });
    world.add({ ...red, id: "Red Supply", type: "supply_truck", pos: P(3810, 2140) });
  }

  return { map, world, script: redScript(world, geisa), outcome: outcome(world, geisa) };
}

/** Scripted enemy: the tank reserve counterattacks once Geisa is threatened. */
function redScript(world: World, geisa: Vec) {
  let triggered = false;
  return () => {
    if (triggered) return;
    const threatened = world.alive("blue").some((u) => dist(u.pos, geisa) < 900);
    const defenders = ["Red 1", "Red 2"].map((id) => world.get(id)!);
    const weakened = defenders.reduce((s, u) => s + (u.state === "destroyed" ? 0 : u.strength), 0) < 120;
    if (threatened || weakened) {
      triggered = true;
      const reserve = world.get("Red 4")!;
      world.command(reserve, { kind: "attack", dest: { x: geisa.x - 100, y: geisa.y + 50 } });
    }
  };
}

function outcome(world: World, geisa: Vec) {
  return (): "win" | "loss" | undefined => {
    const blue = world.alive("blue").filter((u) => u.state !== "broken" && u.type !== "fob" && u.type !== "supply_truck");
    if (blue.length === 0) return "loss";
    const redNear = world.alive("red").some((u) => u.state !== "broken" && u.type !== "fob" && u.type !== "supply_truck" && dist(u.pos, geisa) < 600);
    const blueIn = blue.some((u) => dist(u.pos, geisa) < 350);
    if (blueIn && !redNear) return "win";
  };
}
