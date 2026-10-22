// Authoritative game simulation. Runs headless (Node tests, multiplayer server)
// or under the client. Given the same options, seed and inputs per step it
// produces the same game, which is what replays rely on.
import { Arena, WALL, EMPTY } from './arena.js';
import { createRng, clamp, wrapAngle, shuffle } from './util.js';
import { createBrain, updateBot, BOT_KINDS } from './bot.js';
import {
  STEP, PLAYER_SPEED, TURN_RATE, START_RADIUS, BOT_RESPAWN, DEATH_LINGER, POWERUPS, POWERUP_TYPES,
} from './constants.js';

export { STEP, PLAYER_SPEED, TURN_RATE, START_RADIUS, BOT_RESPAWN, DEATH_LINGER, POWERUPS, POWERUP_TYPES };

export const MODES = {
  classic: { id: 'classic', label: 'Classic', timeLimit: 0, winPct: 90, respawn: true },
  rush: { id: 'rush', label: 'Time Rush', timeLimit: 120, winPct: 100, respawn: true },
  // The arena shrinks; nobody respawns. Last blob standing (or most land) wins.
  storm: {
    id: 'storm', label: 'Ink Storm', timeLimit: 150, winPct: 100, respawn: false,
    storm: { start: 10, end: 120, minFrac: 0.3 },
  },
};

export const DIFFICULTIES = {
  easy: { id: 'easy', label: 'Easy', bots: 6, skill: [0.15, 0.45], speed: 0.92 },
  normal: { id: 'normal', label: 'Normal', bots: 9, skill: [0.35, 0.75], speed: 1 },
  hard: { id: 'hard', label: 'Hard', bots: 12, skill: [0.65, 1], speed: 1.04 },
};

export const BOSS_NAME = 'Grand Smudge';
const MAX_STEP = 0.45; // max cells moved per sub-step, keeps trails 4-connected
const HEAD_RADIUS = 0.85;

const BOT_NAMES = [
  'Pixel', 'Mochi', 'Zigzag', 'Nova', 'Biscuit', 'Comet', 'Pebble', 'Tango', 'Maple',
  'Quark', 'Saffron', 'Rocket', 'Juno', 'Waffle', 'Echo', 'Kiwi', 'Blitz', 'Orbit',
  'Noodle', 'Ziggy', 'Pumpkin', 'Atlas', 'Sprout', 'Domino',
];

export const quantizeAngle = (a) => Math.round(wrapAngle(a) * 1000) / 1000;

export class Game {
  constructor(options = {}) {
    const {
      radius = 64,
      seed = Date.now(),
      mode = 'classic',
      difficulty = 'normal',
      playerName = 'You',
      playerColor = 0,
      playerCosmetics = null,
      colorCount = 16,
      botCount,
      demo = false,
      powerups = true,
      bossLevel = null,
      noHuman = false,
      persistent = false,
    } = options;
    this.mode = MODES[mode] || MODES.classic;
    this.difficulty = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
    this.demo = demo;
    this.persistent = persistent;
    this.powerupsEnabled = powerups;
    this.colorCount = colorCount;
    this.rng = createRng(seed);
    this.arena = new Arena(radius);
    this.players = [];
    this.events = [];
    this.powerups = [];
    this.nextPowerupId = 1;
    this.powerupTimer = 3;
    this.time = 0;
    this.steps = 0;
    this.finished = false;
    this.result = null;

    this.human = noHuman
      ? null
      : this.addPlayer({
        name: playerName, isBot: demo, color: playerColor, skill: 0.6, kind: 'explorer', cosmetics: playerCosmetics,
      });

    const bots = botCount ?? this.difficulty.bots;
    const names = shuffle(BOT_NAMES.slice(), this.rng);
    const colors = [];
    for (let i = 0; i < colorCount; i++) if (i !== playerColor) colors.push(i);
    shuffle(colors, this.rng);
    const [lo, hi] = this.difficulty.skill;
    for (let i = 0; i < bots; i++) {
      const boss = i === 0 && bossLevel !== null;
      this.addPlayer({
        name: boss ? BOSS_NAME : names[i % names.length],
        isBot: true,
        color: colors[i % colors.length],
        skill: boss ? 0.75 + 0.25 * clamp(bossLevel, 0, 1) : lo + (hi - lo) * this.rng(),
        kind: boss ? 'boss' : BOT_KINDS[Math.floor(this.rng() * BOT_KINDS.length)],
        isBoss: boss,
        speedMul: boss ? 1.03 + 0.04 * clamp(bossLevel, 0, 1) : 1,
      });
    }
  }

