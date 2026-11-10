import React, { useEffect, useMemo, useRef, useState } from "react";
import { contours } from "d3-contour";
import ms from "milsymbol";
import { CELL, Vec } from "../sim/map";
import { Game } from "../game";
import { UnitType } from "../sim/world";

// NATO APP-6D / MIL-STD-2525D SIDC codes
const SIDC: Record<"blue" | "red", Record<UnitType, string>> = {
  blue: {
    tank: "10031000141205000000",     // Friendly Armor Platoon
    ifv: "10031000141211020000",      // Friendly Mechanized Infantry Platoon
    infantry: "10031000141211000000", // Friendly Infantry Platoon
    atgm: "10031000131204000000",     // Friendly Anti-Tank Section
  },
  red: {
    tank: "10061000141205000000",     // Hostile Armor Platoon
    ifv: "10061000141211020000",
    infantry: "10061000141211000000",
    atgm: "10061000131204000000",
  },
};

const symUrlCache = new Map<string, string>();
function getSymbolUrl(side: "blue" | "red", type: UnitType, label: string): string {
  const key = `${side}:${type}:${label}`;
  let url = symUrlCache.get(key);
  if (!url) {
    const sym = new ms.Symbol(SIDC[side][type], {
      size: 26,
      uniqueDesignation: label,
      outlineWidth: 3,
      outlineColor: "#f6f2e8",
    });
    url = sym.toDataURL();
    symUrlCache.set(key, url);
  }
  return url;
}

interface Props {
  game: Game;
  god: boolean;
  markerMode: boolean;
  onMapClick: (pos: Vec, grid4: string) => void;
  onRemoveMarker: (name: string) => void;
}

