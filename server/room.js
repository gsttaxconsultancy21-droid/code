// One shared LAN game. The server runs the authoritative engine at 60 Hz and
// broadcasts compact snapshots at 20 Hz; clients only send steering input.
import { Game, STEP, POWERUP_TYPES } from '../src/engine/game.js';

const MAX_CLIENTS = 16;
const BROADCAST_EVERY = 3; // steps
const IDLE_SHUTDOWN_MS = 30000;
const REASONS = ['self', 'cut', 'territory', 'clash', 'storm', 'left'];
const LOOK_SLOTS = ['pattern', 'trail', 'hat', 'face'];

export function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14) || 'Player';
}

function cleanLook(look) {
  if (!look || typeof look !== 'object') return null;
  const out = {};
  for (const k of LOOK_SLOTS) if (typeof look[k] === 'string' && /^[a-z]{1,12}$/.test(look[k])) out[k] = look[k];
  return out;
}

export class Room {
  constructor({ botCount = 8, seed = Date.now() } = {}) {
    this.botCount = botCount;
    this.seed = seed;
    this.clients = new Set();
    this.game = null;
    this.timer = null;
    this.idleTimer = null;
  }

  start() {
    const g = new Game({ noHuman: true, persistent: true, botCount: this.botCount, seed: this.seed++, powerups: true });
    g.arena.trackChanges = true;
    g.arena.changes.length = 0;
    this.game = g;
    this.lastOwner = Uint8Array.from(g.arena.owner);
    this.sentPath = new Map();
    this.pending = [];
    this.rosterDirty = true;
    this.last = performance.now();
    this.acc = 0;
    this.timer = setInterval(() => this.tick(), 1000 / 60);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.game = null;
  }

  connect(conn) {
    if (this.clients.size >= MAX_CLIENTS) {
      conn.send(JSON.stringify({ t: 'full' }));
      conn.close(1013);
      return;
    }
    const client = { conn, player: null, welcomed: false, inputs: 0, windowStart: Date.now() };
    this.clients.add(client);
    conn.on('message', (text) => this.onMessage(client, text));
    conn.on('close', () => this.disconnect(client));
  }

  onMessage(client, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const now = Date.now();
    if (now - client.windowStart > 1000) {
      client.windowStart = now;
      client.inputs = 0;
    }
    if (++client.inputs > 120) return; // flood guard

    if (msg.t === 'join' && !client.player) {
      clearTimeout(this.idleTimer);
      if (!this.game) this.start();
      const color = Number.isInteger(msg.color) && msg.color >= 0 && msg.color < 12 ? msg.color : 0;
      client.player = this.game.addHuman({ name: cleanName(msg.name), color, cosmetics: cleanLook(msg.cosmetics) });
      client.welcomed = false;
      this.rosterDirty = true;
    } else if (msg.t === 'in' && client.player && Number.isFinite(msg.a)) {
      this.game.setTarget(client.player, msg.a);
    } else if (msg.t === 'respawn' && client.player) {
      this.game.respawnHuman(client.player);
    }
  }

  disconnect(client) {
    this.clients.delete(client);
    if (client.player && this.game) {
      this.game.removePlayer(client.player);
      this.rosterDirty = true;
    }
    if (!this.clients.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!this.clients.size) this.stop();
      }, IDLE_SHUTDOWN_MS);
    }
  }

  tick() {
    const g = this.game;
    if (!g) return;
    const now = performance.now();
    this.acc = Math.min(this.acc + (now - this.last) / 1000, 0.25);
    this.last = now;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      g.update(STEP);
      if (g.events.length) {
        this.pending.push(...g.events);
        g.events.length = 0;
      }
      if (g.steps % BROADCAST_EVERY === 0) this.broadcast();
    }
  }

  roster() {
    return this.game.players.map((p) => ({
      id: p.id, name: p.name, color: p.color, isBot: p.isBot, isBoss: p.isBoss, cosmetics: p.cosmetics, left: p.left,
    }));
  }

  playerRows() {
    const g = this.game;
    return g.players.map((p) => [
      p.id, Math.round(p.x * 100), Math.round(p.y * 100), Math.round(p.angle * 1000),
      (p.alive ? 1 : 0) | (g.isShielded(p) ? 2 : 0) | (g.isBoosted(p) ? 4 : 0), p.kills,
    ]);
  }

  powerupRows() {
    return this.game.powerups.map((pu) => [pu.id, POWERUP_TYPES.indexOf(pu.type), Math.round(pu.x * 10), Math.round(pu.y * 10)]);
  }

  encodeEvents() {
    const out = [];
    const pos = (v) => Math.round(v * 10);
    for (const e of this.pending) {
      if (e.type === 'death') {
        out.push(['d', e.victim.id, e.killer ? e.killer.id : 0, Math.max(0, REASONS.indexOf(e.reason)), pos(e.x), pos(e.y)]);
      } else if (e.type === 'capture') {
        out.push(['c', e.player.id, e.gained, Math.round(e.pct * 100), pos(e.x), pos(e.y), e.bomb ? 1 : 0]);
      } else if (e.type === 'powerup') {
        out.push(['p', e.player.id, POWERUP_TYPES.indexOf(e.kind), pos(e.x), pos(e.y)]);
      } else if (e.type === 'block') {
        out.push(['b', e.player.id, pos(e.x), pos(e.y)]);
      }
    }
    this.pending.length = 0;
    return out;
  }

  broadcast() {
    const g = this.game;
    const a = g.arena;
    const owner = [];
    for (const i of new Set(a.changes)) {
      if (a.owner[i] !== this.lastOwner[i]) {
        owner.push(i, a.owner[i]);
        this.lastOwner[i] = a.owner[i];
      }
    }
    a.changes.length = 0;

    const pa = {};
    const pr = [];
    for (const p of g.players) {
      const sent = this.sentPath.get(p.id);
      if (!sent || sent.ref !== p.path) {
        if (sent) pr.push(p.id);
        if (p.path.length) pa[p.id] = p.path.map((v) => Math.round(v * 100));
      } else if (p.path.length > sent.len) {
        pa[p.id] = p.path.slice(sent.len).map((v) => Math.round(v * 100));
      }
      this.sentPath.set(p.id, { ref: p.path, len: p.path.length });
    }

    const pathsNow = () => {
      const all = {};
      for (const p of g.players) if (p.path.length) all[p.id] = p.path.map((v) => Math.round(v * 100));
      return all;
    };
    const rows = this.playerRows();
    const pu = this.powerupRows();
    const delta = JSON.stringify({ t: 's', time: g.time, r: a.activeRadius, p: rows, o: owner, pa, pr, pu, e: this.encodeEvents() });
    let rosterText = null;
    if (this.rosterDirty) {
      this.rosterDirty = false;
      rosterText = JSON.stringify({ t: 'roster', players: this.roster() });
    }
    for (const c of this.clients) {
      if (!c.player) continue;
      if (!c.welcomed) {
        // New players get the full state as of this broadcast, then deltas.
        c.welcomed = true;
        c.conn.send(JSON.stringify({
          t: 'welcome',
          id: c.player.id,
          radius: a.radius,
          time: g.time,
          owner: Buffer.from(a.owner).toString('base64'),
          players: this.roster(),
          state: { t: 's', time: g.time, r: a.activeRadius, p: rows, o: [], pa: pathsNow(), pr: [], pu, e: [] },
        }));
        continue;
      }
      if (rosterText) c.conn.send(rosterText);
      c.conn.send(delta);
    }
  }
}