  makePlayer(id, { name, isBot, color, skill = 0.5, kind = 'explorer', isBoss = false, speedMul = 1, cosmetics = null }) {
    const botSpeed = isBot && !this.demo ? this.difficulty.speed : 1;
    return {
      id,
      name,
      color,
      isBot,
      skill,
      kind,
      isBoss,
      cosmetics,
      x: 0,
      y: 0,
      angle: 0,
      targetAngle: 0,
      baseSpeed: PLAYER_SPEED * botSpeed * speedMul,
      alive: false,
      left: false,
      cell: -1,
      trail: [],
      // Exact positions where trail cells were entered, for smooth trail drawing.
      path: [],
      box: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      kills: 0,
      deaths: 0,
      captures: 0,
      peakPct: 0,
      respawnAt: 0,
      deathTime: 0,
      spawnTime: 0,
      countAtDeath: 0,
      speedUntil: 0,
      shieldUntil: 0,
      lastBlock: -1,
      brain: null,
    };
  }

  addPlayer(cfg) {
    const p = this.makePlayer(this.players.length + 1, cfg);
    this.players.push(p);
    this.spawn(p);
    return p;
  }

  // Multiplayer: add a human, reusing the slot of someone who left.
  addHuman({ name, color, cosmetics = null }) {
    const slot = this.players.find((q) => q.left);
    if (!slot) return this.addPlayer({ name, isBot: false, color, cosmetics });
    const p = this.makePlayer(slot.id, { name, isBot: false, color, cosmetics });
    this.players[slot.id - 1] = p;
    this.spawn(p);
    return p;
  }

  removePlayer(p) {
    if (p.alive) this.kill(p, null, 'left');
    p.left = true;
  }

  respawnHuman(p) {
    if (p.alive || p.left || p.isBot) return;
    p.kills = 0;
    p.captures = 0;
    p.peakPct = 0;
    this.spawn(p);
  }

  spawn(p) {
    const a = this.arena;
    const rng = this.rng;
    const r = START_RADIUS;
    const c = a.center + 0.5;
    const discArea = this.discCells(a.center, a.center, r + 2).length;
    let best = null;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 60; attempt++) {
      const ang = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * Math.max(1, a.activeRadius - r - 7);
      const x = Math.floor(c + Math.cos(ang) * dist);
      const y = Math.floor(c + Math.sin(ang) * dist);
      let free = 0;
      for (const [dx, dy] of this.discCells(x, y, r + 2)) {
        const i = a.index(dx, dy);
        if (a.owner[i] === EMPTY && a.trail[i] === EMPTY) free++;
      }
      let nearHeads = 0;
      for (const q of this.players) {
        if (q.alive && q !== p && Math.hypot(q.x - x, q.y - y) < 12) nearHeads++;
      }
      const score = free - nearHeads * 40;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
      if (nearHeads === 0 && free === discArea) break;
    }

    const { x, y } = best;
    for (const [dx, dy] of this.discCells(x, y, r)) {
      const i = a.index(dx, dy);
      if (a.trail[i] === EMPTY) a.setOwner(i, p.id);
    }
    p.x = x + 0.5;
    p.y = y + 0.5;
    p.cell = a.index(x, y);
    p.box = { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r };
    p.trail = [];
    p.path = [];
    p.alive = true;
    p.speedUntil = 0;
    p.shieldUntil = 0;
    p.angle = rng() * Math.PI * 2 - Math.PI;
    p.targetAngle = p.angle;
    p.spawnTime = this.time;
    if (p.isBot) p.brain = createBrain(p.skill, p.kind);
    this.events.push({ type: 'spawn', player: p, x: p.x, y: p.y });

