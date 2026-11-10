// Client side of the GPS route: decodes the route sent by the server, follows
// the truck along it and builds the path still to drive.

export class RouteView {
  constructor() {
    this.r = null;
    this.version = 0;
  }

  /** msg from the server: { id, pts (decimeters, delta), distance, duration, target } or { none } */
  set(msg) {
    this.version++;
    if (!msg || msg.none || !msg.pts?.length) { this.r = null; return; }
    const n = msg.pts.length / 2;
    const xs = new Float64Array(n), ys = new Float64Array(n), cum = new Float64Array(n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
      x += msg.pts[i * 2];
      y += msg.pts[i * 2 + 1];
      xs[i] = x / 10;
      ys[i] = y / 10;
      if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    // Maneuvers from the server: [point index, code, ...] (codes: TURNS in app.js).
    const man = Array.isArray(msg.man) ? [] : null;
    for (let i = 0; man && i + 1 < msg.man.length; i += 2) if (msg.man[i] > 0 && msg.man[i] < n) man.push({ i: msg.man[i], code: msg.man[i + 1] });
    this.r = { ...msg, man, xs, ys, cum, n, progress: 0, projX: xs[0], projY: ys[0], projT: 0, cached: null, cachedAt: -1 };
  }

  get active() { return !!this.r; }
  get target() { return this.r?.target ?? null; }

  /** Moves the progress marker to where the truck is (forward only, small window). */
  update(x, y) {
    const r = this.r;
    if (!r) return;
    let best = Infinity, bi = r.progress, bt = 0;
    const from = Math.max(0, r.progress - 3), to = Math.min(r.n - 1, r.progress + 300);
    for (let i = from; i < to; i++) {
      const ax = r.xs[i], ay = r.ys[i], dx = r.xs[i + 1] - ax, dy = r.ys[i + 1] - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d < best) { best = d; bi = i; bt = t; }
    }
    if (best < 80) {
      r.progress = bi;
      r.projT = bt;
      r.projX = r.xs[bi] + (r.xs[bi + 1] - r.xs[bi]) * bt;
      r.projY = r.ys[bi] + (r.ys[bi + 1] - r.ys[bi]) * bt;
    }
  }

  /** Meters driven along the route so far. */
  traveled() {
    const r = this.r;
    if (!r) return 0;
    const segLen = r.progress < r.n - 1 ? r.cum[r.progress + 1] - r.cum[r.progress] : 0;
    return r.cum[r.progress] + segLen * r.projT;
  }

  /** Meters left along the route. */
  remaining() {
    const r = this.r;
    return r ? Math.max(0, r.cum[r.n - 1] - this.traveled()) : 0;
  }

  /** Estimated seconds left, scaled from the server's estimate. */
  remainingDuration() {
    const r = this.r;
    if (!r || !r.cum[r.n - 1]) return 0;
    return r.duration * (this.remaining() / r.cum[r.n - 1]);
  }

  /**
   * The next maneuvers ahead: [{ code, dist (meters) }], the arrival (code 6)
   * last. null when the route came without maneuvers (older ETS2 Map).
   */
  maneuvers(count = 2) {
    const r = this.r;
    if (!r?.man) return null;
    const at = this.traveled(), out = [];
    for (const m of r.man) {
      if (m.i <= r.progress) continue;
      out.push({ code: m.code, dist: Math.max(0, r.cum[m.i] - at) });
      if (out.length === count) return out;
    }
    out.push({ code: 6, dist: this.remaining() });
    return out;
  }

  /**
   * What is left of the route inside the world box [x0, y0, x1, y1], from the
   * truck's projection: { path (Path2D, quantized units), start (quantized
   * units along the route where the path begins, to anchor dashes) }.
   * Points closer than `tol` meters to the last drawn one are skipped.
   */
  path(q, box, tol = 0) {
    const r = this.r;
    if (!r) return null;
    const [x0, y0, x1, y1] = box;
    const path = new Path2D();
    let px = r.projX, py = r.projY, pen = false, lx = 0, ly = 0, start = null;
    for (let i = r.progress + 1; i < r.n; i++) {
      const x = r.xs[i], y = r.ys[i];
      if ((px > x ? px : x) >= x0 && (px < x ? px : x) <= x1 && (py > y ? py : y) >= y0 && (py < y ? py : y) <= y1) {
        if (!pen) {
          path.moveTo(px * q, py * q);
          pen = true; lx = px; ly = py;
          start ??= i - 1 === r.progress ? this.traveled() : r.cum[i - 1];
        }
        if (i === r.n - 1 || Math.abs(x - lx) > tol || Math.abs(y - ly) > tol) { path.lineTo(x * q, y * q); lx = x; ly = y; }
      } else {
        if (pen && (lx !== px || ly !== py)) path.lineTo(px * q, py * q); // close the skipped tail
        pen = false;
      }
      px = x; py = y;
    }
    return { path, start: (start ?? 0) * q };
  }
}
