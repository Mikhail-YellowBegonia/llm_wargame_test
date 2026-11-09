// M0 scenario "Kessel": a mechanized company must take a village held by a reinforced enemy.
import { GameMap, Vec, dist } from "./map";
import { World } from "./world";

export const PLAYER = "Steel 6";     // player's callsign (battalion commander)
export const COMPANY = "Alpha 6";    // LLM company commander

export function buildScenario(seed = 7) {
  const map = new GameMap(4000, 4000, seed);
  const P = (x: number, y: number): Vec => ({ x, y });

  const brandt = P(2000, 400), kessel = P(2000, 3000), crossroads = P(2000, 1700);
  const hill112 = P(1100, 2600), hill98 = P(2700, 1300), blackWood = P(3100, 2200);

  map.paint(blackWood, 450, "forest");
  map.paint(P(1400, 1400), 250, "forest");
  const setHill = (p: Vec, top: number, r: number) => map.addHill(p, r, top - map.heightAt(p));
  setHill(hill112, 112, 350);
  setHill(hill98, 98, 300);
  map.paint(brandt, 180, "town");
  map.paint(kessel, 220, "town");
  map.road(brandt, crossroads);
  map.road(crossroads, kessel);
  map.road(crossroads, P(0, 1900));
  map.road(kessel, P(4000, 3300));

  map.places = [
    { name: "Brandt", pos: brandt, kind: "town", note: "small village, company assembly area" },
    { name: "Kessel", pos: kessel, kind: "town", note: "village on the main road, objective" },
    { name: "Miller's Crossroads", pos: crossroads, kind: "crossroads", note: "road junction halfway between Brandt and Kessel" },
    { name: "Hill 112", pos: hill112, kind: "hill", note: "dominant hill west of Kessel, overlooks the approach" },
    { name: "Hill 98", pos: hill98, kind: "hill", note: "low hill east of the main road" },
    { name: "Black Wood", pos: blackWood, kind: "wood", note: "large forest east of the road, southeast of Kessel" },
  ];

  const world = new World(map, seed);
  const blue = { side: "blue" as const, commander: COMPANY, rally: brandt };
  world.add({ ...blue, id: "Alpha 1", type: "ifv", pos: P(1850, 450) });
  world.add({ ...blue, id: "Alpha 2", type: "ifv", pos: P(2150, 450) });
  world.add({ ...blue, id: "Alpha 3", type: "tank", pos: P(2000, 300) });

  const red = { side: "red" as const, rally: P(2000, 3900) };
  world.add({ ...red, id: "Red 1", type: "infantry", pos: P(1930, 3060) });
  world.add({ ...red, id: "Red 2", type: "infantry", pos: P(2090, 2930) });
  world.add({ ...red, id: "Red 3", type: "atgm", pos: P(1120, 2620) });
  world.add({ ...red, id: "Red 4", type: "tank", pos: P(2300, 3750), roe: "hold_fire" });

  return { map, world, script: redScript(world, kessel), outcome: outcome(world, kessel) };
}

/** Scripted enemy: the tank reserve counterattacks once Kessel is threatened. */
function redScript(world: World, kessel: Vec) {
  let triggered = false;
  return () => {
    if (triggered) return;
    const threatened = world.alive("blue").some((u) => dist(u.pos, kessel) < 900);
    const defenders = ["Red 1", "Red 2"].map((id) => world.get(id)!);
    const weakened = defenders.reduce((s, u) => s + (u.state === "destroyed" ? 0 : u.strength), 0) < 120;
    if (threatened || weakened) {
      triggered = true;
      const reserve = world.get("Red 4")!;
      world.command(reserve, { kind: "attack", dest: { x: 2050, y: 2900 } });
    }
  };
}

function outcome(world: World, kessel: Vec) {
  return (): "win" | "loss" | undefined => {
    const blue = world.alive("blue").filter((u) => u.state !== "broken");
    if (blue.length === 0) return "loss";
    const redNear = world.alive("red").some((u) => u.state !== "broken" && dist(u.pos, kessel) < 600);
    const blueIn = blue.some((u) => dist(u.pos, kessel) < 300);
    if (blueIn && !redNear) return "win";
  };
}
