// Canvas renderer: map layers, labels, POIs, trail, destination and truck.
import { FREEWAY, DIVIDED, LOCAL, NO_VEHICLES, TRAIN, TRAM, UNKNOWN } from './mapdata.js';

export const THEMES = {
  dark: {
    bg: '#1b1f24',
    areas: ['#4f555c', '#3f3a30', '#34302a', '#24352a', '#5a2323', '#29482a', '#213a4d', '#57501f', '#3a2b4d'],
    road: {
      [FREEWAY]: ['#e0a63a', '#5c4214'],
      [DIVIDED]: ['#9aa1a9', '#30353b'],
      [LOCAL]: ['#626970', '#2a2e33'],
      [NO_VEHICLES]: ['#4a4f55', '#2a2e33'],
      [UNKNOWN]: ['#5a6066', '#2a2e33'],
      [TRAIN]: ['#6b5a73', null],
      [TRAM]: ['#5b6b73', null],
    },
    ferry: '#4aa3d8',
    label: '#e8ebee', labelHalo: 'rgba(20,23,27,0.9)',
    country: 'rgba(200,210,220,0.55)',
    trail: 'rgba(63,169,255,0.55)',
    truck: '#3fa9ff', truckEdge: '#ffffff',
    dest: '#ff5a52', source: '#7bd88f',
    route: '#e8322b', routeEdge: '#6e1310',
    poiHalo: 'rgba(20,23,27,0.85)',
  },
  light: {
    bg: '#e9e7e0',
    areas: ['#ffffff', '#f0dcb4', '#dfc493', '#c9dfb6', '#d9a6a6', '#a8d29b', '#9cc4dd', '#f1e38a', '#c8b2e0'],
    road: {
      [FREEWAY]: ['#f8c248', '#c4902a'],
      [DIVIDED]: ['#ffffff', '#b9b9b9'],
      [LOCAL]: ['#ffffff', '#c9c9c9'],
      [NO_VEHICLES]: ['#e6e6e6', '#c9c9c9'],
      [UNKNOWN]: ['#f4f4f4', '#c9c9c9'],
      [TRAIN]: ['#9a8aa3', null],
      [TRAM]: ['#8aa0aa', null],
    },
    ferry: '#2a86c4',
    label: '#1f2328', labelHalo: 'rgba(255,255,255,0.92)',
    country: 'rgba(60,70,80,0.5)',
    trail: 'rgba(10,124,255,0.5)',
    truck: '#0a7cff', truckEdge: '#ffffff',
    dest: '#d93025', source: '#188038',
    route: '#e8322b', routeEdge: '#9c1b16',
    poiHalo: 'rgba(255,255,255,0.9)',
  },
};

// Scale thresholds (CSS px per meter).
const OVERVIEW_BELOW = 0.006;
const MID_BELOW = 0.05;

// Minimum on-screen road widths (CSS px) per class at detail level.
const MIN_PX = { [FREEWAY]: 3.2, [DIVIDED]: 2.6, [LOCAL]: 1.7, [NO_VEHICLES]: 1, [UNKNOWN]: 1.4, [TRAIN]: 1, [TRAM]: 0.8 };
// Fixed widths at mid / overview level.
const MID_PX = { [FREEWAY]: 2.4, [DIVIDED]: 1.9, [LOCAL]: 1.1, [NO_VEHICLES]: 0.6, [UNKNOWN]: 0.8, [TRAIN]: 0.7, [TRAM]: 0 };
const MID_FAR_PX = { [FREEWAY]: 2.2, [DIVIDED]: 1.7, [LOCAL]: 0.7, [NO_VEHICLES]: 0, [UNKNOWN]: 0, [TRAIN]: 0, [TRAM]: 0 };
const OV_PX = { [FREEWAY]: 1.7, [DIVIDED]: 1.2, [LOCAL]: 0.55, [NO_VEHICLES]: 0, [UNKNOWN]: 0, [TRAIN]: 0, [TRAM]: 0 };