    for (const q of this.players) {
      if (q !== p && q.alive && a.counts[q.id] <= 0) this.kill(q, p, 'territory');
    }
  }

  discCells(cx, cy, r) {
    const cells = [];
    const a = this.arena;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r + r) continue;
        if (a.isPlayable(cx + dx, cy + dy)) cells.push([cx + dx, cy + dy]);
      }
    }
    return cells;
  }

  setTarget(p, angle) {
    if (p && p.alive && !p.isBot) p.targetAngle = quantizeAngle(angle);
  }

  setHumanTarget(angle) {
    this.setTarget(this.human, angle);
  }

  pctOf(p) {
    const count = p.alive ? this.arena.counts[p.id] : p.countAtDeath;
    return (count / Math.max(1, this.arena.playable)) * 100;
  }

  timeLeft() {
    return this.mode.timeLimit ? Math.max(0, this.mode.timeLimit - this.time) : null;
  }

  leaderboard() {
    return this.players
      .filter((p) => p.alive && !p.left)
      .map((p) => ({ player: p, pct: this.pctOf(p) }))
      .sort((x, y) => y.pct - x.pct);
  }

  isBoosted(p) {
    return this.time < p.speedUntil;
  }

  isShielded(p) {
    return this.time < p.shieldUntil;
  }

  update(dt = STEP) {
    if (this.finished) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.steps++;
    this.updateStorm();

    const respawn = this.mode.respawn || this.persistent;
    for (const p of this.players) {
      if (p.left) continue;
      if (p.alive) {
        if (p.isBot) updateBot(this, p, dt);
      } else if (p.isBot && respawn && this.time >= p.respawnAt) {
        this.spawn(p);
      }
    }
    this.updatePowerups(dt);

    const fastest = PLAYER_SPEED * 1.15 * POWERUPS.speed.factor;
    const steps = Math.max(1, Math.ceil((fastest * dt) / MAX_STEP));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (const p of this.players) if (p.alive) this.stepPlayer(p, h);
      this.resolveHeads();
    }

    for (const p of this.players) {
      if (p.alive) p.peakPct = Math.max(p.peakPct, this.pctOf(p));
    }
    this.checkEnd();
  }

  stormRadius(time = this.time) {
    const st = this.mode.storm;
    const r0 = this.arena.radius - 1;
    if (!st) return r0;
    const k = clamp((time - st.start) / (st.end - st.start), 0, 1);
    return r0 - (r0 - r0 * st.minFrac) * k;
  }

  updateStorm() {
    if (!this.mode.storm) return;
    const a = this.arena;
    const r = this.stormRadius();
    if (r >= a.activeRadius - 0.05) return;
    const hits = a.shrinkTo(r);
    for (const id of hits) this.kill(this.players[id - 1], null, 'storm');
    for (const q of this.players) {
      if (q.alive && a.counts[q.id] <= 0) this.kill(q, null, 'storm');
    }
    const c = a.center + 0.5;
    this.powerups = this.powerups.filter((pu) => Math.hypot(pu.x - c, pu.y - c) < r - 2);
  }

  updatePowerups(dt) {
    if (!this.powerupsEnabled) return;
    this.powerupTimer -= dt;
    if (this.powerupTimer > 0) return;
    const rng = this.rng;
    this.powerupTimer = 4 + rng() * 3;
    const alive = this.players.filter((p) => p.alive).length;
    if (this.powerups.length >= 3 + Math.floor(alive / 3)) return;
    const a = this.arena;
    const c = a.center + 0.5;
    for (let attempt = 0; attempt < 25; attempt++) {
      const ang = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * Math.max(1, a.activeRadius - 5);
      const x = Math.floor(c + Math.cos(ang) * dist);
      const y = Math.floor(c + Math.sin(ang) * dist);
      if (!a.isPlayable(x, y)) continue;
      const i = a.index(x, y);
      if (a.trail[i] !== EMPTY || (a.owner[i] !== EMPTY && attempt < 15)) continue;
      const type = POWERUP_TYPES[Math.floor(rng() * POWERUP_TYPES.length)];
      this.powerups.push({ id: this.nextPowerupId++, type, x: x + 0.5, y: y + 0.5 });
      return;
    }
  }

  applyPowerup(p, pu) {
    const a = this.arena;
    if (pu.type === 'speed') p.speedUntil = this.time + POWERUPS.speed.duration;
    else if (pu.type === 'shield') p.shieldUntil = this.time + POWERUPS.shield.duration;
    this.events.push({ type: 'powerup', player: p, kind: pu.type, x: pu.x, y: pu.y });
    if (pu.type !== 'bomb') return;

    // Ink bomb: instantly claim a disc around the head (never over trails).
    const hx = Math.floor(p.x);
    const hy = Math.floor(p.y);
    const r = POWERUPS.bomb.radius;
    a.captured = [];
    for (const [x, y] of this.discCells(hx, hy, r)) {
      const i = a.index(x, y);
      if (a.trail[i] === EMPTY) a.setOwner(i, p.id);
    }
    const cells = a.captured;
    a.captured = null;
    p.box.minX = Math.min(p.box.minX, hx - r);
    p.box.minY = Math.min(p.box.minY, hy - r);
    p.box.maxX = Math.max(p.box.maxX, hx + r);
    p.box.maxY = Math.max(p.box.maxY, hy + r);
    this.events.push({
      type: 'capture', player: p, gained: cells.length, pct: (cells.length / a.playable) * 100, x: p.x, y: p.y, cells, bomb: true,
    });
    for (const q of this.players) {
      if (q !== p && q.alive && a.counts[q.id] <= 0) this.kill(q, p, 'territory');
    }
  }

  stepPlayer(p, dt) {
    const a = this.arena;
    const diff = wrapAngle(p.targetAngle - p.angle);
    const maxTurn = TURN_RATE * dt;
    p.angle = wrapAngle(p.angle + clamp(diff, -maxTurn, maxTurn));

    const speed = p.baseSpeed * (this.isBoosted(p) ? POWERUPS.speed.factor : 1);
    let nx = p.x + Math.cos(p.angle) * speed * dt;
    let ny = p.y + Math.sin(p.angle) * speed * dt;
    // The arena edge is solid: slide along it instead of leaving the map.
    const c = a.center + 0.5;
    const dx = nx - c;
    const dy = ny - c;
    const d = Math.hypot(dx, dy);
    const lim = a.activeRadius - 1.5;
    if (d > lim) {
      nx = c + (dx / d) * lim;
      ny = c + (dy / d) * lim;
    }

    const ox = Math.floor(p.x);
    const oy = Math.floor(p.y);
    p.x = nx;
    p.y = ny;
    const cx = Math.floor(nx);
    const cy = Math.floor(ny);
    if (cx !== ox || cy !== oy) {
      // Diagonal step: visit an orthogonal neighbour first so the trail never has
      // diagonal gaps the enclosure flood fill could leak through.
      if (cx !== ox && cy !== oy) {
        let mid = a.index(cx, oy);
        if (a.owner[mid] === WALL) mid = a.index(ox, cy);
        if (a.owner[mid] !== WALL) {
          this.enterCell(p, mid);
          if (!p.alive) return;
        }
      }
      p.cell = a.index(cx, cy);
      this.enterCell(p, p.cell);
      if (!p.alive) return;
    }

    for (let k = this.powerups.length - 1; k >= 0; k--) {
      const pu = this.powerups[k];
      if (Math.abs(pu.x - p.x) < 1.2 && Math.abs(pu.y - p.y) < 1.2) {
        this.powerups.splice(k, 1);
        this.applyPowerup(p, pu);
      }
    }
  }

  enterCell(p, c) {
    const a = this.arena;
    if (a.owner[c] === WALL) return;
    const t = a.trail[c];
    if (t !== EMPTY) {
      if (t === p.id) {
        // Brushing the cells just laid down is not a collision.
        if (p.trail.lastIndexOf(c) >= p.trail.length - 2) return;
        this.kill(p, p, 'self');
        return;
      }
      const victim = this.players[t - 1];
      if (victim && victim.alive) {
        const n = victim.trail.length;
        if (victim.trail.lastIndexOf(c) >= n - 2 && Math.hypot(victim.x - p.x, victim.y - p.y) < 1.6) {
          // Ran into the other blob's head, not its trail.
          this.headOn(p, victim);
          if (!p.alive) return;
        } else if (this.isShielded(victim)) {
          if (this.time - victim.lastBlock > 0.5) {
            victim.lastBlock = this.time;
            this.events.push({ type: 'block', player: victim, by: p, x: p.x, y: p.y });
          }
        } else {
          this.kill(victim, p, 'cut');
        }
      }
    }
    if (a.owner[c] === p.id) {
      if (p.trail.length) this.closeLoop(p);
    } else {
      a.setTrail(c, p.id);
      p.trail.push(c);
      p.path.push(p.x, p.y);
    }
  }

  resolveHeads() {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p.alive) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const q = ps[j];
        if (!q.alive) continue;
        if (Math.abs(p.x - q.x) < HEAD_RADIUS && Math.abs(p.y - q.y) < HEAD_RADIUS) this.headOn(p, q);
        if (!p.alive) break;
      }
    }
  }

  // Head-on collision: a shield wins, otherwise the shorter trail wins
  // (a blob at home has no trail). Equal trails knock both out.
  headOn(p, q) {
    if (!p.alive || !q.alive) return;
    const lp = p.trail.length;
    const lq = q.trail.length;
    if (lp === 0 && lq === 0) return;
    const sp = this.isShielded(p);
    const sq = this.isShielded(q);
    if (sp !== sq) {
      if (sp) this.kill(q, p, 'clash');
      else this.kill(p, q, 'clash');
    } else if (lp < lq) {
      this.kill(q, p, 'clash');
    } else if (lq < lp) {
      this.kill(p, q, 'clash');
    } else {
      this.kill(p, q, 'clash');
      this.kill(q, p, 'clash');
    }
  }

  closeLoop(p) {
    const a = this.arena;
    const cells = a.capture(p.id, p.trail, p.box);
    p.trail = [];
    p.path = [];
    p.captures++;
    this.events.push({
      type: 'capture', player: p, gained: cells.length, pct: (cells.length / a.playable) * 100, x: p.x, y: p.y, cells,
    });
    for (const q of this.players) {
      if (q !== p && q.alive && a.counts[q.id] <= 0) this.kill(q, p, 'territory');
    }
  }

  kill(victim, killer, reason) {
    if (!victim || !victim.alive) return;
    const a = this.arena;
    victim.alive = false;
    victim.deaths++;
    victim.deathTime = this.time;
    victim.countAtDeath = Math.max(0, a.counts[victim.id]);
    a.clearTrail(victim.trail, victim.id);
    victim.trail = [];
    victim.path = [];
    victim.speedUntil = 0;
    victim.shieldUntil = 0;
    a.releaseOwner(victim.id);
    if (killer && killer !== victim) killer.kills++;
    if (victim.isBot) victim.respawnAt = this.time + BOT_RESPAWN;
    this.events.push({ type: 'death', victim, killer, reason, x: victim.x, y: victim.y });
  }

  checkEnd() {
    if (this.demo || this.persistent || !this.human) return;
    const h = this.human;
    if (!h.alive) {
      if (this.time - h.deathTime >= DEATH_LINGER) this.finish('defeat');
      return;
    }
    if (this.pctOf(h) >= this.mode.winPct) {
      this.finish('victory');
      return;
    }
    if (!this.mode.respawn && !this.players.some((q) => q !== h && q.alive)) {
      this.finish('victory');
      return;
    }
    if (this.mode.timeLimit && this.time >= this.mode.timeLimit) this.finish('timeup');
  }

  finish(reason) {
    const h = this.human;
    const pct = this.pctOf(h);
    const rank = 1 + this.players.filter((q) => q !== h && q.alive && this.pctOf(q) > pct).length;
    this.finished = true;
    this.result = {
      reason,
      mode: this.mode.id,
      pct,
      peakPct: Math.max(h.peakPct, pct),
      kills: h.kills,
      captures: h.captures,
      rank,
      players: this.players.length,
      time: this.time,
      won: reason === 'victory' || (reason === 'timeup' && rank === 1),
    };
    this.events.push({ type: 'finish', result: this.result });
  }
}
