// Friends in the convoy: positions (smoothed), routes, colors.
import { RouteView } from './route.js';

// No amber/orange (freeways) and no red (our own route).
// Nor blue/cyan (our own truck and trail).
const COLORS = ['#b07cff', '#2ed3b7', '#ff5fa2', '#9bd43a', '#f2f2f2'];
const DELAY = 650; // ms behind real time, peers send every 500 ms

export function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export class ConvoyView {
  constructor() {
    this.info = { active: false, connected: false, peers: 0 };
    this.peers = new Map(); // id -> { id, name, color, samples, last, route }
    this.version = 0;
  }

  onPeer(p) {
    let peer = this.peers.get(p.id);
    if (!peer) {
      peer = { id: p.id, name: p.name, color: colorFor(p.id), samples: [], route: new RouteView() };
      this.peers.set(p.id, peer);
      this.version++;
    }
    peer.name = p.name;
    peer.last = p.state;
    const s = p.state;
    // ETS2 Map running but no truck on the road: listed, not drawn.
    peer.offline = !!s?.offline;
    if (peer.offline) { peer.samples = []; return; }
    const now = performance.now();
    const prev = peer.samples[peer.samples.length - 1];
    if (prev && Math.hypot(prev.x - s.x, prev.y - s.z) > 800) peer.samples = []; // teleport
    peer.samples.push({ t: now, x: s.x, y: s.z, h: s.h, spd: s.spd, paused: s.paused });
    if (peer.samples.length > 8) peer.samples.shift();
    peer.route.update(s.x, s.z);
  }

  onRoute(id, route) {
    const peer = this.peers.get(id);
    if (!peer) {
      // Route can arrive before the first position: keep it for later.
      this.pendingRoutes ??= new Map();
      this.pendingRoutes.set(id, route);
      return;
    }
    peer.route.set(route);
  }

  onLeave(id) {
    this.peers.delete(id);
    this.version++;
  }

  /** Every peer, for the list: drawable ones carry x/y, others offline. */
  all(now) {
    const drawn = new Map(this.positions(now).map((p) => [p.id, p]));
    return [...this.peers.values()].map((p) => drawn.get(p.id) ?? { id: p.id, name: p.name, color: p.color, last: p.last, offline: true });
  }

  /** Smoothed position of every peer for this frame. */
  positions(now) {
    const out = [];
    for (const p of this.peers.values()) {
      if (this.pendingRoutes?.has(p.id)) { p.route.set(this.pendingRoutes.get(p.id)); this.pendingRoutes.delete(p.id); }
      const pos = interpolate(p.samples, now);
      if (pos) out.push({ ...pos, id: p.id, name: p.name, color: p.color, route: p.route, last: p.last });
    }
    return out;
  }
}

function interpolate(s, now) {
  if (!s.length) return null;
  const rt = now - DELAY;
  if (s.length === 1 || rt <= s[0].t) return { x: s[0].x, y: s[0].y, h: s[0].h };
  for (let i = s.length - 1; i > 0; i--) {
    const a = s[i - 1], b = s[i];
    if (rt >= a.t && rt <= b.t) {
      const f = (rt - a.t) / Math.max(1, b.t - a.t);
      let d = b.h - a.h;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: (a.h + d * f + 1) % 1 };
    }
  }
  const b = s[s.length - 1];
  if (b.paused) return { x: b.x, y: b.y, h: b.h };
  const dt = Math.min(1.5, (rt - b.t) / 1000);
  const ang = b.h * Math.PI * 2;
  return { x: b.x - Math.sin(ang) * b.spd * dt, y: b.y - Math.cos(ang) * b.spd * dt, h: b.h };
}
