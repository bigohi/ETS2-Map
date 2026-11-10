// Convoy glue: shares this truck with friends in the same room (through
// server/convoy.js) and relays their trucks and routes to the phones.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Convoy } from './convoy.js';

// 4 per second: enough for a smooth truck on a phone that follows us online.
const STATE_EVERY_MS = 250;
const ROUTE_REPEAT_MS = 30_000;

export class ConvoyHub {
  constructor({ configPath, broadcast, brokers, onCommand }) {
    this.configPath = configPath;
    this.broadcast = broadcast;   // (event, dataText) -> void
    this.onCommand = onCommand;   // (cmd, { from }) -> void, from phones on the web app
    this.brokers = brokers;
    this.config = this.loadConfig();
    this.convoy = null;
    this.peers = new Map();       // id -> { id, name, state, at }
    this.peerRoutes = new Map();  // id -> route
    this.lastState = 0;
    this.myRoute = null;
    this.routeTimer = setInterval(() => this.republishRoute(), ROUTE_REPEAT_MS);
    this.routeTimer.unref();
    // Visible in the convoy even before the truck is on the road ("ETS2 pas lancé"),
    // so friends can tell "not in game" from "not connected".
    this.lastDriveAt = 0;
    this.presenceTimer = setInterval(() => {
      if (this.convoy && Date.now() - this.lastDriveAt > 5000) this.convoy.publishState({ v: 1, offline: true, why: this.why ?? null });
    }, 2000);
    this.presenceTimer.unref();
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
      if (st.connected !== wasConnected) {
        console.log(st.connected
          ? `[convoi] connecté à ${String(st.broker).replace(/^mqtts?:\/\//, '')} (code « ${this.config.room} »)`
          : `[convoi] déconnecté${st.error ? ' : ' + st.error : ''}, nouvel essai…`);
      }
      wasConnected = st.connected;
      this.sendStatus();
    });
    c.on('state', (id, state, meta) => {
      // A friend just showed up: send them our route without waiting.
      if (!this.peers.has(id)) {
        setTimeout(() => this.republishRoute(), 300).unref();
        console.log(`[convoi] + ${meta?.name ?? '?'} ${state?.offline ? '(ETS2 pas lancé)' : '(en jeu)'}`);
      } else if (!!this.peers.get(id).state?.offline !== !!state?.offline) {
        console.log(`[convoi] ${meta?.name ?? '?'} ${state?.offline ? 'a quitté la route' : 'est en jeu'}`);
      }
      const p = { id, name: meta?.name ?? state?.name ?? '?', state, at: Date.now(), ts: meta?.ts };
      this.peers.set(id, p);
      this.broadcast('peer', JSON.stringify(p));
    });
    c.on('route', (id, route) => {
      this.peerRoutes.set(id, route);
      this.broadcast('peerroute', JSON.stringify({ id, route }));
    });
    c.on('hello', () => setTimeout(() => this.republishRoute(), 300 + Math.random() * 700).unref());
    c.on('cmd', (cmd, meta) => {
      try { this.onCommand?.(cmd, meta); } catch (err) { console.error(`[convoy] command: ${err.message}`); }
    });
    c.on('leave', (id) => {
      if (this.peers.has(id)) console.log(`[convoi] - ${this.peers.get(id).name}`);
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
    this.lastDriveAt = now;
    this.lastState = now;
    // The whole HUD, so a phone on the web app can show this truck as "me".
    const r1 = (v) => Math.round(v * 10) / 10;
    this.convoy.publishState({
      v: 1, x: r1(t.x), z: r1(t.z), h: Math.round(t.h * 1e5) / 1e5, paused: !!t.paused,
      spd: r1(t.spd), cc: r1(t.cc), lim: r1(t.lim), nd: Math.round(t.nd ?? 0), nt: Math.round(t.nt ?? 0),
      fuel: r1(t.fuel), range: Math.round(t.range ?? 0), gt: t.gt, rest: t.rest, gear: t.gear, scale: t.scale,
      truck: t.truck ?? null, job: t.job ?? null,
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
