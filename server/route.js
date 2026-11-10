// GPS routing on the PC: loads the road graph baked by tools/map/bake-route.ts,
// snaps the truck onto the road it is driving on, runs A* (fastest route, like
// the in-game GPS) to the job's company or a point picked on the phone, and
// returns the route shape following the lanes.

import fs from 'node:fs';
import path from 'node:path';

const CELL = 200; // spatial index cell (meters)
/** Maneuver codes sent with a route (web/js/route.js shows them). */
export const TURN = { LEFT: 1, RIGHT: 2, KEEP_LEFT: 3, KEEP_RIGHT: 4, FERRY: 5, MIDDLE: 7 };
const cellKey = (cx, cy) => (cx + 4096) * 8192 + (cy + 4096);

export class Router {
  static load(mapDir) {
    const headerPath = path.join(mapDir, 'route.json');
    const binPath = path.join(mapDir, 'route.bin');
    if (!fs.existsSync(headerPath) || !fs.existsSync(binPath)) return null;
    const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'));
    const buf = fs.readFileSync(binPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const arrays = {};
    for (const [name, l] of Object.entries(header.layout)) arrays[name] = new globalThis[l.type](ab, l.offset, l.length);
    return new Router(header, arrays);
  }

  constructor(header, a) {
    this.header = header;
    this.q = header.q;
    this.N = header.nodes;
    this.S = header.nodes * 2;
    this.E = header.edges;
    Object.assign(this, a);
    this.companies = header.companies;

    // Fastest possible speed, for an admissible A* heuristic.
    let vmax = 1;
    for (let e = 0; e < this.E; e++) {
      if (this.edgeFlags[e] & 1 || this.edgeDur[e] <= 0) continue;
      const v = this.edgeDist[e] / this.edgeDur[e];
      if (v > vmax && v < 80) vmax = v;
    }
    this.vmax = vmax;

    // Which state each edge starts from.
    this.edgeFrom = new Uint32Array(this.E);
    for (let s = 0; s < this.S; s++) for (let e = this.stateOff[s]; e < this.stateOff[s + 1]; e++) this.edgeFrom[e] = s;

    // Shape length of each edge (meters).
    this.edgeLen = new Float32Array(this.E);
    for (let e = 0; e < this.E; e++) {
      let l = 0;
      for (let p = this.geomOff[e] + 1; p < this.geomOff[e + 1]; p++) {
        l += Math.hypot(this.pts[p * 2] - this.pts[p * 2 - 2], this.pts[p * 2 + 1] - this.pts[p * 2 - 1]);
      }
      this.edgeLen[e] = l / this.q;
    }

    this.buildIndex();
    // A* scratch space, reused between searches.
    this.g = new Float64Array(this.S);
    this.came = new Int32Array(this.S);
    this.stamp = new Uint32Array(this.S);
    this.round = 0;
  }

  // Grid of edges by the cells their shape bbox covers (CSR layout).
  buildIndex() {
    const counts = new Map();
    const cellsOf = (e, fn) => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let p = this.geomOff[e]; p < this.geomOff[e + 1]; p++) {
        const x = this.pts[p * 2] / this.q, y = this.pts[p * 2 + 1] / this.q;
        if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
      if (maxX - minX > CELL * 40 || maxY - minY > CELL * 40) return; // ferries: not snappable
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++)
        for (let cy = Math.floor(minY / CELL); cy <= Math.floor(maxY / CELL); cy++) fn(cellKey(cx, cy));
    };
    for (let e = 0; e < this.E; e++) cellsOf(e, (k) => counts.set(k, (counts.get(k) ?? 0) + 1));
    this.cellStart = new Map();
    let total = 0;
    for (const [k, c] of counts) { this.cellStart.set(k, total); total += c; }
    this.cellEdges = new Uint32Array(total);
    const fill = new Map(this.cellStart);
    for (let e = 0; e < this.E; e++) cellsOf(e, (k) => { const i = fill.get(k); this.cellEdges[i] = e; fill.set(k, i + 1); });
    this.cellEnd = fill;
  }

  *edgesNear(x, y, radius) {
    const r = Math.ceil(radius / CELL);
    const cx0 = Math.floor(x / CELL), cy0 = Math.floor(y / CELL);
    const seen = new Set();
    for (let cx = cx0 - r; cx <= cx0 + r; cx++)
      for (let cy = cy0 - r; cy <= cy0 + r; cy++) {
        const k = cellKey(cx, cy);
        const s = this.cellStart.get(k);
        if (s === undefined) continue;
        for (let i = s; i < this.cellEnd.get(k); i++) {
          const e = this.cellEdges[i];
          if (!seen.has(e)) { seen.add(e); yield e; }
        }
      }
  }

  /**
   * Best edge under (x, y). With a heading (unit range, SCS convention), only
   * edges going the same way as the truck qualify.
   * Returns { edge, along (meters from edge start), dist } or null.
   */
  snap(x, y, heading = null, maxDist = 60) {
    const fx = heading == null ? 0 : -Math.sin(heading * Math.PI * 2);
    const fy = heading == null ? 0 : -Math.cos(heading * Math.PI * 2);
    const q = this.q;
    let best = null, bestScore = Infinity;
    for (const e of this.edgesNear(x, y, maxDist)) {
      if (this.edgeFlags[e] & 1) continue;
      let along = 0;
      for (let p = this.geomOff[e] + 1; p < this.geomOff[e + 1]; p++) {
        const ax = this.pts[p * 2 - 2] / q, ay = this.pts[p * 2 - 1] / q;
        const bx = this.pts[p * 2] / q, by = this.pts[p * 2 + 1] / q;
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (len * len)));
        const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (d <= maxDist) {
          const align = heading == null ? 1 : (dx * fx + dy * fy) / len;
          if (align > 0.35) {
            const score = d + (1 - align) * 25;
            if (score < bestScore) { bestScore = score; best = { edge: e, along: along + t * len, dist: d }; }
          }
        }
        along += len;
      }
    }
    return best;
  }

  nodeXYm(n) { return [this.nodeXY[n * 2] / this.q, this.nodeXY[n * 2 + 1] / this.q]; }

  /**
   * Unit directions of an edge: `chord` from its start to the point `reach`
   * meters along it, `tangent` the way it points there. With fromEnd, the same
   * over its last `reach` meters, pointing forward. null without a shape.
   */
  edgeDir(e, reach, fromEnd = false) {
    const a = this.geomOff[e], b = this.geomOff[e + 1] - 1;
    if (b <= a) return null;
    const P = this.pts, q = this.q, sign = fromEnd ? -1 : 1;
    const ox = P[(fromEnd ? b : a) * 2], oy = P[(fromEnd ? b : a) * 2 + 1];
    let x = ox, y = oy, len = 0, tx = 0, ty = 0;
    for (let p = fromEnd ? b - 1 : a + 1; fromEnd ? p >= a : p <= b; p += sign) {
      const nx = P[p * 2], ny = P[p * 2 + 1], l = Math.hypot(nx - x, ny - y);
      if (l > 0) { tx = (nx - x) / l; ty = (ny - y) / l; }
      len += l / q;
      x = nx; y = ny;
      if (len >= reach) break;
    }
    const dx = x - ox, dy = y - oy, l = Math.hypot(dx, dy);
    return l > 1e-6 ? { chord: [sign * dx / l, sign * dy / l], tangent: [sign * tx, sign * ty] } : null;
  }

  /**
   * What the driver has to do when the route goes from edge `prev` into edge
   * `e`: 0 nothing, else a TURN code. Only where the road offers another way
   * (the other ways out of the same node), and not for staying on the road
   * that goes straight on.
   */
  turnAt(prev, e) {
    if (this.edgeFlags[e] & 1) return this.edgeFlags[prev] & 1 ? 0 : TURN.FERRY;
    const s = this.edgeFrom[e];
    if (this.stateOff[s + 1] - this.stateOff[s] < 2) return 0;
    const inDir = this.edgeDir(prev, 15, true)?.chord, out = this.edgeDir(e, 45);
    if (!inDir || !out) return 0;
    // Signed turn in degrees, positive = to the right (y grows to the south).
    const turn = (d) => Math.atan2(inDir[0] * d[1] - inDir[1] * d[0], inDir[0] * d[0] + inDir[1] * d[1]) * 180 / Math.PI;
    const dc = turn(out.chord);
    let others = 0, left = 0, right = 0, straighter = false;
    for (let o = this.stateOff[s]; o < this.stateOff[s + 1]; o++) {
      if (o === e || this.edgeFlags[o] & 1 || this.edgeTo[o] === this.edgeTo[e]) continue;
      const d = this.edgeDir(o, 45);
      if (!d) continue;
      const da = turn(d.chord);
      if (Math.abs(da) > 150) continue; // a way back, not a choice
      others++;
      // A fork: another way that leaves almost in the same direction as ours.
      if (Math.abs(da) < 75 && Math.abs(da - dc) < 60) {
        if (da < dc) left++; else right++;
        if (Math.abs(da) < Math.abs(dc) + 4) straighter = true;
      }
    }
    if (!others) return 0;
    // A real turn: the road ends up pointing somewhere else.
    if (Math.abs(dc) >= 40 || Math.abs(turn(out.tangent)) >= 65) return dc < 0 ? TURN.LEFT : TURN.RIGHT;
    // Passing an exit on the road that goes straight on: nothing to say.
    if (!straighter) return 0;
    if (left && right) return TURN.MIDDLE;
    if (right) return TURN.KEEP_LEFT;   // the other way is on our right
    if (left) return TURN.KEEP_RIGHT;
    return 0;
  }

  /** Graph nodes a job goes to: the company's node(s), else nearest road to the city. */
  jobTargets(cityToken, companyToken, cityPos) {
    const list = this.companies[`${cityToken}/${companyToken}`];
    if (list?.length) return { nodes: list.map((c) => c[2]), x: list[0][0], y: list[0][1] };
    if (cityPos) return this.pointTarget(cityPos[0], cityPos[1]);
    return null;
  }

  /** Target for an arbitrary point: both ends of the nearest edge. */
  pointTarget(x, y) {
    for (const radius of [150, 600, 2000]) {
      const s = this.snap(x, y, null, radius);
      if (s) return { nodes: [this.edgeFrom[s.edge] >> 1, this.edgeTo[s.edge] >> 1], x, y };
    }
    return null;
  }

  /**
   * Fastest route from the truck (x, y, heading) to target.nodes.
   * Returns { points: [[x,y]...], distance (m), duration (s), ms } or null.
   */
  route(x, y, heading, target) {
    const t0 = performance.now();
    let start = this.snap(x, y, heading, 40) ?? this.snap(x, y, heading, 120) ?? this.snap(x, y, null, 120);
    if (!start || !target?.nodes?.length) return null;
    const goals = new Set(target.nodes);
    const goalXY = target.nodes.map((n) => this.nodeXYm(n));
    const h = (s) => {
      const [nx, ny] = this.nodeXYm(s >> 1);
      let d = Infinity;
      for (const [gx, gy] of goalXY) d = Math.min(d, Math.hypot(nx - gx, ny - gy));
      return d / this.vmax;
    };

    const round = ++this.round;
    const { g, came, stamp } = this;
    const heap = new Heap();
    const e0 = start.edge;
    const s0 = this.edgeTo[e0];
    const frac = this.edgeLen[e0] > 0 ? Math.max(0, 1 - start.along / this.edgeLen[e0]) : 0;
    stamp[s0] = round;
    g[s0] = this.edgeDur[e0] * frac;
    came[s0] = -1;
    heap.push(g[s0] + h(s0), s0);

    let found = -1;
    // Already on the destination's road.
    if (goals.has(s0 >> 1)) found = s0;
    let iters = 0;
    while (found < 0 && heap.size) {
      const [f, s] = heap.pop();
      if (f - h(s) > g[s] + 1e-6) continue; // stale entry
      if (goals.has(s >> 1)) { found = s; break; }
      if (++iters > 2_000_000) break;
      for (let e = this.stateOff[s]; e < this.stateOff[s + 1]; e++) {
        const t = this.edgeTo[e];
        const cost = g[s] + this.edgeDur[e];
        if (stamp[t] !== round || cost < g[t]) {
          stamp[t] = round;
          g[t] = cost;
          came[t] = e;
          heap.push(cost + h(t), t);
        }
      }
    }
    if (found < 0) return null;

    // Edges back to the start, then the shape.
    const path = [];
    for (let s = found; came[s] >= 0; s = this.edgeFrom[came[s]]) path.push(came[s]);
    path.reverse();
    const points = [];
    const q = this.q;
    // Remainder of the starting edge from the truck's projection.
    {
      let along = 0;
      for (let p = this.geomOff[e0] + 1; p < this.geomOff[e0 + 1]; p++) {
        const ax = this.pts[p * 2 - 2] / q, ay = this.pts[p * 2 - 1] / q;
        const bx = this.pts[p * 2] / q, by = this.pts[p * 2 + 1] / q;
        const len = Math.hypot(bx - ax, by - ay);
        if (along + len >= start.along) {
          if (!points.length) {
            const t = len > 0 ? (start.along - along) / len : 0;
            points.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
          }
          points.push([bx, by]);
        }
        along += len;
      }
      if (!points.length) points.push(this.nodeXYm(s0 >> 1));
    }
    let duration = g[found];
    // Maneuvers: [index in points, TURN code], where the route leaves a node
    // that has another way out.
    const turns = [];
    let prev = e0;
    for (const e of path) {
      const code = this.turnAt(prev, e);
      prev = e;
      if (code) {
        const at = points.length - 1, last = turns[turns.length - 1];
        // Same order twice in a row (lanes of one junction): once is enough.
        if (!(last && last[1] === code && distBetween(points, last[0], at) < 60)) turns.push([at, code]);
      }
      for (let p = this.geomOff[e]; p < this.geomOff[e + 1]; p++) {
        const pt = [this.pts[p * 2] / q, this.pts[p * 2 + 1] / q];
        const last = points[points.length - 1];
        // Ferry legs are straight jumps; shapes otherwise connect end to start.
        if (Math.abs(pt[0] - last[0]) < 0.6 && Math.abs(pt[1] - last[1]) < 0.6) continue;
        points.push(pt);
      }
    }
    let distance = 0;
    for (let i = 1; i < points.length; i++) distance += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    return { points, turns, distance, duration, edges: path.length, ms: Math.round(performance.now() - t0), iters };
  }
}

