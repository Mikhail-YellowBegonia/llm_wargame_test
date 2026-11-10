// "Who knows what": turns world state into the text a given commander is allowed to know.
// This is the single gate for information asymmetry.
import { bearingName, dist, Vec } from "../sim/map";
import { STATS, Unit, World } from "../sim/world";

export const clock = (t: number) => {
  const h = 6 + Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

const strengthWord = (s: number) => (s > 85 ? "full strength" : s > 60 ? "light casualties" : s > 35 ? "heavy casualties" : "critical");
const stateWord: Record<Unit["state"], string> = {
  holding: "holding", moving: "moving", pinned: "PINNED DOWN", broken: "BROKEN (falling back)", destroyed: "destroyed",
};

export function placesBrief(world: World) {
  return world.map.places
    .filter((p) => p.kind !== "marker")
    .map((p) => `- ${p.name} (grid ${world.map.toGrid(p.pos)}, elev ${Math.round(world.map.heightAt(p.pos))}m): ${p.note ?? p.kind}`)
    .join("\n");
}

function orderWord(world: World, u: Unit) {
  const o = u.order;
  if (o.kind === "hold" || !o.dest) return "hold";
  return `${o.kind} to ${o.destName ? o.destName + " " : ""}grid ${world.map.toGrid(o.dest)}`;
}

/** Situation as known to a company commander: own platoons (by radio) + contacts reported by them. */
export function companySitrep(world: World, commander: string) {
  const own = world.units.filter((u) => u.commander === commander);
  const lines = [`SITUATION at ${clock(world.t)}`, "Own platoons:"];
  for (const u of own) {
    if (u.state === "destroyed") { lines.push(`- ${u.id} (${STATS[u.type].label}): DESTROYED / no contact`); continue; }
    lines.push(
      `- ${u.id} (${STATS[u.type].label}): at ${world.map.describe(u.pos)}, ${stateWord[u.state]}, ${strengthWord(u.strength)}, ` +
        `order: ${orderWord(world, u)}, ROE: ${u.roe}${u.target ? ", engaging" : ""}`,
    );
  }
  const ownIds = new Set(own.map((u) => u.id));
  const contacts = [...world.contacts.blue.values()].filter((c) => ownIds.has(c.seenBy));
  lines.push("Enemy contacts reported by your platoons:");
  if (!contacts.length) lines.push("- none");
  for (const c of contacts) {
    const age = world.t - c.seenAt;
    const nearest = own.filter((u) => u.state !== "destroyed").sort((a, b) => dist(a.pos, c.pos) - dist(b.pos, c.pos))[0];
    const rel = nearest ? `, ${Math.round(dist(nearest.pos, c.pos) / 50) * 50}m ${bearingName(nearest.pos, c.pos)} of ${nearest.id}` : "";
    lines.push(`- ${STATS[c.type].label} at ${world.map.describe(c.pos)}${rel}; ${age < 20 ? "in sight now" : `last seen ${Math.round(age / 60)} min ago`} (by ${c.seenBy})`);
  }
  const markers = world.map.places.filter((p) => p.kind === "marker");
  if (markers.length) {
    lines.push("Map markers placed by your superior (usable as destinations by name):");
    for (const m of markers) lines.push(`- ${m.name}: grid ${world.map.toGrid(m.pos, 6)}${m.note ? ` "${m.note}"` : ""}`);
  }
  return lines.join("\n");
}

/** Terrain description for a point, from the viewpoint of a commander's platoons. */
export function describeLocation(world: World, commander: string, p: Vec) {
  const m = world.map;
  const own = world.alive().filter((u) => u.commander === commander);
  const lines = [`${m.describe(p)}: terrain ${m.terrainAt(p)}, elevation ${Math.round(m.heightAt(p))}m.`];
  for (const u of own) {
    const d = dist(u.pos, p);
    lines.push(`- ${u.id}: ${Math.round(d)}m to the ${bearingName(u.pos, p)}, ${m.los(u.pos, p) ? "in line of sight" : "no line of sight"}`);
  }
  return lines.join("\n");
}
