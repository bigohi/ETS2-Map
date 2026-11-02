// ETS2-Map phone app: live telemetry + map + HUD.
import { MapStore } from './mapdata.js';
import { Renderer, View, THEMES } from './renderer.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Settings (persisted).

const DEFAULTS = { night: true, pois: true, companies: true, shields: true, trail: true, autozoom: true, awake: true, headingUp: true, zoomBias: 0 };
const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ets2map.settings') || '{}') };
const saveSettings = () => localStorage.setItem('ets2map.settings', JSON.stringify(settings));

// ---------------------------------------------------------------------------
// Core objects.

const canvas = $('map');
const store = new MapStore('map/');
const renderer = new Renderer(canvas, store);
const view = new View();
let dirty = true;
store.onTileLoaded = () => { dirty = true; };

const state = {
  telemetry: null,         // last packet
  status: { connected: false },
  samples: [],             // [{t, x, y, h, spd}] for interpolation
  truck: null,             // interpolated {x, y, h}
  follow: true,
  trail: JSON.parse(sessionStorage.getItem('ets2map.trail') || '[]'),
  dest: null, source: null, jobKey: '',
  mapError: null,
  lastStreamAt: 0,
  manualScale: 0.3,        // when not following
  smoothScale: null,
};

// ---------------------------------------------------------------------------
// Telemetry stream (Server-Sent Events).

function connect() {
  const es = new EventSource('api/stream');
  es.addEventListener('t', (e) => onTelemetry(JSON.parse(e.data)));
  es.addEventListener('status', (e) => { state.status = JSON.parse(e.data); state.lastStreamAt = performance.now(); updateBanner(); });
  es.onopen = () => { state.lastStreamAt = performance.now(); updateBanner(); };
  es.onerror = () => { state.status = { connected: false, serverDown: true }; updateBanner(); };
}

function onTelemetry(t) {
  state.telemetry = t;
  state.lastStreamAt = performance.now();
  state.status.connected = true;
  state.status.serverDown = false;
  const now = performance.now();
  const last = state.samples[state.samples.length - 1];
  const sample = { t: now, x: t.x, y: t.z, h: t.h, spd: t.spd, paused: t.paused };
  // Teleport (new profile, ferry, train, job reset): drop interpolation + trail.
  if (last && Math.hypot(sample.x - last.x, sample.y - last.y) > 800) {
    state.samples = [];
    state.trail = [];
  }
  // Ignore all-zero positions sent before the truck spawns.
  if (t.x === 0 && t.z === 0) return updateHud();
  state.samples.push(sample);
  if (state.samples.length > 20) state.samples.shift();
  addTrailPoint(sample.x, sample.y);
  updateJob();
  updateHud();
  dirty = true;
}

// Render 100 ms in the past so we can interpolate between two real samples.
const INTERP_DELAY = 110;
function interpolatedTruck(now) {
  const s = state.samples;
  if (!s.length) return null;
  const rt = now - INTERP_DELAY;
  if (s.length === 1 || rt <= s[0].t) return { x: s[0].x, y: s[0].y, h: s[0].h };
  for (let i = s.length - 1; i > 0; i--) {
    const a = s[i - 1], b = s[i];
    if (rt >= a.t && rt <= b.t) {
      const f = (rt - a.t) / Math.max(1, b.t - a.t);
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: lerpTurn(a.h, b.h, f) };
    }
  }
  // Past the newest sample: extrapolate a little along the heading.
  const b = s[s.length - 1];
  if (b.paused) return { x: b.x, y: b.y, h: b.h };
  const dt = Math.min(0.35, (rt - b.t) / 1000);
  const ang = b.h * Math.PI * 2;
  return { x: b.x - Math.sin(ang) * b.spd * dt, y: b.y - Math.cos(ang) * b.spd * dt, h: b.h };
}
function lerpTurn(a, b, f) {
  let d = b - a;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return (a + d * f + 1) % 1;
}

