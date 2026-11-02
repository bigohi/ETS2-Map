// End-to-end test of server/convoy.js against the REAL public MQTT brokers,
// plus a local fake broker to exercise packet framing (split / coalesced / oversize).
//
// Usage: node server/convoy-test.mjs        -> exit code 0 if everything passes

import net from 'node:net';
import crypto from 'node:crypto';
import { Convoy, DEFAULT_BROKERS } from './convoy.js';

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`;
  console.log(line);
  results.push(ok);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => crypto.randomBytes(6).toString('hex');

function waitFor(pred, timeoutMs, stepMs = 100) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve(Date.now() - t0);
      if (Date.now() - t0 >= timeoutMs) return resolve(-1);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function record(c) {
  const log = { state: [], route: [], leave: [], status: [] };
  c.on('state', (id, obj, meta) => log.state.push({ id, obj, meta }));
  c.on('route', (id, obj) => log.route.push({ id, obj }));
  c.on('leave', (id) => log.leave.push({ id, t: Date.now() }));
  c.on('status', (s) => log.status.push(s));
  return log;
}

// ---------------------------------------------------------------------------
// 1. Local framing test with a fake MQTT broker (plain TCP, mqtt://)

async function framingTest() {
  const room = 'Local ' + rid();
  const sender = new Convoy({ room, name: 'Sender', id: 'sender1' });   // only used to encrypt
  sender._sess = 'abc';
  const enc = (kind, d) => sender._encrypt(kind, d);
  const topic = (kind) => `${sender.base}/sender1/${kind}`;
  const encLen = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
  const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const pub = (t, p) => { const body = Buffer.concat([str(t), p]); return Buffer.concat([Buffer.from([0x30]), encLen(body.length), body]); };

  let gotConnect = null;
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', async (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = 0, mul = 1, i = 1;
        for (; ; i++) { len += (buf[i] & 0x7f) * mul; mul *= 128; if (!(buf[i] & 0x80)) { i++; break; } }
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        if (type === 1) { gotConnect = body; sock.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); }
        if (type === 8) {
          sock.write(Buffer.from([0x90, 0x03, body[0], body[1], 0x00]));
          // a) one state split byte by byte
          const a = pub(topic('state'), enc('state', { n: 1 }));
          for (const b of a) { sock.write(Buffer.from([b])); await sleep(1); }
          // b) oversize packet (300 KB, must be skipped) coalesced with a valid one
          const big = pub(topic('route'), crypto.randomBytes(300 * 1024));
          const c = pub(topic('state'), enc('state', { n: 2 }));
          sock.write(Buffer.concat([big, c]));
          // c) three packets coalesced in one chunk, incl. a 60 KB route and garbage
          const route = { pts: Array.from({ length: 4000 }, (_, k) => [k * 1.5, -k * 2.25]) };
          const garbage = pub(topic('state'), crypto.randomBytes(80));
          const stale = pub(topic('state'), (() => { const s = new Convoy({ room, name: 'x', id: 'sender1' }); return s._encrypt('state', { n: 99 }, Date.now() - 60_000); })());
          sock.write(Buffer.concat([pub(topic('route'), enc('route', route)), garbage, stale, pub(topic('state'), enc('state', { n: 3 }))]));
          // d) an echo of the receiver's own id must be ignored
          sock.write(pub(`${sender.base}/recv1/state`, enc('state', { n: 4 })));
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const recv = new Convoy({ room: '  ' + room.toUpperCase() + ' ', name: 'Recv', id: 'recv1', brokers: [`mqtt://127.0.0.1:${port}`] });
  const log = record(recv);
  recv.start();
  await waitFor(() => log.state.length >= 3 && log.route.length >= 1, 5000);
  const ns = log.state.map((s) => s.obj.n).join(',');
  check('framing: CONNECT carries a Last Will (flags 0x06)', gotConnect && gotConnect[7] === 0x06, gotConnect ? 'flags=0x' + gotConnect[7].toString(16) : 'no CONNECT');
  check('framing: split, oversize-skipped, coalesced states decoded; garbage/stale/self dropped', ns === '1,2,3', 'states=' + ns);
  check('framing: 60 KB route in a coalesced chunk', log.route.length === 1 && log.route[0].obj.pts.length === 4000, 'routes=' + log.route.length);
  check('framing: room normalization (case/spaces)', log.state.length > 0 && log.state[0].meta.name === 'Sender');
  await recv.stop();
  server.close();
}

// ---------------------------------------------------------------------------
// 2. Real public brokers

