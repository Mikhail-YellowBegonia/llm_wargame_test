import React, { useEffect, useRef, useState } from "react";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { AgentLog, createGame, Game } from "../game";
import { clock } from "../perception/sitrep";
import { COMPANY, PLAYER } from "../sim/scenario";
import { AirMissionProfile, ArtilleryAmmoType, FACTION_VARIANTS, getMoraleTier, isCowering, MoraleEventKind, MoraleTier, OrderKind, Roe, Side, STATS, UnitType } from "../sim/world";
import { LosObserver, Sandtable3D, SimClockState } from "../render/Sandtable3D";
import { Building, BuildingFloor, MobilityClass, UnitTrait, Vec } from "../sim/map";

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

const KEY_STORAGE = "wargame_deepseek_key";
const metaEnv = (import.meta as unknown as { env: { DEV?: boolean; WARGAME_MODEL?: string } }).env;
const MOBILITIES: readonly MobilityClass[] = ["foot", "wheeled", "tracked", "amphibious"];
const TRAITS: readonly UnitTrait[] = ["infantry", "vehicle", "armored", "low_profile", "tall_profile"];
const SPAWN_TYPES: readonly UnitType[] = [
  "tank", "ifv", "infantry", "atgm", "artillery", "mlrs", "recon",
  "fob", "supply_truck", "shorad", "sam", "helicopter", "aircraft",
];
const FIRE_AMMO_TYPES: readonly ArtilleryAmmoType[] = ["HE_Impact", "HE_Airburst", "Smoke"];

