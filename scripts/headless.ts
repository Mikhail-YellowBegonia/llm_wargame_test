// Headless run without any LLM: all blue platoons attack Kessel directly.
// Useful for tuning combat numbers. Usage: npm run headless [-- seed]
import { buildScenario } from "../src/sim/scenario";
import { asciiMap } from "../src/render/ascii";

const seed = Number(process.argv[2] ?? 7);
const { world, map, script, outcome } = buildScenario(seed);
const kessel = map.resolve("Kessel")!;
for (const u of world.alive("blue")) world.command(u, { kind: "attack", dest: kessel, destName: "Kessel" });

const fmt = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
world.on((e) => console.log(`[${fmt(e.t)}] ${e.unit}: ${e.text}`));

console.log(asciiMap(world, "blue", true));
let result;
while (!(result = outcome()) && world.t < 3600) { world.step(); script(); }
console.log(`\nResult: ${result ?? "timeout"} at ${fmt(world.t)}`);
for (const u of world.units) console.log(`${u.id.padEnd(8)} ${u.state.padEnd(10)} str ${u.strength.toFixed(0).padStart(3)} ${map.describe(u.pos)}`);
console.log(asciiMap(world, "blue", true));
