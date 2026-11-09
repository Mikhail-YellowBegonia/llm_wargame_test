// Simulation core: units, platoon-level bot state machine, spotting, combat, events.
// No I/O here; the world advances by fixed 1-second ticks and emits events.
import { GameMap, Vec, dist, rng } from "./map";

export type Side = "blue" | "red";
export type UnitType = "tank" | "ifv" | "infantry" | "atgm";
export type Roe = "fire_at_will" | "return_fire" | "hold_fire";
export type OrderKind = "hold" | "move" | "attack" | "withdraw";
export interface Order { kind: OrderKind; dest?: Vec; destName?: string }
export type BotState = "holding" | "moving" | "pinned" | "broken" | "destroyed";

interface TypeStats {
  label: string; armored: boolean;
  soft: number; hard: number;   // firepower vs soft / armored targets
  range: number; spot: number;  // meters
  speed: Record<"open" | "forest" | "town" | "road", number>; // km/h
}
export const STATS: Record<UnitType, TypeStats> = {
  tank:     { label: "tank platoon", armored: true,  soft: 6, hard: 10, range: 2000, spot: 2000, speed: { road: 45, open: 30, forest: 8, town: 15 } },
  ifv:      { label: "mech infantry platoon", armored: true, soft: 8, hard: 5, range: 1500, spot: 2000, speed: { road: 45, open: 30, forest: 10, town: 15 } },
  infantry: { label: "infantry platoon", armored: false, soft: 6, hard: 3, range: 600, spot: 1200, speed: { road: 5, open: 4, forest: 3, town: 3 } },
  atgm:     { label: "ATGM section", armored: false, soft: 1, hard: 9, range: 2500, spot: 2500, speed: { road: 5, open: 4, forest: 3, town: 3 } },
};

export interface Unit {
  id: string;            // callsign, e.g. "Alpha 1"
  side: Side; type: UnitType;
  pos: Vec;
  strength: number;      // 0..100
  suppression: number;   // 0..100
  morale: number;        // 0..100
  roe: Roe;
  order: Order;
  state: BotState;
  commander?: string;    // id of the agent that commands this unit
  target?: string;       // enemy currently engaged
  lastFiredAt: number; lastHitAt: number;
  rally?: Vec;           // where it falls back to when broken
}

export interface Contact { id: string; type: UnitType; pos: Vec; seenAt: number; seenBy: string; strength: number }

export type EventKind =
  | "contact" | "under_fire" | "pinned" | "recovered" | "casualties"
  | "arrived" | "broken" | "destroyed" | "enemy_destroyed";
export interface SimEvent { t: number; kind: EventKind; unit: string; text: string }

const COVER = { open: 1, road: 1, forest: 0.6, town: 0.4 } as const;
const DMG_K = 0.03; // tune: strength lost per second per point of firepower

export class World {
  t = 0; // game seconds
  units: Unit[] = [];
  /** What each side knows about enemy units (fused from all its units' spotting). */
  contacts: Record<Side, Map<string, Contact>> = { blue: new Map(), red: new Map() };
  events: SimEvent[] = [];
  private listeners: ((e: SimEvent) => void)[] = [];
  private random: () => number;
  private casualtyMarks = new Map<string, number>();
  private underFireReported = new Map<string, number>();

  constructor(readonly map: GameMap, seed = 1) { this.random = rng(seed); }

  on(fn: (e: SimEvent) => void) { this.listeners.push(fn); }
  private emit(kind: EventKind, u: Unit, text: string) {
    const e = { t: this.t, kind, unit: u.id, text };
    this.events.push(e);
    this.listeners.forEach((fn) => fn(e));
  }

  add(u: Omit<Unit, "strength" | "suppression" | "morale" | "state" | "lastFiredAt" | "lastHitAt" | "roe" | "order"> & Partial<Unit>) {
    const unit: Unit = {
      strength: 100, suppression: 0, morale: 80, state: "holding", roe: "fire_at_will",
      order: { kind: "hold" }, lastFiredAt: -1e9, lastHitAt: -1e9, ...u,
    };
    this.units.push(unit);
    return unit;
  }
  get(id: string) { return this.units.find((u) => u.id.toLowerCase() === id.trim().toLowerCase()); }
  alive(side?: Side) { return this.units.filter((u) => u.state !== "destroyed" && (!side || u.side === side)); }

  /** Give an order to a unit (used by agents, scripts and direct player commands). */
  command(u: Unit, order: Order, roe?: Roe) {
    if (u.state === "destroyed") return "unit destroyed";
    if (u.state === "broken") return `${u.id} is broken and falling back, not responding to orders`;
    u.order = order;
    if (roe) u.roe = roe;
    else if (order.kind === "attack") u.roe = "fire_at_will";
    else if (order.kind === "withdraw") u.roe = "return_fire";
    if (u.state !== "pinned") u.state = order.dest ? "moving" : "holding";
    return "ok";
  }

  step() {
    this.t += 1;
    const live = this.alive();
    this.spot(live);
    for (const u of live) this.fire(u);
    for (const u of live) this.bot(u);
  }

