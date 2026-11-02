#!/usr/bin/env node
// ETS2-Map server.
//  - receives telemetry datagrams from the game plugin (UDP 127.0.0.1:30210)
//  - serves the phone web app (web/) and the baked map (data/map/)
//  - pushes live telemetry to phones over Server-Sent Events (/api/stream)
//
// Usage: node server/server.js [--port 8080] [--udp 30210] [--record file.ndjson] [--replay file.ndjson]

import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const MAP_DIR = path.join(ROOT, 'data', 'map');

const args = parseArgs(process.argv.slice(2));
const HTTP_PORT = Number(args.port ?? process.env.ETS2MAP_HTTP_PORT ?? 8080);
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

function onTelemetry(text, source = 'udp') {
  let obj;
  try { obj = JSON.parse(text); } catch { return; }
  if (!obj || obj.v !== 1) return;
  obj.src = source;
  latest = obj;
  latestRaw = JSON.stringify(obj);
  lastPacketAt = Date.now();
  packetCount++;
  if (recorder) recorder.write(JSON.stringify({ t: lastPacketAt, d: text }) + '\n');
  broadcast('t', latestRaw);
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
    clients.add(res);
    req.socket.setNoDelay(true);
    req.on('close', () => clients.delete(res));
    return;
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
  console.error(`HTTP error: ${err.message}`);
  if (err.code === 'EADDRINUSE') console.error(`Port ${HTTP_PORT} is busy, try --port 8081`);
  process.exit(1);
});

server.listen(HTTP_PORT, '0.0.0.0', async () => {
  const urls = lanAddresses().map((a) => `http://${a.address}:${HTTP_PORT}/`);
  console.log('');
  console.log('ETS2-Map is running. Open this on your phone (same Wi-Fi):');
  for (const u of urls) console.log(`  ${u}`);
  console.log(`  (on this PC: http://localhost:${HTTP_PORT}/)`);
  if (!fs.existsSync(path.join(MAP_DIR, 'meta.json'))) {
    console.log('\nNo map data yet: run "npm run map" once (see README).');
  }
  if (urls.length && !args['no-qr']) {
    try {
      const qr = (await import('qrcode-terminal')).default;
      qr.generate(urls[0], { small: true }, (code) => console.log('\n' + code));
    } catch { /* qrcode-terminal not installed: the URL is enough */ }
  }
});

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
