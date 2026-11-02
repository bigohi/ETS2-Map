#!/usr/bin/env node
// Telemetry simulator: drives a virtual truck along real ETS2 highways from
// the baked map and sends the same UDP datagrams as the game plugin.
// Lets you test the phone app without launching the game.
//
// Usage: node server/sim.js [--from calais] [--to lyon [--company <token>]] [--km 120] [--speed 85] [--port 30210]

import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './route.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_DIR = path.join(ROOT, 'data', 'map');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []),
);
const FROM = String(args.from ?? 'calais');
const TO = args.to ? String(args.to) : null;
const NAME = String(args.name ?? 'S (simulateur)');
const MAX_KM = Number(args.km ?? 120);
const CRUISE_KMH = Number(args.speed ?? 85);
const PORT = Number(args.port ?? process.env.ETS2MAP_PORT ?? 30210);
const HZ = 20;

const meta = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'meta.json'), 'utf8'));
const Q = meta.q;
// Company names as the game sends them ("БЛТ" for blt_ru), when the parsed
// game data is around; the token in capitals otherwise.
const CO_DEFS = path.join(MAP_DIR, '..', 'parsed', 'europe-companyDefs.json');
const coNames = fs.existsSync(CO_DEFS) ? new Map(Object.values(JSON.parse(fs.readFileSync(CO_DEFS, 'utf8'))).map((c) => [c.token, c.name])) : new Map();
const coName = (token) => coNames.get(token) ?? token.toUpperCase();

// ---------------------------------------------------------------------------
// Highway graph from detail tiles.

