#!/usr/bin/env node
// ETS2-Map server.
//  - receives telemetry datagrams from the game plugin (UDP 127.0.0.1:30210)
//  - serves the phone web app (web/) and the baked map (data/map/)
//  - pushes live telemetry to phones over Server-Sent Events (/api/stream)
//
// Usage: node server/server.js [--port 8765] [--udp 30210] [--convoy <room> --name <name>]
//                              [--record file.ndjson] [--replay file.ndjson] [--config data/config.json]

import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { Router, RouteManager } from './route.js';
import { ConvoyHub } from './convoy-hub.js';
import { diagnose, ensurePlugin, WHY_TEXT } from './game-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const MAP_DIR = path.join(ROOT, 'data', 'map');

const args = parseArgs(process.argv.slice(2));
// 8765, not 8080: 8080 is qBittorrent's Web UI (and many other tools).
const PORT_FIXED = args.port != null || process.env.ETS2MAP_HTTP_PORT != null;
const HTTP_PORT = Number(args.port ?? process.env.ETS2MAP_HTTP_PORT ?? 8765);
let httpPort = HTTP_PORT;
const UDP_PORT = Number(args.udp ?? process.env.ETS2MAP_PORT ?? 30210);
const UDP_HOST = args['udp-host'] ?? '127.0.0.1';
const OFFLINE_AFTER_MS = 3000;

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Telemetry state.

let latest = null;          // last packet object
let latestRaw = null;       // last packet as JSON text
let lastPacketAt = 0;
let packetCount = 0;
const clients = new Set();  // SSE responses
let recorder = null;

if (args.record) {
  recorder = fs.createWriteStream(path.resolve(String(args.record)), { flags: 'a' });
  console.log(`Recording telemetry to ${args.record}`);
}

// ---------------------------------------------------------------------------
// GPS route (computed here: the game does not share its own).