const FACILITY_ICONS = new Set([
  'gas_ico', 'service_ico', 'parking_ico', 'garage_large_ico', 'garage_small_ico', 'recruitment_ico',
  'dealer_ico', 'toll_ico', 'weigh_ico', 'weigh_station_ico', 'train_ico', 'port_overlay', 'viewpoint',
]);

export class View {
  constructor() {
    this.cx = 0; this.cy = 0;      // world center (meters)
    this.scale = 0.4;              // CSS px per meter
    this.rot = 0;                  // radians, world rotation on screen
    this.w = 1; this.h = 1;        // CSS px
    this.ax = 0.5; this.ay = 0.5;  // anchor of (cx, cy) on screen, fraction of w/h
  }
  toScreen(x, y) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    const dx = (x - this.cx) * this.scale, dy = (y - this.cy) * this.scale;
    return [this.w * this.ax + c * dx - s * dy, this.h * this.ay + s * dx + c * dy];
  }
  toWorld(px, py) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    const dx = (px - this.w * this.ax) / this.scale, dy = (py - this.h * this.ay) / this.scale;
    return [this.cx + c * dx + s * dy, this.cy - s * dx + c * dy];
  }
  bbox(marginPx = 0) {
    const pts = [[-marginPx, -marginPx], [this.w + marginPx, -marginPx], [this.w + marginPx, this.h + marginPx], [-marginPx, this.h + marginPx]].map(([x, y]) => this.toWorld(x, y));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
}

