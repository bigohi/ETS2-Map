// Convoy glue: shares this truck with friends in the same room (through
// server/convoy.js) and relays their trucks and routes to the phones.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Convoy } from './convoy.js';

const STATE_EVERY_MS = 500;
const ROUTE_REPEAT_MS = 45_000;

export class ConvoyHub {
  constructor({ configPath, broadcast, brokers }) {
    this.configPath = configPath;
    this.broadcast = broadcast;   // (event, dataText) -> void
    this.brokers = brokers;
    this.config = this.loadConfig();
    this.convoy = null;
    this.peers = new Map();       // id -> { id, name, state, at }
    this.peerRoutes = new Map();  // id -> route
    this.lastState = 0;
    this.myRoute = null;
    this.routeTimer = setInterval(() => this.republishRoute(), ROUTE_REPEAT_MS);
    this.routeTimer.unref();
  }

  loadConfig() {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(this.configPath, 'utf8')); } catch { /* first run */ }
    if (!c.id) c.id = crypto.randomBytes(6).toString('hex');
    c.name ??= '';
    c.room ??= '';
    return c;
  }

  saveConfig() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /** Join (or leave with room = '') and remember the choice. */
  configure({ name, room }) {
    if (typeof name === 'string') this.config.name = name.trim().slice(0, 24);
    if (typeof room === 'string') this.config.room = room.trim().slice(0, 64);
    this.saveConfig();
    this.restart();
    return this.info();
  }

  restart() {
    if (this.convoy) {
      const old = this.convoy;
      this.convoy = null;
      old.removeAllListeners();
      old.stop();
    }
    for (const id of this.peers.keys()) this.broadcast('peerleave', JSON.stringify({ id }));
    this.peers.clear();
    this.peerRoutes.clear();
    if (!this.config.room) { this.sendStatus(); return; }

    const c = new Convoy({ room: this.config.room, name: this.config.name || 'Routier', id: this.config.id, brokers: this.brokers });
    let wasConnected = false;
    c.on('status', (st) => {
      // Just (re)connected: our route may have been dropped while offline.
      if (st.connected && !wasConnected) setTimeout(() => this.republishRoute(), 300).unref();
      wasConnected = st.connected;
      this.sendStatus();
    });
    c.on('state', (id, state, meta) => {
      // A friend just showed up: send them our route without waiting.
      if (!this.peers.has(id)) setTimeout(() => this.republishRoute(), 300).unref();
      const p = { id, name: meta?.name ?? state?.name ?? '?', state, at: Date.now() };
      this.peers.set(id, p);
      this.broadcast('peer', JSON.stringify(p));
    });
    c.on('route', (id, route) => {
      this.peerRoutes.set(id, route);
      this.broadcast('peerroute', JSON.stringify({ id, route }));
    });
    c.on('leave', (id) => {
      this.peers.delete(id);
      this.peerRoutes.delete(id);
      this.broadcast('peerleave', JSON.stringify({ id }));
      this.sendStatus();
    });
    this.convoy = c;
    c.start();
    console.log(`Convoy: joining room as "${this.config.name || 'Routier'}"`);
    this.sendStatus();
    // Friends who just joined need our route.
    setTimeout(() => this.republishRoute(), 1500).unref();
  }

  info() {
    const st = this.convoy?.status ?? { connected: false, broker: null, peers: 0, error: null };
    return {
      name: this.config.name,
      room: this.config.room,
      id: this.config.id,
      active: !!this.config.room,
      connected: st.connected,
      broker: st.broker ? st.broker.replace(/^mqtts?:\/\//, '') : null,
      error: st.error,
      peers: this.peers.size,
    };
  }

  sendStatus() {
    this.broadcast('convoy', JSON.stringify(this.info()));
  }

  /** Initial state for a phone that just connected. */
  snapshot() {
    const out = [`event: convoy\ndata: ${JSON.stringify(this.info())}\n\n`];
    for (const p of this.peers.values()) out.push(`event: peer\ndata: ${JSON.stringify(p)}\n\n`);
    for (const [id, route] of this.peerRoutes) out.push(`event: peerroute\ndata: ${JSON.stringify({ id, route })}\n\n`);
    return out.join('');
  }

  onTelemetry(t) {
    if (!this.convoy) return;
    const now = Date.now();
    if (now - this.lastState < STATE_EVERY_MS) return;
    if (t.x === 0 && t.z === 0) return;
    this.lastState = now;
    this.convoy.publishState({
      x: Math.round(t.x * 10) / 10, z: Math.round(t.z * 10) / 10, h: Math.round(t.h * 1e5) / 1e5,
      spd: Math.round(t.spd * 10) / 10, paused: !!t.paused,
      truck: t.truck ? `${t.truck.brand ?? ''} ${t.truck.name ?? ''}`.trim() : '',
      job: t.job ? { dst: t.job.dst, dstCo: t.job.dstCo, cargo: t.job.cargo } : null,
      nd: Math.round(t.nd ?? 0),
    });
  }

  onRoute(route) {
    this.myRoute = route && !route.none ? route : null;
    this.convoy?.publishRoute(this.myRoute ?? { none: true });
  }

  republishRoute() {
    if (this.convoy && this.myRoute) this.convoy.publishRoute(this.myRoute);
  }
}