async function realTest() {
  const room = 'Convoy Test ' + rid();
  const A = new Convoy({ room, name: 'Alice', id: 'A' + rid() });
  const B = new Convoy({ room: room.toLowerCase() + '  ', name: 'Bob', id: 'B' + rid() });
  const C = new Convoy({ room: 'Other ' + rid(), name: 'Carol', id: 'C' + rid() });
  const la = record(A), lb = record(B), lc = record(C);
  const t0 = Date.now();
  A.start(); B.start(); C.start();
  const conn = await waitFor(() => A.status.connected && B.status.connected && C.status.connected, 30_000);
  check('A, B, C connected', conn >= 0, `A=${A.status.broker} B=${B.status.broker} C=${C.status.broker} in ${Date.now() - t0} ms`);
  if (conn < 0) {
    console.log('status A', A.status, 'B', B.status, 'C', C.status);
    await Promise.all([A.stop(), B.stop(), C.stop()]);
    return;
  }

  // ~5 s of states at 2 Hz, one route each
  const route = { pts: Array.from({ length: 3000 }, (_, k) => [k * 10.123, k * -3.456]), name: 'Calais -> Lyon' };
  let sentA = 0, sentB = 0;
  for (let i = 0; i < 10; i++) {
    if (A.publishState({ x: i, y: -i, speed: 80 + i, who: 'A' })) sentA++;
    if (B.publishState({ x: 100 + i, y: i, speed: 70, who: 'B' })) sentB++;
    if (i === 2) { A.publishRoute(route); B.publishRoute({ pts: [[1, 2], [3, 4]] }); }
    C.publishState({ who: 'C' });
    await sleep(500);
  }
  await sleep(1500);
  const routeBytes = Buffer.byteLength(JSON.stringify(route));
  check('B received A state', lb.state.some((s) => s.id === A.id && s.obj.who === 'A' && s.meta.name === 'Alice'), `${lb.state.length}/${sentA} states`);
  check('A received B state', la.state.some((s) => s.id === B.id && s.obj.who === 'B' && s.meta.name === 'Bob'), `${la.state.length}/${sentB} states`);
  check(`B received A route (${(routeBytes / 1024).toFixed(1)} KB)`, lb.route.some((r) => r.id === A.id && r.obj.pts.length === 3000));
  check('A received B route', la.route.some((r) => r.id === B.id && r.obj.pts.length === 2));
  check('nobody receives own messages', !la.state.some((s) => s.id === A.id) && !lb.state.some((s) => s.id === B.id));
  check('C (other room) received nothing', lc.state.length === 0 && lc.route.length === 0, `${lc.state.length} states`);
  check('A, B, C see no foreign room traffic', !la.state.some((s) => s.id === C.id) && !lb.state.some((s) => s.id === C.id));
  check('peers count', A.status.peers === 1 && B.status.peers === 1 && C.status.peers === 0, `A=${A.status.peers} B=${B.status.peers} C=${C.status.peers}`);

  // Broker fallback: unreachable first broker
  const D = new Convoy({ room, name: 'Dave', id: 'D' + rid(), brokers: ['mqtts://127.0.0.1:1', ...DEFAULT_BROKERS] });
  const ld = record(D);
  const td = Date.now();
  D.start();
  const dConn = await waitFor(() => D.status.connected, 30_000);
  const firstErr = ld.status.find((s) => s.error)?.error;
  check('fallback: connected via next broker after 127.0.0.1:1', dConn >= 0 && D.status.broker === DEFAULT_BROKERS[0], `broker=${D.status.broker} in ${Date.now() - td} ms, first error="${firstErr}"`);
  for (let i = 0; i < 4; i++) { D.publishState({ who: 'D' }); await sleep(500); }
  await sleep(1000);
  check('fallback: B received D state', lb.state.some((s) => s.id === D.id));

  // Crash (no DISCONNECT): B must get 'leave' through the Last Will
  const tk = Date.now();
  D._kill();
  const dLeave = await waitFor(() => lb.leave.some((l) => l.id === D.id), 10_000);
  check('Last Will: B gets leave for crashed D', dLeave >= 0, dLeave >= 0 ? `${Date.now() - tk} ms` : 'timeout');

  // Clean stop of A
  const ts = Date.now();
  await A.stop();
  const aLeave = await waitFor(() => lb.leave.some((l) => l.id === A.id), 5000);
  check('stop: B gets leave for A within 5 s', aLeave >= 0, aLeave >= 0 ? `${Date.now() - ts} ms` : 'timeout');
  check('stop: A status disconnected', A.status.connected === false);
  check('stop: A publishes are dropped', A.publishState({ x: 1 }) === false);

  // Silence timeout: C stops talking in its own room; B in room keeps alone. Test 15 s expiry with E.
  const E = new Convoy({ room, name: 'Eve', id: 'E' + rid() });
  E.start();
  await waitFor(() => E.status.connected, 30_000);
  E.publishState({ who: 'E' });
  await waitFor(() => lb.state.some((s) => s.id === E.id), 5000);
  const te = Date.now();
  const eLeave = await waitFor(() => lb.leave.some((l) => l.id === E.id), 20_000, 200);
  check('timeout: B drops silent E after ~15 s', eLeave >= 14_000, eLeave >= 0 ? `${Date.now() - te} ms` : 'timeout');

  await Promise.all([B.stop(), C.stop(), E.stop()]);

  // Second default broker on its own
  const hroom = 'Hive ' + rid();
  const H1 = new Convoy({ room: hroom, name: 'H1', id: 'H1' + rid(), brokers: [DEFAULT_BROKERS[1]] });
  const H2 = new Convoy({ room: hroom, name: 'H2', id: 'H2' + rid(), brokers: [DEFAULT_BROKERS[1]] });
  const lh2 = record(H2);
  H1.start(); H2.start();
  const hConn = await waitFor(() => H1.status.connected && H2.status.connected, 30_000);
  for (let i = 0; i < 4 && hConn >= 0; i++) { H1.publishState({ who: 'H1' }); await sleep(500); }
  if (hConn >= 0) H1.publishRoute(route);
  await waitFor(() => lh2.route.length > 0, 5000);
  check(`${DEFAULT_BROKERS[1]}: state + ${(routeBytes / 1024).toFixed(1)} KB route delivered`, lh2.state.some((s) => s.id === H1.id) && lh2.route.some((r) => r.obj.pts.length === 3000),
    hConn >= 0 ? `${lh2.state.length} states, ${lh2.route.length} routes` : 'not connected: ' + H1.status.error);
  await Promise.all([H1.stop(), H2.stop()]);
}

process.on('uncaughtException', (e) => { console.log('FAIL  uncaught exception: ' + (e?.stack || e)); process.exit(1); });

console.log('--- local framing test');
await framingTest();
console.log('--- real brokers test');
await realTest();
console.log(`--- ${results.length - failures}/${results.length} passed`);
console.log(failures ? 'FAIL' : 'PASS');
process.exit(failures ? 1 : 0);
