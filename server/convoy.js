// ETS2-Map convoy transport.
//
// Shares small encrypted JSON messages between ETS2-Map servers of the same
// "convoy room" through a public MQTT broker. Zero dependencies: a minimal
// MQTT 3.1.1 client (QoS 0 only) is implemented below over node:tls.
//
//   const c = new Convoy({ room: 'My Secret Room', name: 'Quentin', id: 'k3j4h5' });
//   c.on('state', (peerId, obj, { name }) => ...);
//   c.on('route', (peerId, obj) => ...);
//   c.on('leave', (peerId) => ...);
//   c.on('status', (status) => ...);
//   c.on('cmd', (obj, { from }) => ...);   // commands sent to this player (phone on ets.enorme.bid)
//   c.start();  c.publishState({...});  c.publishRoute({...});  await c.stop();
//
// Topics:   ets2map/v2/<roomHash>/<playerId>/<state|route|leave|cmd>   (cmd: <playerId> is the recipient)
// Payload:  12-byte IV | AES-256-GCM ciphertext | 16-byte tag
// Plain:    {"t":kind,"id":senderId,"name":..,"d":obj,"ts":ms,"s":sessionId}
// Key:      PBKDF2-SHA256(normalized room, 'ets2map-convoy-v2', 100000) -> AES-256 (WebCrypto-compatible,
//           so the web app can join from a browser over MQTT/WebSocket).

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import tls from 'node:tls';
import net from 'node:net';

export const DEFAULT_BROKERS = ['mqtts://broker.emqx.io:8883', 'mqtts://broker.hivemq.com:8883'];
export const KDF_SALT = 'ets2map-convoy-v2';
export const KDF_ITERATIONS = 100_000;
export const TOPIC_ROOT = 'ets2map/v2';

const KEEPALIVE_S = 30;
const CONNECT_TIMEOUT_MS = 10_000;     // TCP + TLS + CONNACK + SUBACK
const PEER_TIMEOUT_MS = 15_000;        // peer gone after 15 s of silence
const MAX_AGE_MS = 30_000;             // ignore messages older than this
const MAX_PACKET = 256 * 1024;         // incoming packet cap (bigger ones are skipped)
const MAX_OUT_PAYLOAD = 250 * 1024;    // never send something peers would skip
const MAX_BACKLOG = 512 * 1024;        // drop QoS 0 publishes if the socket is this far behind
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_MS = 10_000;              // a connection that lived this long resets the backoff
const PRIMARY_PROBE_MS = 60_000;       // when on a fallback broker, try the first one again
const NAME_MAX = 32;
const ID_MAX = 64;

export function normalizeRoom(room) {
  return String(room ?? '').trim().toLowerCase();
}

export function roomHashOf(room) {
  return crypto.createHash('sha256').update('ets2map-room:' + normalizeRoom(room)).digest('hex').slice(0, 20);
}

function sanitizeId(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, ID_MAX);
  return s || crypto.randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// MQTT 3.1.1 wire helpers

function encLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function mqttStr(s) {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(first, body) {
  return Buffer.concat([Buffer.from([first]), encLen(body.length), body]);
}

const CONNACK_ERRORS = {
  1: 'unacceptable protocol version',
  2: 'client id rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized',
};

// One MQTT session on one socket. Emits 'ready' (after SUBACK),
// 'message' (topic, payload, retain) and 'close' (errorMessage|null) exactly once.
class MqttConn extends EventEmitter {
  constructor({ url, clientId, will, subscribe }) {
    super();
    this.url = url;
    this.clientId = clientId;
    this.will = will;               // { topic, payload: Buffer }
    this.subscribe = subscribe;     // topic filter
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.skip = 0;
    this.ready = false;
    this.closed = false;
    this.error = null;
    this.openedAt = 0;
    this.readyAt = 0;
    this.lastRx = 0;
    this.timers = [];
  }

  open() {
    let u;
    try {
      u = new URL(this.url);
    } catch {
      this._fail('bad broker url ' + this.url);
      return;
    }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const secure = u.protocol !== 'mqtt:';
    const port = Number(u.port) || (secure ? 8883 : 1883);
    try {
      if (secure) {
        const opts = { host, port };
        if (net.isIP(host) === 0) opts.servername = host;
        this.socket = tls.connect(opts);
        this.socket.once('secureConnect', () => this._onConnect());
      } else {
        this.socket = net.connect({ host, port });
        this.socket.once('connect', () => this._onConnect());
      }
    } catch (e) {
      this._fail(e?.message || String(e));
      return;
    }
    this.socket.setNoDelay?.(true);
    this.socket.on('data', (d) => {
      try { this._onData(d); } catch (e) { this._fail('protocol error: ' + (e?.message || e)); }
    });
    this.socket.on('error', (e) => { this.error = this.error || e?.code || e?.message || String(e); });
    this.socket.on('close', () => this._closed());
    this.timers.push(setTimeout(() => { if (!this.ready) this._fail('connect timeout'); }, CONNECT_TIMEOUT_MS));
  }

  _onConnect() {
    this.openedAt = Date.now();
    this.lastRx = Date.now();
    const flags = 0x02 | (this.will ? 0x04 : 0);   // clean session, will QoS 0, will retain 0
    const parts = [mqttStr('MQTT'), Buffer.from([0x04, flags, KEEPALIVE_S >> 8, KEEPALIVE_S & 0xff]), mqttStr(this.clientId)];
    if (this.will) parts.push(mqttStr(this.will.topic), mqttStr(this.will.payload));
    this._write(packet(0x10, Buffer.concat(parts)));
    const t = setInterval(() => {
      if (Date.now() - this.lastRx > KEEPALIVE_S * 1500) { this._fail('keepalive timeout'); return; }
      this._write(Buffer.from([0xc0, 0x00]));   // PINGREQ
    }, (KEEPALIVE_S * 1000) / 2);
    this.timers.push(t);
  }

  _onData(chunk) {
    this.lastRx = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.buf.length);
        this.skip -= n;
        this.buf = this.buf.subarray(n);
        if (this.skip > 0) return;
      }
      if (this.buf.length < 2) return;
      let len = 0, mul = 1, i = 1, done = false;
      for (; i < this.buf.length && i <= 4; i++) {
        const b = this.buf[i];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (!(b & 0x80)) { done = true; i++; break; }
      }
      if (!done) {
        if (i > 4) throw new Error('malformed remaining length');
        return;   // need more bytes
      }
      const first = this.buf[0];
      if (len > MAX_PACKET) {
        this.buf = this.buf.subarray(i);
        this.skip = len;
        continue;
      }
      if (this.buf.length < i + len) return;
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      this._onPacket(first, body);
    }
  }

  _onPacket(first, body) {
    const type = first >> 4;
    if (type === 2) {                                   // CONNACK
      const rc = body[1];
      if (rc !== 0) { this._fail('connack refused: ' + (CONNACK_ERRORS[rc] || rc)); return; }
      const pid = Buffer.from([0x00, 0x01]);
      this._write(packet(0x82, Buffer.concat([pid, mqttStr(this.subscribe), Buffer.from([0x00])])));
    } else if (type === 9) {                            // SUBACK
      if (body.length < 3 || body[2] === 0x80) { this._fail('subscribe refused'); return; }
      if (!this.ready) {
        this.ready = true;
        this.readyAt = Date.now();
        this.emit('ready');
      }
    } else if (type === 3) {                            // PUBLISH
      const qos = (first >> 1) & 3;
      const retain = (first & 1) === 1;
      if (body.length < 2) return;
      const tl = body.readUInt16BE(0);
      if (body.length < 2 + tl) return;
      const topic = body.toString('utf8', 2, 2 + tl);
      let off = 2 + tl;
      if (qos > 0) {
        if (body.length < off + 2) return;
        const pid = body.subarray(off, off + 2);
        off += 2;
        if (qos === 1) this._write(Buffer.concat([Buffer.from([0x40, 0x02]), pid]));          // PUBACK
        else if (qos === 2) this._write(Buffer.concat([Buffer.from([0x50, 0x02]), pid]));     // PUBREC
      }
      this.emit('message', topic, body.subarray(off), retain);
    } else if (type === 6) {                            // PUBREL (QoS 2, should not happen)
      if (body.length >= 2) this._write(Buffer.concat([Buffer.from([0x70, 0x02]), body.subarray(0, 2)]));
    }
    // PINGRESP (13) and anything else: nothing to do
  }

  // Returns true if the packet was handed to the socket.
  publish(topic, payload) {
    if (!this.ready || this.closed) return false;
    if (this.socket.writableLength > MAX_BACKLOG) return false;
    return this._write(packet(0x30, Buffer.concat([mqttStr(topic), payload])));
  }

  _write(buf) {
    if (this.closed || !this.socket || this.socket.destroyed) return false;
    try { this.socket.write(buf); return true; } catch { return false; }
  }

  // Graceful: optional last publish, then DISCONNECT (so the broker discards the will).
  end(lastTopic, lastPayload) {
    if (this.closed) return;
    if (this.ready && lastTopic) this.publish(lastTopic, lastPayload);
    this._write(Buffer.from([0xe0, 0x00]));
    try { this.socket?.end(); } catch { /* ignore */ }
    const t = setTimeout(() => { try { this.socket?.destroy(); } catch { /* ignore */ } this._closed(); }, 1500);
    t.unref?.();
  }

  // Abrupt: no DISCONNECT, the broker will fire the will.
  kill() {
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this._closed();
  }

  _fail(msg) {
    this.error = msg;
    this.kill();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    this.emit('close', this.error);
  }
}

