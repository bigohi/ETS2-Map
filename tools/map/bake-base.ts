// Bakes the base map (land, lakes, country borders) for the phone, from
// Natural Earth 1:10m data (public domain) projected into game coordinates.
//
// Real geography and the game map do not match exactly (the game world is a
// hand-made miniature), so the projection is corrected with the game's own
// city positions: for each point, the offsets measured at the nearest cities
// are blended in (inverse-distance weighting). Borders then pass between the
// right cities.
//
//   npm run map:base     (after npm run map:bake; downloads Natural Earth once)
//
// Output: data/map/base.json { q, cell, overview: {land, lakes, borders}, cells: {tx_ty: {...}} }

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fromWgs84ToEts2Coords } from '../../vendor/trucksim-maps/packages/libs/map/projections.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'data', 'basemap-src');
const OUT = path.join(ROOT, 'data', 'map');
const PLACES = path.join(ROOT, 'vendor', 'trucksim-maps', 'packages', 'clis', 'generator', 'resources', 'ne_10m_populated_places_simple.geojson');
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const FILES = ['ne_10m_land', 'ne_10m_lakes', 'ne_10m_admin_0_boundary_lines_land'];
const LONLAT_BOX = [-32, 27, 52, 74]; // generous box around the ETS2 map
const CELL = 32768;                    // same grid as the "mid" road tiles

