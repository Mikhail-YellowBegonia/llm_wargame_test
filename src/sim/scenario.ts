// Fulda Gap — Point Alpha (Rasdorf–Geisa) scenario loaded from precompiled 10m static MapAsset.
import { GameMap, MapAsset, Vec, dist } from "./map";
import { World } from "./world";
import fuldaAsset from "./maps/fulda-point-alpha.json";

export const PLAYER = "Steel 6";     // player's callsign (battalion commander)
export const COMPANY = "Alpha 6";    // LLM company commander

export function buildScenario(seed = 7) {
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
    const blue = world.alive("blue").filter((u) => u.state !== "broken");
    if (blue.length === 0) return "loss";
    const redNear = world.alive("red").some((u) => u.state !== "broken" && dist(u.pos, geisa) < 600);
    const blueIn = blue.some((u) => dist(u.pos, geisa) < 350);
    if (blueIn && !redNear) return "win";
  };
}
