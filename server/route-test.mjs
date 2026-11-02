// Quick check of the router: routes from Calais to companies across Europe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './route.js';

const MAP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'map');
let t0 = performance.now();
const r = Router.load(MAP);
console.log(`loaded ${r.N} nodes, ${r.E} edges in ${Math.round(performance.now() - t0)} ms, vmax ${r.vmax.toFixed(1)} m/s`);
const meta = JSON.parse(fs.readFileSync(path.join(MAP, 'meta.json'), 'utf8'));

// Start: on the road nearest to Calais, heading along it.
const [cx, cy] = meta.cityPos.calais;
const s = r.snap(cx, cy, null, 2000);
const g0 = r.geomOff[s.edge];
const ax = r.pts[g0 * 2] / r.q, ay = r.pts[g0 * 2 + 1] / r.q, bx = r.pts[g0 * 2 + 2] / r.q, by = r.pts[g0 * 2 + 3] / r.q;
const heading = ((Math.atan2(-(bx - ax), -(by - ay)) / (Math.PI * 2)) + 1) % 1;
let fails = 0;
for (const key of ['paris/fle', 'lyon/', 'berlin/', 'milano/', 'madrid/', 'warszawa/', 'oslo/', 'istanbul/', 'aberdeen/', 'athens/']) {
  const [city, co] = key.split('/');
  const companyKey = co || Object.keys(r.companies).find((k) => k.startsWith(city + '/'))?.split('/')[1];
  const target = companyKey ? r.jobTargets(city, companyKey, meta.cityPos[city]) : null;
  if (!target) { console.log(`SKIP ${key}: no target`); continue; }
  const res = r.route(ax + (bx - ax) * 0.5, ay + (by - ay) * 0.5, heading, target);
  if (!res) { console.log(`FAIL Calais -> ${city}/${companyKey}`); fails++; continue; }
  const straight = Math.hypot(target.x - cx, target.y - cy) / 1000;
  console.log(`OK   Calais -> ${city}/${companyKey}: ${(res.distance / 1000).toFixed(1)} km (straight ${straight.toFixed(1)}), ${(res.duration / 60).toFixed(0)} min, ${res.points.length} pts, ${res.ms} ms, ${res.iters} iters`);
}
process.exit(fails ? 1 : 0);
