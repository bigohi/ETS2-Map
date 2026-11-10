// Canvas renderer: map layers, labels, POIs, trail, destination and truck.
import { FREEWAY, DIVIDED, LOCAL, NO_VEHICLES, TRAIN, TRAM, UNKNOWN } from './mapdata.js';
import { countryFr } from './countries.js';

export const THEMES = {
  dark: {
    bg: '#0d141d',          // sea
    land: '#21252c',
    border: 'rgba(190,200,215,0.55)',
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
    bg: '#a9cfe2',          // sea
    land: '#ebe8e1',
    border: 'rgba(95,90,120,0.55)',
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
    // 3D view: the flat map canvas is tilted back by `tilt` (CSS perspective
    // `persp` px, pivot on the anchor). The canvas is bigger than the screen
    // then; (lox, loy) is the anchor inside it, lw x lh its size.
    this.tilt = 0;
    this.persp = 1000;
    this.horizon = 0;              // 3D: top band hidden by the horizon, fraction of h
    this.lw = 1; this.lh = 1; this.lox = 0.5; this.loy = 0.5;
  }
  /** World -> offset from the anchor on the flat map (CSS px). */
  flat(x, y) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    const dx = (x - this.cx) * this.scale, dy = (y - this.cy) * this.scale;
    return [c * dx - s * dy, s * dx + c * dy];
  }
  fromFlat(fx, fy) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    return [this.cx + (c * fx + s * fy) / this.scale, this.cy + (-s * fx + c * fy) / this.scale];
  }
  /** Perspective factor of a flat offset: 1 at the anchor, < 1 farther away. */
  depthAt(fy) {
    return this.tilt ? 1 / Math.max(0.05, 1 - (fy * Math.sin(this.tilt)) / this.persp) : 1;
  }
  depth(x, y) { return this.depthAt(this.flat(x, y)[1]); }
  /** World -> map canvas pixel (CSS px, before the tilt). */
  toLocal(x, y) {
    const [fx, fy] = this.flat(x, y);
    return [this.lox + fx, this.loy + fy];
  }
  localToWorld(lx, ly) { return this.fromFlat(lx - this.lox, ly - this.loy); }
  /** World -> screen (CSS px), through the tilt like the CSS transform does. */
  toScreen(x, y) {
    const [fx, fy] = this.flat(x, y);
    const k = this.depthAt(fy);
    return [this.w * this.ax + fx * k, this.h * this.ay + fy * Math.cos(this.tilt) * k];
  }
  toWorld(px, py) {
    const sx = px - this.w * this.ax, sy = py - this.h * this.ay;
    if (!this.tilt) return this.fromFlat(sx, sy);
    const sa = Math.sin(this.tilt) / this.persp;
    const fy = sy / Math.max(0.05, Math.cos(this.tilt) + sy * sa); // above the horizon: clamp
    return this.fromFlat(sx * (1 - fy * sa), fy);
  }
  /** Screen rotation of an arrow drawn pointing up, for a world heading (radians). */
  screenAngle(x, y, ang) {
    if (!this.tilt) return this.rot - ang;
    const d = 20 / this.scale;
    const [x0, y0] = this.toScreen(x, y);
    const [x1, y1] = this.toScreen(x - Math.sin(ang) * d, y - Math.cos(ang) * d);
    return Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
  }
  /** World bbox of the map canvas, plus a margin (CSS px). */
  bbox(marginPx = 0) {
    const m = marginPx;
    const pts = [[-m, -m], [this.lw + m, -m], [this.lw + m, this.lh + m], [-m, this.lh + m]].map(([x, y]) => this.localToWorld(x, y));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  /**
   * Map canvas frame. Flat: the screen. Tilted: big enough to fill the screen
   * at any tilt up to maxTilt (the far side spreads wider and higher).
   */
  layout(maxTilt) {
    const { w, h, ax, ay } = this;
    if (!maxTilt) { this.lw = w; this.lh = h; this.lox = w * ax; this.loy = h * ay; return; }
    const ca = Math.cos(maxTilt), sa = Math.sin(maxTilt) / this.persp;
    // Nothing to draw under the opaque horizon band.
    const top = -(ay - this.horizon) * h, bottom = (1 - ay) * h;
    const yTop = top / Math.max(0.05, ca + top * sa);
    const yBottom = Math.max(bottom, bottom / (ca + bottom * sa));
    const spread = 1 - yTop * sa; // widening of the top edge
    const m = 8;
    this.lox = ax * w * spread + m;
    this.lw = w * spread + 2 * m;
    this.loy = -yTop + m;
    this.lh = this.loy + yBottom + m;
  }
}