console.log('Loading highways...');
const pieces = [];
for (const key of Object.keys(meta.tiles)) {
  const tile = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'tiles', `${key}.json`), 'utf8'));
  for (const r of tile.roads) {
    if (r[0] > 2) continue; // freeway (0), divided (1), local (2: junction links)
    let x = r[2], y = r[3];
    const pts = [[x / Q, y / Q]];
    for (let i = 4; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; pts.push([x / Q, y / Q]); }
    if (pts.length > 1) pieces.push({ cls: r[0], pts });
  }
}
const CELL = 25;
const grid = new Map();
const cellKey = (x, y) => `${Math.round(x / CELL)}_${Math.round(y / CELL)}`;
pieces.forEach((p, i) => {
  for (const end of [0, 1]) {
    const pt = end ? p.pts[p.pts.length - 1] : p.pts[0];
    const k = cellKey(pt[0], pt[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ i, end });
  }
});
function near(pt) {
  const out = [];
  const cx = Math.round(pt[0] / CELL), cy = Math.round(pt[1] / CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${cx + dx}_${cy + dy}`) ?? []));
  return out;
}
const dir = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const angDiff = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; };

function buildRoute() {
  const start = meta.cityPos[FROM];
  if (!start) throw new Error(`unknown city token "${FROM}"`);
  // Try the freeway pieces closest to the start city, both directions, and
  // keep the longest continuous drive.
  const candidates = pieces
    .map((p, i) => ({ i, p, d: Math.min(...p.pts.map((pt) => Math.hypot(pt[0] - start[0], pt[1] - start[1]))) }))
    .filter((c) => c.p.cls === 0 && c.d < 15000)
    .sort((a, b) => a.d - b.d)
    .slice(0, 25);
  let bestRoute = null;
  for (const c of candidates) {
    for (const reverse of [false, true]) {
      const r = chain(c.i, reverse);
      if (!bestRoute || r.length > bestRoute.length) bestRoute = r;
      if (bestRoute.length >= MAX_KM * 1000) return bestRoute;
    }
  }
  return bestRoute;
}

function chain(first, reverse) {
  const visited = new Set([first]);
  const route = reverse ? [...pieces[first].pts].reverse() : [...pieces[first].pts];
  let length = 0;
  for (let i = 1; i < route.length; i++) length += Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
  while (length < MAX_KM * 1000) {
    const end = route[route.length - 1];
    const heading = dir(route[route.length - 2], end);
    let pick = null, pickAng = Infinity;
    for (const c of near(end)) {
      if (visited.has(c.i)) continue;
      const p = pieces[c.i];
      const pts = c.end === 0 ? p.pts : [...p.pts].reverse();
      const gap = Math.hypot(pts[0][0] - end[0], pts[0][1] - end[1]);
      if (gap > 25) continue;
      const a = angDiff(heading, dir(pts[0], pts[Math.min(2, pts.length - 1)]));
      // Prefer straight-on, close, and the biggest road class.
      const score = a + gap / 40 + [0, 0.12, 0.35][p.cls];
      if (a < (55 * Math.PI) / 180 && score < pickAng) { pickAng = score; pick = { i: c.i, pts }; }
    }
    if (!pick) break;
    visited.add(pick.i);
    for (let i = 0; i < pick.pts.length; i++) {
      if (i === 0 && Math.hypot(pick.pts[0][0] - end[0], pick.pts[0][1] - end[1]) < 0.5) continue;
      length += Math.hypot(pick.pts[i][0] - route[route.length - 1][0], pick.pts[i][1] - route[route.length - 1][1]);
      route.push(pick.pts[i]);
    }
  }
  return { route, length };
}

// With --to <city>, drive the real GPS route (same router as the server) to a
// company in that city; otherwise chain highways from --from.
let route, length, dstCity, dstCo;
const router = TO ? Router.load(MAP_DIR) : null;
if (router) {
  const [cx, cy] = meta.cityPos[FROM];
  const s0 = router.snap(cx, cy, null, 3000);
  const g0 = router.geomOff[s0.edge];
  const ax = router.pts[g0 * 2] / Q, ay = router.pts[g0 * 2 + 1] / Q, bx = router.pts[g0 * 2 + 2] / Q, by = router.pts[g0 * 2 + 3] / Q;
  const h0 = ((Math.atan2(-(bx - ax), -(by - ay)) / (Math.PI * 2)) + 1) % 1;
  dstCity = TO;
  dstCo = String(args.company ?? Object.keys(router.companies).find((k) => k.startsWith(TO + '/'))?.split('/')[1] ?? '');
  const target = router.jobTargets(dstCity, dstCo, meta.cityPos[dstCity]);
  const r = target && router.route((ax + bx) / 2, (ay + by) / 2, h0, target);
  if (!r) throw new Error(`no route from ${FROM} to ${TO}`);
  route = r.points;
  length = r.distance;
} else {
  ({ route, length } = buildRoute());
  // Destination: city closest to the route end, with one of its companies.
  const endPt = route[route.length - 1];
  let dd = Infinity;
  for (const [token, pos] of Object.entries(meta.cityPos)) {
    const d = (pos[0] - endPt[0]) ** 2 + (pos[1] - endPt[1]) ** 2;
    if (d < dd && meta.companies[token]) { dd = d; dstCity = token; }
  }
  dstCo = Object.keys(meta.companies[dstCity] ?? {})[0] ?? '';
}
// Cumulative distances.
const cum = [0];
for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
const srcCo = Object.keys(meta.companies[FROM] ?? {})[0] ?? '';
console.log(`Route: ${meta.cityNames[FROM] ?? FROM} -> ${meta.cityNames[dstCity] ?? dstCity} (${dstCo}), ${(length / 1000).toFixed(1)} km, ${route.length} points${router ? ' (GPS route)' : ' (highway chain)'}`);

// Drive.

function posAt(s) {
  s = Math.max(0, Math.min(length, s));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const a = route[lo], b = route[hi];
  const f = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, dx: b[0] - a[0], dy: b[1] - a[1] };
}
function turnAhead(s, look) {
  const a = posAt(s), b = posAt(s + look / 2), c = posAt(s + look);
  return angDiff(Math.atan2(b.y - a.y, b.x - a.x), Math.atan2(c.y - b.y, c.x - b.x));
}

const sock = dgram.createSocket('udp4');
let s = 0, v = 0, gt = 8 * 60 + 1440 * 0, fuel = 640, seq = 0, heading = 0;
const startGt = gt;
const income = 18240;
let last = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;

  const turn = turnAhead(s, 220);
  const target = (CRUISE_KMH / 3.6) * Math.max(0.42, 1 - turn / 1.2);
  v += Math.max(-3 * dt, Math.min(1.4 * dt, target - v));
  s += v * dt;
  if (s >= length) { s = 0; v = 0; }
  const p = posAt(s);
  // Heading: 0 = north (-z), counter-clockwise, unit range.
  const h = ((Math.atan2(-p.dx, -p.dy) / (Math.PI * 2)) + 1) % 1;
  heading = h;
  gt += (dt * 19) / 60;
  fuel = Math.max(0, fuel - v * dt * 0.00032);
  const remaining = length - s;

  const pkt = {
    v: 1, seq: seq++, game: 'eut2', gv: '1.18', paused: false, sim: Math.round(now * 1000),
    x: p.x, y: 40, z: p.y, h, p: 0, r: 0,
    spd: v, cc: v > 20 ? CRUISE_KMH / 3.6 : 0, lim: 90 / 3.6,
    nd: remaining, nt: (remaining / 23) * 19, fuel, range: fuel / 0.32, gt: Math.floor(gt), rest: Math.max(0, 600 - Math.floor(gt - startGt)), scale: 19,
    gear: v > 1 ? 12 : 0, engine: true, pbrake: false, trailers: 1,
    truck: { fuelCap: 900, brand: 'Scania', name: NAME },
    job: {
      mass: 21300, income, deliv: startGt + 60 * 9, km: Math.round(length / 1000 * 4.5), special: false,
      cargo: 'Pièces automobiles', cargoId: 'car_parts',
      src: meta.cityNames[FROM] ?? FROM, srcId: FROM, srcCo: coName(srcCo), srcCoId: srcCo,
      dst: meta.cityNames[dstCity] ?? dstCity, dstId: dstCity, dstCo: coName(dstCo), dstCoId: dstCo, market: 'freight_market',
    },
  };
  sock.send(JSON.stringify(pkt), PORT, '127.0.0.1');
}, 1000 / HZ);

setInterval(() => {
  process.stdout.write(`\r${(s / 1000).toFixed(1).padStart(6)} / ${(length / 1000).toFixed(1)} km  ${Math.round(v * 3.6).toString().padStart(3)} km/h  heading ${(heading * 360).toFixed(0).padStart(3)}°   `);
}, 1000);
console.log(`Sending ${HZ} Hz telemetry to udp://127.0.0.1:${PORT} (Ctrl+C to stop)`);
