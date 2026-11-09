// ASCII map for the terminal prototype. Shows only what the given side knows.
import { CELL } from "../sim/map";
import { Side, Unit, World } from "../sim/world";

const GLYPH = { open: ".", forest: "♣", town: "#", road: "=" } as const;
const SCALE = 2; // cells per character (100 m)

export function asciiMap(world: World, side: Side, god = false, friendlies: Pick<Unit, "id" | "pos">[] = world.alive(side)) {
  const { map } = world;
  const cols = Math.floor(map.cols / SCALE), rows = Math.floor(map.rows / SCALE);
  const grid: string[][] = [];
  for (let r = 0; r < rows; r++) {
    grid.push([]);
    for (let c = 0; c < cols; c++) {
      const p = { x: (c + 0.5) * SCALE * CELL, y: (r + 0.5) * SCALE * CELL };
      const h = map.heightAt(p);
      grid[r].push(map.terrainAt(p) === "open" && h > 60 ? "^" : GLYPH[map.terrainAt(p)]);
    }
  }
  const put = (x: number, y: number, ch: string) => {
    const c = Math.floor(x / (SCALE * CELL)), r = Math.floor(y / (SCALE * CELL));
    if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch;
  };
  for (const pl of map.places) put(pl.pos.x, pl.pos.y, "*");
  for (const u of friendlies) put(u.pos.x, u.pos.y, u.id.slice(-1));
  if (god) for (const u of world.alive(side === "blue" ? "red" : "blue")) put(u.pos.x, u.pos.y, "R");
  else for (const c of world.contacts[side].values()) put(c.pos.x, c.pos.y, world.t - c.seenAt < 60 ? "E" : "e");

  const lines = grid.map((row, r) => String(r).padStart(2, "0") + " " + row.join("")).reverse();
  const header = "   " + Array.from({ length: cols }, (_, c) => (c % 5 === 0 ? String(c).padStart(2, "0")[0] : " ")).join("");
  const header2 = "   " + Array.from({ length: cols }, (_, c) => (c % 5 === 0 ? String(c).padStart(2, "0")[1] : " ")).join("");
  const legend = [
    "Legend: digits=own platoons  E=enemy contact (e=stale)  *=named place  #=town  ♣=forest  ==road  ^=high ground",
    "Places: " + map.places.map((p) => `${p.name} [${map.toGrid(p.pos)}]`).join(", "),
  ];
  return [...lines, header, header2, ...legend].join("\n");
}
