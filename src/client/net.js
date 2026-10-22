// Same-Wi-Fi multiplayer client. The local server runs the real simulation;
// RemoteGame mirrors its state from snapshots and exposes the same surface the
// renderer and HUD use for a local Game.
import { Arena, WALL } from '../engine/arena.js';
import { PLAYER_SPEED, POWERUPS, POWERUP_TYPES } from '../engine/constants.js';
import { wrapAngle } from '../engine/util.js';

const REASONS = ['self', 'cut', 'territory', 'clash', 'storm', 'left'];
const MAX_EXTRAPOLATE = 0.15;

export const ONLINE_MODE = { id: 'online', label: 'Wi-Fi', timeLimit: 0, winPct: 100, respawn: true };

function decodeBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class RemoteGame {
  constructor(welcome) {
    this.mode = ONLINE_MODE;
    this.online = true;
    this.arena = new Arena(welcome.radius);
    const a = this.arena;
    a.owner.set(decodeBytes(welcome.owner));
    a.counts.fill(0);
    a.playable = 0;
    for (let i = 0; i < a.owner.length; i++) {
      if (a.owner[i] !== WALL) {
        a.playable++;
        a.counts[a.owner[i]]++;
      }
    }
    a.ownerVersion++;
    this.players = [];
    this.powerups = [];
    this.events = [];
    this.time = welcome.time;
    this.finished = false;
    this.rosterVersion = 0;
    this.applyRoster(welcome.players);
    this.human = this.players[welcome.id - 1];
    this.applySnapshot(welcome.state, true);
  }

  playerSlot(id) {
    let p = this.players[id - 1];
    if (!p) {
      p = {
        id, name: '', color: 0, isBot: true, isBoss: false, cosmetics: null, x: 0, y: 0, angle: 0,
        alive: false, left: false, path: [], kills: 0, peakPct: 0, shieldUntil: 0, speedUntil: 0,
        net: null, countAtDeath: 0,
      };
      this.players[id - 1] = p;
    }
    return p;
  }

  applyRoster(list) {
    for (const r of list) {
      const p = this.playerSlot(r.id);
      p.name = r.name;
      p.color = r.color;
      p.isBot = r.isBot;
      p.isBoss = r.isBoss;
      p.cosmetics = r.cosmetics;
      p.left = r.left;
    }
    this.rosterVersion++;
  }

  applySnapshot(s, initial = false) {
    const a = this.arena;
    const gainedBy = new Map();
    for (let k = 0; k < s.o.length; k += 2) {
      const i = s.o[k];
      const owner = s.o[k + 1];
      if (owner === WALL) {
        if (a.owner[i] !== WALL) {
          a.counts[a.owner[i]]--;
          a.owner[i] = WALL;
          a.playable--;
          a.ownerVersion++;
          if (a.trackChanges) a.changes.push(i);
        }
        continue;
      }
      a.setOwner(i, owner);
      if (owner) {
        let list = gainedBy.get(owner);
        if (!list) gainedBy.set(owner, (list = []));
        list.push(i);
      }
    }
    if (s.r) a.activeRadius = s.r;

    const now = performance.now() / 1000;
    for (const row of s.p) {
      const [id, x100, y100, a1000, flags, kills] = row;
      const p = this.playerSlot(id);
      const alive = (flags & 1) === 1;
      const x = x100 / 100;
      const y = y100 / 100;
      if (alive && (!p.alive || !p.net || Math.hypot(x - p.x, y - p.y) > 4)) {
        p.x = x;
        p.y = y;
      }
      if (!alive && p.alive) p.countAtDeath = a.counts[id];
      p.alive = alive;
      p.angle = a1000 / 1000;
      p.kills = kills;
      p.shieldUntil = flags & 2 ? Infinity : 0;
      p.speedUntil = flags & 4 ? Infinity : 0;
      p.net = { x, y, angle: p.angle, at: now };
    }
    for (const id of s.pr || []) this.playerSlot(id).path = [];
    for (const [id, pts] of Object.entries(s.pa || {})) {
      const p = this.playerSlot(Number(id));
      for (const v of pts) p.path.push(v / 100);
    }
    this.powerups = (s.pu || []).map(([id, t, x, y]) => ({ id, type: POWERUP_TYPES[t], x: x / 10, y: y / 10 }));
    this.time = s.time;
    if (initial) return;

    for (const e of s.e || []) {
      const kind = e[0];
      if (kind === 'd') {
        this.events.push({
          type: 'death', victim: this.playerSlot(e[1]), killer: e[2] ? this.playerSlot(e[2]) : null,
          reason: REASONS[e[3]] || 'cut', x: e[4] / 10, y: e[5] / 10,
        });
      } else if (kind === 'c') {
        this.events.push({
          type: 'capture', player: this.playerSlot(e[1]), gained: e[2], pct: e[3] / 100,
          x: e[4] / 10, y: e[5] / 10, bomb: !!e[6], cells: gainedBy.get(e[1]) || [],
        });
      } else if (kind === 'p') {
        this.events.push({ type: 'powerup', player: this.playerSlot(e[1]), kind: POWERUP_TYPES[e[2]], x: e[3] / 10, y: e[4] / 10 });
      } else if (kind === 'b') {
        this.events.push({ type: 'block', player: this.playerSlot(e[1]), x: e[2] / 10, y: e[3] / 10 });
      }
    }
  }

  // Dead-reckons every blob forward from its last snapshot and eases the
  // displayed position toward it.
  update(dt) {
    this.time += dt;
    const now = performance.now() / 1000;
    const ease = 1 - Math.exp(-dt * 18);
    for (const p of this.players) {
      if (!p || !p.alive || !p.net) continue;
      const age = Math.min(now - p.net.at, MAX_EXTRAPOLATE);
      const speed = PLAYER_SPEED * (p.speedUntil > this.time ? POWERUPS.speed.factor : 1);
      const tx = p.net.x + Math.cos(p.net.angle) * speed * age;
      const ty = p.net.y + Math.sin(p.net.angle) * speed * age;
      p.x += (tx - p.x) * ease;
      p.y += (ty - p.y) * ease;
      p.angle += wrapAngle(p.net.angle - p.angle) * ease;
    }
  }

  pctOf(p) {
    const count = p.alive ? this.arena.counts[p.id] : p.countAtDeath;
    return (count / Math.max(1, this.arena.playable)) * 100;
  }

  timeLeft() {
    return null;
  }

  isShielded(p) {
    return p.shieldUntil > this.time;
  }

  isBoosted(p) {
    return p.speedUntil > this.time;
  }

  leaderboard() {
    return this.players
      .filter((p) => p && p.alive && !p.left)
      .map((p) => ({ player: p, pct: this.pctOf(p) }))
      .sort((x, y) => y.pct - x.pct);
  }
}