export const App: React.FC = () => {
  const [, setTick] = useState(0);
  const [speed, setSpeed] = useState(2);
  const [paused, setPaused] = useState(false); // Debug only
  const [inspectorMode, setInspectorMode] = useState(false);
  const [observerEyeH, setObserverEyeH] = useState(2.0);
  const [hoverPos, setHoverPos] = useState<Vec | null>(null);
  const [losObserver, setLosObserver] = useState<LosObserver | null>(null);
  const [selectedBuilding, setSelectedBuilding] = useState<{ building: Building; floorLevel: number } | null>(null);
  const [god, setGod] = useState(false);
  const [aiCommander, setAiCommander] = useState(false);
  const [showLlmPanel, setShowLlmPanel] = useState(false);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [pendingOrder, setPendingOrder] = useState<"move" | "attack" | "withdraw" | "garrison" | "fire_mission" | null>(null);
  const [pendingSortie, setPendingSortie] = useState<AirMissionProfile | null>(null);
  const [fireAmmo, setFireAmmo] = useState<ArtilleryAmmoType>("HE_Impact");
  const [spawnMode, setSpawnMode] = useState(false);
  const [spawnSide, setSpawnSide] = useState<Side>("blue");
  const [spawnType, setSpawnType] = useState<UnitType>("artillery");
  const [commandNote, setCommandNote] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [markerMode, setMarkerMode] = useState(false);
  const [markerNote, setMarkerNote] = useState("");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(KEY_STORAGE) ?? "");
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [agentLogs, setAgentLogs] = useState<AgentLog[]>([]);
  const [companyLogs, setCompanyLogs] = useState<{ t: number; from: string; to: string; text: string }[]>([]);

  const msgSeq = useRef(0);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const gameRef = useRef<Game | null>(null);
  if (!gameRef.current) {
    const proxyBase = `${window.location.origin}/api/deepseek`;
    const provider = createDeepSeek({
      baseURL: proxyBase,
      apiKey: "proxy",
      fetch: async (url, init) => {
        const userKey = localStorage.getItem(KEY_STORAGE)?.trim();
        if (userKey) {
          const directUrl = String(url).replace(proxyBase, "https://api.deepseek.com");
          const headers = new Headers(init?.headers);
          headers.set("Authorization", `Bearer ${userKey}`);
          return fetch(directUrl, { ...init, headers });
        }
        if (metaEnv.DEV) return fetch(url, init);
        throw new Error("No DeepSeek API key set. Click 'API Key' in the top bar to enter your key.");
      },
    });
    const modelId = metaEnv.WARGAME_MODEL || "deepseek-flash";
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

  const simClockRef = useRef<SimClockState>({ tickAlpha: 0, speed: 2, paused: false });
  simClockRef.current.speed = speed;
  simClockRef.current.paused = paused || inspectorMode || !!game.result;

  // 60 FPS rAF accumulator driving 1 Hz simulation ticks with fractional tickAlpha for smooth interpolation
  useEffect(() => {
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const clk = simClockRef.current;
      if (clk.paused || game.result) return;
      acc += dt * clk.speed;
      let stepped = false;
      while (acc >= 1) {
        acc -= 1;
        stepped = true;
        if (game.step()) {
          acc = 1;
          break;
        }
      }
      clk.tickAlpha = acc;
      if (stepped) setTick((t) => t + 1);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [game]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, game.agentThinking]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setPendingOrder(null); setPendingSortie(null); setSpawnMode(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const updateApiKey = (val: string) => {
    setApiKey(val);
    if (val.trim()) localStorage.setItem(KEY_STORAGE, val.trim());
    else localStorage.removeItem(KEY_STORAGE);
  };

  const sendRadio = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    if (!metaEnv.DEV && !apiKey.trim()) {
      setShowKeyInput(true);
      return;
    }
    const eta = game.radio(text);
    const deliverAt = world.t + eta;
    setMessages((prev) => [
      ...prev,
      { id: ++msgSeq.current, t: world.t, from: PLAYER, to: COMPANY, text, deliverAt },
    ]);
    setInput("");
    setTick((t) => t + 1);
  };

  const toggleInspector = () => {
    const next = !inspectorMode;
    setInspectorMode(next);
    game.setInspectorMode(next);
    if (!next) {
      setLosObserver(null);
      setSelectedBuilding(null);
    }
  };

  const toggleAiCommander = () => {
    const next = !aiCommander;
    setAiCommander(next);
    game.setAiCommanderEnabled(next);
  };

  const toggleGod = () => {
    const next = !god;
    setGod(next);
    if (!next && selectedUnitId) {
      const u = world.get(selectedUnitId);
      if (u?.side === "red") {
        setSelectedUnitId(null);
        setPendingOrder(null);
      }
    }
  };

  const handleSelectUnit = (unitId: string) => {
    setSelectedUnitId((prev) => (prev === unitId ? null : unitId));
    setPendingOrder(null);
    setCommandNote(null);
  };

  const handleMapClick = (pos: Vec, grid4: string) => {
    if (inspectorMode && !markerMode) {
      setSelectedBuilding(null);
      setLosObserver({ pos, eyeHeight: observerEyeH, label: `Terrain ${grid4} (+${observerEyeH}m)` });
      return;
    }
    if (!inspectorMode && !markerMode && pendingSortie) {
      const res = game.callAirSortie(spawnSide, pos, pendingSortie);
      if (res.ok && res.unit) {
        if (spawnSide === "red" && !god) setGod(true);
        setSelectedUnitId(res.unit.id);
        setCommandNote(`${res.unit.id}: ${pendingSortie} (${res.unit.flightAltitude}) → ${grid4}`);
      } else {
        setCommandNote(res.reason ?? "air sortie failed");
      }
      setPendingSortie(null);
      setTick((t) => t + 1);
      return;
    }
    if (!inspectorMode && !markerMode && spawnMode) {
      const spawned = game.spawnUnit(spawnSide, spawnType, pos);
      if (spawnSide === "red" && !god) setGod(true);
      setSelectedUnitId(spawned.id);
      setPendingOrder(null);
      setCommandNote(`Spawned ${spawned.id} (${spawnType}) at ${grid4}`);
      setTick((t) => t + 1);
      return;
    }
    if (!inspectorMode && !markerMode && selectedUnitId && pendingOrder && pendingOrder !== "garrison") {
      const orderPayload = pendingOrder === "fire_mission"
        ? { kind: pendingOrder, dest: pos, destName: grid4, ammoType: fireAmmo }
        : { kind: pendingOrder, dest: pos, destName: grid4 };
      const res = game.directCommand(selectedUnitId, orderPayload);
      setCommandNote(
        res === "ok"
          ? `${selectedUnitId}: ${pendingOrder === "fire_mission" ? `fire_mission (${fireAmmo})` : pendingOrder} → ${grid4}`
          : res,
      );
      setPendingOrder(null);
      setTick((t) => t + 1);
      return;
    }
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

  const handleSelectBuilding = (building: Building, floor: BuildingFloor) => {
    setSelectedBuilding({ building, floorLevel: floor.level });
    if (inspectorMode) {
      setLosObserver({
        pos: building.center,
        eyeHeight: floor.elevationOffset,
        label: `${building.id} F${floor.level} (+${floor.elevationOffset}m)`,
      });
    }
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

  const moraleBadge = (tier: MoraleTier, cowering: boolean) => {
    const colors: Record<MoraleTier, { bg: string; fg: string }> = {
      calm: { bg: "#dcfce7", fg: "#166534" },
      worried: { bg: "#fef9c3", fg: "#854d0e" },
      shaken: { bg: "#ffedd5", fg: "#9a3412" },
      panicked: { bg: "#fee2e2", fg: "#991b1b" },
    };
    const c = colors[tier];
    return (
      <span style={{ background: c.bg, color: c.fg, padding: "1px 5px", borderRadius: 3, fontSize: 10, fontWeight: 700 }}>
        {tier.toUpperCase()}{cowering ? " · COWER" : ""}
      </span>
    );
  };

  const unitRows: {
    id: string;
    type: keyof typeof STATS;
    designation: string;
    state: string;
    strength: number;
    engaging: boolean;
    moraleTier?: MoraleTier;
    cowering?: boolean;
    suppression?: number;
    moraleEvents?: MoraleEventKind[];
  }[] = god || !aiCommander
    ? world.units
        .filter((u) => u.side === "blue")
        .map((u) => ({
          id: u.id,
          type: u.type,
          designation: u.designation,
          state: u.state,
          strength: u.strength,
          engaging: !!u.target,
          moraleTier: getMoraleTier(u.morale),
          cowering: isCowering(u),
          suppression: u.suppression,
          moraleEvents: u.activeMoraleEvents,
        }))
    : picture.status.map((s) => ({
        ...s,
        designation: world.get(s.id)?.designation ?? STATS[s.type].label,
      }));

  const redRows = god
    ? world.units
        .filter((u) => u.side === "red")
        .map((u) => ({
          id: u.id,
          type: u.type,
          designation: u.designation,
          state: u.state,
          strength: u.strength,
          engaging: !!u.target,
          moraleTier: getMoraleTier(u.morale),
          cowering: isCowering(u),
          suppression: u.suppression,
        }))
    : [];

  const selectedUnit = selectedUnitId ? world.get(selectedUnitId) : undefined;
  const selectedTelemetry = selectedUnit ? world.getUnitTelemetry(selectedUnit) : undefined;

  const inspectPos = hoverPos ?? losObserver?.pos ?? null;
  const inspectDef = inspectPos ? world.map.terrainDefAt(inspectPos) : null;
  const inspectSlope = inspectPos ? world.map.slopeAt(inspectPos) : 0;
  const inspectElev = inspectPos ? world.map.elevationAt(inspectPos) : 0;

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden" }}>
      {/* Full-screen Three.js 3D Sandtable */}
      <Sandtable3D
        game={game}
        god={god}
        markerMode={markerMode}
        inspectorMode={inspectorMode}
        orderTargetMode={(!!pendingOrder && pendingOrder !== "garrison") || spawnMode || !!pendingSortie}
        allowBuildingSelect={
          inspectorMode ||
          (!!selectedUnit && selectedUnit.traits.includes("infantry") && (!pendingOrder || pendingOrder === "garrison"))
        }
        selectedUnitId={selectedUnitId}
        losObserver={losObserver}
        selectedBuilding={selectedBuilding}
        simClockRef={simClockRef}
        onMapClick={handleMapClick}
        onHoverPos={setHoverPos}
        onSelectBuilding={handleSelectBuilding}
        onSelectUnit={handleSelectUnit}
        onCancelOrder={() => { setPendingOrder(null); setPendingSortie(null); setSpawnMode(false); }}
      />

      {/* Top-left flex column stack: prevents top bar wrap from overlapping left HUD card */}
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          bottom: 58,
          maxWidth: showLlmPanel ? "calc(100vw - 380px)" : "calc(100vw - 32px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 10,
          pointerEvents: "none",
        }}
      >
      <div
        style={{
          ...panelStyle,
          pointerEvents: "auto",
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 13,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontFamily: "ui-monospace, monospace", fontSize: 15 }}>{clock(world.t)}</strong>
        <span style={{ color: "#786f60" }}>|</span>
        <div style={{ display: "flex", gap: 4 }}>
          {[1, 2, 4, 8].map((s) => (
            <button key={s} style={btnStyle(speed === s && !paused && !inspectorMode)} onClick={() => { setPaused(false); setSpeed(s); }}>
              {s}x
            </button>
          ))}
        </div>
        <span style={{ color: "#786f60" }}>|</span>
        <button
          style={{ ...btnStyle(inspectorMode), background: inspectorMode ? "#0369a1" : "#ede6d6" }}
          onClick={toggleInspector}
          title="Pause combat & LLM turns to inspect 6D terrain stats, building floors, and 3D Beer-Lambert LoS fans (no API key needed)"
        >
          {inspectorMode ? "Map Inspector ON" : "Map Inspector"}
        </button>
        {inspectorMode && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5 }}>
            <span>Eye:</span>
            {[1.8, 2.8, 10].map((h) => (
              <button key={h} style={btnStyle(observerEyeH === h)} onClick={() => setObserverEyeH(h)}>
                {h}m
              </button>
            ))}
          </div>
        )}
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
        <button style={btnStyle(god)} onClick={toggleGod} title="Debug: show ground-truth positions & allow selecting Red units">
          God
        </button>
        <button style={btnStyle(paused)} onClick={() => setPaused((p) => !p)} title="Pause or resume simulation ticks">
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          style={btnStyle(showLlmPanel)}
          onClick={() => setShowLlmPanel((p) => !p)}
          title="Show/hide BATTALION NET chat, AI Commander toggle, API Key, and LLM Debug tools"
        >
          LLM Panel
        </button>
        {showLlmPanel && (
          <>
            <span style={{ color: "#786f60" }}>|</span>
            <button
              style={{ ...btnStyle(aiCommander), background: aiCommander ? "#15803d" : "#b45309", color: "#fff" }}
              onClick={toggleAiCommander}
              title="Toggle Alpha 6 LLM Commander ON/OFF (OFF runs direct-command sandbox without API key)"
            >
              AI Commander: {aiCommander ? "ON" : "OFF"}
            </button>
            <button style={btnStyle(showDebug)} onClick={() => setShowDebug((d) => !d)} title="Debug: LLM context & tool calls">
              LLM Debug
            </button>
            <button
              style={{
                ...btnStyle(showKeyInput),
                borderColor: !metaEnv.DEV && !apiKey.trim() ? "#b45309" : "#9e9381",
              }}
              onClick={() => setShowKeyInput((k) => !k)}
              title="Set DeepSeek API key (saved in browser localStorage; optional in local dev)"
            >
              {apiKey.trim() ? "API Key ✓" : metaEnv.DEV ? "API Key (env)" : "API Key !"}
            </button>
            {showKeyInput && (
              <input
                type="password"
                value={apiKey}
                onChange={(e) => updateApiKey(e.target.value)}
                placeholder="sk-... (DeepSeek API key)"
                style={{
                  padding: "3px 7px",
                  fontSize: 12,
                  border: "1px solid #9e9381",
                  borderRadius: 4,
                  background: "#fffdf8",
                  width: 175,
                }}
              />
            )}
          </>
        )}
        {game.result && !showLlmPanel && (
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              fontWeight: 700,
              fontSize: 12,
              background: game.result === "win" ? "#dcfce7" : "#fee2e2",
              color: game.result === "win" ? "#14532d" : "#7f1d1d",
            }}
          >
            {game.result === "win" ? "VICTORY — Geisa Secured" : "DEFEAT — Alpha Co. Combat Ineffective"}
          </span>
        )}
      </div>

      {/* Left floating window: GIS Map Inspector (when active) or Unit Overview */}
      {inspectorMode ? (
        <div
          style={{
            ...panelStyle,
            pointerEvents: "auto",
            width: 300,
            maxHeight: "100%",
            padding: "10px 12px",
            fontSize: 11.5,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: 13 }}>GIS / 3D LoS INSPECTOR</strong>
            {losObserver && (
              <button style={btnStyle()} onClick={() => { setLosObserver(null); setSelectedBuilding(null); }}>
                Clear LoS
              </button>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#524a3e" }}>
            Click terrain to cast a 2km 3D Beer-Lambert LoS fan, or click a building to inspect floors & elevated vantage points.
          </div>

          {losObserver && (
            <div style={{ padding: "6px 8px", background: "#e0f2fe", border: "1px solid #7dd3fc", borderRadius: 4 }}>
              <strong>Observer:</strong> {losObserver.label}
              <div style={{ marginTop: 4, display: "flex", gap: 8, fontSize: 10.5 }}>
                <span style={{ color: "#15803d" }}>■ T = 1 Clear</span>
                <span style={{ color: "#c2410c" }}>■ 0 &lt; T &lt; 1 Foliage</span>
                <span style={{ color: "#b91c1c" }}>■ T = 0 Blocked</span>
              </div>
            </div>
          )}

          {inspectPos && inspectDef ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid #cfc6b4", paddingTop: 6 }}>
              <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                <strong>Grid {world.map.toGrid(inspectPos, 6)}</strong> · {Math.round(inspectElev)}m · slope {inspectSlope.toFixed(1)}°
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 12, height: 12, borderRadius: 2, background: inspectDef.meta.colorHex, border: "1px solid #555", display: "inline-block" }} />
                <strong>{inspectDef.meta.name}</strong> <code>({inspectDef.id})</code>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, background: "rgba(235,229,215,0.6)", padding: 6, borderRadius: 4 }}>
                <span>Move cost: <b>{inspectDef.movementCost}</b></span>
                <span>Speed mult: <b>{inspectDef.speedMultiplier}x</b></span>
                <span>Base sig: <b>{inspectDef.baseSignature}</b></span>
                <span>T@100m: <b>{inspectDef.transmittancePer100m}</b></span>
                <span>Canopy: <b>{inspectDef.canopyHeight}m</b></span>
                <span>Max slope: <b>{inspectDef.passability.maxSlopeDeg}°</b></span>
              </div>
              <div>
                <strong>Passability:</strong>{" "}
                {MOBILITIES.map((m) => (
                  <span
                    key={m}
                    style={{
                      display: "inline-block",
                      marginRight: 4,
                      marginTop: 2,
                      padding: "1px 5px",
                      borderRadius: 3,
                      fontSize: 10.5,
                      background: world.map.isPassable(inspectPos, m) ? "#dcfce7" : "#fee2e2",
                      color: world.map.isPassable(inspectPos, m) ? "#166534" : "#991b1b",
                    }}
                  >
                    {m}
                  </span>
                ))}
              </div>
              <div>
                <strong>Trait Modifiers:</strong>
                {TRAITS.every((tr) => !inspectDef.traitModifiers[tr]) ? (
                  <div style={{ fontSize: 10.5, color: "#6e6555" }}>None (1.0 neutral)</div>
                ) : (
                  TRAITS.map((tr) => {
                    const mod = inspectDef.traitModifiers[tr];
                    if (!mod) return null;
                    return (
                      <div key={tr} style={{ fontFamily: "ui-monospace, monospace", fontSize: 10.5, color: "#4b4338" }}>
                        · {tr}: sig {mod.signatureMult ?? 1}, dmg {mod.damageMult ?? 1}, sup {mod.suppressionMult ?? 1}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div style={{ color: "#786f60", fontStyle: "italic" }}>Hover or click any cell to inspect 6D terrain stats.</div>
          )}

          {selectedBuilding && (
            <div style={{ borderTop: "1px solid #cfc6b4", paddingTop: 6 }}>
              <strong>Building {selectedBuilding.building.id}</strong> (roof +{selectedBuilding.building.roofHeight}m, {selectedBuilding.building.floors.length} floors)
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
                {selectedBuilding.building.floors.map((fl) => {
                  const active = fl.level === selectedBuilding.floorLevel;
                  return (
                    <button
                      key={fl.level}
                      onClick={() => handleSelectBuilding(selectedBuilding.building, fl)}
                      style={{
                        ...btnStyle(active),
                        textAlign: "left",
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 11,
                      }}
                    >
                      <span>F{fl.level} (+{fl.elevationOffset}m) · {fl.state}</span>
                      <span>cap {fl.capacity} · dmg {fl.modifiers.damageMult ?? 1}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
      <div
        style={{
          ...panelStyle,
          pointerEvents: "auto",
          width: 265,
          maxHeight: "100%",
          overflowY: "auto",
          padding: "10px 12px",
          fontSize: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <strong style={{ fontSize: 13 }}>ALPHA CO. STATUS</strong>
          <span style={{ fontSize: 11, color: "#6e6555", fontFamily: "ui-monospace, monospace" }}>
            req: {world.sideResources.blue} · {world.t - picture.tracksAt}s
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#6e6555", marginBottom: 8 }}>
          {god
            ? "GOD MODE: live ground truth (click Blue or Red to command)"
            : !aiCommander
              ? "SANDBOX: click any unit or 3D sprite for direct orders"
              : picture.syncedAt < 0
                ? "Status & contacts: awaiting first radio sync with Alpha 6"
                : `Status & contacts synced at ${clock(picture.syncedAt)} (${world.t - picture.syncedAt}s ago)`}
        </div>

        {/* Debug Unit Spawner */}
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginBottom: 8, padding: "5px 6px", background: "rgba(235, 229, 215, 0.7)", borderRadius: 4, border: "1px solid #d4cbb8" }}>
          <select
            value={spawnSide}
            onChange={(e) => setSpawnSide(e.target.value as Side)}
            style={{ fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid #9e9381", background: "#fffdf8" }}
          >
            <option value="blue">Blue</option>
            <option value="red">Red</option>
          </select>
          <select
            value={spawnType}
            onChange={(e) => setSpawnType(e.target.value as UnitType)}
            style={{ fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid #9e9381", background: "#fffdf8", flex: 1, minWidth: 80 }}
          >
            {SPAWN_TYPES.map((t) => (
              <option key={t} value={t}>{t} ({FACTION_VARIANTS[spawnSide][t].shortCode})</option>
            ))}
          </select>
          <button
            style={{ ...btnStyle(spawnMode), fontSize: 11, padding: "2px 7px" }}
            onClick={() => { setSpawnMode((s) => !s); setPendingOrder(null); setPendingSortie(null); }}
            title="Click 3D terrain to spawn unit (Esc/right-click cancels)"
          >
            {spawnMode ? "Spawning…" : "+ Spawn"}
          </button>
          <div style={{ display: "flex", gap: 4, width: "100%", marginTop: 2 }}>
            <button
              style={{ ...btnStyle(pendingSortie === "cap_loiter"), fontSize: 10.5, padding: "2px 6px", flex: 1 }}
              onClick={() => { setPendingSortie((p) => (p === "cap_loiter" ? null : "cap_loiter")); setSpawnMode(false); setPendingOrder(null); }}
              title="Click 3D map to call CAP sortie (auto high/low altitude)"
            >
              {pendingSortie === "cap_loiter" ? "Click Map (CAP)…" : "✈ Call CAP"}
            </button>
            <button
              style={{ ...btnStyle(pendingSortie === "strike_egress"), fontSize: 10.5, padding: "2px 6px", flex: 1 }}
              onClick={() => { setPendingSortie((p) => (p === "strike_egress" ? null : "strike_egress")); setSpawnMode(false); setPendingOrder(null); }}
              title="Click 3D map to call Ground Strike sortie"
            >
              {pendingSortie === "strike_egress" ? "Click Map (Strike)…" : "✈ Call Strike"}
            </button>
          </div>
        </div>

        {unitRows.length === 0 ? (
          <div style={{ color: "#786f60", fontStyle: "italic", padding: "6px 0" }}>
            Radio Alpha 6 to receive unit status report.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {unitRows.map((u) => {
              const isSel = selectedUnitId === u.id;
              return (
                <div
                  key={u.id}
                  onClick={() => handleSelectUnit(u.id)}
                  style={{
                    padding: "6px 8px",
                    background: isSel ? "#dbeafe" : "rgba(235, 229, 215, 0.65)",
                    borderRadius: 4,
                    border: `1px solid ${isSel ? "#2563eb" : "#d4cbb8"}`,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <strong>{u.id}</strong>
                    {stateBadge(u.state)}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, color: "#524a3e", fontSize: 11 }}>
                    <span>{u.designation}</span>
                    <span style={{ fontFamily: "ui-monospace, monospace" }}>
                      str {Math.round(u.strength)}%{u.suppression !== undefined ? ` · sup ${Math.round(u.suppression)}%` : ""}{u.engaging ? " · ENG" : ""}
                    </span>
                  </div>
                  {u.moraleTier && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 3, gap: 4, flexWrap: "wrap" }}>
                      {moraleBadge(u.moraleTier, !!u.cowering)}
                      {u.moraleEvents && u.moraleEvents.length > 0 && (
                        <span style={{ fontSize: 9.5, fontFamily: "ui-monospace, monospace", color: "#4b4338" }}>
                          {u.moraleEvents.join(", ")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {god && redRows.length > 0 && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid #cfc6b4" }}>
            <strong style={{ fontSize: 11.5, color: "#991b1b" }}>RED FORCES (GOD)</strong>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 5 }}>
              {redRows.map((u) => {
                const isSel = selectedUnitId === u.id;
                return (
                  <div
                    key={u.id}
                    onClick={() => handleSelectUnit(u.id)}
                    style={{
                      padding: "5px 8px",
                      background: isSel ? "#fee2e2" : "rgba(242, 226, 222, 0.65)",
                      borderRadius: 4,
                      border: `1px solid ${isSel ? "#dc2626" : "#dfc2be"}`,
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <strong>{u.id}</strong>
                      {stateBadge(u.state)}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2, color: "#524a3e", fontSize: 10.5 }}>
                      <span>{u.designation}</span>
                      <span style={{ fontFamily: "ui-monospace, monospace" }}>
                        str {Math.round(u.strength)}% · sup {Math.round(u.suppression)}%
                      </span>
                    </div>
                    <div style={{ marginTop: 2 }}>{moraleBadge(u.moraleTier, u.cowering)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {selectedUnit && selectedTelemetry && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid #cfc6b4", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong style={{ fontSize: 12 }}>DIRECT ORDER: {selectedUnit.id}</strong>
                <div style={{ fontSize: 10.5, color: "#524a3e" }}>{selectedTelemetry.designation} · {selectedTelemetry.category} ({selectedTelemetry.echelon})</div>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  style={{ ...btnStyle(), padding: "1px 6px", background: "#fee2e2", color: "#991b1b", borderColor: "#fca5a5" }}
                  onClick={() => {
                    const delId = selectedUnit.id;
                    game.deleteUnit(delId);
                    setSelectedUnitId(null);
                    setPendingOrder(null);
                    setCommandNote(`Deleted ${delId}`);
                    setTick((t) => t + 1);
                  }}
                  title="Delete unit cleanly from world"
                >
                  Delete
                </button>
                <button style={{ ...btnStyle(), padding: "1px 6px" }} onClick={() => { setSelectedUnitId(null); setPendingOrder(null); }}>
                  ×
                </button>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(["move", "attack", "withdraw"] as const).map((kind) => (
                <button
                  key={kind}
                  style={btnStyle(pendingOrder === kind)}
                  onClick={() => { setSpawnMode(false); setPendingOrder((p) => (p === kind ? null : kind)); setCommandNote(null); }}
                >
                  {kind[0].toUpperCase() + kind.slice(1)}
                </button>
              ))}
              {selectedUnit.traits.includes("infantry") && (
                <button
                  style={btnStyle(pendingOrder === "garrison")}
                  onClick={() => { setSpawnMode(false); setPendingOrder((p) => (p === "garrison" ? null : "garrison")); setCommandNote(null); }}
                >
                  Garrison
                </button>
              )}
              {selectedUnit.traits.includes("infantry") && (
                <button
                  style={btnStyle(selectedUnit.order.kind === "withdraw_off_map")}
                  onClick={() => {
                    setPendingOrder(null);
                    const res = game.directCommand(selectedUnit.id, { kind: "withdraw_off_map" });
                    setCommandNote(res === "ok" ? `${selectedUnit.id}: withdrawing off-map (-${STATS[selectedUnit.type].reinforceCost} req on exit)` : res);
                    setTick((t) => t + 1);
                  }}
                  title="Withdraw off ground map edge to reconstitute KIA losses while preserving veterancy"
                >
                  Withdraw Off-Map
                </button>
              )}
              {(selectedUnit.type === "artillery" || selectedUnit.type === "mlrs") && (
                <button
                  style={btnStyle(pendingOrder === "fire_mission")}
                  onClick={() => { setSpawnMode(false); setPendingOrder((p) => (p === "fire_mission" ? null : "fire_mission")); setCommandNote(null); }}
                >
                  Fire Mission
                </button>
              )}
              {selectedUnit.type === "helicopter" && (
                <>
                  <button
                    style={btnStyle(selectedUnit.isLanded)}
                    onClick={() => {
                      const res = selectedUnit.isLanded
                        ? game.takeoffHelicopter(selectedUnit.id)
                        : game.landHelicopter(selectedUnit.id);
                      setCommandNote(res === "ok" ? `${selectedUnit.id}: ${selectedUnit.isLanded ? "landed" : "airborne"}` : res);
                      setTick((t) => t + 1);
                    }}
                  >
                    {selectedUnit.isLanded ? "Take Off" : "Land"}
                  </button>
                  {selectedUnit.isLanded && selectedUnit.embarkedIds.length === 0 && (
                    <button
                      style={btnStyle()}
                      onClick={() => {
                        const nearInf = world.onMapAlive(selectedUnit.side).find(
                          (x) => x.traits.includes("infantry") && !x.embarkedIn && Math.hypot(x.pos.x - selectedUnit.pos.x, x.pos.y - selectedUnit.pos.y) <= 200,
                        );
                        if (!nearInf) { setCommandNote("No friendly infantry within 200m to embark"); return; }
                        const res = game.embarkUnit(nearInf.id, selectedUnit.id);
                        setCommandNote(res === "ok" ? `Embarked ${nearInf.id}` : res);
                        setTick((t) => t + 1);
                      }}
                    >
                      Embark Inf
                    </button>
                  )}
                  {selectedUnit.embarkedIds.length > 0 && selectedUnit.isLanded && (
                    <button
                      style={btnStyle()}
                      onClick={() => {
                        for (const pid of [...selectedUnit.embarkedIds]) game.disembarkUnit(pid);
                        setCommandNote(`${selectedUnit.id}: disembarked troops`);
                        setTick((t) => t + 1);
                      }}
                    >
                      Disembark
                    </button>
                  )}
                </>
              )}
              <button
                style={btnStyle(selectedUnit.order.kind === "hold" && !pendingOrder)}
                onClick={() => {
                  setPendingOrder(null);
                  const res = game.directCommand(selectedUnit.id, { kind: "hold" as OrderKind });
                  setCommandNote(res === "ok" ? `${selectedUnit.id}: holding` : res);
                  setTick((t) => t + 1);
                }}
              >
                Hold
              </button>
            </div>
            {(selectedUnit.type === "artillery" || selectedUnit.type === "mlrs") && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10.5, color: "#524a3e" }}>Shell:</span>
                {FIRE_AMMO_TYPES.map((am) => (
                  <button
                    key={am}
                    style={{ ...btnStyle(fireAmmo === am), fontSize: 10, padding: "2px 6px" }}
                    onClick={() => setFireAmmo(am)}
                  >
                    {am === "HE_Impact" ? "HE Impact" : am === "HE_Airburst" ? "Airburst" : "Smoke"}
                  </button>
                ))}
              </div>
            )}
            {pendingOrder && (
              <div style={{ fontSize: 10.5, color: "#1d4ed8", fontWeight: 600 }}>
                {pendingOrder === "garrison"
                  ? "Click a highlighted 3D building to select floor (Esc/right-click cancels)."
                  : pendingOrder === "fire_mission"
                    ? `Click terrain on 3D map for ${fireAmmo} Fire Mission (Esc/right-click cancels).`
                    : `Click terrain on 3D map to dispatch ${pendingOrder.toUpperCase()} (Esc/right-click cancels).`}
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10.5, color: "#524a3e" }}>ROE:</span>
              {(["fire_at_will", "return_fire", "hold_fire"] as Roe[]).map((r) => (
                <button
                  key={r}
                  style={{ ...btnStyle(selectedUnit.roe === r), fontSize: 10, padding: "2px 6px" }}
                  onClick={() => {
                    const res = game.directCommand(selectedUnit.id, selectedUnit.order, r);
                    setCommandNote(res === "ok" ? `${selectedUnit.id} ROE: ${r}` : res);
                    setTick((t) => t + 1);
                  }}
                >
                  {r === "fire_at_will" ? "Fire" : r === "return_fire" ? "Return" : "Hold"}
                </button>
              ))}
            </div>

            {selectedUnit.traits.includes("infantry") && (
              <div style={{ background: "rgba(235,229,215,0.65)", padding: 6, borderRadius: 4, fontSize: 10.5 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>Garrison ({selectedUnit.headcount} pax)</strong>
                  {selectedUnit.garrison && (
                    <button
                      style={{ ...btnStyle(), fontSize: 10, padding: "2px 6px" }}
                      onClick={() => {
                        const res = game.exitBuilding(selectedUnit.id);
                        setCommandNote(res === "ok" ? `${selectedUnit.id} exited building` : res);
                        setTick((t) => t + 1);
                      }}
                    >
                      Exit Building
                    </button>
                  )}
                </div>
                {selectedBuilding ? (
                  <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ color: "#4b4338" }}>Click floor on {selectedBuilding.building.id} to garrison:</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {selectedBuilding.building.floors.map((fl) => (
                        <button
                          key={fl.level}
                          style={{
                            ...btnStyle(selectedUnit.garrison?.buildingId === selectedBuilding.building.id && selectedUnit.garrison?.floorLevel === fl.level),
                            fontSize: 10,
                            padding: "2px 6px",
                          }}
                          onClick={() => {
                            const res = game.garrisonBuildingFloor(selectedUnit.id, selectedBuilding.building.id, fl.level);
                            setPendingOrder(null);
                            setCommandNote(
                              res === "ok"
                                ? selectedUnit.garrison?.buildingId === selectedBuilding.building.id
                                  ? `${selectedUnit.id} garrisoned ${selectedBuilding.building.id} F${fl.level}`
                                  : `${selectedUnit.id} moving to garrison ${selectedBuilding.building.id} F${fl.level}`
                                : res,
                            );
                            setTick((t) => t + 1);
                          }}
                        >
                          Garrison F{fl.level} (cap {fl.capacity})
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ color: "#6e6555", marginTop: 2 }}>Click any 3D building to assign floor.</div>
                )}
              </div>
            )}

            {commandNote && (
              <div style={{ fontSize: 10.5, color: "#0369a1", fontFamily: "ui-monospace, monospace" }}>{commandNote}</div>
            )}

            {/* Live Selected-Unit Telemetry */}
            <div style={{ background: "rgba(235,229,215,0.6)", padding: 6, borderRadius: 4, fontSize: 10.5, fontFamily: "ui-monospace, monospace" }}>
              <div><strong>Telemetry</strong> · mob: {selectedUnit.mobility} · vet: <b>{selectedTelemetry.veterancy.toFixed(1)}</b> · obs: {selectedTelemetry.hasObserver ? "YES" : "no"}</div>
              {selectedTelemetry.offMapReconstituteAt !== undefined && (
                <div style={{ color: "#1d4ed8", fontWeight: 700 }}>
                  OFF-MAP RECONSTITUTING: returns in {Math.max(0, selectedTelemetry.offMapReconstituteAt - world.t)}s
                </div>
              )}
              {selectedUnit.type === "aircraft" && (
                <div>
                  air: <b>{selectedTelemetry.airState}</b> · alt: <b>{selectedTelemetry.flightAltitude}</b> · fuel: <b>{Math.round(selectedTelemetry.fuel)}/{selectedTelemetry.maxFuel}</b>
                  {selectedTelemetry.afterburner ? " · AB" : ""}
                  {selectedTelemetry.turnaroundTimers && (
                    <div style={{ color: "#1d4ed8" }}>
                      turnaround: refuel {selectedTelemetry.turnaroundTimers.refuelTime}s / repair {selectedTelemetry.turnaroundTimers.repairTime}s / rearm {selectedTelemetry.turnaroundTimers.rearmTime}s
                    </div>
                  )}
                </div>
              )}
              {selectedUnit.type === "helicopter" && (
                <div>
                  helo: <b>{selectedTelemetry.isForcedLanding ? "FORCED LANDED (<30%)" : selectedTelemetry.isLanded ? "LANDED" : "AIRBORNE"}</b>
                </div>
              )}
              {selectedTelemetry.supplyCapacity > 0 && (
                <div>
                  supply: <b>{selectedTelemetry.supplyCapacity === Infinity ? "∞" : `${Math.round(selectedTelemetry.supplyCarried)}/${selectedTelemetry.supplyCapacity}`}</b>
                </div>
              )}
              {selectedTelemetry.maxIndirectAmmo > 0 && (
                <div>
                  indirectAmmo: <b>{selectedTelemetry.indirectAmmo}/{selectedTelemetry.maxIndirectAmmo}</b>
                </div>
              )}
              {(selectedUnit.type === "artillery" || selectedUnit.type === "mlrs") && (
                <div>
                  posCal: <b style={{ color: selectedTelemetry.isPositionCalibrated ? "#15803d" : "#786f60" }}>{selectedTelemetry.isPositionCalibrated ? "CALIBRATED" : "uncalibrated"}</b>
                  {selectedTelemetry.fireMission && (
                    <span>
                      {" "}· FM: <b>{selectedTelemetry.fireMission.effectiveAmmo}</b> ({selectedTelemetry.fireMission.phase.toUpperCase()} {selectedTelemetry.fireMission.rangingFired}/{selectedTelemetry.fireMission.rangingNeeded}, disp {Math.round(selectedTelemetry.fireMission.dispersionRadius)}m, salvo {selectedTelemetry.fireMission.salvoRemaining})
                    </span>
                  )}
                </div>
              )}
              <div>
                morale: <b>{Math.round(selectedTelemetry.morale)}</b> ({selectedTelemetry.moraleTier}
                {selectedTelemetry.cowering ? ", Cowering" : ""}) · sup: <b>{Math.round(selectedTelemetry.suppression)}%</b>
              </div>
              <div>
                moraleEvents: <b>{selectedTelemetry.activeMoraleEvents.length ? selectedTelemetry.activeMoraleEvents.join(", ") : "none"}</b>
              </div>
              {(selectedTelemetry.embarkedIn || selectedTelemetry.embarkedIds.length > 0) && (
                <div>
                  {selectedTelemetry.embarkedIn
                    ? `embarkedIn: ${selectedTelemetry.embarkedIn}`
                    : `passengers: ${selectedTelemetry.embarkedIds.join(", ")}`}
                </div>
              )}
              <div>bodySig: <b>{selectedTelemetry.bodySignature.toFixed(2)}</b> · muzzle: {selectedUnit.muzzleSignature} ({selectedUnit.weaponClass})</div>
              <div>
                ter: <b>{selectedTelemetry.terrainId}</b> (sig×{selectedTelemetry.modifiers.signatureMult ?? 1}, dmg×{selectedTelemetry.modifiers.damageMult ?? 1})
              </div>
              <div>
                inBuilding: <b>{selectedTelemetry.garrison ? `${selectedTelemetry.garrison.buildingId} F${selectedTelemetry.garrison.floorLevel} (+${selectedTelemetry.garrison.elevationOffset}m)` : "no"}</b>
              </div>
              <div style={{ marginTop: 2 }}>
                <strong>ownPerception:</strong>{" "}
                {selectedTelemetry.ownPerception.length === 0
                  ? "none"
                  : selectedTelemetry.ownPerception.map((p) => `${p.targetId}:${p.level}`).join(", ")}
              </div>
              <div style={{ marginTop: 3, borderTop: "1px dashed #c2b8a3", paddingTop: 3 }}>
                <strong>Armor (KE/CE):</strong>{" "}
                F {selectedTelemetry.armor.front.ke}/{selectedTelemetry.armor.front.ce} ·
                S {selectedTelemetry.armor.side.ke}/{selectedTelemetry.armor.side.ce} ·
                R {selectedTelemetry.armor.rear.ke}/{selectedTelemetry.armor.rear.ce} ·
                T {selectedTelemetry.armor.top.ke}/{selectedTelemetry.armor.top.ce}
              </div>
              <div style={{ marginTop: 2 }}>
                <strong>Weapons:</strong>{" "}
                {selectedTelemetry.weaponSlots.map((w) => (
                  <span key={w.id} style={{ display: "inline-block", marginRight: 5 }}>
                    {w.id}[{w.ammo} {w.ammoRemaining}/{w.maxAmmo}
                    {w.mutexLocked ? " LOCKED" : w.cooldown > 0 ? ` ${w.cooldown}s` : " RDY"}
                    {w.mutexGroup ? `/${w.mutexGroup}` : ""}]
                  </span>
                ))}
              </div>
              {selectedTelemetry.subRoster && (
                <div style={{ marginTop: 2 }}>
                  <strong>SubRoster:</strong>{" "}
                  R:{selectedTelemetry.subRoster.personnel.rifleman} MG:{selectedTelemetry.subRoster.personnel.mg_specialist} AT:{selectedTelemetry.subRoster.personnel.at_specialist}
                  <div style={{ color: "#9a3412" }}>
                    WIA: {Object.values(selectedTelemetry.subRoster.wia).reduce((a, b) => a + b, 0)} ·{" "}
                    KIA: {Object.values(selectedTelemetry.subRoster.kia).reduce((a, b) => a + b, 0)} (selfCap {selectedTelemetry.subRoster.selfRecoveryCap})
                  </div>
                  {selectedTelemetry.subRoster.assignments.some((a) => a.crossManned) && (
                    <div style={{ color: "#b45309" }}>
                      Cross-manned:{" "}
                      {selectedTelemetry.subRoster.assignments
                        .filter((a) => a.crossManned)
                        .map((a) => `${a.weaponId} by ${a.role} (${Math.round(a.efficiency * 100)}%)`)
                        .join(", ")}
                    </div>
                  )}
                  {selectedTelemetry.subRoster.abandoned.length > 0 && (
                    <div style={{ color: "#786f60" }}>
                      Dropped: {selectedTelemetry.subRoster.abandoned.join(", ")}
                    </div>
                  )}
                </div>
              )}
            </div>
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
      )}
      </div>

      {/* Right floating window: Radio Net (hidden behind LLM Panel toggle by default) */}
      {showLlmPanel && (
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
            {!aiCommander ? (
              <span style={{ color: "#b45309", fontWeight: 700 }}>AI OFF — SANDBOX</span>
            ) : game.agentThinking ? (
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
          <strong>Mission:</strong> Fulda Gap — Advance past <strong>Point Alpha [2323]</strong> and seize{" "}
          <strong>Geisa [3513]</strong>. Alpha Co. stages from <strong>Rasdorf Approach [0316]</strong>.
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
            {game.result === "win" ? "VICTORY — Geisa Secured" : "DEFEAT — Alpha Co. Combat Ineffective"}
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
      )}

      {/* Optional Debug Drawer: LLM Context, Tool Calls, & Company Net */}
      {showLlmPanel && showDebug && (
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