let routeRaw = null;        // last 'route' event payload (JSON text)
let routes = null;
let onRouteChange = null;   // set by the convoy to share the route
try {
  const router = Router.load(MAP_DIR);
  if (router) {
    const meta = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'meta.json'), 'utf8'));
    routes = new RouteManager(router, meta, (route) => {
      routeRaw = JSON.stringify(route);
      broadcast('route', routeRaw);
      onRouteChange?.(route);
    });
    console.log(`Road graph loaded: ${router.N} nodes, ${router.E} edges`);
  } else {
    console.log('No road graph (data/map/route.bin): run "npm run map:route" to get GPS routes.');
  }
} catch (err) {
  console.error(`Road graph not loaded: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Convoy: friends' trucks through a public MQTT broker (encrypted per room).

const convoy = new ConvoyHub({
  configPath: path.resolve(ROOT, String(args.config ?? 'data/config.json')),
  broadcast: (event, data) => broadcast(event, data),
  brokers: args.broker ? String(args.broker).split(',') : undefined,
  // Long press on the web app (ets.enorme.bid) arrives as a command.
  onCommand: (cmd) => {
    if (!routes || !cmd) return;
    if (cmd.action === 'clear') routes.setManualTarget(null);
    else if (cmd.action === 'target' && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) routes.setManualTarget(cmd.x, cmd.y);
    else return;
    if (latest) routes.update(latest);
  },
});
if (typeof args.convoy === 'string' || typeof args.name === 'string') {
  convoy.configure({ room: typeof args.convoy === 'string' ? args.convoy : undefined, name: typeof args.name === 'string' ? args.name : undefined });
} else if (convoy.config.room) {
  convoy.restart();
}
// First launch from the .cmd: ask for the convoy once, then it is remembered.
if (args.ask && !convoy.config.room && process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nConvoi (Entrée pour passer, modifiable ensuite depuis le téléphone)');
  const name = (await rl.question('  Ton pseudo : ')).trim();
  const room = name ? (await rl.question('  Code du convoi (le même pour tous) : ')).trim() : '';
  rl.close();
  if (name && room) convoy.configure({ name, room });
}
onRouteChange = (route) => convoy.onRoute(route);
const SITE = String(args.site ?? 'https://ets.enorme.bid').replace(/\/+$/, '');

// Plugin in the game folder that is actually used (fixes a missed or failed install).
const DLL_SOURCE = path.join(ROOT, 'plugin', 'build', 'ets2map_telemetry.dll');
ensurePlugin(DLL_SOURCE).then((r) => {
  if (r.result === 'installed') console.log(`[jeu] plugin installé : ${r.target}\n      Si ETS2 tourne déjà, redémarre-le.`);
}).catch(() => {});

// No truck data: find out why, every 15 s, tell this window and the convoy.
let lastWhy = null;
async function checkGame() {
  const driving = latest && !(latest.x === 0 && latest.z === 0) && Date.now() - lastPacketAt < 10000;
  if (driving) { lastWhy = null; convoy.why = null; return; }
  const d = await diagnose({ dllSource: DLL_SOURCE, packetsSeen: Date.now() - lastPacketAt < 10000 }).catch(() => null);
  if (!d) return;
  convoy.why = d.why;
  if (d.why !== lastWhy) console.log(`[jeu] ${WHY_TEXT[d.why]}`);
  lastWhy = d.why;
}
setTimeout(checkGame, 6000).unref();
setInterval(checkGame, 15000).unref();

// Console hints for whoever runs this window (friends included).
let gameSeen = false;
setInterval(() => {
  if (gameSeen && Date.now() - lastPacketAt > 10000) { gameSeen = false; console.log('[jeu] plus de données du jeu (ETS2 fermé ?)'); }
}, 5000).unref();

function onTelemetry(text, source = 'udp') {
  let obj;
  try { obj = JSON.parse(text); } catch { return; }
  if (!obj || obj.v !== 1) return;
  if (!gameSeen) { gameSeen = true; console.log('[jeu] ETS2 connecté, télémétrie reçue'); }
  obj.src = source;
  latest = obj;
  latestRaw = JSON.stringify(obj);
  lastPacketAt = Date.now();
  packetCount++;
  if (recorder) recorder.write(JSON.stringify({ t: lastPacketAt, d: text }) + '\n');
  broadcast('t', latestRaw);
  try { routes?.update(obj); } catch (err) { console.error(`[route] ${err.message}`); }
  try { convoy.onTelemetry(obj); } catch (err) { console.error(`[convoy] ${err.message}`); }
}

function broadcast(event, data) {
  const chunk = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of clients) res.write(chunk);
}

function status() {
  const age = latest ? Date.now() - lastPacketAt : null;
  return {
    connected: latest !== null && age < OFFLINE_AFTER_MS,
    lastPacketAgeMs: age,
    packets: packetCount,
    phones: clients.size,
    map: fs.existsSync(path.join(MAP_DIR, 'meta.json')),
  };
}

// Status heartbeat: lets phones show "game not running" and keeps proxies from
// closing idle streams.
setInterval(() => broadcast('status', JSON.stringify(status())), 2000).unref();

// ---------------------------------------------------------------------------
// UDP input (or replay of a recording).

if (args.replay) {
  startReplay(path.resolve(String(args.replay)));
} else {
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg) => onTelemetry(msg.toString('utf8')));
  udp.on('error', (err) => {
    console.error(`UDP error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${UDP_PORT} is already used: is another ETS2-Map server running?`);
      process.exit(1);
    }
  });
  udp.bind(UDP_PORT, UDP_HOST, () => console.log(`Listening for game telemetry on udp://${UDP_HOST}:${UDP_PORT}`));
}

function startReplay(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!lines.length) { console.error('Replay file is empty'); process.exit(1); }
  console.log(`Replaying ${lines.length} packets from ${file} (looping)`);
  let i = 0;
  const step = () => {
    const cur = lines[i];
    onTelemetry(cur.d, 'replay');
    const next = lines[(i + 1) % lines.length];
    i = (i + 1) % lines.length;
    const delay = i === 0 ? 1000 : Math.min(2000, Math.max(0, next.t - cur.t));
    setTimeout(step, delay);
  };
  step();
}