type Pt = [number, number];
const t0 = Date.now();
const log = (...m: unknown[]) => console.log(`[base ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

async function download() {
  fs.mkdirSync(SRC, { recursive: true });
  for (const f of FILES) {
    const p = path.join(SRC, `${f}.geojson`);
    if (fs.existsSync(p) && fs.statSync(p).size > 1000) continue;
    log(`downloading ${f}...`);
    const r = await fetch(`${NE}${f}.geojson`);
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  }
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

// --- projection corrected by city positions --------------------------------

function controlPoints(meta: any) {
  const places = JSON.parse(fs.readFileSync(PLACES, 'utf8')).features as any[];
  const byName = new Map<string, any[]>();
  for (const f of places) {
    for (const n of [f.properties.name, f.properties.nameascii, f.properties.namealt].filter(Boolean)) {
      const k = norm(n);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k)!.push(f);
    }
  }
  const pts: { x: number; y: number; dx: number; dy: number }[] = [];
  for (const [name, gx, gy] of meta.cities as [string, number, number][]) {
    const cands = byName.get(norm(name)) ?? [];
    let best: { d: number; px: number; py: number } | null = null;
    for (const f of cands) {
      const [px, py] = fromWgs84ToEts2Coords([f.properties.longitude, f.properties.latitude]);
      const d = Math.hypot(px - gx, py - gy);
      if (!best || d < best.d) best = { d, px, py };
    }
    // Same name, wrong place (or a different town) if far off.
    if (best && best.d < 4000) pts.push({ x: best.px, y: best.py, dx: gx - best.px, dy: gy - best.py });
  }
  return pts;
}

function makeProjector(cps: { x: number; y: number; dx: number; dy: number }[]) {
  return (lon: number, lat: number): Pt => {
    const [x, y] = fromWgs84ToEts2Coords([lon, lat]);
    let sw = 0, sx = 0, sy = 0;
    for (const c of cps) {
      const d2 = (c.x - x) ** 2 + (c.y - y) ** 2 + 4e6; // 2 km softening
      const w = 1 / (d2 * d2);                            // power 4: local influence
      sw += w; sx += w * c.dx; sy += w * c.dy;
    }
    return [x + sx / sw, y + sy / sw];
  };
}

// --- geometry ---------------------------------------------------------------

function simplify(points: Pt[], tol: number): Pt[] {
  if (points.length <= 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const sq = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      const d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Sutherland-Hodgman against an axis-aligned rectangle.
function clipRing(ring: Pt[], [x0, y0, x1, y1]: number[]): Pt[] {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}

// Line clipped to a rectangle: list of inside runs.
function clipLine(line: Pt[], [x0, y0, x1, y1]: number[]): Pt[][] {
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  const inside = (p: Pt) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    if (inside(p)) {
      if (!cur.length && i > 0) cur.push(line[i - 1]); // enter: keep the edge (slight overdraw, no gap)
      cur.push(p);
    } else if (cur.length) {
      cur.push(p);
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

const bboxOf = (pts: Pt[]) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of pts) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
};
const overlaps = (p: number[], q: number[]) => p[0] <= q[2] && p[2] >= q[0] && p[1] <= q[3] && p[3] >= q[1];

function encode(points: Pt[], q: number): number[] {
  const out: number[] = [];
  let px = 0, py = 0;
  points.forEach(([x, y], i) => {
    const qx = Math.round(x * q), qy = Math.round(y * q);
    if (i === 0) out.push(qx, qy);
    else { if (qx === px && qy === py) return; out.push(qx - px, qy - py); }
    px = qx; py = qy;
  });
  return out;
}

// --- main -------------------------------------------------------------------

async function main() {
  await download();
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
  const q = meta.q;
  const cps = controlPoints(meta);
  log(`${cps.length} cities used to fit the projection to the game map`);
  const project = makeProjector(cps);

  const [bx0, by0, bx1, by1] = meta.bounds;
  const margin = 25000;
  const area = [bx0 - margin, by0 - margin, bx1 + margin, by1 + margin];
  const inBox = (ring: number[][]) => ring.some(([lon, lat]) => lon >= LONLAT_BOX[0] && lon <= LONLAT_BOX[2] && lat >= LONLAT_BOX[1] && lat <= LONLAT_BOX[3]);

  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(SRC, `${f}.geojson`), 'utf8')).features as any[];
  const rings = (f: any): number[][][] => f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map((p: number[][][]) => p[0]) : [];
  const lines = (f: any): number[][][] => f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];

  const collect = (features: any[], getter: (f: any) => number[][][], closed: boolean) => {
    const out: Pt[][] = [];
    for (const f of features) {
      for (const r of getter(f)) {
        if (!inBox(r)) continue;
        // Project the whole ring (Eurasia is one ring): dropping far points
        // would join the rest with straight chords across the seas. The
        // rectangle clip below cuts it properly.
        const pts = r.map(([lon, lat]) => project(lon, lat));
        if (pts.length < (closed ? 3 : 2)) continue;
        if (!overlaps(bboxOf(pts), area)) continue;
        out.push(pts);
      }
    }
    return out;
  };

  const land = collect(read('ne_10m_land'), rings, true);
  const lakes = collect(read('ne_10m_lakes'), rings, true);
  const borders = collect(read('ne_10m_admin_0_boundary_lines_land'), lines, false);
  log(`land ${land.length} rings, lakes ${lakes.length}, borders ${borders.length} lines`);

  // Whole map at once, coarse: overview level.
  const coarse = (set: Pt[][], tol: number, closed: boolean) => set
    .map((r) => (closed ? clipRing(simplify(r, tol), area) : simplify(r, tol)))
    .filter((r) => r.length >= (closed ? 3 : 2))
    .map((r) => encode(r, q));
  const overview = { land: coarse(land, 350, true), lakes: coarse(lakes.filter((r) => { const b = bboxOf(r); return (b[2] - b[0]) * (b[3] - b[1]) > 4e6; }), 350, true), borders: coarse(borders, 250, false) };

  // Detail: per 32 km cell, finer.
  const cells: Record<string, { land: number[][]; lakes: number[][]; borders: number[][] }> = {};
  const fineLand = land.map((r) => simplify(r, 40));
  const fineLakes = lakes.map((r) => simplify(r, 30));
  const fineBorders = borders.map((r) => simplify(r, 30));
  const sets = [fineLand, fineLakes, fineBorders].map((s) => s.map((r) => ({ r, b: bboxOf(r) })));
  for (let tx = Math.floor(area[0] / CELL); tx <= Math.floor(area[2] / CELL); tx++) {
    for (let ty = Math.floor(area[1] / CELL); ty <= Math.floor(area[3] / CELL); ty++) {
      const rect = [tx * CELL - 2, ty * CELL - 2, (tx + 1) * CELL + 2, (ty + 1) * CELL + 2]; // tiny overlap: no seams
      const cell = { land: [] as number[][], lakes: [] as number[][], borders: [] as number[][] };
      for (const { r, b } of sets[0]) if (overlaps(b, rect)) { const c = clipRing(r, rect); if (c.length >= 3) cell.land.push(encode(c, q)); }
      for (const { r, b } of sets[1]) if (overlaps(b, rect)) { const c = clipRing(r, rect); if (c.length >= 3) cell.lakes.push(encode(c, q)); }
      for (const { r, b } of sets[2]) if (overlaps(b, rect)) for (const run of clipLine(r, rect)) cell.borders.push(encode(run, q));
      if (cell.land.length || cell.lakes.length || cell.borders.length) cells[`${tx}_${ty}`] = cell;
    }
  }

  const out = { format: 1, q, cell: CELL, overview, cells };
  const text = JSON.stringify(out);
  fs.writeFileSync(path.join(OUT, 'base.json'), text);
  fs.writeFileSync(path.join(OUT, 'base.json.gz'), zlib.gzipSync(text, { level: 9 }));
  const pts = (a: number[][]) => a.reduce((s, r) => s + r.length / 2, 0);
  log(`overview ${pts(overview.land) + pts(overview.lakes) + pts(overview.borders)} pts, ${Object.keys(cells).length} cells, ${(text.length / 1048576).toFixed(1)} MB json, ${(zlib.gzipSync(text).length / 1048576).toFixed(2)} MB gz`);
}

main();
