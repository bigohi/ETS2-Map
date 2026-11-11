// Bakes the TruckSim Maps parser output (data/parsed/*.json) into the compact
// tile format used by the ETS2-Map phone app (data/map/).
//
// Run through npm (needs the vendored TruckSim Maps workspace for tsx + libs):
//   npm run map:bake -- [--parsed data/parsed] [--out data/map] [--game "<ETS2 dir>"]
//
// Output, all coordinates in game units (meters, x = east, y = game z = south),
// quantized to Q units per meter and delta-encoded:
//   meta.json            bounds, tile lists, cities, countries, companies
//   overview.json        major roads, heavily simplified (whole map at once)
//   mid/<tx>_<ty>.json   all roads, simplified, MID_TILE meters square
//   tiles/<tx>_<ty>.json full detail (areas, roads, ferries, POIs), TILE meters
// Each .json also gets a .json.gz twin that the server sends to phones.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { readMapData } from '../../vendor/trucksim-maps/packages/libs/io/index.ts';
import {
  Ets2DlcGuards,
  Ets2ScsSourceToDlcGuard,
  toEts2DlcGuards,
} from '../../vendor/trucksim-maps/packages/libs/map/constants.ts';
import { fromWgs84ToEts2Coords } from '../../vendor/trucksim-maps/packages/libs/map/projections.ts';
import {
  convertToMapGeoJson,
  geoJsonMapDataKeys,
} from '../../vendor/trucksim-maps/packages/clis/generator/geo-json/map.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Format constants (keep in sync with web/js/map-data.js).

const FORMAT = 1;
const Q = 2; // quantization: 1 unit = 0.5 m
const TILE = 8192;
const MID_TILE = 32768;
const ROAD_CLASSES = ['freeway', 'divided', 'local', 'no_vehicles', 'train', 'tram', 'unknown'] as const;
const LANE_WIDTH = 4.5;

// ---------------------------------------------------------------------------
// CLI.

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const parsedDir = path.resolve(ROOT, arg('parsed', 'data/parsed'));
const outDir = path.resolve(ROOT, arg('out', 'data/map'));
const gameDir = arg('game', 'D:\\SteamLibrary\\steamapps\\common\\Euro Truck Simulator 2');