export class Renderer {
  /** canvas: the map (tilted in 3D); overlay: labels, icons and markers, never tilted. */
  constructor(canvas, overlay, store) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.mapCtx = this.ctx = canvas.getContext('2d', { alpha: false });
    this.octx = overlay.getContext('2d');
    this.store = store;
    this.dpr = 1;
    this.mdpr = 1;
    this.theme = THEMES.dark;
    this.frameKey = '';
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = window.innerWidth, h = window.innerHeight;
    this.overlay.width = Math.round(w * this.dpr);
    this.overlay.height = Math.round(h * this.dpr);
    this.frameKey = '';
    return [w, h];
  }

  /** Sizes and tilts the map canvas for this frame (see View.layout). */
  layout(view, maxTilt) {
    view.layout(maxTilt);
    // The tilted canvas is several screens big: cap its resolution.
    this.mdpr = maxTilt ? Math.min(this.dpr, 1.5) : this.dpr;
    const key = [view.lw, view.lh, view.lox, view.loy, view.w, view.h, view.ax, view.ay, this.mdpr].map((n) => Math.round(n * 100)).join();
    const st = this.canvas.style;
    if (key !== this.frameKey) {
      this.frameKey = key;
      this.canvas.width = Math.round(view.lw * this.mdpr);
      this.canvas.height = Math.round(view.lh * this.mdpr);
      st.left = `${view.w * view.ax - view.lox}px`;
      st.top = `${view.h * view.ay - view.loy}px`;
      st.width = `${view.lw}px`;
      st.height = `${view.lh}px`;
      st.transformOrigin = `${view.lox}px ${view.loy}px`;
      this.cache = null;
    }
    const tf = view.tilt ? `perspective(${view.persp}px) rotateX(${view.tilt}rad)` : 'none';
    if (this.lastTf !== tf) { this.lastTf = tf; st.transform = tf; }
  }

  /**
   * scene: { truck: {x, y, h} | null, trail: [[x,y]...], dest: [x,y] | null, source: [x,y] | null,
   *          opts: {pois, companies, shields, trail} }
   */
  draw(view, scene) {
    const { theme, store, dpr } = this;
    const ctx = this.ctx = this.mapCtx;
    const q = store.q || 2;
    this.needsRedraw = false;
    ctx.setTransform(this.mdpr, 0, 0, this.mdpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, view.lw, view.lh);
    const o = this.octx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
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

    // Routes: only the part on screen, thinned to what the zoom can show.
    const routeBox = view.bbox(60), routeTol = 0.6 / view.scale;

    // Friends' routes (dashed, their color), under ours.
    if (scene.opts.peerRoutes && scene.peers?.length) {
      const w = Math.max(4 * q, px(3.5));
      for (const peer of scene.peers) {
        if (!peer.route?.active || peer.hideRoute) continue;
        const r = peer.route.path(q, routeBox, routeTol);
        // Dark underlay so the dashes read on top of amber highways.
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(10,12,16,0.7)';
        ctx.lineWidth = w + px(3);
        ctx.stroke(r.path);
        // Dashes anchored on the road: they do not slide with the truck.
        ctx.setLineDash([px(10), px(6)]);
        ctx.lineDashOffset = r.start % px(16);
        ctx.strokeStyle = peer.color;
        ctx.lineWidth = w;
        ctx.stroke(r.path);
      }
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }

    // GPS route, on the road, under the trail and markers.
    if (scene.route?.active) {
      const r = scene.route.path(q, routeBox, routeTol);
      const w = Math.max(7 * q, px(5));
      for (const [color, width] of [[theme.routeEdge, w + px(2.5)], [theme.route, w]]) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke(r.path);
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

    // Screen-space layers, on the overlay (upright even in 3D).
    this.ctx = o;
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (view.tilt) this.drawHorizon(view);
    const placed = this.markerBoxes(view, scene);
    if (view.scale >= 0.06) this.drawPois(view, bbox, scene.opts, placed);
    this.drawLabels(view, placed);
    if (scene.source) this.drawPin(view, scene.source, theme.source, false);
    if (scene.dest) this.drawPin(view, scene.dest, theme.dest, true);
    for (const peer of scene.peers ?? []) this.drawPeer(view, peer);
    if (scene.truck) this.drawTruck(view, scene.truck);
    if (scene.dest && scene.truck) this.drawEdgeArrow(view, scene.dest, scene.truck, theme.dest, null, scene.roadScale);
    const me = scene.truck ?? { x: view.cx, y: view.cy };
    // Off screen: name, distance in the game's kilometers, speed.
    for (const peer of scene.peers ?? []) this.drawEdgeArrow(view, [peer.x, peer.y], me, peer.color, peer.name, scene.roadScale, `${kmhOf(peer)} km/h`);
    this.ctx = this.mapCtx;
  }

  /** 3D: the far side of the map fades out like a horizon. */
  drawHorizon(view) {
    const { ctx, theme } = this;
    const k = Math.min(1, view.tilt / 0.6);
    const solid = view.h * view.horizon * k, end = solid + view.h * 0.17 * k;
    if (end < 1) return;
    const g = ctx.createLinearGradient(0, 0, 0, end);
    g.addColorStop(0, theme.bg);
    g.addColorStop(solid / end, theme.bg);
    g.addColorStop(1, hexAlpha(theme.bg, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.w, end);
  }

  worldTransform(ctx, view, offX = 0, offY = 0) {
    const q = this.store.q || 2;
    const k = view.scale / q;
    ctx.setTransform(this.mdpr, 0, 0, this.mdpr, 0, 0);
    ctx.translate(view.lox + offX, view.loy + offY);
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
    this.drawLand(ctx, view, bbox, px);
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
    const { store, theme } = this;
    const dpr = this.mdpr;
    const margin = Math.round(Math.max(view.lw, view.lh) * 0.5);
    let c = this.cache;
    // Where the cached center lands on screen now.
    let off = c ? view.toLocal(c.cx, c.cy) : null;
    const now = performance.now();
    if (view.scale !== this.lastScale) { this.lastScale = view.scale; this.lastScaleChange = now; }
    const sameFrame = c && c.rot === view.rot && c.theme === theme && c.w === view.lw && c.h === view.lh && c.lox === view.lox && c.loy === view.loy;
    const valid = sameFrame && c.scale === view.scale && c.version === store.version &&
      Math.abs(off[0] - view.lox) < margin * 0.9 && Math.abs(off[1] - view.loy) < margin * 0.9;
    // While a pinch/wheel zoom is in progress, stretch the old image instead of
    // re-rendering every frame; redraw sharp once the zoom settles.
    const ratio = c ? view.scale / c.scale : 1;
    if (!valid && sameFrame && now - this.lastScaleChange < 160 && ratio > 0.4 && ratio < 2.5) {
      const ctx = this.ctx;
      const ax = c.margin + c.lox, ay = c.margin + c.loy;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.cacheCanvas,
        (off[0] - ax * ratio) * dpr, (off[1] - ay * ratio) * dpr,
        this.cacheCanvas.width * ratio, this.cacheCanvas.height * ratio);
      this.needsRedraw = true;
      return;
    }
    if (!valid) {
      if (!this.cacheCanvas) this.cacheCanvas = document.createElement('canvas');
      const cw = Math.round((view.lw + margin * 2) * dpr), ch = Math.round((view.lh + margin * 2) * dpr);
      if (this.cacheCanvas.width !== cw || this.cacheCanvas.height !== ch) {
        this.cacheCanvas.width = cw;
        this.cacheCanvas.height = ch;
      }
      const cctx = this.cacheCanvas.getContext('2d');
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, cw, ch);
      // Same view, but with a margin all around.
      const big = Object.assign(Object.create(Object.getPrototypeOf(view)), view, {
        lw: view.lw + margin * 2, lh: view.lh + margin * 2,
        lox: view.lox + margin, loy: view.loy + margin,
      });
      this.worldTransform(cctx, big);
      this.drawBase(cctx, big, big.bbox(20));
      c = this.cache = { cx: view.cx, cy: view.cy, scale: view.scale, rot: view.rot, version: store.version, theme, w: view.lw, h: view.lh, lox: view.lox, loy: view.loy, margin };
      off = view.toLocal(c.cx, c.cy);
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.cacheCanvas,
      Math.round((off[0] - view.lox - c.margin) * dpr),
      Math.round((off[1] - view.loy - c.margin) * dpr));
  }

  /** Land, lakes and country borders under the roads. */
  drawLand(ctx, view, bbox, px) {
    const b = this.store.baseMap;
    if (!b) return;
    let parts;
    if (view.scale < OVERVIEW_BELOW) parts = [b.overview];
    else {
      parts = [];
      for (let tx = Math.floor(bbox[0] / b.cell); tx <= Math.floor(bbox[2] / b.cell); tx++)
        for (let ty = Math.floor(bbox[1] / b.cell); ty <= Math.floor(bbox[3] / b.cell); ty++) {
          const c = b.cells.get(`${tx}_${ty}`);
          if (c) parts.push(c);
        }
    }
    ctx.fillStyle = this.theme.land;
    for (const p of parts) ctx.fill(p.land);
    ctx.fillStyle = this.theme.bg;
    for (const p of parts) ctx.fill(p.lakes);
    ctx.strokeStyle = this.theme.border;
    ctx.lineWidth = px(view.scale < OVERVIEW_BELOW ? 1.2 : 1.5);
    ctx.setLineDash(view.scale < OVERVIEW_BELOW ? [] : [px(7), px(4)]);
    for (const p of parts) ctx.stroke(p.borders);
    ctx.setLineDash([]);
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
        if (view.tilt && view.depth(p.x, p.y) < 0.6) continue; // far side: clutter
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

  /** Screen boxes of the truck, pins and friends: labels must not cover them. */
  markerBoxes(view, scene) {
    const boxes = [];
    const add = (pos, l, t, r, b) => {
      if (!pos) return;
      const [x, y] = view.toScreen(pos[0], pos[1]);
      boxes.push([x - l, y - t, x + r, y + b]);
    };
    if (scene.truck) add([scene.truck.x, scene.truck.y], 24, 24, 24, 24);
    if (scene.dest) add(scene.dest, 14, 38, 14, 4);
    if (scene.source) add(scene.source, 12, 30, 12, 4);
    for (const p of scene.peers ?? []) add([p.x, p.y], 40, 18, 40, 38);
    return boxes;
  }

  drawLabels(view, placed) {
    const { ctx, store, theme } = this;
    const s = view.scale;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';


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

    // Countries when zoomed out, wherever cities left room.
    if (s < 0.012) {
      ctx.font = '600 12px system-ui, sans-serif';
      for (const c of store.countries) {
        const [x, y] = view.toScreen(c.x, c.y);
        if (x < -100 || y < -20 || x > view.w + 100 || y > view.h + 20) continue;
        const text = countryFr(c.name).toUpperCase();
        const wdt = ctx.measureText(text).width;
        const box = [x - wdt / 2 - 4, y - 10, x + wdt / 2 + 4, y + 10];
        if (collides(placed, box)) continue;
        placed.push(box);
        ctx.strokeStyle = theme.labelHalo;
        ctx.lineWidth = 3;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = theme.country;
        ctx.fillText(text, x, y);
      }
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
    ctx.rotate(view.screenAngle(peer.x, peer.y, peer.h * Math.PI * 2));
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
    // Name and speed under the arrow, always upright.
    ctx.font = '700 12px system-ui, sans-serif';
    const tag = `${peer.name} · ${kmhOf(peer)} km/h`;
    const w = ctx.measureText(tag).width + 14;
    ctx.fillStyle = peer.color;
    roundRect(ctx, -w / 2, 17, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(tag, 0, 26.5);
    ctx.restore();
  }

  drawTruck(view, truck) {
    const { ctx, theme } = this;
    const [x, y] = view.toScreen(truck.x, truck.y);
    // Screen angle of the truck's forward vector.
    const ang = truck.h * Math.PI * 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(view.screenAngle(truck.x, truck.y, ang));
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
  // Distances are straight lines, in the game's kilometers (map meters x roadScale).
  drawEdgeArrow(view, dest, truck, color, name, roadScale = 19, extra = null) {
    const { ctx, theme } = this;
    const [dx, dy] = view.toScreen(dest[0], dest[1]);
    // Free map area between the HUD panels (computed by the app from the layout).
    const ins = view.insets ?? { left: 34, top: 184, right: 94, bottom: 144 };
    const left = ins.left, right = view.w - ins.right, top = ins.top, bottom = view.h - ins.bottom;
    // Only for targets really off screen.
    if (dx >= 20 && dy >= 20 && dx <= view.w - 20 && dy <= view.h - 20) return;
    // From the truck, or from the middle of the free area if the truck is off it.
    let [tx, ty] = view.toScreen(truck.x, truck.y);
    if (!(tx >= left && tx <= right && ty >= top && ty <= bottom)) { tx = (left + right) / 2; ty = (top + bottom) / 2; }
    const ang = Math.atan2(dy - ty, dx - tx);
    // Intersect ray from truck with the free area.
    const c = Math.cos(ang), s = Math.sin(ang);
    let t = Infinity;
    if (c > 0) t = Math.min(t, (right - tx) / c);
    if (c < 0) t = Math.min(t, (left - tx) / c);
    if (s > 0) t = Math.min(t, (bottom - ty) / s);
    if (s < 0) t = Math.min(t, (top - ty) / s);
    if (!isFinite(t) || t < 0) return;
    const ex = tx + c * t, ey = ty + s * t;
    const distKm = (Math.hypot(dest[0] - truck.x, dest[1] - truck.y) * roadScale) / 1000;
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
    const label = [name, km, extra].filter(Boolean).join(' · ');
    const lx = ex - c * 30, ly = ey - s * 22;
    ctx.strokeStyle = theme.labelHalo;
    ctx.lineWidth = 3.5;
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = color;
    ctx.fillText(label, lx, ly);
  }
}

const kmhOf = (peer) => Math.round(Math.abs(peer.spd ?? 0) * 3.6);

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

/** '#rrggbb' -> 'rgba(r,g,b,a)'. */
function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