export class Renderer {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.store = store;
    this.dpr = 1;
    this.theme = THEMES.dark;
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    return [w, h];
  }

  /**
   * scene: { truck: {x, y, h} | null, trail: [[x,y]...], dest: [x,y] | null, source: [x,y] | null,
   *          opts: {pois, companies, shields, trail} }
   */
  draw(view, scene) {
    const { theme, store, dpr } = this;
    const ctx = this.ctx;
    const q = store.q || 2;
    this.needsRedraw = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, view.w, view.h);
    if (!store.meta) return;

    const bbox = view.bbox(40);
    if (view.scale < MID_BELOW) {
      // Zoomed out: thousands of lines. Render them once into a bigger
      // offscreen canvas and just slide it while panning.
      this.drawCachedBase(view);
    } else {
      this.worldTransform(ctx, view);
      this.drawBase(ctx, view, bbox);
    }

    const k = view.scale / q;
    const px = (n) => n / k; // CSS px -> quantized world units
    this.worldTransform(ctx, view);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Friends' routes (dashed, their color), under ours.
    if (scene.opts.peerRoutes && scene.peers?.length) {
      const w = Math.max(4 * q, px(3.5));
      for (const peer of scene.peers) {
        if (!peer.route?.active) continue;
        const paths = peer.route.path(q);
        // Dark underlay so the dashes read on top of amber highways.
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(10,12,16,0.7)';
        ctx.lineWidth = w + px(3);
        for (const p of paths) if (p) ctx.stroke(p);
        ctx.setLineDash([px(10), px(6)]);
        ctx.strokeStyle = peer.color;
        ctx.lineWidth = w;
        for (const p of paths) if (p) ctx.stroke(p);
      }
      ctx.setLineDash([]);
    }

    // GPS route, on the road, under the trail and markers.
    if (scene.route?.active) {
      const paths = scene.route.path(q);
      const w = Math.max(7 * q, px(5));
      for (const [color, width] of [[theme.routeEdge, w + px(2.5)], [theme.route, w]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        for (const p of paths) if (p) ctx.stroke(p);
      }
    }

    // Trail.
    if (scene.opts.trail && scene.trail.length > 1) {
      ctx.beginPath();
      ctx.moveTo(scene.trail[0][0] * q, scene.trail[0][1] * q);
      for (let i = 1; i < scene.trail.length; i++) ctx.lineTo(scene.trail[i][0] * q, scene.trail[i][1] * q);
      if (scene.truck) ctx.lineTo(scene.truck.x * q, scene.truck.y * q);
      ctx.strokeStyle = theme.trail;
      ctx.lineWidth = px(4);
      ctx.stroke();
    }

    // Straight guide line truck -> destination when zoomed out.
    if (scene.truck && scene.dest && view.scale < 0.08 && !scene.route?.active) {
      ctx.beginPath();
      ctx.moveTo(scene.truck.x * q, scene.truck.y * q);
      ctx.lineTo(scene.dest[0] * q, scene.dest[1] * q);
      ctx.setLineDash([px(6), px(6)]);
      ctx.strokeStyle = theme.dest;
      ctx.lineWidth = px(2);
      ctx.globalAlpha = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    // Screen-space layers.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const placed = [];
    if (view.scale >= 0.06) this.drawPois(view, bbox, scene.opts, placed);
    this.drawLabels(view, placed);
    if (scene.source) this.drawPin(view, scene.source, theme.source, false);
    if (scene.dest) this.drawPin(view, scene.dest, theme.dest, true);
    for (const peer of scene.peers ?? []) this.drawPeer(view, peer);
    if (scene.truck) this.drawTruck(view, scene.truck);
    if (scene.dest && scene.truck) this.drawEdgeArrow(view, scene.dest, scene.truck, theme.dest, null);
    const me = scene.truck ?? { x: view.cx, y: view.cy };
    for (const peer of scene.peers ?? []) this.drawEdgeArrow(view, [peer.x, peer.y], me, peer.color, peer.name);
  }

  worldTransform(ctx, view, offX = 0, offY = 0) {
    const q = this.store.q || 2;
    const k = view.scale / q;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(view.w * view.ax + offX, view.h * view.ay + offY);
    ctx.rotate(view.rot);
    ctx.scale(k, k);
    ctx.translate(-view.cx * q, -view.cy * q);
  }

  /** Map geometry (areas, ferries, roads) for the current level, world transform already set. */
  drawBase(ctx, view, bbox) {
    const { theme, store } = this;
    const prev = this.ctx;
    this.ctx = ctx;
    const k = view.scale / (store.q || 2);
    const px = (n) => n / k;
    // Round joins look best up close; bevel/butt is much cheaper for the
    // thousands of hairlines drawn when zoomed out.
    const far = view.scale < MID_BELOW;
    ctx.lineCap = far ? 'butt' : 'round';
    ctx.lineJoin = far ? 'bevel' : 'round';
    if (view.scale < OVERVIEW_BELOW) {
      this.drawRoadsFixed([store.overview], OV_PX, px);
      this.drawFerries([store.overview], px);
    } else if (view.scale < MID_BELOW) {
      const tiles = store.tiles('mid', bbox);
      if (!store.ready('mid', bbox)) this.drawRoadsFixed([store.overview], OV_PX, px);
      // Local roads stay hairlines until they can be told apart.
      this.drawRoadsFixed(tiles, view.scale < 0.02 ? MID_FAR_PX : MID_PX, px);
      this.drawFerries(tiles, px);
    } else {
      const tiles = store.tiles('detail', bbox);
      if (!store.ready('detail', bbox)) {
        // Fill holes with the coarser level while detail loads.
        const mids = store.tiles('mid', bbox);
        this.drawRoadsFixed(mids.length ? mids : [store.overview], MID_PX, px);
      }
      for (const t of tiles) {
        for (const a of t.areas) {
          ctx.fillStyle = theme.areas[a.color] ?? theme.areas[0];
          ctx.fill(a.path);
        }
      }
      this.drawFerries(tiles, px);
      this.drawRoadsDetail(tiles, px);
    }
    this.ctx = prev;
  }

  drawCachedBase(view) {
    const { dpr, store, theme } = this;
    const margin = Math.round(Math.max(view.w, view.h) * 0.5);
    let c = this.cache;
    // Where the cached center lands on screen now.
    let off = c ? view.toScreen(c.cx, c.cy) : null;
    const now = performance.now();
    if (view.scale !== this.lastScale) { this.lastScale = view.scale; this.lastScaleChange = now; }
    const sameFrame = c && c.rot === view.rot && c.theme === theme && c.w === view.w && c.h === view.h && c.ax === view.ax && c.ay === view.ay;
    const valid = sameFrame && c.scale === view.scale && c.version === store.version &&
      Math.abs(off[0] - view.w * view.ax) < margin * 0.9 && Math.abs(off[1] - view.h * view.ay) < margin * 0.9;
    // While a pinch/wheel zoom is in progress, stretch the old image instead of
    // re-rendering every frame; redraw sharp once the zoom settles.
    const ratio = c ? view.scale / c.scale : 1;
    if (!valid && sameFrame && now - this.lastScaleChange < 160 && ratio > 0.4 && ratio < 2.5) {
      const ctx = this.ctx;
      const ax = c.margin + c.w * c.ax, ay = c.margin + c.h * c.ay;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.cacheCanvas,
        (off[0] - ax * ratio) * dpr, (off[1] - ay * ratio) * dpr,
        this.cacheCanvas.width * ratio, this.cacheCanvas.height * ratio);
      this.needsRedraw = true;
      return;
    }
    if (!valid) {
      if (!this.cacheCanvas) this.cacheCanvas = document.createElement('canvas');
      const cw = Math.round((view.w + margin * 2) * dpr), ch = Math.round((view.h + margin * 2) * dpr);
      if (this.cacheCanvas.width !== cw || this.cacheCanvas.height !== ch) {
        this.cacheCanvas.width = cw;
        this.cacheCanvas.height = ch;
      }
      const cctx = this.cacheCanvas.getContext('2d');
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, cw, ch);
      // Same view, but with a margin all around.
      const big = Object.assign(Object.create(Object.getPrototypeOf(view)), view, {
        w: view.w + margin * 2, h: view.h + margin * 2,
        ax: (view.w * view.ax + margin) / (view.w + margin * 2),
        ay: (view.h * view.ay + margin) / (view.h + margin * 2),
      });
      this.worldTransform(cctx, big);
      this.drawBase(cctx, big, big.bbox(20));
      c = this.cache = { cx: view.cx, cy: view.cy, scale: view.scale, rot: view.rot, version: store.version, theme, w: view.w, h: view.h, ax: view.ax, ay: view.ay, margin };
      off = view.toScreen(c.cx, c.cy);
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.cacheCanvas,
      Math.round((off[0] - view.w * view.ax - c.margin) * dpr),
      Math.round((off[1] - view.h * view.ay - c.margin) * dpr));
  }

  drawRoadsFixed(tiles, widths, px) {
    const { ctx, theme } = this;
    // Group strokes by class so each class is one style change per tile.
    for (const cls of [TRAIN, LOCAL, NO_VEHICLES, UNKNOWN, DIVIDED, FREEWAY]) {
      const w = widths[cls];
      if (!w) continue;
      ctx.strokeStyle = theme.road[cls][0];
      ctx.lineWidth = px(w);
      if (cls === TRAIN) ctx.setLineDash([px(4), px(3)]);
      for (const t of tiles) for (const b of t.roads) if (b.cls === cls) ctx.stroke(b.path);
      if (cls === TRAIN) ctx.setLineDash([]);
    }
  }

  drawRoadsDetail(tiles, px) {
    const { ctx, theme } = this;
    const casing = px(1.6);
    // Pass 1: casings (outline) for all road classes that have one.
    for (const t of tiles) {
      for (const b of t.roads) {
        const colors = theme.road[b.cls];
        if (!colors[1]) continue;
        ctx.strokeStyle = colors[1];
        ctx.lineWidth = Math.max(b.w, px(MIN_PX[b.cls])) + casing;
        ctx.stroke(b.path);
      }
    }
    // Pass 2: fills, minor first so highways stay on top.
    for (const t of tiles) {
      for (const b of t.roads) {
        const colors = theme.road[b.cls];
        ctx.strokeStyle = colors[0];
        const w = Math.max(b.w, px(MIN_PX[b.cls]));
        if (b.cls === TRAIN || b.cls === TRAM) {
          ctx.lineWidth = px(MIN_PX[b.cls]);
          ctx.setLineDash([px(5), px(4)]);
          ctx.stroke(b.path);
          ctx.setLineDash([]);
        } else {
          ctx.lineWidth = w;
          ctx.stroke(b.path);
        }
      }
    }
  }

  drawFerries(tiles, px) {
    const { ctx, theme } = this;
    ctx.strokeStyle = theme.ferry;
    ctx.lineWidth = px(1.5);
    ctx.setLineDash([px(7), px(5)]);
    for (const t of tiles) for (const p of t.ferries) ctx.stroke(p);
    ctx.setLineDash([]);
  }

  drawPois(view, bbox, opts, placed) {
    const { ctx, store, theme } = this;
    const tiles = store.tiles('detail', bbox);
    const showFacilities = opts.pois && view.scale >= 0.12;
    const showCompanies = opts.companies && view.scale >= 0.35;
    const showShields = opts.shields && view.scale >= 0.06;
    for (const t of tiles) {
      for (const p of t.pois) {
        let size;
        if (p.type === 'company') { if (!showCompanies) continue; size = 18; }
        else if (p.type === 'road') { if (!showShields) continue; size = 22; }
        else if (FACILITY_ICONS.has(p.icon) || p.type === 'facility') { if (!showFacilities) continue; size = 22; }
        else if (p.type === 'ferry' || p.type === 'train') { if (!showFacilities) continue; size = 22; }
        else continue;
        const [sx, sy] = view.toScreen(p.x, p.y);
        if (sx < -40 || sy < -40 || sx > view.w + 40 || sy > view.h + 40) continue;
        const img = store.icon(p.icon);
        if (!img) continue;
        const h = size, w = Math.round((img.naturalWidth / img.naturalHeight) * h);
        const box = [sx - w / 2 - 2, sy - h / 2 - 2, sx + w / 2 + 2, sy + h / 2 + 2];
        if (collides(placed, box)) continue;
        placed.push(box);
        ctx.drawImage(img, sx - w / 2, sy - h / 2, w, h);
      }
    }
  }

  drawLabels(view, placed) {
    const { ctx, store, theme } = this;
    const s = view.scale;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    // Countries when zoomed far out.
    if (s < 0.012) {
      ctx.font = '600 13px system-ui, sans-serif';
      for (const c of store.countries) {
        const [x, y] = view.toScreen(c.x, c.y);
        if (x < -100 || y < -20 || x > view.w + 100 || y > view.h + 20) continue;
        const text = c.name.toUpperCase();
        const wdt = ctx.measureText(text).width;
        const box = [x - wdt / 2, y - 9, x + wdt / 2, y + 9];
        if (collides(placed, box)) continue;
        placed.push(box);
        ctx.fillStyle = theme.country;
        ctx.fillText(text, x, y);
      }
    }

    // Cities: big ones first so they win collisions.
    const maxRank = s < 0.004 ? 2 : s < 0.012 ? 4 : s < 0.03 ? 7 : 99;
    const cities = store.cities.filter((c) => c.rank <= maxRank || c.capital === 2).sort((a, b) => a.rank - b.rank);
    for (const c of cities) {
      const [x, y] = view.toScreen(c.x, c.y);
      if (x < -100 || y < -20 || x > view.w + 100 || y > view.h + 20) continue;
      const size = c.rank <= 2 ? 16 : c.rank <= 5 ? 14 : 12.5;
      ctx.font = `${c.capital === 2 ? 700 : 600} ${size}px system-ui, sans-serif`;
      const wdt = ctx.measureText(c.name).width;
      const box = [x - wdt / 2 - 3, y - size / 2 - 3, x + wdt / 2 + 3, y + size / 2 + 3];
      if (collides(placed, box)) continue;
      placed.push(box);
      ctx.strokeStyle = theme.labelHalo;
      ctx.lineWidth = 3.5;
      ctx.strokeText(c.name, x, y);
      ctx.fillStyle = theme.label;
      ctx.fillText(c.name, x, y);
    }
  }

  drawPin(view, pos, color, big) {
    const { ctx } = this;
    const [x, y] = view.toScreen(pos[0], pos[1]);
    if (x < -30 || y < -30 || x > view.w + 30 || y > view.h + 30) return;
    const r = big ? 11 : 8;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-r * 0.4, -r * 1.2, -r, -r * 1.5, -r, -r * 2.2);
    ctx.arc(0, -r * 2.2, r, Math.PI, 0);
    ctx.bezierCurveTo(r, -r * 1.5, r * 0.4, -r * 1.2, 0, 0);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -r * 2.2, r * 0.38, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }

  drawPeer(view, peer) {
    const { ctx } = this;
    const [x, y] = view.toScreen(peer.x, peer.y);
    if (x < -60 || y < -40 || x > view.w + 60 || y > view.h + 40) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.save();
    ctx.rotate(view.rot - peer.h * Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(10, 11);
    ctx.lineTo(0, 5);
    ctx.lineTo(-10, 11);
    ctx.closePath();
    ctx.fillStyle = peer.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Name tag under the arrow, always upright.
    ctx.font = '700 12px system-ui, sans-serif';
    const w = ctx.measureText(peer.name).width + 12;
    ctx.fillStyle = peer.color;
    roundRect(ctx, -w / 2, 17, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(peer.name, 0, 26.5);
    ctx.restore();
  }

  drawTruck(view, truck) {
    const { ctx, theme } = this;
    const [x, y] = view.toScreen(truck.x, truck.y);
    // Screen angle of the truck's forward vector.
    const ang = truck.h * Math.PI * 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(view.rot - ang);
    // Soft halo.
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(63,169,255,0.18)';
    ctx.fill();
    // Arrow pointing "up" in truck space (forward = -y).
    ctx.beginPath();
    ctx.moveTo(0, -17);
    ctx.lineTo(12, 13);
    ctx.lineTo(0, 6);
    ctx.lineTo(-12, 13);
    ctx.closePath();
    ctx.fillStyle = theme.truck;
    ctx.strokeStyle = theme.truckEdge;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // Arrow at the screen edge pointing to something off screen (destination, friend).
  drawEdgeArrow(view, dest, truck, color, name) {
    const { ctx, theme } = this;
    const [dx, dy] = view.toScreen(dest[0], dest[1]);
    const m = 34;
    if (dx >= m && dy >= m + 120 && dx <= view.w - m && dy <= view.h - m - 60) return;
    const [tx, ty] = view.toScreen(truck.x, truck.y);
    const ang = Math.atan2(dy - ty, dx - tx);
    // Intersect ray from truck with the inset screen rectangle.
    const left = m, right = view.w - m - 60, top = m + 150, bottom = view.h - m - 110;
    const c = Math.cos(ang), s = Math.sin(ang);
    let t = Infinity;
    if (c > 0) t = Math.min(t, (right - tx) / c);
    if (c < 0) t = Math.min(t, (left - tx) / c);
    if (s > 0) t = Math.min(t, (bottom - ty) / s);
    if (s < 0) t = Math.min(t, (top - ty) / s);
    if (!isFinite(t) || t < 0) return;
    const ex = tx + c * t, ey = ty + s * t;
    const distKm = Math.hypot(dest[0] - truck.x, dest[1] - truck.y) / 1000;
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -10);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-8, 10);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const km = `${distKm < 10 ? distKm.toFixed(1) : Math.round(distKm)} km`;
    const label = name ? `${name} · ${km}` : km;
    const lx = ex - c * 30, ly = ey - s * 22;
    ctx.strokeStyle = theme.labelHalo;
    ctx.lineWidth = 3.5;
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = color;
    ctx.fillText(label, lx, ly);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function collides(placed, b) {
  for (const p of placed) if (b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]) return true;
  return false;
}
