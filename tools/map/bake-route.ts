// Bakes the road graph used to compute GPS routes on the PC (server/route.js).
// Uses the TruckSim Maps graph generator (lanes, one-ways, junction turns,
// ferries) and stores, for every directed edge, its cost and its exact shape
// (driving-side carriageway, path through the junction) so the route can be
// drawn on the road.
//
//   npm run map:route      (after npm run map:parse)
//
// Output: data/map/route.json (header) + data/map/route.bin (typed arrays).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readMapData } from '../../vendor/trucksim-maps/packages/libs/io/index.ts';
import { ItemType } from '../../vendor/trucksim-maps/packages/libs/map/constants.ts';
import { Ets2DlcGuards, Ets2ScsSourceToDlcGuard, toEts2DlcGuards } from '../../vendor/trucksim-maps/packages/libs/map/constants.ts';
import { getLineString } from '../../vendor/trucksim-maps/packages/libs/map/linestring.ts';
import { generateGraph, graphMapDataKeys } from '../../vendor/trucksim-maps/packages/clis/generator/graph/graph.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const Q = 2; // same quantization as the map tiles
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const parsedDir = path.resolve(ROOT, arg('parsed', 'data/parsed'));
const outDir = path.resolve(ROOT, arg('out', 'data/map'));
const gameDir = arg('game', 'D:\\SteamLibrary\\steamapps\\common\\Euro Truck Simulator 2');
const t0 = Date.now();
const log = (...m: unknown[]) => console.log(`[route ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

function allowedGuards(): Set<number> | null {
  if (!fs.existsSync(gameDir)) return null;
  const owned = new Set<number>();
  for (const f of fs.readdirSync(gameDir)) {
    const g = Ets2ScsSourceToDlcGuard[f];
    if (g != null) for (const d of Ets2DlcGuards[g]) owned.add(d);
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
  return guards;
}

type Pt = [number, number];
function simplify(points: Pt[], tol: number): Pt[] {
  if (points.length <= 2) return points;
  const sq = tol * tol;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

function main() {
  const guards = allowedGuards();
  log('reading parser output...');
  const data = readMapData(parsedDir, 'europe', {
    mapDataKeys: [...graphMapDataKeys, 'companyDefs'],
  }) as any;

  // The graph generator drops what carries a guard it does not know: give the
  // Iceland pieces a guard it knows when they are owned, remove them otherwise.
  const KNOWN: Record<number, number> = { 26: 0, 27: 23 };
  for (const coll of [data.roads, data.prefabs] as Map<bigint, any>[]) {
    for (const [uid, item] of coll) {
      const known = KNOWN[item.dlcGuard];
      if (known == null) continue;
      if (!guards || guards.has(item.dlcGuard)) item.dlcGuard = known;
      else coll.delete(uid);
    }
  }
  // A ferry port whose prefab is gone cannot be reached: drop it and the lines to it.
  const lostPorts = new Set<bigint>();
  for (const [uid, f] of data.ferries as Map<bigint, any>) {
    if (f.prefabUid == null || !data.prefabs.has(f.prefabUid)) { lostPorts.add(f.nodeUid); data.ferries.delete(uid); }
  }
  if (lostPorts.size) {
    for (const f of data.ferries.values()) f.connections = f.connections.filter((c: any) => !lostPorts.has(c.nodeUid));
    log(`${lostPorts.size} ferry ports without a prefab dropped`);
  }

  log('generating road graph (TruckSim Maps)...');
  const { graph } = generateGraph(data);
  log(`${graph.size} graph nodes`);

  const lookups = {
    ferriesByUid: new Map([...data.ferries.values()].map((f: any) => [f.uid, { ...f, type: ItemType.Ferry }])),
    companiesByPrefab: new Map([...data.companies.values()].map((c: any) => [c.prefabUid, c])),
  };

  // Node indices for every uid that appears (keys and neighbors).
  const index = new Map<bigint, number>();
  const uids: bigint[] = [];
  const idx = (uid: bigint) => {
    let i = index.get(uid);
    if (i === undefined) { i = uids.length; index.set(uid, i); uids.push(uid); }
    return i;
  };
  for (const [uid, nb] of graph) {
    idx(uid);
    for (const n of nb.forward) idx(n.nodeUid);
    for (const n of nb.backward) idx(n.nodeUid);
  }
  const N = uids.length;
  const nodeXY = new Int32Array(N * 2);
  let missingNodes = 0;
  for (let i = 0; i < N; i++) {
    const node = data.nodes.get(uids[i]);
    if (!node) { missingNodes++; continue; }
    nodeXY[i * 2] = Math.round(node.x * Q);
    nodeXY[i * 2 + 1] = Math.round(node.y * Q);
  }

  // Edges grouped by source state (node * 2 + dir), dir 0 = forward, 1 = backward.
  log('computing edge shapes...');
  const perState: { to: number; dist: number; dur: number; flags: number; pts: Pt[] }[][] = Array.from({ length: N * 2 }, () => []);
  let edges = 0, shapeFailures = 0, skippedDlc = 0, points = 0;
  const shapeCache = new Map<string, Pt[]>();
  for (const [uid, nb] of graph) {
    const from = index.get(uid)!;
    for (const [dir, list] of [[0, nb.forward], [1, nb.backward]] as const) {
      for (const n of list) {
        if (guards && n.dlcGuard >= 0 && !guards.has(n.dlcGuard)) { skippedDlc++; continue; }
        const to = index.get(n.nodeUid)!;
        const key = `${uid}:${n.nodeUid}`;
        let pts = shapeCache.get(key);
        if (!pts) {
          try {
            pts = simplify(getLineString([uid, n.nodeUid], data, lookups as any).map((p: number[]) => [p[0], p[1]] as Pt), 0.4);
          } catch {
            shapeFailures++;
            pts = [[nodeXY[from * 2] / Q, nodeXY[from * 2 + 1] / Q], [nodeXY[to * 2] / Q, nodeXY[to * 2 + 1] / Q]];
          }
          shapeCache.set(key, pts);
        }
        // Shapes must run from `from` to `to`.
        const fx = nodeXY[from * 2] / Q, fy = nodeXY[from * 2 + 1] / Q;
        const d0 = Math.hypot(pts[0][0] - fx, pts[0][1] - fy), d1 = Math.hypot(pts[pts.length - 1][0] - fx, pts[pts.length - 1][1] - fy);
        if (d1 < d0) pts = [...pts].reverse();
        const flags = (n.isFerry ? 1 : 0) | (n.isOneLaneRoad ? 2 : 0);
        perState[from * 2 + dir].push({ to: to * 2 + (n.direction === 'forward' ? 0 : 1), dist: n.distance, dur: n.duration, flags, pts });
        edges++;
        points += pts.length;
      }
    }
  }
  log(`${edges} edges, ${points} shape points, ${shapeFailures} straight-line fallbacks, ${skippedDlc} skipped (DLC), ${missingNodes} nodes without position`);

  const stateOff = new Uint32Array(N * 2 + 1);
  const edgeTo = new Uint32Array(edges);
  const edgeDist = new Float32Array(edges);
  const edgeDur = new Float32Array(edges);
  const edgeFlags = new Uint8Array(edges + ((4 - (edges % 4)) % 4));
  const geomOff = new Uint32Array(edges + 1);
  const pts = new Int32Array(points * 2);
  let e = 0, p = 0;
  for (let s = 0; s < N * 2; s++) {
    stateOff[s] = e;
    for (const ed of perState[s]) {
      edgeTo[e] = ed.to;
      edgeDist[e] = ed.dist;
      edgeDur[e] = ed.dur;
      edgeFlags[e] = ed.flags;
      geomOff[e] = p;
      for (const [x, y] of ed.pts) { pts[p * 2] = Math.round(x * Q); pts[p * 2 + 1] = Math.round(y * Q); p++; }
      e++;
    }
  }
  stateOff[N * 2] = e;
  geomOff[edges] = p;

  // Company -> graph node, for job destinations.
  const companies: Record<string, number[][]> = {};
  for (const c of data.companies.values()) {
    const i = index.get(c.nodeUid);
    if (i === undefined) continue;
    (companies[`${c.cityToken}/${c.token}`] ??= []).push([Math.round(c.x), Math.round(c.y), i]);
  }

  const arrays: [string, ArrayBufferView][] = [
    ['nodeXY', nodeXY], ['stateOff', stateOff], ['edgeTo', edgeTo], ['edgeDist', edgeDist],
    ['edgeDur', edgeDur], ['edgeFlags', edgeFlags], ['geomOff', geomOff], ['pts', pts],
  ];
  const layout: Record<string, { type: string; offset: number; length: number }> = {};
  let offset = 0;
  for (const [name, arr] of arrays) {
    layout[name] = { type: arr.constructor.name, offset, length: (arr as any).length };
    offset += arr.byteLength;
  }
  const buf = Buffer.alloc(offset);
  for (const [name, arr] of arrays) Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(buf, layout[name].offset);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'route.bin'), buf);
  fs.writeFileSync(path.join(outDir, 'route.json'), JSON.stringify({
    format: 1, q: Q, nodes: N, edges, points, bakedAt: new Date().toISOString(), layout, companies,
  }));
  log(`route.bin ${(buf.length / 1048576).toFixed(1)} MB, ${Object.keys(companies).length} companies linked -> ${outDir}`);
}

main();