// ---------------------------------------------------------------------------

export class Convoy extends EventEmitter {
  constructor({ room, name, id, brokers } = {}) {
    super();
    const normRoom = normalizeRoom(room);
    if (!normRoom) throw new Error('Convoy: room is required');
    this.room = normRoom;
    this.roomHash = roomHashOf(normRoom);
    this.id = sanitizeId(id);
    this.name = String(name ?? '').trim().slice(0, NAME_MAX) || 'Driver';
    this.brokers = Array.isArray(brokers) && brokers.length ? brokers.map(String) : DEFAULT_BROKERS.slice();
    this.key = crypto.pbkdf2Sync(normRoom, KDF_SALT, KDF_ITERATIONS, 32, 'sha256');
    this.base = `${TOPIC_ROOT}/${this.roomHash}`;
    this.peers = new Map();   // id -> { name, last, sess }

    this._conn = null;        // active (ready or connecting) connection
    this._probe = null;       // connection attempt to the primary broker while on a fallback
    this._brokerIdx = 0;
    this._fails = 0;
    this._running = false;
    this._retryTimer = null;
    this._peerTimer = null;
    this._probeTimer = null;
    this._status = { connected: false, broker: null, peers: 0, error: null };
  }

  get status() {
    return { ...this._status };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._fails = 0;
    this._brokerIdx = 0;
    this._peerTimer = setInterval(() => this._expirePeers(), 1000);
    this._probeTimer = setInterval(() => this._probePrimary(), PRIMARY_PROBE_MS);
    this._connect();
  }

  // Best-effort 'leave', clean DISCONNECT, no reconnect. Resolves once the socket is closed (max ~1.5 s).
  stop() {
    if (!this._running) return Promise.resolve();
    this._running = false;
    clearTimeout(this._retryTimer);
    clearInterval(this._peerTimer);
    clearInterval(this._probeTimer);
    this._retryTimer = this._peerTimer = this._probeTimer = null;
    if (this._probe) { this._probe.removeAllListeners(); this._probe.kill(); this._probe = null; }
    const conn = this._conn;
    this._conn = null;
    const done = new Promise((resolve) => {
      if (!conn || conn.closed) { resolve(); return; }
      conn.removeAllListeners('message');
      conn.removeAllListeners('ready');
      conn.removeAllListeners('close');
      conn.once('close', () => resolve());
      conn.end(`${this.base}/${this.id}/leave`, this._encrypt('leave', null));
    });
    for (const pid of [...this.peers.keys()]) this._dropPeer(pid);
    this._setStatus({ connected: false, broker: null, error: null });
    return done;
  }

  publishState(obj) {
    return this._publish('state', obj);
  }

  publishRoute(obj) {
    return this._publish('route', obj);
  }

