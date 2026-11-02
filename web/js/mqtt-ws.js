// Convoy from the browser: minimal MQTT 3.1.1 client over WebSocket (QoS 0)
// plus the same encryption as server/convoy.js (PBKDF2 -> AES-256-GCM).
// Needs a secure context (https or localhost) for WebCrypto.

export const WS_BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const TOPIC_ROOT = 'ets2map/v2';
const KDF_SALT = 'ets2map-convoy-v2';
const KDF_ITERATIONS = 100_000;
const MAX_AGE_MS = 30_000;
const te = new TextEncoder(), td = new TextDecoder();

export const normalizeRoom = (room) => String(room ?? '').trim().toLowerCase();

async function roomHash(room) {
  const d = await crypto.subtle.digest('SHA-256', te.encode('ets2map-room:' + normalizeRoom(room)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

async function roomKey(room) {
  const base = await crypto.subtle.importKey('raw', te.encode(normalizeRoom(room)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode(KDF_SALT), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

// --- MQTT wire --------------------------------------------------------------

function encLen(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return out;
}
const str = (s) => { const b = te.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
const packet = (type, body) => new Uint8Array([type, ...encLen(body.length), ...body]);

function connectPacket(clientId) {
  const body = [...str('MQTT'), 4, 0x02 /* clean session */, 0, 30 /* keepalive */, ...str(clientId)];
  return packet(0x10, body);
}
const subscribePacket = (topic) => packet(0x82, [0, 1, ...str(topic), 0]);
function publishPacket(topic, payload) {
  const t = str(topic);
  const out = new Uint8Array(1 + 4 + t.length + payload.length);
  const len = encLen(t.length + payload.length);
  out[0] = 0x30;
  out.set(len, 1);
  out.set(t, 1 + len.length);
  out.set(payload, 1 + len.length + t.length);
  return out.subarray(0, 1 + len.length + t.length + payload.length);
}

/**
 * Listens to a convoy room. Callbacks: onState(id, name, d), onRoute(id, d),
 * onLeave(id), onStatus({connected, broker, error}).
 */
export class WebConvoy {
  constructor({ room, callbacks, brokers = WS_BROKERS }) {
    this.room = normalizeRoom(room);
    this.cb = callbacks;
    this.brokers = brokers;
    this.idx = 0;
    this.id = 'web' + Math.random().toString(36).slice(2, 10);
    this.peers = new Map(); // id -> last seen
    this.stopped = false;
  }

  async start() {
    this.key = await roomKey(this.room);
    this.base = `${TOPIC_ROOT}/${await roomHash(this.room)}`;
    this.connect();
    this.expiry = setInterval(() => {
      const now = Date.now();
      for (const [id, at] of this.peers) if (now - at > 15000) { this.peers.delete(id); this.cb.onLeave?.(id); }
    }, 1000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.expiry);
    clearInterval(this.ping);
    clearTimeout(this.retry);
    try { this.ws?.send(new Uint8Array([0xe0, 0])); this.ws?.close(); } catch { /* closing anyway */ }
  }

  connect() {
    if (this.stopped) return;
    const url = this.brokers[this.idx % this.brokers.length];
    let ws;
    try { ws = new WebSocket(url, 'mqtt'); } catch (e) { return this.fail(url, e.message); }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.buf = new Uint8Array(0);
    const timeout = setTimeout(() => ws.close(), 10000);
    ws.onopen = () => ws.send(connectPacket('e2mweb' + Math.random().toString(36).slice(2, 12)));
    ws.onmessage = (e) => this.onData(new Uint8Array(e.data), url, timeout);
    ws.onclose = () => {
      clearTimeout(timeout);
      clearInterval(this.ping);
      if (this.ws === ws) this.fail(url, this.ready ? 'connexion perdue' : 'injoignable');
    };
    ws.onerror = () => {};
  }

  fail(url, error) {
    this.ready = false;
    this.cb.onStatus?.({ connected: false, broker: null, error });
    if (this.stopped) return;
    this.idx++;
    this.retry = setTimeout(() => this.connect(), Math.min(15000, 1000 * this.idx));
  }

  onData(chunk, url, timeout) {
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf);
    b.set(chunk, this.buf.length);
    let off = 0;
    for (;;) {
      if (b.length - off < 2) break;
      let len = 0, mul = 1, i = off + 1, ok = false;
      for (; i < b.length && i < off + 5; i++) {
        len += (b[i] & 127) * mul;
        mul *= 128;
        if (!(b[i] & 128)) { ok = true; i++; break; }
      }
      if (!ok || b.length - i < len) break;
      this.onPacket(b[off], b.subarray(i, i + len), url, timeout);
      off = i + len;
    }
    this.buf = b.slice(off);
  }

  onPacket(first, body, url, timeout) {
    const type = first >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { this.ws.close(); return; }
      this.ws.send(subscribePacket(`${this.base}/+/+`));
    } else if (type === 9) { // SUBACK
      clearTimeout(timeout);
      this.ready = true;
      this.idx = this.brokers.indexOf(url);
      this.ping = setInterval(() => { try { this.ws.send(new Uint8Array([0xc0, 0])); } catch { /* reconnects */ } }, 15000);
      this.cb.onStatus?.({ connected: true, broker: url.replace(/^wss:\/\//, '').replace(/\/mqtt$/, ''), error: null });
      // Tell the PCs a viewer arrived so they resend their routes.
      this.publish(`${this.base}/${this.id}/hello`, 'hello', null);
    } else if (type === 3) { // PUBLISH (QoS 0)
      if (first & 1) return; // retained: never ours
      const tlen = (body[0] << 8) | body[1];
      const topic = td.decode(body.subarray(2, 2 + tlen));
      this.onMessage(topic, body.slice(2 + tlen));
    }
  }

  async onMessage(topic, payload) {
    const parts = topic.split('/');
    if (parts.length !== 5 || `${parts[0]}/${parts[1]}` !== TOPIC_ROOT) return;
    const pid = parts[3], kind = parts[4];
    if (kind === 'cmd' || kind === 'hello' || payload.length < 30) return;
    let msg;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.subarray(0, 12) }, this.key, payload.subarray(12));
      msg = JSON.parse(td.decode(plain));
    } catch { return; }
    if (!msg || msg.t !== kind || msg.id !== pid) return;
    if (kind === 'leave') { if (this.peers.delete(pid)) this.cb.onLeave?.(pid); return; }
    if (Date.now() - msg.ts > MAX_AGE_MS) return;
    this.peers.set(pid, Date.now());
    if (kind === 'state') this.cb.onState?.(pid, String(msg.name ?? '?').slice(0, 32), msg.d);
    else if (kind === 'route') this.cb.onRoute?.(pid, msg.d);
  }

  /** Command for one player's PC (e.g. a destination picked on the map). */
  sendCmd(toId, obj) {
    return this.publish(`${this.base}/${toId}/cmd`, 'cmd', obj);
  }

  async publish(topic, kind, obj) {
    if (!this.ready) return false;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = te.encode(JSON.stringify({ t: kind, id: this.id, name: 'web', d: obj, ts: Date.now(), s: null }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, plain));
    const payload = new Uint8Array(12 + ct.length);
    payload.set(iv);
    payload.set(ct, 12);
    try { this.ws.send(publishPacket(topic, payload)); } catch { return false; }
    return true;
  }
}
