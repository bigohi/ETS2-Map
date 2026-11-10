// ETS2-Map phone app: live telemetry + map + HUD.
import { MapStore } from './mapdata.js';
import { Renderer, View, THEMES } from './renderer.js';
import { RouteView } from './route.js';
import { ConvoyView, Clock } from './convoy.js';
import { WebConvoy } from './mqtt-ws.js';
import { countryFr } from './countries.js';
import { latin, hasForeign } from './latin.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Settings (persisted).

const DEFAULTS = { hiddenRoutes: [], peerRoutes: true, route: true, night: true, pois: true, companies: true, shields: true, trail: true, turns: true, autozoom: true, awake: true, headingUp: true, view3d: false, zoomBias: 0 };
const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ets2map.settings') || '{}') };
const saveSettings = () => localStorage.setItem('ets2map.settings', JSON.stringify(settings));

// ---------------------------------------------------------------------------
// Core objects.

const canvas = $('map');
const store = new MapStore('map/');
// Gestures land on the overlay: always screen-sized, even when the map is tilted.
const surface = $('overlay');
const renderer = new Renderer(canvas, surface, store);
// 3D view: map tilted back like a car GPS, only while following the truck.
const TILT_3D = 1.0; // radians (57°)
const view = new View();
const route = new RouteView();
const convoy = new ConvoyView();
let peers = [];   // friends' smoothed positions for the current frame

// Why a PC sends no truck (server/game-check.js), as shown to the convoy.
const WHY = {
  'no-game': 'ETS2 pas lancé',
  'no-plugin': 'Plugin absent : relancer « 1 - Installer le plugin », ETS2 fermé',
  restart: 'Plugin installé pendant le jeu : redémarrer ETS2',
  'not-loaded': 'ETS2 n\'a pas chargé le plugin : redémarrer ETS2, OK sur « SDK »',
  menu: 'Dans les menus : charger le profil et prendre la route',
  'no-data': 'Plugin chargé mais rien n\'arrive : fermer les autres fenêtres ETS2 Map',
};

let dirty = true;
store.onTileLoaded = () => { dirty = true; };

const state = {
  telemetry: null,         // last packet
  status: { connected: false },
  samples: [],             // [{t, x, y, h, spd}] for interpolation
  truck: null,             // interpolated {x, y, h}
  follow: true,
  overview: false,         // fit view (always flat)
  userRot: false,          // turned by hand with two fingers: keep that rotation
  toNorth: false,          // compass tapped after a hand rotation: back to north
  trail: JSON.parse(sessionStorage.getItem('ets2map.trail') || '[]'),
  dest: null, source: null, jobKey: '',
  mapError: null,
  lastStreamAt: 0,
  manualScale: 0.3,        // when not following
  smoothScale: null,
  interval: 50, delay: 110, // ms between samples, ms rendered in the past
};

// ---------------------------------------------------------------------------
// Telemetry stream (Server-Sent Events).

function connect() {
  const es = new EventSource('api/stream');
  es.addEventListener('t', (e) => onTelemetry(JSON.parse(e.data)));
  es.addEventListener('route', (e) => { route.set(JSON.parse(e.data)); if (state.truck) route.update(state.truck.x, state.truck.y); updateHud(); dirty = true; });
  es.addEventListener('convoy', (e) => { convoy.info = JSON.parse(e.data); renderConvoy(); });
  es.addEventListener('peer', (e) => onPeerState(JSON.parse(e.data)));
  es.addEventListener('peerroute', (e) => { const m = JSON.parse(e.data); convoy.onRoute(m.id, m.route); updateHud(); dirty = true; });
  es.addEventListener('peerleave', (e) => { convoy.onLeave(JSON.parse(e.data).id); renderConvoy(); dirty = true; });
  es.addEventListener('status', (e) => { state.status = JSON.parse(e.data); state.lastStreamAt = performance.now(); updateBanner(); });
  es.onopen = () => { state.lastStreamAt = performance.now(); updateBanner(); };
  es.onerror = () => { state.status = { connected: false, serverDown: true }; updateBanner(); };
}

function onPeerState(p) {
  convoy.onPeer(p);
  scheduleConvoyRender();
  if (p.id === state.followPeer) updateHud();
}