  /** Command for one player (its server acts on it). */
  publishCmd(toId, obj) {
    const conn = this._conn;
    if (!this._running || !conn || !conn.ready) return false;
    return conn.publish(`${this.base}/${sanitizeId(toId)}/cmd`, this._encrypt('cmd', obj));
  }

  // Test hook: simulate a crash (socket destroyed, no DISCONNECT -> broker fires the Last Will).
  _kill() {
    this._running = false;
    clearTimeout(this._retryTimer);
    clearInterval(this._peerTimer);
    clearInterval(this._probeTimer);
    if (this._probe) { this._probe.removeAllListeners(); this._probe.kill(); this._probe = null; }
    if (this._conn) { this._conn.removeAllListeners(); this._conn.kill(); this._conn = null; }
    this._setStatus({ connected: false, broker: null });
  }

  // -------------------------------------------------------------------------

  _publish(kind, obj) {
    const conn = this._conn;
    if (!this._running || !conn || !conn.ready) return false;
    let payload;
    try { payload = this._encrypt(kind, obj); } catch { return false; }
    if (payload.length > MAX_OUT_PAYLOAD) return false;
    return conn.publish(`${this.base}/${this.id}/${kind}`, payload);
  }

  _encrypt(kind, obj, ts = Date.now(), sess = this._sess) {
    const plain = Buffer.from(JSON.stringify({ t: kind, id: this.id, name: this.name, d: obj ?? null, ts, s: sess }), 'utf8');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]);
  }

  _decrypt(buf) {
    if (buf.length < 12 + 16 + 2) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(buf.length - 16));
      const plain = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
      const msg = JSON.parse(plain.toString('utf8'));
      return msg && typeof msg === 'object' ? msg : null;
    } catch {
      return null;
    }
  }

  _newConn(idx) {
    // Each connection gets a session id; it is in every message and in the will,
    // so a (possibly old) will is only honoured for the peer's current session.
    const sess = crypto.randomBytes(6).toString('hex');
    const clientId = 'e2m' + crypto.randomBytes(10).toString('hex');   // 23 chars, spec-safe
    const will = { topic: `${this.base}/${this.id}/leave`, payload: this._encrypt('leave', null, Date.now(), sess) };
    const conn = new MqttConn({ url: this.brokers[idx], clientId, will, subscribe: `${this.base}/+/+` });
    conn.sess = sess;
    conn.idx = idx;
    conn.on('message', (topic, payload, retain) => {
      try { this._onMessage(topic, payload, retain); } catch { /* never throw from handlers */ }
    });
    return conn;
  }

  _connect() {
    if (!this._running || (this._conn && !this._conn.closed)) return;
    const idx = this._brokerIdx % this.brokers.length;
    const conn = this._newConn(idx);
    this._conn = conn;
    conn.on('ready', () => {
      if (this._conn !== conn) return;
      this._sess = conn.sess;
      this._setStatus({ connected: true, broker: this.brokers[idx], error: null });
    });
    conn.on('close', (err) => {
      if (this._conn !== conn) return;
      this._conn = null;
      this._sess = null;
      const lived = conn.readyAt ? Date.now() - conn.readyAt : 0;
      if (lived >= STABLE_MS) {
        this._fails = 0;              // was a good session: retry the same broker first
      } else {
        this._fails++;
        this._brokerIdx = (idx + 1) % this.brokers.length;
      }
      this._setStatus({ connected: false, broker: null, error: (err || 'connection closed') + ` (${this.brokers[idx]})` });
      this._scheduleRetry();
    });
    conn.open();
  }

  _scheduleRetry() {
    if (!this._running) return;
    clearTimeout(this._retryTimer);
    const round = Math.floor(Math.max(0, this._fails - 1) / this.brokers.length);
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** round);
    const delay = Math.min(BACKOFF_MAX_MS, base * (1 + Math.random() * 0.2));
    this._retryTimer = setTimeout(() => this._connect(), this._fails === 0 ? BACKOFF_MIN_MS : delay);
  }

  // All peers must end up on the same broker to see each other: while on a
  // fallback, periodically try the preferred (first) broker and switch if it works.
  _probePrimary() {
    const cur = this._conn;
    if (!this._running || this._probe || !cur || !cur.ready || cur.idx === 0) return;
    const probe = this._newConn(0);
    this._probe = probe;
    probe.on('ready', () => {
      if (this._probe !== probe) return;
      this._probe = null;
      if (!this._running) { probe.kill(); return; }
      clearTimeout(this._retryTimer);
      const old = this._conn;
      this._conn = probe;
      this._sess = probe.sess;
      this._brokerIdx = 0;
      this._fails = 0;
      probe.on('close', (err) => {
        if (this._conn !== probe) return;
        this._conn = null;
        this._sess = null;
        this._brokerIdx = 1 % this.brokers.length;
        this._fails++;
        this._setStatus({ connected: false, broker: null, error: (err || 'connection closed') + ` (${this.brokers[0]})` });
        this._scheduleRetry();
      });
      if (old) { old.removeAllListeners(); old.end(); }
      this._setStatus({ connected: true, broker: this.brokers[0], error: null });
    });
    probe.on('close', () => { if (this._probe === probe) this._probe = null; });
    probe.open();
  }

  _onMessage(topic, payload, retain) {
    if (retain) return;                                   // we never publish retained
    const parts = topic.split('/');
    if (parts.length !== 5 || `${parts[0]}/${parts[1]}` !== TOPIC_ROOT || parts[2] !== this.roomHash) return;
    const pid = parts[3], kind = parts[4];
    if (kind === 'cmd') {
      // Addressed to us (topic carries the recipient), from a phone or a friend.
      if (pid !== this.id) return;
      const msg = this._decrypt(payload);
      if (!msg || msg.t !== 'cmd' || typeof msg.ts !== 'number' || Math.abs(Date.now() - msg.ts) > MAX_AGE_MS) return;
      this._emit('cmd', msg.d, { from: typeof msg.id === 'string' ? msg.id : null });
      return;
    }
    if (kind === 'hello') {
      // A phone on the web app just joined: it needs our route now.
      const msg = this._decrypt(payload);
      if (msg && msg.t === 'hello' && msg.id === pid && Math.abs(Date.now() - msg.ts) <= MAX_AGE_MS) this._emit('hello', pid);
      return;
    }
    if (pid === this.id) return;                          // our own echo
    if (kind !== 'state' && kind !== 'route' && kind !== 'leave') return;
    const msg = this._decrypt(payload);
    if (!msg || msg.t !== kind || msg.id !== pid || typeof msg.ts !== 'number') return;
    const now = Date.now();
    const fresh = now - msg.ts <= MAX_AGE_MS;
    const peer = this.peers.get(pid);

    if (kind === 'leave') {
      // A Last Will carries the ts of its CONNECT, so it may look old: accept it if
      // it belongs to the peer's current session.
      if (!peer) return;
      if (!fresh && !(msg.s && msg.s === peer.sess)) return;
      this._dropPeer(pid);
      return;
    }
    if (!fresh) return;
    const name = typeof msg.name === 'string' ? msg.name.slice(0, NAME_MAX) : '';
    const isNew = !peer;
    this.peers.set(pid, { name, last: now, sess: typeof msg.s === 'string' ? msg.s : null });
    if (isNew) this._setStatus({ peers: this.peers.size });
    if (kind === 'state') this._emit('state', pid, msg.d, { name });
    else this._emit('route', pid, msg.d);
  }

  _expirePeers() {
    const now = Date.now();
    for (const [pid, p] of this.peers) {
      if (now - p.last > PEER_TIMEOUT_MS) this._dropPeer(pid);
    }
  }

  _dropPeer(pid) {
    if (!this.peers.delete(pid)) return;
    this._emit('leave', pid);
    this._setStatus({ peers: this.peers.size });
  }

  _setStatus(patch) {
    const next = { ...this._status, ...patch };
    const s = this._status;
    if (next.connected === s.connected && next.broker === s.broker && next.peers === s.peers && next.error === s.error) return;
    this._status = next;
    this._emit('status', this.status);
  }

  _emit(...args) {
    try { this.emit(...args); } catch (e) {
      // A listener threw: never let it reach socket handlers / crash the host.
      try { console.error('[convoy] listener error:', e?.message || e); } catch { /* ignore */ }
    }
  }
}
