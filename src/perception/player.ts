// What the player (Steel 6) knows. Rules:
// - friendly positions: data link, refreshed every DATALINK_PERIOD seconds;
// - friendly status + enemy contacts: snapshot of the company commander's picture,
//   pushed only when a transmission between player and company commander is delivered;
// - orders the company commander gives: intercepted with a delay and plotted;
//   platoon reports on the company net are NOT visible.
import type { Vec } from "../sim/map";
import { Contact, Order, Unit, World } from "../sim/world";

export const DATALINK_PERIOD = 30;
export const INTERCEPT_DELAY = 10;

export interface FriendlyTrack { id: string; type: Unit["type"]; pos: Vec }
export interface FriendlyStatus { id: string; type: Unit["type"]; state: Unit["state"]; strength: number; roe: Unit["roe"]; engaging: boolean }
export interface PlottedOrder { t: number; unit: string; order: Order; from: Vec }

export class PlayerPicture {
  tracks: FriendlyTrack[] = [];
  tracksAt = 0;
  status: FriendlyStatus[] = [];
  contacts: Contact[] = [];
  syncedAt = -1;
  orders: PlottedOrder[] = [];
  private pendingOrders: (PlottedOrder & { visibleAt: number })[] = [];

  constructor(private world: World, private commander: string) {
    this.refreshTracks();
  }

  private own() { return this.world.units.filter((u) => u.commander === this.commander); }

  refreshTracks() {
    this.tracks = this.own().filter((u) => u.state !== "destroyed").map((u) => ({ id: u.id, type: u.type, pos: { ...u.pos } }));
    this.tracksAt = this.world.t;
  }

  /** Called when player <-> company commander traffic is delivered. */
  sync() {
    const own = this.own();
    this.status = own.map((u) => ({ id: u.id, type: u.type, state: u.state, strength: u.strength, roe: u.roe, engaging: !!u.target }));
    const ids = new Set(own.map((u) => u.id));
    this.contacts = [...this.world.contacts.blue.values()].filter((c) => ids.has(c.seenBy)).map((c) => ({ ...c, pos: { ...c.pos } }));
    this.syncedAt = this.world.t;
    this.refreshTracks();
  }

  /** An order went out on the company net; it shows up on the player's map a bit later. */
  intercept(unit: string, order: Order) {
    const u = this.world.get(unit);
    if (!u) return;
    this.pendingOrders.push({ t: this.world.t, unit, order, from: { ...u.pos }, visibleAt: this.world.t + INTERCEPT_DELAY });
  }

  step() {
    const t = this.world.t;
    if (t % DATALINK_PERIOD === 0) this.refreshTracks();
    for (const p of this.pendingOrders.filter((p) => p.visibleAt <= t)) {
      this.orders = this.orders.filter((o) => o.unit !== p.unit); // latest order per platoon
      this.orders.push(p);
    }
    this.pendingOrders = this.pendingOrders.filter((p) => p.visibleAt > t);
  }

}