const meClock = new Clock();
/** ts: when the PC sent it (online mode, the PC's clock); none on Wi-Fi. */
function onTelemetry(t, ts) {
  state.telemetry = t;
  state.lastStreamAt = performance.now();
  state.status.connected = true;
  state.status.serverDown = false;
  const now = meClock.stamp(ts, performance.now());
  const last = state.samples[state.samples.length - 1];
  if (last && now <= last.t) return; // out of order
  const sample = { t: now, x: t.x, y: t.z, h: t.h, spd: t.spd, paused: t.paused };
  // How far apart samples come: 50 ms on Wi-Fi, 250 ms through the convoy.
  if (last && !t.paused && now - last.t < 1000) state.interval += (now - last.t - state.interval) * 0.1;
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
  route.update(sample.x, sample.y);
  updateJob();
  updateHud();
  dirty = true;
}

// Render in the past so we can interpolate between two real samples: 110 ms
// on Wi-Fi, more when samples come further apart (online: 4 per second), else
// the truck runs out of samples, guesses ahead and jumps back.
function interpolatedTruck(now) {
  const s = state.samples;
  if (!s.length) return null;
  const want = Math.max(110, Math.min(700, state.interval * 1.6 + 30));
  state.delay += (want - state.delay) * 0.02;
  const rt = now - state.delay;
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

// Game time runs faster than real time: x19 on the road in ETS2 (local.scale
// from the SDK), x3 in cities. Durations are converted with the road scale.
let roadScale = 19;
const toReal = (gameMinutes) => gameMinutes / roadScale;
const fmtReal = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
function setReal(id, text) { $(id).textContent = text ?? ''; }
// A city name in Cyrillic or Greek (a friend's game in another language) takes
// our map's name; company names from the game are transliterated (latin.js).
const cityName = (name, id) => (hasForeign(name) ? store.meta?.cityNames?.[id] ?? latin(name) : name);

// The real clock ticks on its own, game or not.
setInterval(() => { setReal('clock-real', `${fmtReal(new Date())} réel`); updateHud(); }, 1000);
setReal('clock-real', `${fmtReal(new Date())} réel`);

/** Whose delivery the job card shows: the friend the camera follows, else ours. */
function hudSource() {
  const p = state.follow && state.followPeer ? convoy.peers.get(state.followPeer) : null;
  return p && !p.offline && p.last ? { t: p.last, route: p.route, peer: p } : { t: state.telemetry, route, peer: null };
}

function updateHud() {
  if (state.telemetry) updateDash(state.telemetry);
  const src = hudSource();
  if (src.t) updateJobCard(src);
  else $('job').classList.add('hidden');
  updateTurns(src);
}

function updateDash(t) {
  if (t.scale >= 10 && t.scale <= 60) roadScale = t.scale;

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
  setReal('rest-real', t.rest > 0 ? `≈ ${fmtDur(toReal(t.rest))} réel` : '');
  $('clock-val').textContent = t.gt ? fmtClock(t.gt) : '—';
}

// Job / navigation card.
function updateJobCard({ t, route, peer }) {
  const job = t.job;
  const who = $('job-who');
  who.classList.toggle('hidden', !peer);
  if (peer) { who.textContent = peer.name; who.style.background = peer.color; }
  // Distance/time: the game's GPS when it has one, else our own route.
  const ownRoute = route.active && !(t.nd > 1);
  const hasNav = t.nd > 1 || ownRoute;
  $('job').classList.toggle('hidden', !job && !hasNav && !peer);
  if (job) {
    $('job-title').textContent = `${cityName(job.dst, job.dstId)}${job.dstCo ? ' · ' + latin(job.dstCo) : ''}`;
    const parts = [latin(job.cargo)];
    if (job.mass) parts.push(`${(job.mass / 1000).toFixed(1).replace('.0', '')} t`);
    if (job.income) parts.push(fmtMoney(job.income));
    if (job.src) parts.push(`depuis ${cityName(job.src, job.srcId)}`);
    $('job-sub').textContent = parts.filter(Boolean).join(' · ');
  } else {
    $('job-title').textContent = latin(route.target?.label) ?? (hasNav ? 'Itinéraire GPS' : 'Conduite libre');
    $('job-sub').textContent = ownRoute ? 'Itinéraire calculé par ETS2 Map' : '';
  }
  if (ownRoute) {
    // Map meters to the game's kilometers (the map is 19 times smaller on the road).
    $('nav-dist').textContent = fmtKm(route.remaining() * roadScale);
    // Our estimate is real driving time: show the game equivalent under it.
    const realMin = route.remainingDuration() / 60;
    $('nav-time').textContent = `≈ ${fmtDur(realMin)}`;
    setReal('nav-time-real', 'réel');
    $('nav-eta').textContent = t.gt ? fmtClock(t.gt + realMin * roadScale) : '—';
    setReal('nav-eta-real', `réel ${fmtReal(new Date(Date.now() + realMin * 60000))}`);
  } else {
    $('nav-dist').textContent = hasNav ? fmtKm(t.nd) : '—';
    $('nav-time').textContent = hasNav && t.nt > 0 ? fmtDur(t.nt / 60) : '—';
    $('nav-eta').textContent = hasNav && t.nt > 0 && t.gt ? fmtClock(t.gt + t.nt / 60) : '—';
    const realMin = hasNav && t.nt > 0 ? toReal(t.nt / 60) : null;
    setReal('nav-time-real', realMin != null ? `≈ ${fmtDur(realMin)} réel` : '');
    setReal('nav-eta-real', realMin != null ? `réel ${fmtReal(new Date(Date.now() + realMin * 60000))}` : '');
  }
  const dl = $('deadline');
  if (job && job.deliv && t.gt && job.deliv < 0xfffffff0) {
    const left = job.deliv - t.gt;
    dl.textContent = left >= 0 ? fmtDur(left) : `+${fmtDur(-left)}`;
    setReal('deadline-real', left >= 0 ? `≈ ${fmtDur(toReal(left))} réel` : `+${fmtDur(toReal(-left))} réel`);
    dl.classList.toggle('late', left < 0 || (t.nt > 0 && left < t.nt / 60));
    dl.classList.toggle('tight', left >= 0 && t.nt > 0 && left < (t.nt / 60) * 1.15 && left >= t.nt / 60);
    $('deadline-box').classList.remove('hidden');
  } else {
    $('deadline-box').classList.add('hidden');
  }
}

// Next directions: what to do at the next junction, and the one after.
// Codes come from the PC (server/route.js TURN); 6 is the arrival.
const TURNS = {
  1: ['Tourner à gauche', 'turn', true], 2: ['Tourner à droite', 'turn', false],
  3: ['Serrer à gauche', 'keep', true], 4: ['Serrer à droite', 'keep', false],
  5: ['Prendre le ferry', 'ferry', false], 6: ['Arrivée', 'arrive', false], 7: ['Rester au milieu', 'straight', false],
};
const TURN_ICONS = {
  turn: '<path d="M7 21V11a3 3 0 0 1 3-3h8"/><path d="M14 4l4 4-4 4"/>',
  keep: '<path d="M9 21v-6l7-8"/><path d="M11 7h5v5"/>',
  straight: '<path d="M12 21V4"/><path d="M7 9l5-5 5 5"/>',
  ferry: '<path d="M3 15h18l-2.5 5h-13z"/><path d="M7 15v-5h10v5"/><path d="M12 10V5"/>',
  arrive: '<path d="M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21z"/><circle cx="12" cy="10.5" r="2"/>',
};
// Meters on the map are what the truck really drives: 90 km/h covers 25 of them a second.
const fmtTurnDist = (m) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`);
function setTurnIcon(el, code) {
  const [, icon, left] = TURNS[code] ?? TURNS[7];
  if (el.dataset.code !== String(code)) {
    el.dataset.code = code;
    el.innerHTML = TURN_ICONS[icon];
    el.classList.toggle('flip', left);
  }
}
function updateTurns({ route }) {
  const list = settings.turns ? route.maneuvers(2) : null;
  $('turn').classList.toggle('hidden', !list);
  if (!list) return;
  const [next, then] = list;
  setTurnIcon($('turn-icon'), next.code);
  $('turn-dist').textContent = fmtTurnDist(next.dist);
  $('turn-text').textContent = (TURNS[next.code] ?? TURNS[7])[0];
  $('turn-then').classList.toggle('hidden', !then);
  if (then) {
    setTurnIcon($('turn-then-icon'), then.code);
    $('turn-then-dist').textContent = fmtTurnDist(then.dist);
  }
}

function updateBanner() {
  const b = $('banner');
  let text = '';
  if (state.mapError) text = state.mapError;
  else if (state.status.serverDown) text = 'Serveur injoignable…';
  else if (state.online && !state.online.room) text = 'Rejoins ton convoi (bouton Convoi)';
  else if (state.online && state.status.brokerDown) text = 'Connexion au convoi…';
  else if (state.online && !state.online.meId) text = `En attente de ${state.online.name || 'toi'}… (ETS2 Map lancé sur ton PC, même code)`;
  else if (state.online && state.meOffline) text = WHY[state.meWhy] ?? 'ETS2 Map tourne sur ton PC, mais ETS2 n\'est pas sur la route';
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
  // Following a friend from the convoy list, else our own truck.
  const followed = state.followPeer ? peers.find((p) => p.id === state.followPeer) : null;
  const truck = followed ?? state.truck;
  if (state.follow && truck) {
    state.overview = state.userRot = state.toNorth = false;
    view.cx = truck.x;
    view.cy = truck.y;
    // Landscape: the job card sits on the left, so keep the truck right of center.
    const landscape = view.w > view.h * 1.2;
    view.ax = landscape ? 0.62 : 0.5;
    // 3D: the truck sits lower, there is more road to see ahead.
    view.ay = settings.view3d ? (landscape ? 0.78 : 0.76) : settings.headingUp ? (landscape ? 0.7 : 0.66) : 0.52;
    const targetRot = settings.headingUp ? truck.h * Math.PI * 2 : 0;
    view.rot = approachAngle(view.rot, targetRot, dt, 6);
    const kmh = Math.abs((followed ? followed.spd : state.telemetry?.spd) ?? 0) * 3.6;
    const base = settings.autozoom ? autoScale(kmh, Math.min(view.w, view.h)) : Math.min(view.w, view.h) / 600;
    const target = base * Math.pow(2, settings.zoomBias) * (settings.view3d ? 1.3 : 1);
    state.smoothScale = state.smoothScale == null ? target : state.smoothScale + (target - state.smoothScale) * Math.min(1, dt * 1.2);
    view.scale = state.smoothScale;
  } else if ((!settings.headingUp || state.toNorth) && !state.userRot && view.rot !== 0) {
    view.rot = approachAngle(view.rot, 0, dt, 8);
    if (view.rot === 0) state.toNorth = false;
  }
  $('compass').style.transform = `rotate(${(view.rot * 180) / Math.PI}deg)`;
  // 3D stays on while panning; only the overview is flat (it fits a bbox).
  const tilt = settings.view3d && !state.overview ? TILT_3D : 0;
  if (view.tilt !== tilt) {
    view.tilt += (tilt - view.tilt) * Math.min(1, dt * 7);
    if (Math.abs(tilt - view.tilt) < 0.002) view.tilt = tilt;
    dirty = true;
  }
  view.persp = view.h * 2;
  view.horizon = 0.1;
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
  if (!on) { state.followPeer = null; updateHud(); }
  if (on) state.overview = false;
  $('btn-recenter').classList.toggle('hidden', on);
  if (on) state.smoothScale = view.scale;
  dirty = true;
}

// Leave follow mode where we are. Flat: anchored at screen center.
// Tilted: keep the anchor, moving it would change the perspective.
function leaveFollow() {
  if (!state.follow) return;
  if (!view.tilt) {
    const [cx, cy] = view.toWorld(view.w / 2, view.h / 2);
    view.cx = cx; view.cy = cy; view.ax = 0.5; view.ay = 0.5;
  }
  setFollow(false);
}

function zoomAt(factor, px, py) {
  if (state.follow) {
    settings.zoomBias = Math.max(-6, Math.min(3, settings.zoomBias + Math.log2(factor)));
    saveSettings();
  } else {
    // Buttons zoom around the anchor (screen center, or the truck spot in 3D).
    px ??= view.ax * view.w; py ??= view.ay * view.h;
    const [wx, wy] = view.toWorld(px, py);
    view.scale = clampScale(view.scale * factor);
    // keep (wx, wy) under the finger
    const [nx, ny] = view.toWorld(px, py);
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
  // Friends too, so the whole convoy fits.
  for (const p of peers) pts.push([p.x, p.y]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  setFollow(false);
  state.overview = true;
  state.userRot = state.toNorth = false;
  computeInsets();
  // Fit into the part of the screen not covered by the HUD.
  const ins = view.insets;
  const freeW = Math.max(120, view.w - ins.left - ins.right), freeH = Math.max(120, view.h - ins.top - ins.bottom);
  view.rot = 0;
  view.ax = (ins.left + freeW / 2) / view.w;
  view.ay = (ins.top + freeH / 2) / view.h;
  view.cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  view.cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const w = Math.max(500, Math.max(...xs) - Math.min(...xs)) * 1.15;
  const h = Math.max(500, Math.max(...ys) - Math.min(...ys)) * 1.15;
  view.scale = clampScale(Math.min(freeW / w, freeH / h));
  dirty = true;
}

// ---------------------------------------------------------------------------
// Gestures: drag to pan, pinch to zoom, double tap to zoom in, wheel.

const pointers = new Map();
let gesture = null;
let pressTimer = 0;
surface.addEventListener('pointerdown', (e) => {
  try { surface.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  startGesture();
  clearTimeout(pressTimer);
  if (pointers.size === 1) {
    const [px, py] = [e.clientX, e.clientY];
    pressTimer = setTimeout(() => {
      if (pointers.size === 1 && gesture && !gesture.moved) {
        gesture.moved = true; // not a tap
        setDestination(...view.toWorld(px, py));
      }
    }, 600);
  }
});
surface.addEventListener('contextmenu', (e) => { e.preventDefault(); setDestination(...view.toWorld(e.clientX, e.clientY)); });

async function setDestination(x, y) {
  navigator.vibrate?.(30);
  if (state.online) {
    if (!online || !state.online.meId) { toast('Choisis d\'abord qui tu es (bouton Convoi)'); return; }
    toast('Itinéraire vers ce point…', 'Annuler', clearDestination);
    if (!(await online.sendCmd(state.online.meId, { action: 'target', x, y }))) toast('Convoi non connecté');
    return;
  }
  toast('Itinéraire vers ce point…', 'Annuler', clearDestination);
  try {
    const r = await fetch('api/route/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x, y }) });
    if (!r.ok) toast((await r.json()).error === 'no road graph' ? 'Graphe routier absent (npm run map:route)' : 'Itinéraire impossible');
  } catch { toast('Serveur injoignable'); }
}
async function clearDestination() {
  if (state.online) {
    if (online && state.online.meId) await online.sendCmd(state.online.meId, { action: 'clear' });
    toast('Destination effacée');
    return;
  }
  await fetch('api/route/target', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) }).catch(() => {});
  toast('Destination effacée');
}

let toastTimer = 0;
function toast(text, action, onAction) {
  const el = $('toast');
  el.querySelector('span').textContent = text;
  const btn = el.querySelector('button');
  btn.classList.toggle('hidden', !action);
  btn.textContent = action ?? '';
  btn.onclick = () => { el.classList.add('hidden'); onAction?.(); };
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}
surface.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (!gesture) return;
  const pts = [...pointers.values()];
  if (pts.length === 1 && gesture.n === 1) {
    const [x, y] = pts[0];
    if (!gesture.moved && Math.hypot(x - gesture.x, y - gesture.y) < 8) return;
    if (!gesture.moved) {
      gesture.moved = true;
      leaveFollow();
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
    // Twist: turns the map once the fingers have turned past ~12°, so a
    // plain pinch does not turn it by accident.
    const a = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]);
    let da = a - gesture.a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    gesture.a = a;
    if (!gesture.rotating) {
      gesture.twist += da;
      if (Math.abs(gesture.twist) > 0.2) { gesture.rotating = true; da = gesture.twist; leaveFollow(); }
    }
    if (state.follow) zoomAt(factor);
    else {
      // The spot under the fingers stays under the fingers.
      const [ox, oy] = view.toWorld(gesture.mx, gesture.my);
      view.scale = clampScale(view.scale * factor);
      if (gesture.rotating) { view.rot += da; state.userRot = true; state.toNorth = false; }
      const [nx, ny] = view.toWorld(mx, my);
      view.cx += ox - nx;
      view.cy += oy - ny;
      dirty = true;
    }
    gesture.mx = mx; gesture.my = my;
  }
});
const endPointer = (e) => {
  clearTimeout(pressTimer);
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
surface.addEventListener('pointerup', endPointer);
surface.addEventListener('pointercancel', endPointer);
function startGesture() {
  const pts = [...pointers.values()];
  if (!pts.length) { gesture = null; return; }
  if (pts.length === 1) gesture = { n: 1, x: pts[0][0], y: pts[0][1], moved: gesture?.moved && gesture.n > 1, world: view.toWorld(pts[0][0], pts[0][1]) };
  else {
    const mx = (pts[0][0] + pts[1][0]) / 2, my = (pts[0][1] + pts[1][1]) / 2;
    const a = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]);
    gesture = { n: 2, d: Math.max(10, Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1])), mx, my, a, twist: 0, rotating: false, moved: true };
  }
}
surface.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomAt(Math.pow(2, -e.deltaY / 400), e.clientX, e.clientY);
}, { passive: false });

// ---------------------------------------------------------------------------
// Buttons + settings.

$('btn-zoom-in').onclick = () => zoomAt(1.6);
$('btn-zoom-out').onclick = () => zoomAt(1 / 1.6);
$('btn-rotate').onclick = () => {
  // After a hand rotation, the compass first puts north back up.
  if (state.userRot) { state.userRot = false; state.toNorth = true; dirty = true; return; }
  settings.headingUp = !settings.headingUp;
  saveSettings();
  if (settings.headingUp && !state.follow) setFollow(true);
  dirty = true;
};
$('btn-3d').onclick = () => set3d(!settings.view3d);
function set3d(on) {
  settings.view3d = on;
  // A tilted map only makes sense facing the road.
  if (on) { settings.headingUp = true; if (state.overview) setFollow(true); }
  saveSettings();
  $('btn-3d').textContent = on ? '2D' : '3D';
  $('btn-3d').setAttribute('aria-label', on ? 'Vue 2D' : 'Vue 3D');
  $('set-3d').checked = on;
  dirty = true;
}
$('set-3d').onchange = (e) => set3d(e.target.checked);
set3d(settings.view3d);
$('btn-fit').onclick = () => fitOverview();
$('btn-recenter').onclick = () => { state.followPeer = null; setFollow(true); updateRecenter(); updateHud(); };
// The pill says what it does: back to me when following a friend.
function updateRecenter() {
  const label = $('btn-recenter').querySelector('span');
  if (label) label.textContent = state.followPeer ? 'Revenir sur moi' : 'Recentrer';
}
$('btn-menu').onclick = () => $('settings').showModal();
$('btn-clear-dest').onclick = () => { clearDestination(); $('settings').close(); };
$('btn-clear-trail').onclick = () => { state.trail = []; sessionStorage.removeItem('ets2map.trail'); dirty = true; };
$('btn-fullscreen').onclick = () => {
  const el = document.documentElement;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: 'hide' });
};

const toggles = { 'set-peer-routes': 'peerRoutes', 'set-route': 'route', 'set-night': 'night', 'set-pois': 'pois', 'set-companies': 'companies', 'set-shields': 'shields', 'set-trail': 'trail', 'set-turns': 'turns', 'set-autozoom': 'autozoom', 'set-awake': 'awake' };
for (const [id, key] of Object.entries(toggles)) {
  const el = $(id);
  el.checked = !!settings[key];
  el.onchange = () => {
    settings[key] = el.checked;
    saveSettings();
    applyTheme();
    if (key === 'awake') keepAwake();
    updateHud();
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
  computeInsets();
  dirty = true;
}

// Part of the screen not covered by the HUD, where edge arrows go.
function computeInsets() {
  const rect = (id) => { const el = $(id); return el && !el.classList.contains('hidden') ? el.getBoundingClientRect() : null; };
  const job = rect('job') || rect('turn') ? $('topleft').getBoundingClientRect() : null, ctl = rect('controls'), spd = rect('speed'), info = rect('info');
  const pad = 30;
  const ins = { left: pad, top: pad, right: pad, bottom: pad };
  if (ctl) ins.right = view.w - ctl.left + pad;
  if (view.w > view.h * 1.2) {
    if (job) ins.left = job.right + pad;
    if (info) ins.bottom = view.h - info.top + pad;
  } else {
    if (job) ins.top = job.bottom + pad;
    if (spd) ins.bottom = view.h - spd.top + pad;
  }
  view.insets = ins;
}
setInterval(computeInsets, 500);
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

function frame(now) {
  state.truck = interpolatedTruck(now);
  peers = convoy.positions(now);
  for (const p of peers) p.hideRoute = settings.hiddenRoutes.includes(p.id);
  const moving = (state.samples.length && !state.telemetry?.paused) || peers.length > 0;
  updateCamera(now);
  if (dirty || moving || gesture || renderer.needsRedraw) {
    renderer.layout(view, (settings.view3d && !state.overview) || view.tilt ? TILT_3D : 0);
    renderer.draw(view, {
      truck: state.truck,
      trail: state.trail,
      dest: route.target ? [route.target.x, route.target.y] : state.dest,
      route: settings.route ? route : null,
      peers,
      roadScale,
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
  if (await hasLocalServer()) connect();
  else startOnline();
  requestAnimationFrame(frame);
}
start();

// ---------------------------------------------------------------------------
// Online mode (ets.enorme.bid): no PC server next to the phone. The phone joins
// the convoy room itself over MQTT/WebSocket and shows "me" from my PC's
// published telemetry, friends from theirs.

async function hasLocalServer() {
  try {
    const r = await fetch('api/status', { cache: 'no-store' });
    return r.ok && (r.headers.get('content-type') ?? '').includes('json');
  } catch { return false; }
}

let online = null;
const ONLINE_KEY = 'ets2map.online';
function onlineConfig() {
  const cfg = JSON.parse(localStorage.getItem(ONLINE_KEY) || '{}');
  // Link from the PC console / QR code: #r=<code>&me=<playerId>&n=<pseudo>
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('r')) {
    cfg.room = h.get('r');
    cfg.meId = h.get('me') || null;
    cfg.name = h.get('n') || cfg.name || '';
    localStorage.setItem(ONLINE_KEY, JSON.stringify(cfg));
    history.replaceState(null, '', location.pathname); // keep the code out of the address bar
  }
  return cfg;
}
function saveOnline(cfg) { localStorage.setItem(ONLINE_KEY, JSON.stringify(cfg)); }

function startOnline() {
  state.online = onlineConfig();
  const cfg = state.online;
  online?.stop();
  online = null;
  for (const id of [...convoy.peers.keys()]) convoy.onLeave(id);
  convoy.info = { online: true, active: !!cfg.room, connected: false, name: cfg.name ?? '', room: cfg.room ?? '', broker: null, error: null };
  state.status = { connected: false, online: true };
  updateBanner();
  renderConvoy();
  if (!cfg.room) {
    $('convoy-sheet').showModal();
    renderConvoy();
    return;
  }
  online = new WebConvoy({
    room: cfg.room,
    callbacks: {
      onStatus: (st) => {
        convoy.info = { ...convoy.info, connected: st.connected, broker: st.broker, error: st.error };
        state.status.brokerDown = !st.connected;
        renderConvoy();
        updateBanner();
      },
      onState: (id, name, d, ts) => {
        if (!cfg.meId && cfg.name && name.toLowerCase() === cfg.name.toLowerCase()) {
          cfg.meId = id;
          saveOnline(cfg);
          convoy.onLeave(id);
        }
        if (id === cfg.meId) {
          if (cfg.name !== name) { cfg.name = name; saveOnline(cfg); convoy.info.name = name; }
          if (d?.offline) { state.meOffline = true; state.meWhy = d.why; state.status.connected = false; updateBanner(); return; }
          state.meOffline = false;
          onTelemetry(d, ts);
        } else {
          onPeerState({ id, name, state: d, ts });
        }
      },
      onRoute: (id, d) => {
        if (id === cfg.meId) { route.set(d); if (state.truck) route.update(state.truck.x, state.truck.y); }
        else convoy.onRoute(id, d);
        updateHud();
        dirty = true;
      },
      onLeave: (id) => {
        if (id === cfg.meId) { state.status.connected = false; updateBanner(); }
        else { convoy.onLeave(id); renderConvoy(); }
        dirty = true;
      },
    },
  });
  online.start().catch(() => { convoy.info.error = 'navigateur non compatible (https requis)'; renderConvoy(); });
}

/** "This one is me" from the convoy list. */
function setOnlineMe(id, name) {
  const cfg = state.online;
  cfg.meId = id;
  cfg.name = name;
  saveOnline(cfg);
  convoy.info.name = name;
  convoy.onLeave(id);
  state.samples = [];
  state.trail = [];
  route.set(null);
  renderConvoy();
}

// Debug hook for automated checks.
// ---------------------------------------------------------------------------
// Convoy sheet.


const meName = () => convoy.info.name || 'Moi';
$('btn-convoy').onclick = () => { renderConvoy(); $('convoy-sheet').showModal(); };
$('convoy-join').onclick = async () => {
  const name = $('convoy-name').value.trim();
  const room = $('convoy-room').value.trim();
  if (!name || !room) { $('convoy-msg').textContent = 'Indique ton pseudo et le code du convoi.'; return; }
  await postConvoy({ name, room });
};
$('convoy-leave').onclick = () => postConvoy({ room: '' });
async function postConvoy(body) {
  if (state.online) {
    const cfg = state.online;
    if (body.room !== cfg.room || (body.name ?? cfg.name) !== cfg.name) cfg.meId = null;
    cfg.room = body.room;
    if (body.name != null) cfg.name = body.name;
    saveOnline(cfg);
    state.samples = [];
    state.telemetry = null;
    route.set(null);
    startOnline();
    return;
  }
  try {
    const r = await fetch('api/convoy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    convoy.info = await r.json();
    if (!convoy.info.active) { for (const id of [...convoy.peers.keys()]) convoy.onLeave(id); }
  } catch { $('convoy-msg').textContent = 'Serveur injoignable.'; }
  renderConvoy();
}
let convoyRenderPending = false;
function scheduleConvoyRender() {
  if (convoyRenderPending) return;
  convoyRenderPending = true;
  setTimeout(() => { convoyRenderPending = false; renderConvoy(); }, 1000);
}
function renderConvoy() {
  const info = convoy.info;
  const n = convoy.peers.size;
  $('convoy-badge').textContent = n;
  $('convoy-badge').classList.toggle('hidden', !n);
  $('btn-convoy').classList.toggle('on', !!info.active);
  if (!$('convoy-sheet').open) return;
  if (document.activeElement !== $('convoy-name')) $('convoy-name').value = info.name ?? '';
  if (document.activeElement !== $('convoy-room')) $('convoy-room').value = info.room ?? '';
  $('convoy-leave').classList.toggle('hidden', !info.active);
  $('convoy-join').textContent = info.active ? 'Mettre à jour' : 'Rejoindre';
  $('convoy-msg').textContent = !info.active
    ? (info.online ? 'Mets le même pseudo et le même code que dans ETS2 Map sur ton PC.' : 'Même code pour tout le convoi. Le code chiffre vos positions.')
    : info.connected
      ? `Connecté (${info.broker}) · ${n} pote${n > 1 ? 's' : ''} en ligne${info.online && !state.online?.meId ? ` · « ${info.name} » pas encore vu : touche « C'est moi » sur ta ligne` : ''}`
      : `Connexion… ${info.error ? '(' + info.error + ')' : ''}`;
  const list = $('convoy-list');
  list.replaceChildren();
  const me = state.truck;
  for (const p of convoy.all(performance.now())) {
    const li = document.createElement('li');
    const dist = me && !p.offline ? (Math.hypot(p.x - me.x, p.y - me.y) * roadScale) / 1000 : null;
    const s = p.last ?? {};
    // Trip, country to country: "Calais (France) → Berlin (Allemagne)".
    const where = (city, token) => {
      const c = countryFr(store.meta?.cityCountry?.[token]);
      return city ? `${cityName(city, token)}${c ? ` (${c})` : ''}` : c;
    };
    const trip = p.offline ? (WHY[s.why] ?? 'ETS2 Map lancé, pas encore sur la route')
      : s.job ? `${where(s.job.src, s.job.srcId)} → ${where(s.job.dst, s.job.dstId)}` : 'Conduite libre';
    const stats = p.offline ? 'hors jeu'
      : [`${Math.round(Math.abs(s.spd ?? 0) * 3.6)} km/h`, dist != null ? `à ${dist < 10 ? dist.toFixed(1) : Math.round(dist)} km` : null, s.paused ? 'en pause' : null, latin(s.job?.cargo)].filter(Boolean).join(' · ');
    li.innerHTML = `<span class="dot"></span><div class="who"><b></b><small class="trip"></small><small class="stats"></small></div><div class="acts"></div>`;
    li.querySelector('.dot').style.background = p.color;
    li.querySelector('b').textContent = p.name;
    li.querySelector('.trip').textContent = trip;
    li.querySelector('.stats').textContent = stats;
    const acts = li.querySelector('.acts');
    const button = (text, cls, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = cls;
      btn.textContent = text;
      btn.onclick = (ev) => { ev.stopPropagation(); onClick(); };
      acts.append(btn);
      return btn;
    };
    if (!p.offline) {
      const following = state.followPeer === p.id;
      button(following ? 'Centré' : 'Centrer', `act${following ? ' on' : ''}`, () => {
        state.followPeer = p.id;
        state.follow = true;
        $('btn-recenter').classList.remove('hidden');
        updateRecenter();
        $('convoy-sheet').close();
        updateHud();
        dirty = true;
      });
      const hidden = settings.hiddenRoutes.includes(p.id);
      button(hidden ? 'Trajet masqué' : 'Trajet affiché', `act${hidden ? '' : ' on'}`, () => {
        settings.hiddenRoutes = hidden ? settings.hiddenRoutes.filter((id) => id !== p.id) : [...settings.hiddenRoutes, p.id];
        saveSettings();
        renderConvoy();
        dirty = true;
      });
    }
    if (state.online && !state.online.meId) button("C'est moi", 'me-btn', () => setOnlineMe(p.id, p.name));
    list.append(li);
  }
  if (!list.children.length && info.active) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Personne pour l\'instant. Tes potes doivent lancer ETS2 Map avec le même code.';
    list.append(li);
  }
}
setInterval(() => { if ($('convoy-sheet').open) renderConvoy(); }, 1000);

window.__ets2map = { state, view, settings, store, renderer, route, convoy, get online() { return online; } };
