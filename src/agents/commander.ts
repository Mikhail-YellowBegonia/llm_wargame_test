// LLM company commander: wakes on radio traffic, reads its own sitrep, acts through tools.
import { generateText, isStepCount, tool, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { RadioNet } from "../comms/radio";
import { clock, companySitrep, describeLocation, placesBrief } from "../perception/sitrep";
import { Order, OrderKind, Roe, STATS, World } from "../sim/world";

export interface CommanderOpts {
  id: string;                 // own callsign
  superior: string;           // callsign of whoever gives us orders
  personality: string;        // flavour text for the system prompt
  model: LanguageModel;
  upNet: RadioNet;            // net to superior
  downNet: RadioNet;          // net to subordinates
  log: (entry: object) => void;
}

/** Structured payload attached to order transmissions (lets the player's map plot intercepted orders). */
export interface OrderPayload { unit: string; order: Order }

const HEARTBEAT = 180; // game seconds without traffic before a routine self-check (only while in contact)
const MAX_HISTORY = 40;

export class Commander {
  private history: ModelMessage[] = [];
  private inbox: string[] = [];
  private busy = false;
  private lastRun = 0;

  constructor(private world: World, private o: CommanderOpts) {}

  receive(from: string, text: string) { this.inbox.push(`[${clock(this.world.t)}] ${from}: ${text}`); }
  get thinking() { return this.busy; }
  /** Full LLM context for the debug view. */
  context() { return { system: this.system(), history: this.history, inbox: this.inbox }; }

  /** Called every tick; starts an LLM turn if there is something to react to. */
  tick() {
    if (this.busy) return;
    const inContact = [...this.world.contacts.blue.values()].some((c) => this.world.t - c.seenAt < 60);
    if (!this.inbox.length && inContact && this.world.t - this.lastRun > HEARTBEAT)
      this.inbox.push(`[${clock(this.world.t)}] (no new traffic - routine check of the situation)`);
    if (this.inbox.length) void this.run();
  }

  private subordinates() { return this.world.units.filter((u) => u.commander === this.o.id); }

  private system() {
    const subs = this.subordinates().map((u) => `- ${u.id}: ${STATS[u.type].label}`).join("\n");
    return `You are ${this.o.id}, commander of a mechanized company in a late-1990s conventional war. ${this.o.personality}
Your superior is ${this.o.superior} (the player). You talk to them only by radio.

Your platoons (they obey simple orders and fight on their own; they return fire, get pinned under heavy fire, and fall back if shattered):
${subs}

Map (grid references are 4 digits = 100m square: first two digits easting, last two northing; north = higher northing):
${placesBrief(this.world)}

How you work:
- You only know what your platoons report. The SITUATION block is your current picture; contacts can be stale.
- Act with tools. Orders travel over the company radio net and take some seconds to arrive.
- Use radio_superior to acknowledge orders, ask for clarification, and report important developments (contact, casualties, objective taken, plan changes). Keep transmissions short, in radio style ("Steel 6, this is Alpha 6, ...").
- Data link: every time you and your superior exchange a transmission, their map is automatically updated with your platoons' status, the enemy contacts you know, and the orders you issued. So do NOT recite grids, positions or unit lists; give your assessment, intent, problems and requests instead.
- Interpret your superior's intent; use initiative when the situation changes, and tell them what you did.
- Speak the same language your superior uses.
- Any plain text you write without a tool is your private notes; nobody hears it.
- Each turn: decide, issue your orders/transmissions, then end the turn with a one-line private note. Do not wait or poll inside a turn; you are woken automatically when new traffic arrives, with a fresh SITUATION block.`;
  }

  private tools() {
    const w = this.world;
    const resolve = (ref: string) => w.map.resolve(ref);
    return {
      describe_location: tool({
        description: "Terrain, elevation and line of sight from each of your platoons to a location.",
        inputSchema: z.object({ location: z.string().describe("4- or 6-digit grid, or a place name") }),
        execute: async ({ location }) => {
          const p = resolve(location);
          return p ? describeLocation(w, this.o.id, p) : `Unknown location "${location}". Use a 4/6-digit grid or a named place.`;
        },
      }),
      order_platoon: tool({
        description:
          "Radio an order to one of your platoons. move = travel (fires per ROE); attack = advance and engage, fire at will; hold = stay (or go to destination then hold); withdraw = fall back, return fire only.",
        inputSchema: z.object({
          platoon: z.string().describe('callsign, e.g. "Alpha 1"'),
          action: z.enum(["move", "attack", "hold", "withdraw"]),
          destination: z.string().optional().describe("grid or place name; omit for hold-in-place"),
          roe: z.enum(["fire_at_will", "return_fire", "hold_fire"]).optional(),
        }),
        execute: async ({ platoon, action, destination, roe }) => {
          const u = w.get(platoon);
          if (!u || u.commander !== this.o.id) return `${platoon} is not one of your platoons.`;
          if (u.state === "destroyed") return `${u.id} is destroyed.`;
          const dest = destination ? resolve(destination) : undefined;
          if (destination && !dest) return `Unknown destination "${destination}".`;
          if (action !== "hold" && !dest) return `Action ${action} needs a destination.`;
          const order = { kind: action as OrderKind, dest, destName: dest && !/^\d+$/.test(destination!) ? destination : undefined };
          const text = `${u.id}, this is ${this.o.id}: ${action}${destination ? " to " + destination : ""}${roe ? ", " + roe.replace(/_/g, " ") : ""}. Over.`;
          const eta = this.o.downNet.send(w.t, this.o.id, u.id, text, () => {
            const r = w.command(u, order, roe as Roe | undefined);
            if (r !== "ok") this.receive(u.id, `cannot comply: ${r}`);
          }, { unit: u.id, order } satisfies OrderPayload);
          return `Order transmitted, ${u.id} receives it in ~${eta}s.`;
        },
      }),
      radio_superior: tool({
        description: `Send a radio transmission to your superior ${this.o.superior}.`,
        inputSchema: z.object({ message: z.string() }),
        execute: async ({ message }) => {
          const eta = this.o.upNet.send(w.t, this.o.id, this.o.superior, message);
          return `Transmitting (${eta}s of airtime incl. queue).`;
        },
      }),
    };
  }

  private async run() {
    this.busy = true;
    this.lastRun = this.world.t;
    const traffic = "Incoming radio traffic:\n" + this.inbox.splice(0).join("\n");
    const prompt = `${traffic}\n\n${companySitrep(this.world, this.o.id)}`;
    try {
      const res = await generateText({
        model: this.o.model,
        system: this.system(),
        messages: [...this.history, { role: "user", content: prompt }],
        tools: this.tools(),
        stopWhen: isStepCount(4),
      });
      // Store the traffic without the bulky sitrep; the next turn gets a fresh one.
      this.history.push({ role: "user", content: traffic }, ...res.responseMessages);
      this.trimHistory();
      this.o.log({
        t: this.world.t, agent: this.o.id, prompt,
        steps: res.steps.map((s) => ({
          text: s.text,
          calls: s.toolCalls.map((c) => ({ tool: c.toolName, input: c.input, output: s.toolResults.find((r) => r.toolCallId === c.toolCallId)?.output })),
        })),
        usage: res.totalUsage,
      });
    } catch (err) {
      this.o.log({ t: this.world.t, agent: this.o.id, error: String(err) });
      this.inbox.unshift(traffic.replace("Incoming radio traffic:\n", "")); // retry next tick
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      this.busy = false;
    }
  }

  private trimHistory() {
    if (this.history.length <= MAX_HISTORY) return;
    let cut = this.history.length - MAX_HISTORY;
    while (cut < this.history.length && this.history[cut].role !== "user") cut++;
    this.history = this.history.slice(cut);
  }
}