function addTrailPoint(x, y) {
  const tr = state.trail;
  const last = tr[tr.length - 1];
  if (last && Math.hypot(x - last[0], y - last[1]) < 15) return;
  tr.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  if (tr.length > 4000) tr.splice(0, tr.length - 4000);
  if (tr.length % 20 === 0) sessionStorage.setItem('ets2map.trail', JSON.stringify(tr));
}

function updateJob() {
  const job = state.telemetry?.job;
  const key = job ? `${job.srcId}/${job.srcCoId}>${job.dstId}/${job.dstCoId}` : '';
  if (key === state.jobKey || !store.meta) return;
  state.jobKey = key;
  const near = state.samples.length ? [state.samples.at(-1).x, state.samples.at(-1).y] : null;
  state.dest = job ? store.companyPos(job.dstId, job.dstCoId, near) : null;
  state.source = job ? store.companyPos(job.srcId, job.srcCoId, near) : null;
}

// ---------------------------------------------------------------------------
// HUD.

const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const fmtClock = (min) => `${DAYS[Math.floor(min / 1440) % 7]} ${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
const fmtDur = (min) => {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
};
const fmtKm = (m) => (m < 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`);
const fmtMoney = (n) => `${Number(n).toLocaleString('fr-FR')} €`;

function updateHud() {
  const t = state.telemetry;
  if (!t) return;

  // Speed cluster.
  const kmh = Math.round(Math.abs(t.spd) * 3.6);
  const limit = Math.round(t.lim * 3.6);
  $('speed-val').textContent = kmh;
  $('speed-val').classList.toggle('over', limit > 0 && kmh > limit + 2);
  $('limit').classList.toggle('hidden', !(limit > 0));
  $('limit-val').textContent = limit;
  const cc = Math.round(t.cc * 3.6);
  $('cruise').classList.toggle('hidden', !(cc > 0));
  $('cruise-val').textContent = cc;
  $('gear').textContent = t.gear > 0 ? `${t.gear}` : t.gear < 0 ? `R${-t.gear}` : 'N';

  // Info strip.
  const cap = t.truck?.fuelCap || 0;
  const pct = cap ? Math.max(0, Math.min(1, t.fuel / cap)) : 0;
  $('fuel-bar').style.width = `${pct * 100}%`;
  $('fuel-bar').classList.toggle('low', pct < 0.15);
  $('fuel-val').textContent = t.range > 0 ? `${Math.round(t.range)} km` : `${Math.round(t.fuel)} L`;
  $('rest-val').textContent = t.rest > 0 ? fmtDur(t.rest) : t.rest < 0 ? 'Repos !' : '—';
  $('rest-val').classList.toggle('tired', t.rest < 120);
  $('clock-val').textContent = t.gt ? fmtClock(t.gt) : '—';

  // Job / navigation card.
  const job = t.job;
  const hasNav = t.nd > 1;
  $('job').classList.toggle('hidden', !job && !hasNav);
  if (job) {
    $('job-title').textContent = `${job.dst}${job.dstCo ? ' · ' + job.dstCo : ''}`;
    const parts = [job.cargo];
    if (job.mass) parts.push(`${(job.mass / 1000).toFixed(1).replace('.0', '')} t`);
    if (job.income) parts.push(fmtMoney(job.income));
    if (job.src) parts.push(`depuis ${job.src}`);
    $('job-sub').textContent = parts.filter(Boolean).join(' · ');
  } else {
    $('job-title').textContent = 'Itinéraire GPS';
    $('job-sub').textContent = '';
  }
  $('nav-dist').textContent = hasNav ? fmtKm(t.nd) : '—';
  $('nav-time').textContent = hasNav && t.nt > 0 ? fmtDur(t.nt / 60) : '—';
  $('nav-eta').textContent = hasNav && t.nt > 0 && t.gt ? fmtClock(t.gt + t.nt / 60) : '—';
  const dl = $('deadline');
  if (job && job.deliv && t.gt && job.deliv < 0xfffffff0) {
    const left = job.deliv - t.gt;
    dl.textContent = left >= 0 ? fmtDur(left) : `+${fmtDur(-left)}`;
    dl.classList.toggle('late', left < 0 || (t.nt > 0 && left < t.nt / 60));
    dl.classList.toggle('tight', left >= 0 && t.nt > 0 && left < (t.nt / 60) * 1.15 && left >= t.nt / 60);
    $('deadline-box').classList.remove('hidden');
  } else {
    $('deadline-box').classList.add('hidden');
  }
}

