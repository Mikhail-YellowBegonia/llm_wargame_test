// M0 terminal prototype: you are Steel 6, talking to your LLM company commander by radio.
import readline from "node:readline";
import fs from "node:fs";
import { deepseek } from "@ai-sdk/deepseek";
import { createGame } from "./game";
import { clock } from "./perception/sitrep";
import { asciiMap } from "./render/ascii";

try { process.loadEnvFile(); } catch { /* no .env file */ }
if (!process.env.DEEPSEEK_API_KEY) { console.error("Set DEEPSEEK_API_KEY in .env (see .env.example)."); process.exit(1); }

fs.mkdirSync("logs", { recursive: true });
const logFile = `logs/session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const C = { dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "Steel 6 > " });
const say = (s: string) => { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); console.log(s); rl.prompt(true); };

let eavesdrop = false;
const game = createGame(deepseek(process.env.WARGAME_MODEL ?? "deepseek-v4-flash"), {
  onPlayerRadio: (m) => say(`${C.green}[${clock(game.world.t)}] ${m.from}: ${m.text}${C.reset}`),
  onCompanyNet: (m) => eavesdrop && say(`${C.dim}[${clock(game.world.t)}] (company net) ${m.from} -> ${m.to}: ${m.text}${C.reset}`),
  log: (e) => {
    fs.appendFileSync(logFile, JSON.stringify(e) + "\n");
    if (e.error) say(`${C.red}[agent error] ${e.error.slice(0, 300)}${C.reset}`);
  },
});
const { world } = game;

let speed = 2, paused = false, acc = 0, over = false;
const HELP = `Type anything to radio Alpha 6 (your LLM company commander).
Commands:
  /map              your map (data link: friendly positions refresh every 30s, enemy = reported contacts)
  /god              debug: true positions of everything
  /pause, /go       pause / resume       /speed N   time multiplier (now ${speed}x)
  /net              toggle eavesdropping on the company net
  /quit`;

const timer = setInterval(() => {
  if (paused || over) return;
  acc += 0.1 * speed;
  while (acc >= 1) {
    acc -= 1;
    const result = game.step();
    if (result) {
      over = true;
      say(`${result === "win" ? C.green : C.red}=== ${result === "win" ? "VICTORY: Kessel is ours" : "DEFEAT: Alpha company is combat ineffective"} at ${clock(world.t)} ===${C.reset}\nType /quit to exit (or /god to review).`);
      break;
    }
  }
}, 100);

rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return rl.prompt();
  const [cmd, ...args] = s.split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "/help": say(HELP); break;
    case "/map": say(asciiMap(world, "blue", false, game.picture.tracks)); break;
    case "/god": say(asciiMap(world, "blue", true)); break;
    case "/pause": paused = true; say("(paused)"); break;
    case "/go": paused = false; say("(running)"); break;
    case "/speed": speed = Math.max(0.25, Math.min(16, Number(args[0]) || 1)); say(`(speed ${speed}x)`); break;
    case "/net": eavesdrop = !eavesdrop; say(`(company net eavesdrop ${eavesdrop ? "on" : "off"})`); break;
    case "/quit": clearInterval(timer); rl.close(); process.exit(0);
    default: {
      if (s.startsWith("/")) { say("Unknown command, /help"); break; }
      const eta = game.radio(s);
      say(`${C.dim}(transmitting, ~${eta}s)${C.reset}`);
    }
  }
});

say(`OPERATION KESSEL - ${clock(world.t)}
Steel 6, you command 2nd Battalion. Alpha Company (Alpha 6) is at Brandt with two mech infantry platoons and a tank platoon.
Intel: enemy infantry is holding the village of Kessel, 2.6 km north. Armor may be in the area.
Mission: take Kessel. Log: ${logFile}
${HELP}`);
