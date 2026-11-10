import React, { useEffect, useRef, useState } from "react";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { AgentLog, createGame, Game } from "../game";
import { clock } from "../perception/sitrep";
import { COMPANY, PLAYER } from "../sim/scenario";
import { STATS } from "../sim/world";
import { PaperMap } from "../render/PaperMap";
import { Vec } from "../sim/map";

interface ChatEntry {
  id: number;
  t: number;
  from: string;
  to: string;
  text: string;
  deliverAt: number;
}

const panelStyle: React.CSSProperties = {
  background: "rgba(248, 244, 234, 0.94)",
  border: "1px solid #b8ae9c",
  borderRadius: 6,
  boxShadow: "0 4px 16px rgba(60, 50, 35, 0.14)",
  color: "#2b2620",
  backdropFilter: "blur(6px)",
};

const btnStyle = (active = false): React.CSSProperties => ({
  padding: "4px 9px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 4,
  border: "1px solid #9e9381",
  background: active ? "#2f5d8c" : "#ede6d6",
  color: active ? "#fff" : "#2b2620",
  cursor: "pointer",
});

export const App: React.FC = () => {
  const [, setTick] = useState(0);
  const [speed, setSpeed] = useState(2);
  const [paused, setPaused] = useState(false); // Debug only
  const [god, setGod] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [markerMode, setMarkerMode] = useState(false);
  const [markerNote, setMarkerNote] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [agentLogs, setAgentLogs] = useState<AgentLog[]>([]);
  const [companyLogs, setCompanyLogs] = useState<{ t: number; from: string; to: string; text: string }[]>([]);

  const msgSeq = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const gameRef = useRef<Game | null>(null);
  if (!gameRef.current) {
    const provider = createDeepSeek({
      baseURL: `${window.location.origin}/api/deepseek`,
      apiKey: "proxy",
    });
    const modelId = (import.meta as unknown as { env: { WARGAME_MODEL?: string } }).env.WARGAME_MODEL || "deepseek-flash";
    gameRef.current = createGame(provider(modelId), {
      onPlayerRadio: (m) => {
        setMessages((prev) => [
          ...prev,
          { id: ++msgSeq.current, t: gameRef.current!.world.t, from: m.from, to: m.to, text: m.text, deliverAt: m.deliverAt },
        ]);
      },
      onCompanyNet: (m) => {
        setCompanyLogs((prev) => [...prev.slice(-60), { t: gameRef.current!.world.t, from: m.from, to: m.to, text: m.text }]);
      },
      log: (entry) => {
        setAgentLogs((prev) => [...prev, entry]);
      },
    });
  }
  const game = gameRef.current;
  const { world, picture, battalionNet } = game;

  // Main simulation loop
  useEffect(() => {
    let acc = 0;
    const id = setInterval(() => {
      if (paused || game.result) return;
      acc += 0.1 * speed;
      let stepped = false;
      while (acc >= 1) {
        acc -= 1;
        stepped = true;
        if (game.step()) break;
      }
      if (stepped) setTick((t) => t + 1);
    }, 100);
    return () => clearInterval(id);
  }, [game, speed, paused]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, game.agentThinking]);

  const sendRadio = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    const eta = game.radio(text);
    const deliverAt = world.t + eta;
    setMessages((prev) => [
      ...prev,
      { id: ++msgSeq.current, t: world.t, from: PLAYER, to: COMPANY, text, deliverAt },
    ]);
    setInput("");
    setTick((t) => t + 1);
  };

  const handleMapClick = (pos: Vec, grid4: string) => {
    if (markerMode) {
      const name = game.addMarker(pos, markerNote.trim() || undefined);
      setMarkerNote("");
      setMarkerMode(false);
      setInput((prev) => (prev ? `${prev} ${name} (${grid4})` : `${name} (${grid4}) `));
      setTick((t) => t + 1);
      inputRef.current?.focus();
    } else {
      setInput((prev) => (prev && !prev.endsWith(" ") ? `${prev} ${grid4}` : `${prev}${grid4} `));
      inputRef.current?.focus();
    }
  };

  const handleRemoveMarker = (name: string) => {
    game.removeMarker(name);
    setTick((t) => t + 1);
  };

  const stateBadge = (state: string) => {
    const colors: Record<string, { bg: string; fg: string }> = {
      holding: { bg: "#d1fae5", fg: "#065f46" },
      moving: { bg: "#dbeafe", fg: "#1e40af" },
      pinned: { bg: "#fef3c7", fg: "#92400e" },
      broken: { bg: "#fee2e2", fg: "#991b1b" },
      destroyed: { bg: "#e5e7eb", fg: "#4b5563" },
    };
    const c = colors[state] ?? colors.holding;
    return (
      <span style={{ background: c.bg, color: c.fg, padding: "1px 6px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>
        {state.toUpperCase()}
      </span>
    );
  };

  const unitRows = god
    ? world.units
        .filter((u) => u.side === "blue")
        .map((u) => ({ id: u.id, type: u.type, state: u.state, strength: u.strength, engaging: !!u.target }))
    : picture.status;

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden" }}>
      {/* Full-screen Paper Map */}
      <PaperMap
        game={game}
        god={god}
        markerMode={markerMode}
        onMapClick={handleMapClick}
        onRemoveMarker={handleRemoveMarker}
      />

      {/* Top-left floating bar: Clock, speed, marker tool, debug toggles */}
      <div
        style={{
          ...panelStyle,
          position: "absolute",
          top: 20,
          left: 20,
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
        }}
      >
        <strong style={{ fontFamily: "ui-monospace, monospace", fontSize: 15 }}>{clock(world.t)}</strong>
        <span style={{ color: "#786f60" }}>|</span>
        <div style={{ display: "flex", gap: 4 }}>
          {[1, 2, 4, 8].map((s) => (
            <button key={s} style={btnStyle(speed === s && !paused)} onClick={() => { setPaused(false); setSpeed(s); }}>
              {s}x
            </button>
          ))}
        </div>
        <span style={{ color: "#786f60" }}>|</span>
        <button
          style={btnStyle(markerMode)}
          onClick={() => setMarkerMode((m) => !m)}
          title="Place a named reference point on the map (shared with Alpha 6)"
        >
          + Marker
        </button>
        {markerMode && (
          <input
            value={markerNote}
            onChange={(e) => setMarkerNote(e.target.value)}
            placeholder="optional label (then click map)"
            style={{
              padding: "3px 7px",
              fontSize: 12,
              border: "1px solid #9e9381",
              borderRadius: 4,
              background: "#fffdf8",
              width: 165,
            }}
          />
        )}
        <span style={{ color: "#786f60" }}>|</span>
        <button style={btnStyle(god)} onClick={() => setGod((g) => !g)} title="Debug: show ground-truth positions">
          God
        </button>
        <button style={btnStyle(showDebug)} onClick={() => setShowDebug((d) => !d)} title="Debug: LLM context & tool calls">
          LLM Debug
        </button>
        {showDebug && (
          <button style={btnStyle(paused)} onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause (dbg)"}
          </button>
        )}
      </div>

      {/* Left floating window: Unit Overview (synced on radio contact) */}
      <div
        style={{
          ...panelStyle,
          position: "absolute",
          top: 72,
          left: 20,
          width: 265,
          padding: "10px 12px",
          fontSize: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <strong style={{ fontSize: 13 }}>ALPHA CO. STATUS</strong>
          <span style={{ fontSize: 11, color: "#6e6555", fontFamily: "ui-monospace, monospace" }}>
            pos: {world.t - picture.tracksAt}s ago
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#6e6555", marginBottom: 8 }}>
          {god
            ? "GOD MODE: live ground truth"
            : picture.syncedAt < 0
              ? "Status & contacts: awaiting first radio sync with Alpha 6"
              : `Status & contacts synced at ${clock(picture.syncedAt)} (${world.t - picture.syncedAt}s ago)`}
        </div>

        {unitRows.length === 0 ? (
          <div style={{ color: "#786f60", fontStyle: "italic", padding: "6px 0" }}>
            Radio Alpha 6 to receive unit status report.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {unitRows.map((u) => (
              <div
                key={u.id}
                style={{
                  padding: "6px 8px",
                  background: "rgba(235, 229, 215, 0.65)",
                  borderRadius: 4,
                  border: "1px solid #d4cbb8",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>{u.id}</strong>
                  {stateBadge(u.state)}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, color: "#524a3e", fontSize: 11 }}>
                  <span>{STATS[u.type].label}</span>
                  <span style={{ fontFamily: "ui-monospace, monospace" }}>
                    str {Math.round(u.strength)}%{u.engaging ? " · ENGAGING" : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {picture.orders.length > 0 && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid #cfc6b4", fontSize: 11, color: "#4b4338" }}>
            <strong>Intercepted Co. Orders:</strong>
            {picture.orders.map((o) => (
              <div key={o.unit} style={{ marginTop: 2, fontFamily: "ui-monospace, monospace" }}>
                · {o.unit}: {o.order.kind}
                {o.order.dest ? ` → ${o.order.destName ?? world.map.toGrid(o.order.dest)}` : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right floating window: Radio Net */}
      <div
        style={{
          ...panelStyle,
          position: "absolute",
          top: 20,
          right: 20,
          bottom: 20,
          width: 340,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid #cfc6b4",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <strong style={{ fontSize: 13 }}>BATTALION NET</strong>
            <div style={{ fontSize: 11, color: "#6e6555" }}>You: {PLAYER} · Sub: {COMPANY}</div>
          </div>
          <div style={{ fontSize: 11, fontFamily: "ui-monospace, monospace" }}>
            {game.agentThinking ? (
              <span style={{ color: "#b45309", fontWeight: 700 }}>ALPHA 6 THINKING…</span>
            ) : battalionNet.busy(world.t) ? (
              <span style={{ color: "#1d4ed8", fontWeight: 700 }}>TX ON AIR ({battalionNet.backlog})</span>
            ) : (
              <span style={{ color: "#15803d" }}>NET CLEAR</span>
            )}
          </div>
        </div>

        {/* Mission header */}
        <div
          style={{
            padding: "8px 12px",
            background: "rgba(232, 225, 210, 0.7)",
            borderBottom: "1px solid #d8cfbe",
            fontSize: 11.5,
            color: "#3f382e",
          }}
        >
          <strong>Mission:</strong> Seize village of <strong>Kessel [2030]</strong>. Alpha Co. is assembled at{" "}
          <strong>Brandt [2004]</strong>.
        </div>

        {/* Radio log */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          {messages.length === 0 && (
            <div style={{ color: "#786f60", fontSize: 12, fontStyle: "italic" }}>
              No transmissions yet. Send orders to Alpha 6 below (click any point on the map to insert its grid).
            </div>
          )}
          {messages.map((m) => {
            const fromPlayer = m.from === PLAYER;
            const pending = m.deliverAt > world.t;
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: fromPlayer ? "flex-end" : "flex-start",
                  maxWidth: "90%",
                  padding: "7px 10px",
                  borderRadius: 6,
                  background: fromPlayer ? "#dce7f5" : "#fffdf8",
                  border: `1px solid ${fromPlayer ? "#9bb5d6" : "#cfc6b4"}`,
                  fontSize: 12.5,
                  lineHeight: 1.4,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 10.5,
                    color: "#6e6555",
                    marginBottom: 3,
                    fontFamily: "ui-monospace, monospace",
                  }}
                >
                  <strong>{m.from} → {m.to}</strong>
                  <span>{pending ? `TX… (${Math.ceil(m.deliverAt - world.t)}s)` : clock(m.t)}</span>
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
              </div>
            );
          })}
          <div ref={chatEndRef} />
        </div>

        {/* Victory / Defeat banner */}
        {game.result && (
          <div
            style={{
              padding: "10px 12px",
              background: game.result === "win" ? "#dcfce7" : "#fee2e2",
              color: game.result === "win" ? "#14532d" : "#7f1d1d",
              fontWeight: 700,
              fontSize: 13,
              textAlign: "center",
              borderTop: "1px solid #cfc6b4",
            }}
          >
            {game.result === "win" ? "VICTORY — Kessel Secured" : "DEFEAT — Alpha Co. Combat Ineffective"}
          </div>
        )}

        {/* Input box */}
        <form onSubmit={sendRadio} style={{ padding: 10, borderTop: "1px solid #cfc6b4", display: "flex", gap: 6 }}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Transmit to Alpha 6…"
            style={{
              flex: 1,
              padding: "7px 9px",
              fontSize: 12.5,
              borderRadius: 4,
              border: "1px solid #9e9381",
              background: "#fffdf9",
            }}
          />
          <button type="submit" style={{ ...btnStyle(true), padding: "7px 12px" }}>
            Send
          </button>
        </form>
      </div>

      {/* Optional Debug Drawer: LLM Context, Tool Calls, & Company Net */}
      {showDebug && (
        <div
          style={{
            ...panelStyle,
            position: "absolute",
            left: 300,
            right: 372,
            bottom: 20,
            maxHeight: "48vh",
            display: "flex",
            flexDirection: "column",
            fontSize: 11.5,
          }}
        >
          <div
            style={{
              padding: "6px 12px",
              borderBottom: "1px solid #cfc6b4",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <strong>LLM DEBUG — Alpha 6 Turns ({agentLogs.length}) & Company Net</strong>
            <button style={{ ...btnStyle(), padding: "1px 6px" }} onClick={() => setShowDebug(false)}>
              ×
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", flex: 1, overflow: "hidden" }}>
            <div style={{ overflowY: "auto", padding: 10, borderRight: "1px solid #cfc6b4", fontFamily: "ui-monospace, monospace" }}>
              {agentLogs.length === 0 ? (
                <div style={{ color: "#786f60" }}>No LLM turns yet.</div>
              ) : (
                agentLogs.map((l, idx) => {
                  const steps = (l.steps as { text?: string; calls: { tool: string; input: unknown; output: unknown }[] }[]) ?? [];
                  const usage = l.usage as { inputTokens?: number; outputTokens?: number } | undefined;
                  return (
                    <div key={idx} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: "1px dashed #cfc6b4" }}>
                      <div style={{ fontWeight: 700, color: "#1e3a8a" }}>
                        Turn #{idx + 1} @ {clock(l.t)} {usage ? `(in:${usage.inputTokens} out:${usage.outputTokens})` : ""}
                      </div>
                      {l.error && <div style={{ color: "#b91c1c" }}>Error: {l.error}</div>}
                      <details style={{ marginTop: 4 }}>
                        <summary style={{ cursor: "pointer", color: "#524a3e" }}>Prompt / Sitrep</summary>
                        <pre style={{ whiteSpace: "pre-wrap", fontSize: 10.5, background: "#ece5d5", padding: 6, borderRadius: 4 }}>
                          {String(l.prompt ?? "")}
                        </pre>
                      </details>
                      {steps.map((s, si) => (
                        <div key={si} style={{ marginTop: 4 }}>
                          {s.calls.map((c, ci) => (
                            <div key={ci} style={{ color: "#065f46" }}>
                              → <strong>{c.tool}</strong>({JSON.stringify(c.input)}) ⇒ {String(c.output)}
                            </div>
                          ))}
                          {s.text && <div style={{ color: "#4b4338", marginTop: 2 }}>Note: {s.text}</div>}
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
            <div style={{ overflowY: "auto", padding: 10, fontFamily: "ui-monospace, monospace" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Company Net (Debug Eavesdrop)</div>
              {companyLogs.map((c, i) => (
                <div key={i} style={{ marginBottom: 3, color: "#4b4338" }}>
                  [{clock(c.t)}] {c.from} → {c.to}: {c.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