// ---------------------------------------------------------------------------
// HTTP.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(req, res, baseDir, relPath, { immutable = false } = {}) {
  const filePath = path.resolve(baseDir, '.' + path.posix.normalize('/' + relPath));
  if (!filePath.startsWith(baseDir)) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  const gzPath = filePath + '.gz';

  let servePath = filePath;
  const headers = { 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=86400' : 'no-cache' };
  if (acceptsGzip && fs.existsSync(gzPath)) {
    servePath = gzPath;
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  } else if (!fs.existsSync(filePath)) {
    // Map data may only exist precompressed: inflate it for clients without gzip.
    if (fs.existsSync(gzPath)) {
      res.writeHead(200, headers);
      fs.createReadStream(gzPath).pipe(zlib.createGunzip()).pipe(res);
      return;
    }
    return notFound(res);
  }
  let stat;
  try { stat = fs.statSync(servePath); } catch { return notFound(res); }
  if (stat.isDirectory()) return sendFile(req, res, baseDir, path.posix.join(relPath, 'index.html'));
  headers['Content-Length'] = stat.size;
  const etag = `"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  headers['ETag'] = etag;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(servePath).pipe(res);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    if (latestRaw) res.write(`event: t\ndata: ${latestRaw}\n\n`);
    if (routeRaw) res.write(`event: route\ndata: ${routeRaw}\n\n`);
    res.write(convoy.snapshot());
    clients.add(res);
    req.socket.setNoDelay(true);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/route/target' && req.method === 'POST') {
    return readJson(req).then((body) => {
      if (!routes) return json(res, { ok: false, error: 'no road graph' }, 503);
      if (body?.clear) routes.setManualTarget(null);
      else if (Number.isFinite(body?.x) && Number.isFinite(body?.y)) routes.setManualTarget(body.x, body.y);
      else return json(res, { ok: false, error: 'x, y or clear expected' }, 400);
      if (latest) routes.update(latest);
      json(res, { ok: true });
    }, () => json(res, { ok: false, error: 'bad json' }, 400));
  }
  if (p === '/api/convoy') {
    if (req.method === 'POST') {
      return readJson(req).then((body) => json(res, convoy.configure(body ?? {})), () => json(res, { error: 'bad json' }, 400));
    }
    return json(res, { ...convoy.info(), list: [...convoy.peers.values()] });
  }
  if (p === '/api/state') return json(res, { status: status(), telemetry: latest });
  if (p === '/api/status') return json(res, status());
  if (p.startsWith('/map/')) {
    const rel = p.slice('/map/'.length);
    // meta.json carries the bake version used to bust the cache of everything else.
    return sendFile(req, res, MAP_DIR, rel, { immutable: rel !== 'meta.json' && url.searchParams.has('v') });
  }
  return sendFile(req, res, WEB_DIR, p === '/' ? 'index.html' : p);
});

server.on('error', (err) => {
  // Port taken by another app: take the next free one rather than giving up.
  if (err.code === 'EADDRINUSE' && !PORT_FIXED && httpPort < HTTP_PORT + 10) {
    console.log(`Port ${httpPort} déjà utilisé par un autre programme, essai du ${httpPort + 1}…`);
    httpPort++;
    setTimeout(() => server.listen(httpPort, '0.0.0.0'), 100);
    return;
  }
  console.error(`HTTP error: ${err.message}`);
  if (err.code === 'EADDRINUSE') console.error(`Port ${httpPort} is busy, try --port ${httpPort + 1}`);
  process.exit(1);
});

server.on('listening', onListening);
server.listen(httpPort, '0.0.0.0');

async function onListening() {
  const urls = lanAddresses().map((a) => `http://${a.address}:${httpPort}/`);
  console.log('');
  console.log('ETS2-Map is running. Open this on your phone (same Wi-Fi):');
  for (const u of urls) console.log(`  ${u}`);
  console.log(`  (on this PC: http://localhost:${httpPort}/)`);
  if (!fs.existsSync(path.join(MAP_DIR, 'meta.json'))) {
    console.log('\nNo map data yet: run "npm run map" once (see README).');
  }
  // Online: works on 4G too, the phone joins the convoy as this player.
  const c = convoy.config;
  const onlineUrl = c.room ? `${SITE}/#r=${encodeURIComponent(c.room)}&me=${c.id}&n=${encodeURIComponent(c.name || '')}` : null;
  if (onlineUrl) {
    console.log(`\nOr from anywhere (convoy "${c.room}" as ${c.name || '?'}):`);
    console.log(`  ${onlineUrl}`);
  }
  const qrUrl = onlineUrl ?? urls[0];
  if (qrUrl && !args['no-qr']) {
    try {
      const qr = (await import('qrcode-terminal')).default;
      qr.generate(qrUrl, { small: true }, (code) => console.log(`\n${onlineUrl ? 'QR = online link' : 'QR = Wi-Fi link'}\n${code}`));
    } catch { /* qrcode-terminal not installed: the URL is enough */ }
  }
}

// LAN IPv4 addresses, the physical ones (Wi-Fi/Ethernet) first.
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|ZeroTier|Tailscale|Docker/i.test(name);
      const privateLan = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      out.push({ name, address: a.address, rank: (virtual ? 2 : 0) + (privateLan ? 0 : 1) });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}