function updateBanner() {
  const b = $('banner');
  let text = '';
  if (state.mapError) text = state.mapError;
  else if (state.status.serverDown) text = 'Serveur injoignable…';
  else if (!state.status.connected) text = state.telemetry ? 'Jeu déconnecté' : 'En attente du jeu…';
  else if (state.telemetry?.paused) text = 'Jeu en pause';
  b.textContent = text;
  b.classList.toggle('hidden', !text);
}
setInterval(() => {
  // No packet for 3 s while the stream is alive = game closed or plugin missing.
  if (state.telemetry && performance.now() - state.lastStreamAt > 6000) state.status.connected = false;
  updateBanner();
}, 1000);

// ---------------------------------------------------------------------------
// Camera.

// Meters visible across the short side of the screen, by speed (km/h).
const ZOOM_CURVE = [[0, 260], [20, 320], [40, 520], [60, 750], [80, 1000], [100, 1250], [130, 1600]];
function autoScale(kmh, shortSide) {
  let meters = ZOOM_CURVE[ZOOM_CURVE.length - 1][1];
  for (let i = 1; i < ZOOM_CURVE.length; i++) {
    const [s0, m0] = ZOOM_CURVE[i - 1], [s1, m1] = ZOOM_CURVE[i];
    if (kmh <= s1) { meters = m0 + ((m1 - m0) * (kmh - s0)) / (s1 - s0); break; }
  }
  return shortSide / meters;
}

let lastFrame = performance.now();
function updateCamera(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const truck = state.truck;
  if (state.follow && truck) {
    view.cx = truck.x;
    view.cy = truck.y;
    // Landscape: the job card sits on the left, so keep the truck right of center.
    const landscape = view.w > view.h * 1.2;
    view.ax = landscape ? 0.62 : 0.5;
    view.ay = settings.headingUp ? (landscape ? 0.7 : 0.66) : 0.52;
    const targetRot = settings.headingUp ? truck.h * Math.PI * 2 : 0;
    view.rot = approachAngle(view.rot, targetRot, dt, 6);
    const kmh = Math.abs(state.telemetry?.spd ?? 0) * 3.6;
    const base = settings.autozoom ? autoScale(kmh, Math.min(view.w, view.h)) : Math.min(view.w, view.h) / 600;
    const target = base * Math.pow(2, settings.zoomBias);
    state.smoothScale = state.smoothScale == null ? target : state.smoothScale + (target - state.smoothScale) * Math.min(1, dt * 1.2);
    view.scale = state.smoothScale;
  } else if (!settings.headingUp && view.rot !== 0) {
    view.rot = approachAngle(view.rot, 0, dt, 8);
  }
  $('compass').style.transform = `rotate(${(view.rot * 180) / Math.PI}deg)`;
}
function approachAngle(cur, target, dt, speed) {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) < 0.0005) return target;
  return cur + d * Math.min(1, dt * speed);
}

function setFollow(on) {
  state.follow = on;
  $('btn-recenter').classList.toggle('hidden', on);
  if (on) state.smoothScale = view.scale;
  dirty = true;
}