function distBetween(points, a, b) {
  let d = 0;
  for (let i = a + 1; i <= b; i++) d += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return d;
}

/** Binary min-heap of (priority, value) pairs. */
class Heap {
  constructor() { this.p = []; this.v = []; }
  get size() { return this.p.length; }
  push(pri, val) {
    const { p, v } = this;
    let i = p.length;
    p.push(pri); v.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (p[parent] <= pri) break;
      p[i] = p[parent]; v[i] = v[parent];
      i = parent;
    }
    p[i] = pri; v[i] = val;
  }
  pop() {
    const { p, v } = this;
    const top = [p[0], v[0]];
    const lp = p.pop(), lv = v.pop();
    if (p.length) {
      let i = 0;
      const n = p.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mp = lp;
        if (l < n && p[l] < mp) { m = l; mp = p[l]; }
        if (r < n && p[r] < mp) { m = r; mp = p[r]; }
        if (m === i) break;
        p[i] = p[m]; v[i] = v[m];
        i = m;
      }
      p[i] = lp; v[i] = lv;
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Keeps the current route up to date while driving.

const OFF_ROUTE_M = 45;
const OFF_ROUTE_MS = 2500;
const REROUTE_MIN_MS = 4000;

export class RouteManager {
  constructor(router, meta, onChange) {
    this.router = router;
    this.meta = meta;
    this.onChange = onChange;
    this.current = null;     // { id, points, cum, distance, duration, target, reason }
    this.jobKey = '';
    this.manual = null;      // { x, y } picked on the phone
    this.offSince = 0;
    this.lastCompute = 0;
    this.progress = 0;
    this.seq = 0;
  }

  setManualTarget(x, y) {
    this.manual = x == null ? null : { x, y };
    this.forceAt = 0;
    this.current = null;
    this.lastCompute = 0;
    if (!this.manual && !this.jobTarget) this.publish(null);
  }

  update(t) {
    if (!t || t.paused && this.current) return;
    if (t.x === 0 && t.z === 0) return;
    const job = t.job;
    const jobKey = job ? `${job.dstId}/${job.dstCoId}` : '';
    if (jobKey !== this.jobKey) {
      this.jobKey = jobKey;
      this.jobTarget = job ? this.router.jobTargets(job.dstId, job.dstCoId, this.meta?.cityPos?.[job.dstId]) : null;
      if (this.jobTarget) this.jobTarget.label = [job.dst, job.dstCo].filter(Boolean).join(' · ');
      if (job) this.manual = null; // a new job replaces a point picked by hand
      this.current = null;
      this.lastCompute = 0;
      if (!this.jobTarget && !this.manual) this.publish(null);
    }
    const target = this.manual ? this.router.pointTarget(this.manual.x, this.manual.y) : this.jobTarget;
    if (!target) return;
    if (this.manual && target) target.label = 'Point choisi';

    const now = Date.now();
    if (!this.current) {
      if (now - this.lastCompute > 1500) this.compute(t, target, 'new');
      return;
    }
    // Off-route detection near the current progress.
    const d = this.distanceToRoute(t.x, t.z);
    if (d > OFF_ROUTE_M && Math.abs(t.spd) > 1.5) {
      if (!this.offSince) this.offSince = now;
      if (now - this.offSince > OFF_ROUTE_MS && now - this.lastCompute > REROUTE_MIN_MS) this.compute(t, target, 'reroute');
    } else {
      this.offSince = 0;
    }
  }

  compute(t, target, reason) {
    this.lastCompute = Date.now();
    this.offSince = 0;
    const r = this.router.route(t.x, t.z, t.h, target);
    if (!r) {
      if (this.current) return; // keep the old one rather than nothing
      this.publish(null);
      return;
    }
    // Maneuver points survive the simplification; their indices follow.
    const index = new Int32Array(r.points.length);
    const pts = simplifyPts(r.points, 1.5, r.turns.map((m) => m[0]), index);
    const turns = r.turns.map(([i, code]) => [index[i], code]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.progress = 0;
    this.current = { id: ++this.seq, points: pts, turns, cum, distance: r.distance, duration: r.duration, target: { x: target.x, y: target.y, label: target.label }, reason, ms: r.ms };
    console.log(`[route] ${reason}: ${(r.distance / 1000).toFixed(1)} km, ${pts.length} pts, ${r.ms} ms -> ${target.label ?? ''}`);
    this.publish(this.current);
  }

  distanceToRoute(x, y) {
    const pts = this.current.points;
    let best = Infinity, bestI = this.progress;
    const from = Math.max(1, this.progress - 5), to = Math.min(pts.length, this.progress + 400);
    for (let i = from; i < to; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const tt = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(x - ax - tt * dx, y - ay - tt * dy);
      if (d < best) { best = d; bestI = i - 1; }
    }
    if (best < OFF_ROUTE_M) this.progress = bestI;
    return best;
  }

  publish(route) {
    this.onChange(route ? encodeRoute(route) : { id: ++this.seq, none: true });
  }
}

/** Douglas-Peucker. `must`: indices kept anyway; `index`: filled with old index -> new index. */
export function simplifyPts(points, tol, must = [], index = null) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  for (const i of must) keep[i] = 1;
  // Each stretch between two forced points is simplified on its own.
  const stack = [];
  for (let i = 1, a = 0; i < points.length; i++) if (keep[i]) { stack.push([a, i]); a = i; }
  const sq = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
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
  if (index) for (let i = 0, n = 0; i < points.length; i++) { index[i] = n; if (keep[i]) n++; }
  return points.filter((_, i) => keep[i]);
}

/** Compact form for the phone: points in decimeters, delta encoded. */
export function encodeRoute(r) {
  const enc = [];
  let px = 0, py = 0;
  r.points.forEach(([x, y], i) => {
    const qx = Math.round(x * 10), qy = Math.round(y * 10);
    if (i === 0) enc.push(qx, qy); else enc.push(qx - px, qy - py);
    px = qx; py = qy;
  });
  // man: maneuvers, flat [point index, TURN code, ...].
  return { id: r.id, pts: enc, man: (r.turns ?? []).flat(), distance: Math.round(r.distance), duration: Math.round(r.duration), target: r.target, reason: r.reason };
}
