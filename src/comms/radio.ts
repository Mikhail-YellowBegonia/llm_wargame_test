// Radio nets: one speaker at a time, so traffic queues up when things get busy.
export interface RadioMsg { from: string; to: string; text: string; deliverAt: number; onDeliver?: () => void; data?: unknown }

export class RadioNet {
  private queue: RadioMsg[] = [];
  private busyUntil = 0;
  constructor(readonly name: string, private listeners: Record<string, (m: RadioMsg) => void> = {}) {}

  listen(callsign: string, fn: (m: RadioMsg) => void) { this.listeners[callsign] = fn; }

  /** Queue a transmission at game time t. Airtime grows with message length (kept short: the LLM is slow enough). */
  send(t: number, from: string, to: string, text: string, onDeliver?: () => void, data?: unknown) {
    const airtime = 1 + text.split(/\s+/).length / 8;
    const start = Math.max(t, this.busyUntil);
    this.busyUntil = start + airtime;
    this.queue.push({ from, to, text, deliverAt: this.busyUntil, onDeliver, data });
    return Math.round(this.busyUntil - t);
  }

  deliver(t: number) {
    const due = this.queue.filter((m) => m.deliverAt <= t);
    this.queue = this.queue.filter((m) => m.deliverAt > t);
    for (const m of due) { m.onDeliver?.(); this.listeners[m.to]?.(m); this.listeners["*"]?.(m); }
  }
  get backlog() { return this.queue.length; }
  /** Messages queued or on air (for UI status). */
  get pending(): readonly RadioMsg[] { return this.queue; }
  busy(t: number) { return this.busyUntil > t; }
}