const t0 = Date.now();
const log = (...m: unknown[]) => console.log(`[bake ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

// ---------------------------------------------------------------------------
// DLC ownership: keep only map content the player can actually see.

function allowedDlcGuards(): Set<number> | null {
  if (!fs.existsSync(gameDir)) {
    log(`game dir not found (${gameDir}), keeping content for every DLC`);
    return null;
  }
  const owned = new Set<number>();
  for (const f of fs.readdirSync(gameDir)) {
    const guard = Ets2ScsSourceToDlcGuard[f];
    if (guard == null) continue;
    for (const dlc of Ets2DlcGuards[guard]) owned.add(dlc);
  }
  const guards = toEts2DlcGuards(owned as never);
  guards.add(0);
  // Iceland: guards the pinned TruckSim Maps does not know yet.
  // 26 = Iceland, 27 = Iceland + Nordic Horizons (the port of Ålesund).
  const has = (f: string) => fs.existsSync(path.join(gameDir, f));
  if (has('dlc_iceland.scs')) {
    guards.add(26 as never);
    if (has('dlc_polar.scs') || has('dlc_polar_circle.scs')) guards.add(27 as never);
  }
  log(`owned map DLC guards: ${[...guards].sort((a, b) => a - b).join(',')}`);
  return guards;
}

// ---------------------------------------------------------------------------
// Geometry helpers.

type Pt = [number, number];

function toGame(p: number[]): Pt {
  const [x, y] = fromWgs84ToEts2Coords([p[0], p[1]]);
  return [x, y];
}

function simplify(points: Pt[], tolerance: number): Pt[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const sq = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let d: number;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

interface Line { cls: number; width: number; pts: Pt[] }

// Greedily chains lines of the same class/width whose endpoints meet (within
// tol meters) into longer polylines.
function joinLines(lines: Line[], tol: number): Line[] {
  const key = (p: Pt) => `${Math.round(p[0] / tol)}_${Math.round(p[1] / tol)}`;
  const ends = new Map<string, number[]>();
  lines.forEach((l, i) => {
    for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
      const k = `${l.cls}|${l.width}|${key(p)}`;
      const arr = ends.get(k);
      if (arr) arr.push(i); else ends.set(k, [i]);
    }
  });
  const used = new Uint8Array(lines.length);
  const take = (l: Line, at: Pt): Pt[] | null => {
    for (const j of ends.get(`${l.cls}|${l.width}|${key(at)}`) ?? []) {
      if (used[j]) continue;
      const o = lines[j].pts;
      used[j] = 1;
      if (key(o[0]) === key(at)) return o.slice(1);
      return o.slice(0, -1).reverse();
    }
    return null;
  };
  const out: Line[] = [];
  lines.forEach((l, i) => {
    if (used[i]) return;
    used[i] = 1;
    let pts = [...l.pts];
    for (let next = take(l, pts[pts.length - 1]); next; next = take(l, pts[pts.length - 1])) pts.push(...next);
    for (let prev = take(l, pts[0]); prev; prev = take(l, pts[0])) pts = [...prev.reverse(), ...pts];
    out.push({ cls: l.cls, width: l.width, pts });
  });
  return out;
}

function lineLength(points: Pt[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return l;
}

// Quantize + delta encode: [x0, y0, dx1, dy1, ...]; drops repeated points.
function encode(points: Pt[]): number[] {
  const out: number[] = [];
  let px = 0, py = 0, first = true;
  for (const [x, y] of points) {
    const qx = Math.round(x * Q), qy = Math.round(y * Q);
    if (first) { out.push(qx, qy); first = false; }
    else {
      if (qx === px && qy === py) continue;
      out.push(qx - px, qy - py);
    }
    px = qx; py = qy;
  }
  return out;
}

// Splits a polyline into runs of consecutive segments whose midpoints fall in
// the same tile. Runs share their boundary vertex so nothing is lost.
function splitByTile(points: Pt[], size: number): Map<string, Pt[][]> {
  const out = new Map<string, Pt[][]>();
  let curKey: string | null = null;
  let cur: Pt[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const key = tileKey((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, size);
    if (key !== curKey) {
      if (curKey && cur.length > 1) push(out, curKey, cur);
      curKey = key;
      cur = [a];
    }
    cur.push(b);
  }
  if (curKey && cur.length > 1) push(out, curKey, cur);
  return out;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v); else m.set(k, [v]);
}

function tileKey(x: number, y: number, size: number): string {
  return `${Math.floor(x / size)}_${Math.floor(y / size)}`;
}

function centroid(points: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of points) { x += p[0]; y += p[1]; }
  return [x / points.length, y / points.length];
}

// ---------------------------------------------------------------------------
// Bake.

interface DetailTile { areas: number[][]; roads: number[][]; ferries: number[][]; pois: unknown[][] }
interface MidTile { roads: number[][]; ferries: number[][] }

function main() {
  if (!fs.existsSync(path.join(parsedDir, 'europe-roads.json'))) {
    console.error(`No parser output in ${parsedDir}. Run "npm run map:parse" first.`);
    process.exit(1);
  }
  const guards = allowedDlcGuards();
  const visible = (props: Record<string, unknown>) =>
    guards == null || props.dlcGuard == null || guards.has(props.dlcGuard as number);

  log('reading parser output...');
  const data = readMapData(parsedDir, 'europe', {
    includeHiddenRoadsAndPrefabs: false,
    mapDataKeys: [...geoJsonMapDataKeys, 'companies'],
  });

  log('building geometry (TruckSim Maps generator)...');
  const geo = convertToMapGeoJson(data as never, { includeDebug: false, skipCoalescing: false });
  log(`${geo.features.length} features`);

  const detail = new Map<string, DetailTile>();
  const mid = new Map<string, MidTile>();
  const overview: { roads: number[][]; ferries: number[][] } = { roads: [], ferries: [] };
  // Collected first, then joined end-to-end so the phone strokes few long lines.
  const overviewLines: Line[] = [];
  const midLines = new Map<string, Line[]>();
  const dt = (k: string) => {
    let t = detail.get(k);
    if (!t) detail.set(k, (t = { areas: [], roads: [], ferries: [], pois: [] }));
    return t;
  };
  const mt = (k: string) => {
    let t = mid.get(k);
    if (!t) mid.set(k, (t = { roads: [], ferries: [] }));
    return t;
  };

  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (pts: Pt[]) => {
    for (const [x, y] of pts) {
      if (x < bounds[0]) bounds[0] = x;
      if (y < bounds[1]) bounds[1] = y;
      if (x > bounds[2]) bounds[2] = x;
      if (y > bounds[3]) bounds[3] = y;
    }
  };

  const cities: unknown[] = [];
  const countries: unknown[] = [];
  const poiIcons: string[] = [];
  const iconIndex = (name: string) => {
    let i = poiIcons.indexOf(name);
    if (i < 0) { i = poiIcons.length; poiIcons.push(name); }
    return i;
  };
  const poiTypes: string[] = [];
  const poiTypeIndex = (name: string) => {
    let i = poiTypes.indexOf(name);
    if (i < 0) { i = poiTypes.length; poiTypes.push(name); }
    return i;
  };
  const seenPois = new Set<string>();
  const stats = { roads: 0, roadKm: 0, areas: 0, ferries: 0, pois: 0, skippedDlc: 0, other: new Map<string, number>() };

  for (const f of geo.features as { geometry: { type: string; coordinates: any }; properties: Record<string, any> }[]) {
    const p = f.properties ?? {};
    if (!visible(p)) { stats.skippedDlc++; continue; }
    const g = f.geometry;

    switch (p.type) {
      case 'road': {
        if (p.hidden) break;
        const lines: number[][][] = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
        const cls = Math.max(0, ROAD_CLASSES.indexOf(p.roadType));
        // Divided roads already come as two carriageway lines (one side has 0
        // lanes), so the width is just the lanes of this line.
        const lanes = Math.max(1, (p.leftLanes ?? 0) + (p.rightLanes ?? 0));
        const width = Math.round(lanes * LANE_WIDTH * Q);
        for (const line of lines) {
          const pts = line.map(toGame);
          if (pts.length < 2) continue;
          grow(pts);
          stats.roads++;
          stats.roadKm += lineLength(pts) / 1000;
          for (const [k, runs] of splitByTile(pts, TILE)) for (const r of runs) dt(k).roads.push([cls, width, ...encode(simplify(r, 0.25))]);
          const simpleMid = simplify(pts, 12);
          for (const [k, runs] of splitByTile(simpleMid, MID_TILE)) for (const r of runs) push(midLines, k, { cls, width, pts: r });
          if (cls <= 1 || (cls === 2 && lineLength(pts) > 1500)) {
            overviewLines.push({ cls, width: cls === 2 ? 0 : width, pts });
          }
        }
        break;
      }
      case 'prefab':
      case 'mapArea': {
        const rings: number[][][] = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((poly: number[][][]) => poly[0]);
        for (const ring of rings) {
          const pts = ring.map(toGame);
          if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
          if (pts.length < 3) continue;
          grow(pts);
          stats.areas++;
          const [cx, cy] = centroid(pts);
          // zIndex: map areas 0/1, prefabs use their own layering; keep as-is.
          dt(tileKey(cx, cy, TILE)).areas.push([p.color ?? 0, p.zIndex ?? 0, p.type === 'prefab' ? 1 : 0, ...encode(pts)]);
        }
        break;
      }
      case 'ferry':
      case 'train': {
        const pts = (g.coordinates as number[][]).map(toGame);
        if (pts.length < 2) break;
        stats.ferries++;
        const kind = p.type === 'train' ? 1 : 0;
        overview.ferries.push([kind, ...encode(pts)]);
        for (const [k, runs] of splitByTile(pts, MID_TILE)) for (const r of runs) mt(k).ferries.push([kind, ...encode(r)]);
        for (const [k, runs] of splitByTile(pts, TILE)) for (const r of runs) dt(k).ferries.push([kind, ...encode(r)]);
        break;
      }
      case 'city': {
        const [x, y] = toGame(g.coordinates);
        cities.push([p.name, Math.round(x), Math.round(y), p.scaleRank ?? 5, p.capital ?? 0]);
        break;
      }
      case 'country': {
        const [x, y] = toGame(g.coordinates);
        countries.push([p.name, Math.round(x), Math.round(y)]);
        break;
      }
      case 'poi': {
        if (!p.sprite) break;
        const [x, y] = toGame(g.coordinates);
        const dedupeKey = `${p.sprite}:${Math.round(x / 40)}:${Math.round(y / 40)}`;
        if (seenPois.has(dedupeKey)) break;
        seenPois.add(dedupeKey);
        stats.pois++;
        const row: unknown[] = [iconIndex(String(p.sprite)), poiTypeIndex(String(p.poiType ?? '')), Math.round(x * Q), Math.round(y * Q)];
        if (p.poiName) row.push(String(p.poiName));
        dt(tileKey(x, y, TILE)).pois.push(row);
        break;
      }
      default:
        stats.other.set(p.type, (stats.other.get(p.type) ?? 0) + 1);
    }
  }

  // Companies: where to put the destination flag for a job.
  // companies[cityToken][companyToken] = [[x, y], ...] (game meters)
  const companies: Record<string, Record<string, number[][]>> = {};
  const cityTokens: Record<string, string> = {};
  const cityCountry: Record<string, string> = {};
  for (const c of values<{ token: string; name: string; countryToken: string }>(data.cities)) {
    cityTokens[c.token] = c.name;
    cityCountry[c.token] = c.countryToken;
  }
  for (const c of values<{ token: string; cityToken: string; x: number; y: number; dlcGuard?: number }>((data as any).companies)) {
    if (guards && c.dlcGuard != null && !guards.has(c.dlcGuard)) continue;
    ((companies[c.cityToken] ??= {})[c.token] ??= []).push([Math.round(c.x), Math.round(c.y)]);
  }
  // City token -> position, for jobs whose company is unknown.
  const cityPos: Record<string, number[]> = {};
  for (const c of values<{ token: string; x: number; y: number; areas: { x: number; y: number; width: number; height: number; hidden: boolean }[] }>(data.cities)) {
    const a = c.areas?.find((ar) => !ar.hidden);
    cityPos[c.token] = a ? [Math.round(a.x + a.width / 2), Math.round(a.y + a.height / 2)] : [Math.round(c.x), Math.round(c.y)];
  }

  // Draw order inside a tile: areas by zIndex then map areas before prefabs;
  // roads from small to big so highways end up on top.
  for (const t of detail.values()) {
    t.areas.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    t.roads.sort((a, b) => b[0] - a[0]);
  }
  log('joining lines for the zoomed-out levels...');
  for (const [k, lines] of midLines) {
    for (const l of joinLines(lines, 1)) mt(k).roads.push([l.cls, l.width, ...encode(simplify(l.pts, 12))]);
  }
  for (const l of joinLines(overviewLines, 3)) {
    if (lineLength(l.pts) < 600) continue; // ramps and junction bits vanish at this scale anyway
    overview.roads.push([l.cls, l.width, ...encode(simplify(l.pts, 90))]);
  }
  for (const t of mid.values()) t.roads.sort((a, b) => b[0] - a[0]);
  overview.roads.sort((a, b) => b[0] - a[0]);

  // Write.
  log('writing files...');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'mid'), { recursive: true });
  let bytes = 0, gzBytes = 0;
  const write = (rel: string, obj: unknown) => {
    const text = JSON.stringify(obj);
    const gz = zlib.gzipSync(text, { level: 9 });
    fs.writeFileSync(path.join(outDir, rel), text);
    fs.writeFileSync(path.join(outDir, rel + '.gz'), gz);
    bytes += text.length;
    gzBytes += gz.length;
    return gz.length;
  };

  const tileSizes: Record<string, number> = {};
  for (const [k, t] of detail) tileSizes[k] = write(`tiles/${k}.json`, t);
  const midSizes: Record<string, number> = {};
  for (const [k, t] of mid) midSizes[k] = write(`mid/${k}.json`, t);
  const ovSize = write('overview.json', overview);

  // Game icons (extracted by the parser from the player's own game files).
  const iconSrc = path.join(parsedDir, 'icons');
  fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });
  let iconsCopied = 0;
  for (const name of poiIcons) {
    const src = path.join(iconSrc, `${name}.png`);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(outDir, 'icons', `${name}.png`)); iconsCopied++; }
  }
  log(`icons: ${iconsCopied}/${poiIcons.length} copied`);

  const gameVersion = readGameVersion();
  write('meta.json', {
    format: FORMAT,
    map: 'europe',
    gameVersion,
    bakedAt: new Date().toISOString(),
    q: Q,
    tile: TILE,
    midTile: MID_TILE,
    roadClasses: ROAD_CLASSES,
    bounds: bounds.map(Math.round),
    tiles: tileSizes,
    midTiles: midSizes,
    poiIcons,
    poiTypes,
    cities,
    countries,
    cityNames: cityTokens,
    cityCountry,
    cityPos,
    companies,
  });

  log(`roads: ${stats.roads} lines, ${Math.round(stats.roadKm)} km (game meters)`);
  log(`areas: ${stats.areas}, ferries: ${stats.ferries}, POIs: ${stats.pois}, cities: ${cities.length}, skipped (DLC not owned): ${stats.skippedDlc}`);
  log(`other feature types ignored: ${[...stats.other].map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  log(`tiles: ${detail.size} detail, ${mid.size} mid; overview ${(ovSize / 1024).toFixed(0)} KB gz`);
  log(`total ${(bytes / 1048576).toFixed(1)} MB json, ${(gzBytes / 1048576).toFixed(1)} MB gzip -> ${outDir}`);
}

function values<T>(m: unknown): T[] {
  if (m instanceof Map) return [...m.values()] as T[];
  return (m as T[]) ?? [];
}

function readGameVersion(): string | null {
  try {
    const logPath = path.join(process.env.USERPROFILE ?? '', 'Documents', 'Euro Truck Simulator 2', 'game.log.txt');
    const m = fs.readFileSync(logPath, 'utf8').match(/g_game_version "([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

main();
