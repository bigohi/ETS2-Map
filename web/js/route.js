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
    this.r = { ...msg, xs, ys, cum, n, progress: 0, projX: xs[0], projY: ys[0], projT: 0, cached: null, cachedAt: -1 };
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

  /** Meters left along the route. */
  remaining() {
    const r = this.r;
    if (!r) return 0;
    const segLen = r.progress < r.n - 1 ? r.cum[r.progress + 1] - r.cum[r.progress] : 0;
    return Math.max(0, r.cum[r.n - 1] - r.cum[r.progress] - segLen * r.projT);
  }

  /** Estimated seconds left, scaled from the server's estimate. */
  remainingDuration() {
    const r = this.r;
    if (!r || !r.cum[r.n - 1]) return 0;
    return r.duration * (this.remaining() / r.cum[r.n - 1]);
  }

  /** Path2D (quantized units) of what is left, from the truck's projection. */
  path(q) {
    const r = this.r;
    if (!r) return null;
    if (r.cachedAt !== r.progress || r.cachedQ !== q) {
      const p = new Path2D();
      p.moveTo(r.xs[r.progress + 1 < r.n ? r.progress + 1 : r.progress] * q, r.ys[r.progress + 1 < r.n ? r.progress + 1 : r.progress] * q);
      for (let i = r.progress + 2; i < r.n; i++) p.lineTo(r.xs[i] * q, r.ys[i] * q);
      r.cached = p;
      r.cachedAt = r.progress;
      r.cachedQ = q;
    }
    // Head segment from the truck's projection, rebuilt each frame.
    const head = new Path2D();
    head.moveTo(r.projX * q, r.projY * q);
    if (r.progress + 1 < r.n) head.lineTo(r.xs[r.progress + 1] * q, r.ys[r.progress + 1] * q);
    return [head, r.cached];
  }
}
