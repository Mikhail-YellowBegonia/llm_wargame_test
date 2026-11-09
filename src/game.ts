// Wires world, radio nets, scripted enemy and LLM agents together. UI-agnostic (CLI now, browser later).
import { deepseek } from "@ai-sdk/deepseek";
import { Commander } from "./agents/commander";
import { RadioMsg, RadioNet } from "./comms/radio";
import { COMPANY, PLAYER, buildScenario } from "./sim/scenario";
import { SimEvent, Unit } from "./sim/world";

export interface GameHooks {
  onPlayerRadio: (m: RadioMsg) => void;       // traffic the player hears
  onCompanyNet?: (m: RadioMsg) => void;       // company net chatter (debug/eavesdrop)
  onEvent?: (e: SimEvent) => void;            // raw sim events (debug)
  log: (entry: object) => void;
}

export const DATALINK_PERIOD = 30; // seconds between friendly position updates on the player's map

export function createGame(hooks: GameHooks, seed = 7) {
  const { world, script, outcome } = buildScenario(seed);
  const battalionNet = new RadioNet("battalion");
  const companyNet = new RadioNet("company");
  const model = deepseek(process.env.WARGAME_MODEL ?? "deepseek-v4-flash");

  const alpha6 = new Commander(world, {
    id: COMPANY, superior: PLAYER, model, upNet: battalionNet, downNet: companyNet, log: hooks.log,
    personality: "You are an experienced, steady captain who prefers using terrain and overwatch to rushing.",
  });

  battalionNet.listen(PLAYER, hooks.onPlayerRadio);
  battalionNet.listen(COMPANY, (m) => alpha6.receive(m.from, m.text));
  companyNet.listen(COMPANY, (m) => alpha6.receive(m.from, m.text));
  if (hooks.onCompanyNet) companyNet.listen("*", hooks.onCompanyNet);

  // Platoon bots report their events to their commander over the company net.
  world.on((e) => {
    hooks.onEvent?.(e);
    const u = world.get(e.unit);
    if (u?.side === "blue" && u.commander && e.kind !== "destroyed")
      companyNet.send(world.t, u.id, u.commander, e.text);
    if (u?.side === "blue" && e.kind === "destroyed") alpha6.receive("(net)", `${u.id} has stopped answering on the net.`);
  });

  // Data link: the player's map only refreshes friendly positions periodically.
  let datalink: Pick<Unit, "id" | "pos" | "state">[] = [];
  const refreshDatalink = () => (datalink = world.alive("blue").map((u) => ({ id: u.id, pos: { ...u.pos }, state: u.state })));
  refreshDatalink();

  return {
    world,
    get datalink() { return datalink; },
    get agentThinking() { return alpha6.thinking; },
    /** Player transmits to the company commander. */
    radio(text: string) { return battalionNet.send(world.t, PLAYER, COMPANY, text); },
    /** Player bypasses the chain of command and radios a platoon directly. The company commander is not told. */
    direct(unitId: string, text: string, apply: () => string) {
      return companyNet.send(world.t, PLAYER, unitId, text, () => {
        const r = apply();
        if (r !== "ok") hooks.onPlayerRadio({ from: unitId, to: PLAYER, text: `cannot comply: ${r}`, deliverAt: world.t });
      });
    },
    /** Advance one game second. Returns the outcome when the game ends. */
    step() {
      world.step();
      script();
      battalionNet.deliver(world.t);
      companyNet.deliver(world.t);
      alpha6.tick();
      if (world.t % DATALINK_PERIOD === 0) refreshDatalink();
      return outcome();
    },
  };
}