function zoomAt(factor, px, py) {
  if (state.follow) {
    settings.zoomBias = Math.max(-6, Math.min(3, settings.zoomBias + Math.log2(factor)));
    saveSettings();
  } else {
    const [wx, wy] = view.toWorld(px ?? view.w / 2, py ?? view.h / 2);
    view.scale = clampScale(view.scale * factor);
    // keep (wx, wy) under the finger
    const [nx, ny] = view.toWorld(px ?? view.w / 2, py ?? view.h / 2);
    view.cx += wx - nx;
    view.cy += wy - ny;
  }
  dirty = true;
}
const clampScale = (s) => Math.max(0.0015, Math.min(12, s));

function fitOverview() {
  const pts = [];
  if (state.truck) pts.push([state.truck.x, state.truck.y]);
  if (state.dest) pts.push(state.dest);
  if (pts.length < 2 && store.meta) {
    const b = store.meta.bounds;
    pts.push([b[0], b[1]], [b[2], b[3]]);
  }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  setFollow(false);
  view.rot = 0;
  view.ax = 0.5; view.ay = 0.5;
  view.cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  view.cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const w = Math.max(500, Math.max(...xs) - Math.min(...xs)) * 1.25;
  const h = Math.max(500, Math.max(...ys) - Math.min(...ys)) * 1.25;
  view.scale = clampScale(Math.min((view.w - 40) / w, (view.h - 260) / h));
  dirty = true;
}

// ---------------------------------------------------------------------------
// Gestures: drag to pan, pinch to zoom, double tap to zoom in, wheel.

const pointers = new Map();
let gesture = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  startGesture();
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (!gesture) return;
  const pts = [...pointers.values()];
  if (pts.length === 1 && gesture.n === 1) {
    const [x, y] = pts[0];
    if (!gesture.moved && Math.hypot(x - gesture.x, y - gesture.y) < 8) return;
    if (!gesture.moved) {
      gesture.moved = true;
      if (state.follow) {
        // Leave follow mode where we are, anchored at screen center.
        const [cx, cy] = view.toWorld(view.w / 2, view.h / 2);
        view.cx = cx; view.cy = cy; view.ax = 0.5; view.ay = 0.5;
        setFollow(false);
      }
      gesture.world = view.toWorld(x, y);
    }
    const [nx, ny] = view.toWorld(x, y);
    view.cx += gesture.world[0] - nx;
    view.cy += gesture.world[1] - ny;
    dirty = true;
  } else if (pts.length >= 2 && gesture.n >= 2) {
    const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
    const factor = d / gesture.d;
    gesture.d = d;
    zoomAt(factor, state.follow ? undefined : mx, state.follow ? undefined : my);
    if (!state.follow) {
      const [nx, ny] = view.toWorld(mx, my);
      const [ox, oy] = view.toWorld(gesture.mx, gesture.my);
      view.cx += ox - nx;
      view.cy += oy - ny;
    }
    gesture.mx = mx; gesture.my = my;
  }
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (gesture && !gesture.moved && gesture.n === 1 && pointers.size === 0) {
    const now = performance.now();
    if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      zoomAt(2, e.clientX, e.clientY);
      lastTap.t = 0;
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
  startGesture();
};
let lastTap = { t: 0, x: 0, y: 0 };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
function startGesture() {
  const pts = [...pointers.values()];
  if (!pts.length) { gesture = null; return; }
  if (pts.length === 1) gesture = { n: 1, x: pts[0][0], y: pts[0][1], moved: gesture?.moved && gesture.n > 1, world: view.toWorld(pts[0][0], pts[0][1]) };
  else {
    const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
    gesture = { n: 2, d: Math.max(10, Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1])), mx, my, moved: true };
  }
}
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(Math.pow(2, -e.deltaY / 400), e.clientX, e.clientY);
}, { passive: false });

// ---------------------------------------------------------------------------
// Buttons + settings.

