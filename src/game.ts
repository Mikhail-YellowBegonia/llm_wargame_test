// Wires world, radio nets, scripted enemy and LLM agents together. UI-agnostic (CLI and browser).
import type { LanguageModel } from "ai";
import { Commander, OrderPayload } from "./agents/commander";
import { RadioMsg, RadioNet } from "./comms/radio";
import { PlayerPicture } from "./perception/player";
import { COMPANY, PLAYER, buildScenario } from "./sim/scenario";
import { AirMissionProfile, FlightAltitude, Order, Roe, Side, SimEvent, UnitType } from "./sim/world";
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
  let spawnSeq = 0;
  let result: "win" | "loss" | undefined;
  let inspectorMode = false;
  let aiCommanderEnabled = false;

  return {
    world, picture, battalionNet, commander: alpha6,
    get agentThinking() { return alpha6.thinking; },
    get result() { return result; },
    get inspectorMode() { return inspectorMode; },
    setInspectorMode(enabled: boolean) { inspectorMode = enabled; },
    get aiCommanderEnabled() { return aiCommanderEnabled; },
    setAiCommanderEnabled(enabled: boolean) { aiCommanderEnabled = enabled; },
    get autoSupportEnabled() { return world.autoSupportEnabled; },
    setAutoSupportEnabled(enabled: boolean) { world.autoSupportEnabled = enabled; },
    /** Direct sandbox command bypassing radio/LLM latency. */
    directCommand(unitId: string, order: Order, roe?: Roe) {
      const u = world.get(unitId);
      if (!u) return `unknown unit "${unitId}"`;
      const res = world.command(u, order, roe);
      if (res === "ok") {
        picture.sync();
      }
      return res;
    },
    /** Direct sandbox command to move & garrison an infantry unit onto a BuildingFloor. */
    garrisonBuildingFloor(unitId: string, buildingId: string, floorLevel: number) {
      const u = world.get(unitId);
      if (!u) return `unknown unit "${unitId}"`;
      const res = world.orderGarrison(u, buildingId, floorLevel);
      if (res === "ok" && !aiCommanderEnabled) picture.sync();
      return res;
    },
    /** Direct sandbox command to exit a garrisoned BuildingFloor. */
    exitBuilding(unitId: string) {
      const u = world.get(unitId);
      if (!u) return `unknown unit "${unitId}"`;
      const res = world.vacateBuilding(u);
      if (res === "ok") picture.sync();
      return res;
    },
    /** Debug sandbox helper: spawn a new unit on the map. */
    spawnUnit(side: Side, type: UnitType, pos: Vec, id?: string) {
      if (type === "aircraft") {
        const res = world.callAirSortie(side, pos, "cap_loiter", { id, commander: side === "blue" ? COMPANY : undefined });
        if (res.ok && res.unit) {
          picture.sync();
          return res.unit;
        }
      }
      let uid = id;
      if (!uid) {
        do { uid = `${side === "blue" ? "Blue" : "Red"} ${type} ${++spawnSeq}`; } while (world.get(uid));
      }
      const rally = side === "blue"
        ? (world.map.resolve("Rasdorf Approach") ?? { x: 350, y: 1600 })
        : { x: 3850, y: 1600 };
      const unit = world.add({
        id: uid,
        side,
        type,
        pos: { ...pos },
        commander: side === "blue" ? COMPANY : undefined,
        rally,
      });
      picture.sync();
      return unit;
    },
    /** Call in a fixed-wing air sortie (uses free turnaround aircraft if ready at base). */
    callAirSortie(side: Side, dest: Vec, missionProfile: AirMissionProfile = "cap_loiter", altitude?: FlightAltitude) {
      const res = world.callAirSortie(side, dest, missionProfile, {
        altitude,
        commander: side === "blue" ? COMPANY : undefined,
      });
      if (res.ok) picture.sync();
      return res;
    },
    landHelicopter(unitId: string) {
      const u = world.get(unitId);
      if (!u) return `unknown unit "${unitId}"`;
      const res = world.landHelicopter(u);
      if (res === "ok") picture.sync();
      return res;
    },
    takeoffHelicopter(unitId: string) {
      const u = world.get(unitId);
      if (!u) return `unknown unit "${unitId}"`;
      const res = world.takeoffHelicopter(u);
      if (res === "ok") picture.sync();
      return res;
    },
    embarkUnit(passengerId: string, transportId: string) {
      const p = world.get(passengerId);
      const t = world.get(transportId);
      if (!p || !t) return "unknown unit";
      const res = world.embark(p, t);
      if (res === "ok") picture.sync();
      return res;
    },
    disembarkUnit(passengerId: string) {
      const p = world.get(passengerId);
      if (!p) return "unknown unit";
      const res = world.disembark(p);
      if (res === "ok") picture.sync();
      return res;
    },
    /** Debug sandbox helper: remove a unit cleanly from the world. */
    deleteUnit(id: string) {
      const removed = world.removeUnit(id);
      if (removed) picture.sync();
      return removed;
    },
    /** Player transmits to the company commander. Returns seconds until delivery. */
    radio(text: string) { return battalionNet.send(world.t, PLAYER, COMPANY, text); },
    /** Player map marker, shared with the company commander via data link. */
    addMarker(pos: Vec, note?: string) {
      const name = `M${++markerSeq}`;
      world.map.places.push({ name, pos, kind: "marker", note });
      return name;
    },
    removeMarker(name: string) { world.map.places = world.map.places.filter((p) => !(p.kind === "marker" && p.name === name)); },
    /** Advance one game second (paused automatically in Map Inspector mode). */
    step() {
      if (result || inspectorMode) return result;
      world.step();
      script();
      battalionNet.deliver(world.t);
      companyNet.deliver(world.t);
      picture.step();
      if (aiCommanderEnabled) alpha6.tick();
      return (result = outcome());
    },
  };
}
export type Game = ReturnType<typeof createGame>;