  // ---------- spotting ----------
  private canSee(o: Unit, e: Unit) {
    const d = dist(o.pos, e.pos);
    let range = STATS[o.type].spot;
    const ter = this.map.terrainAt(e.pos);
    if (ter === "forest" || ter === "town") range *= 0.5;
    if (this.t - e.lastFiredAt < 10) range *= 1.5; // muzzle flash / signature
    if (e.state === "holding" && !STATS[e.type].armored) range *= 0.7; // dug-in infantry
    return d <= range && this.map.los(o.pos, e.pos);
  }
  private spot(live: Unit[]) {
    for (const side of ["blue", "red"] as Side[]) {
      const known = this.contacts[side];
      for (const e of live) {
        if (e.side === side) continue;
        const observer = live.find((o) => o.side === side && this.canSee(o, e));
        if (!observer) continue;
        if (!known.has(e.id) || this.t - known.get(e.id)!.seenAt > 120)
          this.emit("contact", observer, `spotted ${STATS[e.type].label} at ${this.map.describe(e.pos)}`);
        known.set(e.id, { id: e.id, type: e.type, pos: { ...e.pos }, seenAt: this.t, seenBy: observer.id, strength: e.strength });
      }
      for (const [id, c] of known) {
        const u = this.units.find((x) => x.id === id);
        if (u?.state === "destroyed" && this.t - c.seenAt > 5) known.delete(id);
      }
    }
  }

  // ---------- combat ----------
  private fire(u: Unit) {
    if (u.roe === "hold_fire" || u.state === "broken") return;
    if (u.roe === "return_fire" && this.t - u.lastHitAt > 30) return;
    const st = STATS[u.type];
    // Pick the closest visible enemy in range (prefer current target).
    let target: Unit | undefined, best = Infinity;
    for (const e of this.alive()) {
      if (e.side === u.side) continue;
      const d = dist(u.pos, e.pos);
      if (d > st.range || !this.canSee(u, e)) continue;
      const score = e.id === u.target ? d * 0.5 : d;
      if (score < best) { best = score; target = e; }
    }
    u.target = target?.id;
    if (!target) return;
    const d = dist(u.pos, target.pos);
    const ts = STATS[target.type];
    let dmg = (ts.armored ? st.hard : st.soft) * DMG_K;
    dmg *= u.strength / 100;
    dmg *= 1 - u.suppression / 150;
    dmg *= u.state === "moving" ? 0.5 : u.state === "pinned" ? 0.4 : 1;
    dmg *= 1 - (0.5 * d) / st.range;
    dmg *= COVER[this.map.terrainAt(target.pos)];
    if (target.state === "holding") dmg *= 0.75; // hasty fighting positions
    dmg *= 0.5 + this.random();
    u.lastFiredAt = this.t;
    this.hit(target, dmg, u, 1 - d / st.range);
  }
  private hit(u: Unit, dmg: number, by: Unit, closeness: number) {
    u.strength = Math.max(0, u.strength - dmg);
    const supp = (dmg * 6 + 0.8 * closeness) * (STATS[u.type].armored ? 0.5 : 1);
    u.suppression = Math.min(100, u.suppression + supp);
    u.morale = Math.max(0, u.morale - dmg * 0.6);
    u.lastHitAt = this.t;
    if (this.t - (this.underFireReported.get(u.id) ?? -1e9) > 90) {
      this.underFireReported.set(u.id, this.t);
      this.emit("under_fire", u, `taking fire from the ${bearingWord(u.pos, by.pos)}`);
    }
    for (const mark of [75, 50, 25]) {
      if (u.strength < mark && (this.casualtyMarks.get(u.id) ?? 100) > mark) {
        this.casualtyMarks.set(u.id, mark);
        this.emit("casualties", u, `casualties, now at about ${mark}% strength`);
      }
    }
    if (u.strength < 8) {
      u.state = "destroyed";
      this.emit("destroyed", u, `${u.id} has been destroyed`);
      this.emit("enemy_destroyed", by, `destroyed enemy ${STATS[u.type].label}`);
    }
  }

  // ---------- platoon bot (finite state machine) ----------
  private bot(u: Unit) {
    if (u.state === "destroyed") return;
    // Recovery over time.
    const recentlyHit = this.t - u.lastHitAt < 15;
    u.suppression = Math.max(0, u.suppression - (recentlyHit ? 0.7 : 3));

    if (u.state !== "broken" && (u.strength < 30 || u.morale < 20)) {
      u.state = "broken";
      u.roe = "return_fire";
      u.order = { kind: "withdraw", dest: u.rally };
      this.emit("broken", u, "unit is combat ineffective and falling back on its own");
    }
    if (u.state === "moving" || u.state === "holding") {
      if (u.suppression > 60 && u.order.kind !== "withdraw") { u.state = "pinned"; this.emit("pinned", u, "pinned down, cannot move"); }
    } else if (u.state === "pinned" && u.suppression < 30) {
      u.state = u.order.dest ? "moving" : "holding";
      this.emit("recovered", u, "no longer pinned, resuming orders");
    }
    if ((u.state === "moving" || u.state === "broken") && u.order.dest) this.move(u, u.order.dest);
  }
  private move(u: Unit, dest: Vec) {
    const d = dist(u.pos, dest);
    const kmh = STATS[u.type].speed[this.map.terrainAt(u.pos)];
    const step = (kmh / 3.6) * (u.suppression > 30 ? 0.5 : 1);
    if (d <= step) {
      u.pos = { ...dest };
      const was = u.order;
      u.order = { kind: "hold" };
      if (u.state === "moving") { u.state = "holding"; this.emit("arrived", u, `arrived at ${was.destName ?? this.map.describe(dest)}, holding`); }
      return;
    }
    u.pos = { x: u.pos.x + ((dest.x - u.pos.x) / d) * step, y: u.pos.y + ((dest.y - u.pos.y) / d) * step };
  }
}

function bearingWord(from: Vec, to: Vec) {
  const deg = (Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI;
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(((deg + 360) % 360) / 45) % 8];
}