$('btn-zoom-in').onclick = () => zoomAt(1.6);
$('btn-zoom-out').onclick = () => zoomAt(1 / 1.6);
$('btn-rotate').onclick = () => {
  settings.headingUp = !settings.headingUp;
  saveSettings();
  if (settings.headingUp && !state.follow) setFollow(true);
  dirty = true;
};
$('btn-fit').onclick = () => fitOverview();
$('btn-recenter').onclick = () => setFollow(true);
$('btn-menu').onclick = () => $('settings').showModal();
$('btn-clear-trail').onclick = () => { state.trail = []; sessionStorage.removeItem('ets2map.trail'); dirty = true; };
$('btn-fullscreen').onclick = () => {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: 'hide' });
};

const toggles = { 'set-night': 'night', 'set-pois': 'pois', 'set-companies': 'companies', 'set-shields': 'shields', 'set-trail': 'trail', 'set-autozoom': 'autozoom', 'set-awake': 'awake' };
for (const [id, key] of Object.entries(toggles)) {
  const el = $(id);
  el.checked = !!settings[key];
  el.onchange = () => {
    settings[key] = el.checked;
    saveSettings();
    applyTheme();
    if (key === 'awake') keepAwake();
    dirty = true;
  };
}

function applyTheme() {
  document.body.classList.toggle('theme-dark', settings.night);
  document.body.classList.toggle('theme-light', !settings.night);
  renderer.theme = settings.night ? THEMES.dark : THEMES.light;
  document.querySelector('meta[name=theme-color]').content = renderer.theme.bg;
  dirty = true;
}

// ---------------------------------------------------------------------------
// Keep the screen on. Wake Lock needs HTTPS (or localhost); on plain LAN HTTP
// we fall back to a tiny looping muted video from a canvas stream.

let wakeLock = null;
async function keepAwake() {
  if (!settings.awake) {
    wakeLock?.release?.();
    wakeLock = null;
    $('keepawake').pause();
    return;
  }
  try {
    if ('wakeLock' in navigator && window.isSecureContext) {
      wakeLock = await navigator.wakeLock.request('screen');
      return;
    }
  } catch { /* fall through */ }
  try {
    const v = $('keepawake');
    if (!v.srcObject) {
      const c = document.createElement('canvas');
      c.width = c.height = 2;
      const g = c.getContext('2d');
      setInterval(() => { g.fillStyle = `rgb(${Math.random() * 255},0,0)`; g.fillRect(0, 0, 2, 2); }, 1000);
      v.srcObject = c.captureStream(1);
    }
    await v.play();
  } catch { /* best effort */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
document.addEventListener('pointerdown', () => keepAwake(), { once: true });

// ---------------------------------------------------------------------------
// Main loop.

function resize() {
  const [w, h] = renderer.resize();
  view.w = w;
  view.h = h;
  dirty = true;
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

function frame(now) {
  state.truck = interpolatedTruck(now);
  const moving = state.samples.length && !state.telemetry?.paused;
  updateCamera(now);
  if (dirty || moving || gesture || renderer.needsRedraw) {
    renderer.draw(view, {
      truck: state.truck,
      trail: state.trail,
      dest: state.dest,
      source: state.source,
      opts: settings,
    });
    dirty = false;
  }
  requestAnimationFrame(frame);
}

async function start() {
  applyTheme();
  resize();
  $('btn-recenter').classList.add('hidden');
  try {
    const meta = await store.init();
    // Start somewhere sensible before the first packet: the map center.
    const b = meta.bounds;
    view.cx = (b[0] + b[2]) / 2;
    view.cy = (b[1] + b[3]) / 2;
    view.scale = Math.min(view.w / (b[2] - b[0]), view.h / (b[3] - b[1]));
    $('about').textContent = `Carte ${meta.gameVersion ?? ''} · ${Object.keys(meta.tiles).length} tuiles · générée le ${new Date(meta.bakedAt).toLocaleDateString('fr-FR')}`;
  } catch {
    state.mapError = 'Carte absente : lance "npm run map" sur le PC';
  }
  updateBanner();
  connect();
  requestAnimationFrame(frame);
}
start();

// Debug hook for automated checks.
window.__ets2map = { state, view, settings, store, renderer };