export const PaperMap: React.FC<Props> = ({ game, god, markerMode, onMapClick, onRemoveMarker }) => {
  const { world, picture } = game;
  const { map } = world;

  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 0.18 });
  const [drag, setDrag] = useState<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [hoverPos, setHoverPos] = useState<Vec | null>(null);

  // Center map on initial mount
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const k = Math.min((rect.width - 40) / map.width, (rect.height - 40) / map.depth);
    setView({
      k,
      x: (rect.width - map.width * k) / 2,
      y: (rect.height - map.depth * k) / 2,
    });
  }, [map]);

  // Precompute static terrain geometry once per map
  const staticLayers = useMemo(() => {
    // 1. Contours from height grid
    const thresholds = [20, 35, 50, 65, 80, 95, 110];
    const contourGen = contours().size([map.cols, map.rows]).thresholds(thresholds);
    const heightArr = Array.from(map.height);
    const contourGeo = contourGen(heightArr);

    const toSvgPath = (rings: number[][][]) =>
      rings
        .map((ring) =>
          ring
            .map(([cx, cy], i) => {
              const x = cx * CELL;
              const y = (map.rows - cy) * CELL;
              return `${i === 0 ? "M" : "L"}${x.toFixed(0)},${y.toFixed(0)}`;
            })
            .join(" ") + "Z",
        )
        .join(" ");

    const contourPaths = contourGeo.map((c) => ({
      value: c.value,
      major: c.value % 50 === 0 || c.value >= 95,
      d: c.coordinates.map((poly) => toSvgPath(poly)).join(" "),
    }));

    // 2. Forest, town, road cells
    const forests: { x: number; y: number }[] = [];
    const towns: { x: number; y: number }[] = [];
    const roads: { x: number; y: number }[] = [];
    for (let r = 0; r < map.rows; r++) {
      for (let c = 0; c < map.cols; c++) {
        const t = map.terrain[r * map.cols + c];
        const x = c * CELL;
        const y = (map.rows - 1 - r) * CELL;
        if (t === "forest") forests.push({ x, y });
        else if (t === "town") towns.push({ x, y });
        else if (t === "road") roads.push({ x, y });
      }
    }

    // 3. Grid lines (every 100m minor, every 1000m major)
    const gridLines: { x1: number; y1: number; x2: number; y2: number; major: boolean; label?: string; lx?: number; ly?: number }[] = [];
    for (let gx = 0; gx <= map.width; gx += 100) {
      const major = gx % 500 === 0;
      if (gx % 200 !== 0 && !major) continue;
      gridLines.push({
        x1: gx, y1: 0, x2: gx, y2: map.depth, major,
        label: major ? String(gx / 100).padStart(2, "0") : undefined,
        lx: gx + 12, ly: map.depth - 20,
      });
    }
    for (let gy = 0; gy <= map.depth; gy += 100) {
      const major = gy % 500 === 0;
      if (gy % 200 !== 0 && !major) continue;
      const sy = map.depth - gy;
      gridLines.push({
        x1: 0, y1: sy, x2: map.width, y2: sy, major,
        label: major ? String(gy / 100).padStart(2, "0") : undefined,
        lx: 16, ly: sy - 10,
      });
    }

    return { contourPaths, forests, towns, roads, gridLines };
  }, [map]);

  // Convert screen clientX/Y to world meters (x east, y north)
  const screenToWorld = (clientX: number, clientY: number): Vec | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const sx = (clientX - rect.left - view.x) / view.k;
    const sy = (clientY - rect.top - view.y) / view.k;
    const wx = sx;
    const wy = map.depth - sy;
    if (!map.inBounds({ x: wx, y: wy })) return null;
    return { x: wx, y: wy };
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextK = Math.min(1.2, Math.max(0.1, view.k * factor));
    setView({
      k: nextK,
      x: mx - ((mx - view.x) / view.k) * nextK,
      y: my - ((my - view.y) / view.k) * nextK,
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDrag({ sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const wp = screenToWorld(e.clientX, e.clientY);
    setHoverPos(wp);
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    const moved = drag.moved || Math.hypot(dx, dy) > 4;
    setDrag({ ...drag, moved });
    setView((v) => ({ ...v, x: drag.vx + dx, y: drag.vy + dy }));
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (drag && !drag.moved) {
      const wp = screenToWorld(e.clientX, e.clientY);
      if (wp) onMapClick(wp, map.toGrid(wp, 4));
    }
    setDrag(null);
  };

  const toSvgY = (wy: number) => map.depth - wy;

  // Friendly units to display (god = real-time, normal = datalink tracks)
  const blueUnits = god
    ? world.alive("blue").map((u) => ({ id: u.id, type: u.type, pos: u.pos }))
    : picture.tracks;

  // Enemy contacts or god-mode real enemy units
  const redContacts = god
    ? world.alive("red").map((u) => ({ id: u.id, type: u.type, pos: u.pos, age: 0 }))
    : picture.contacts.map((c) => ({ id: c.id, type: c.type, pos: c.pos, age: world.t - c.seenAt }));

  const orderColor: Record<string, string> = {
    attack: "#b91c1c",
    move: "#1d4ed8",
    withdraw: "#d97706",
    hold: "#374151",
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        position: "absolute",
        inset: "10px",
        background: "#f2ece1",
        border: "1px solid #b8ae9c",
        borderRadius: 6,
        boxShadow: "inset 0 0 24px rgba(90,78,60,0.12)",
        overflow: "hidden",
        cursor: markerMode ? "crosshair" : drag?.moved ? "grabbing" : "grab",
        userSelect: "none",
      }}
    >
      <svg width="100%" height="100%" style={{ display: "block" }}>
        <defs>
          <marker id="arrow-attack" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#b91c1c" />
          </marker>
          <marker id="arrow-move" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#1d4ed8" />
          </marker>
          <marker id="arrow-withdraw" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#d97706" />
          </marker>
        </defs>

        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* Paper base */}
          <rect x={0} y={0} width={map.width} height={map.depth} fill="#f4efe4" stroke="#8a7f6d" strokeWidth={6} />

          {/* Forest cells (low saturation sage green) */}
          <g fill="#cedac2" opacity={0.85}>
            {staticLayers.forests.map((c, i) => (
              <rect key={i} x={c.x} y={c.y} width={CELL + 1} height={CELL + 1} />
            ))}
          </g>

          {/* Elevation contour lines (warm sepia) */}
          <g fill="none">
            {staticLayers.contourPaths.map((c, i) => (
              <path
                key={i}
                d={c.d}
                stroke={c.major ? "#b29c7e" : "#cbbba2"}
                strokeWidth={c.major ? 4 : 2}
                opacity={0.75}
              />
            ))}
          </g>

          {/* Roads */}
          <g fill="#c9b497">
            {staticLayers.roads.map((c, i) => (
              <rect key={i} x={c.x + 8} y={c.y + 8} width={CELL - 16} height={CELL - 16} rx={6} />
            ))}
          </g>

          {/* Town cells */}
          <g fill="#b5aba0" stroke="#7d746a" strokeWidth={1.5}>
            {staticLayers.towns.map((c, i) => (
              <rect key={i} x={c.x + 4} y={c.y + 4} width={CELL - 8} height={CELL - 8} />
            ))}
          </g>

          {/* Grid lines & labels */}
          <g>
            {staticLayers.gridLines.map((g, i) => (
              <React.Fragment key={i}>
                <line
                  x1={g.x1}
                  y1={g.y1}
                  x2={g.x2}
                  y2={g.y2}
                  stroke={g.major ? "#968c7b" : "#cfc7b8"}
                  strokeWidth={g.major ? 2.5 : 1.2}
                  strokeDasharray={g.major ? undefined : "8 8"}
                />
                {g.label && (
                  <text
                    x={g.lx}
                    y={g.ly}
                    fill="#6e6555"
                    fontSize={38}
                    fontFamily="ui-monospace, monospace"
                    fontWeight={600}
                  >
                    {g.label}
                  </text>
                )}
              </React.Fragment>
            ))}
          </g>

          {/* Named places & Player markers */}
          {map.places.map((pl) => {
            const sx = pl.pos.x;
            const sy = toSvgY(pl.pos.y);
            if (pl.kind === "marker") {
              return (
                <g
                  key={pl.name}
                  transform={`translate(${sx},${sy})`}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveMarker(pl.name);
                  }}
                >
                  <title>Click to remove marker {pl.name}</title>
                  <circle r={26} fill="rgba(217, 119, 6, 0.18)" stroke="#b45309" strokeWidth={4} />
                  <path d="M -20 0 L 20 0 M 0 -20 L 0 20" stroke="#b45309" strokeWidth={3} />
                  <text y={-34} textAnchor="middle" fill="#92400e" fontSize={36} fontWeight={700} stroke="#f4efe4" strokeWidth={8} paintOrder="stroke">
                    {pl.name}{pl.note ? `: ${pl.note}` : ""}
                  </text>
                </g>
              );
            }
            return (
              <g key={pl.name} transform={`translate(${sx},${sy})`}>
                <circle r={10} fill="#4b443a" />
                <text
                  y={-20}
                  textAnchor="middle"
                  fill="#2f2923"
                  fontSize={44}
                  fontWeight={700}
                  fontFamily="Georgia, serif"
                  stroke="#f4efe4"
                  strokeWidth={10}
                  paintOrder="stroke"
                >
                  {pl.name}
                </text>
                <text
                  y={36}
                  textAnchor="middle"
                  fill="#665d50"
                  fontSize={28}
                  fontFamily="ui-monospace, monospace"
                  stroke="#f4efe4"
                  strokeWidth={6}
                  paintOrder="stroke"
                >
                  [{map.toGrid(pl.pos)}]
                </text>
              </g>
            );
          })}

          {/* Plotted company orders (intercepted from company net) */}
          {picture.orders.map((po) => {
            const dest = po.order.dest;
            if (!dest) return null;
            const track = blueUnits.find((u) => u.id === po.unit);
            const from = track ? track.pos : po.from;
            const color = orderColor[po.order.kind] ?? "#1d4ed8";
            const markerId =
              po.order.kind === "attack" ? "arrow-attack" : po.order.kind === "withdraw" ? "arrow-withdraw" : "arrow-move";
            return (
              <g key={po.unit} opacity={0.85}>
                <line
                  x1={from.x}
                  y1={toSvgY(from.y)}
                  x2={dest.x}
                  y2={toSvgY(dest.y)}
                  stroke={color}
                  strokeWidth={6}
                  strokeDasharray={po.order.kind === "move" ? "18 12" : undefined}
                  markerEnd={`url(#${markerId})`}
                />
                <circle cx={dest.x} cy={toSvgY(dest.y)} r={16} fill="none" stroke={color} strokeWidth={4} />
              </g>
            );
          })}

          {/* God mode: true lines of fire */}
          {god &&
            world.alive().map((u) => {
              if (!u.target || world.t - u.lastFiredAt > 3) return null;
              const tgt = world.get(u.target);
              if (!tgt) return null;
              return (
                <line
                  key={`fire-${u.id}`}
                  x1={u.pos.x}
                  y1={toSvgY(u.pos.y)}
                  x2={tgt.pos.x}
                  y2={toSvgY(tgt.pos.y)}
                  stroke={u.side === "blue" ? "#2563eb" : "#dc2626"}
                  strokeWidth={3}
                  strokeDasharray="10 10"
                  opacity={0.7}
                />
              );
            })}

          {/* Enemy contacts (high saturation red NATO symbols + uncertainty circle) */}
          {redContacts.map((c) => {
            const sx = c.pos.x;
            const sy = toSvgY(c.pos.y);
            const fade = Math.max(0.3, 1 - c.age / 600);
            const errRadius = god ? 0 : Math.min(250, 40 + c.age * 0.4);
            const url = getSymbolUrl("red", c.type, god ? c.id : c.age > 45 ? `?` : "");
            return (
              <g key={c.id} transform={`translate(${sx},${sy})`} opacity={fade}>
                {errRadius > 0 && (
                  <circle
                    r={errRadius}
                    fill="rgba(220, 38, 38, 0.07)"
                    stroke="#dc2626"
                    strokeWidth={3}
                    strokeDasharray="10 8"
                  />
                )}
                <image href={url} x={-55} y={-45} width={110} height={90} />
              </g>
            );
          })}

          {/* Friendly units (high saturation blue NATO symbols) */}
          {blueUnits.map((u) => {
            const sx = u.pos.x;
            const sy = toSvgY(u.pos.y);
            const shortLabel = u.id.replace("Alpha ", "A");
            const url = getSymbolUrl("blue", u.type, shortLabel);
            return (
              <g key={u.id} transform={`translate(${sx},${sy})`}>
                <image href={url} x={-55} y={-45} width={110} height={90} />
              </g>
            );
          })}
        </g>
      </svg>

      {/* Bottom-left coordinate readout */}
      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: 10,
          background: "rgba(246, 241, 229, 0.92)",
          border: "1px solid #bfb5a2",
          borderRadius: 4,
          padding: "4px 10px",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          color: "#3f382e",
          pointerEvents: "none",
        }}
      >
        {hoverPos
          ? `Grid ${map.toGrid(hoverPos, 4)} (${map.toGrid(hoverPos, 6)}) · ${map.terrainAt(hoverPos)} · elev ${Math.round(map.heightAt(hoverPos))}m · click to ${markerMode ? "place marker" : "insert grid"}`
          : "Scroll to zoom · drag to pan · click to insert grid"}
      </div>
    </div>
  );
};