// Builds the WebSocket URL for a host typed by the player ("192.168.1.5:8080")
// or, when empty, the server that served this page.
export function serverUrl(address) {
  const addr = (address || '').trim().replace(/^(https?|wss?):\/\//, '').replace(/\/.*$/, '');
  if (addr) return `ws://${addr}/ws`;
  if (/^https?:$/.test(location.protocol)) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  return null;
}

export class Connection {
  constructor(url, hello, handlers) {
    this.handlers = handlers;
    this.game = null;
    this.closed = false;
    this.lastAngle = null;
    this.lastSent = 0;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.send({ t: 'join', ...hello });
    this.ws.onmessage = (ev) => this.receive(ev.data);
    this.ws.onclose = () => this.close('closed');
    this.ws.onerror = () => this.close('error');
  }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  receive(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === 'welcome') {
      this.game = new RemoteGame(msg);
      this.handlers.onReady(this.game);
    } else if (!this.game) {
      if (msg.t === 'full') this.close('full');
    } else if (msg.t === 's') {
      this.game.applySnapshot(msg);
    } else if (msg.t === 'roster') {
      this.game.applyRoster(msg.players);
      this.handlers.onRoster();
    }
  }

  steer(angle) {
    const now = performance.now();
    if (angle === this.lastAngle || now - this.lastSent < 30) return;
    this.lastAngle = angle;
    this.lastSent = now;
    this.send({ t: 'in', a: Math.round(angle * 1000) / 1000 });
  }

  respawn() {
    this.send({ t: 'respawn' });
  }

  close(reason = 'left') {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    this.handlers.onClose(reason, !!this.game);
  }
}
