// Wires world, radio nets, scripted enemy and LLM agents together. UI-agnostic (CLI and browser).
import type { LanguageModel } from "ai";
import { Commander, OrderPayload } from "./agents/commander";
import { RadioMsg, RadioNet } from "./comms/radio";
import { PlayerPicture } from "./perception/player";
import { COMPANY, PLAYER, buildScenario } from "./sim/scenario";
import { SimEvent } from "./sim/world";
import type { Vec } from "./sim/map";

export interface GameHooks {
  onPlayerRadio: (m: RadioMsg) => void;       // traffic the player hears
  onCompanyNet?: (m: RadioMsg) => void;       // full company net (debug only)
  onEvent?: (e: SimEvent) => void;            // raw sim events (debug)
  log: (entry: AgentLog) => void;             // agent turns / errors
}
export type AgentLog = Record<string, unknown> & { t: number; agent: string; error?: string };

export function createGame(model: LanguageModel, hooks: GameHooks, seed = 7) {
  const { world, script, outcome } = buildScenario(seed);
  const battalionNet = new RadioNet("battalion");
  const companyNet = new RadioNet("company");
  const picture = new PlayerPicture(world, COMPANY);

  const alpha6 = new Commander(world, {
    id: COMPANY, superior: PLAYER, model, upNet: battalionNet, downNet: companyNet, log: hooks.log as (e: object) => void,
    personality: "You are an experienced, steady captain who prefers using terrain and overwatch to rushing.",
  });

  battalionNet.listen(PLAYER, hooks.onPlayerRadio);
  battalionNet.listen(COMPANY, (m) => alpha6.receive(m.from, m.text));
  battalionNet.listen("*", () => picture.sync()); // any player <-> company traffic pushes the data link
  companyNet.listen(COMPANY, (m) => alpha6.receive(m.from, m.text));
  companyNet.listen("*", (m) => {
    hooks.onCompanyNet?.(m);
    if (m.from === COMPANY && m.data) { const d = m.data as OrderPayload; picture.intercept(d.unit, d.order); }
  });

  // Platoon bots report their events to their commander over the company net.
  world.on((e) => {
    hooks.onEvent?.(e);
    const u = world.get(e.unit);
    if (u?.side !== "blue" || !u.commander) return;
    if (e.kind === "destroyed") alpha6.receive("(net)", `${u.id} has stopped answering on the net.`);
    else companyNet.send(world.t, u.id, u.commander, e.text);
  });

  let markerSeq = 0;
  let result: "win" | "loss" | undefined;

  return {
    world, picture, battalionNet, commander: alpha6,
    get agentThinking() { return alpha6.thinking; },
    get result() { return result; },
    /** Player transmits to the company commander. Returns seconds until delivery. */
    radio(text: string) { return battalionNet.send(world.t, PLAYER, COMPANY, text); },
    /** Player map marker, shared with the company commander via data link. */
    addMarker(pos: Vec, note?: string) {
      const name = `M${++markerSeq}`;
      world.map.places.push({ name, pos, kind: "marker", note });
      return name;
    },
    removeMarker(name: string) { world.map.places = world.map.places.filter((p) => !(p.kind === "marker" && p.name === name)); },
    /** Advance one game second. */
    step() {
      if (result) return result;
      world.step();
      script();
      battalionNet.deliver(world.t);
      companyNet.deliver(world.t);
      picture.step();
      alpha6.tick();
      return (result = outcome());
    },
  };
}
export type Game = ReturnType<typeof createGame>;
