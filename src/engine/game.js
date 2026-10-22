// Authoritative game simulation. Runs headless (Node tests) or under the client.
import { Arena, WALL, EMPTY } from './arena.js';
import { createRng, clamp, wrapAngle, shuffle } from './util.js';
import { createBrain, updateBot } from './bot.js';

export const MODES = {
  classic: { id: 'classic', label: 'Classic', timeLimit: 0, winPct: 90 },
  rush: { id: 'rush', label: 'Time Rush', timeLimit: 120, winPct: 100 },
};

export const DIFFICULTIES = {
  easy: { id: 'easy', label: 'Easy', bots: 6, skill: [0.15, 0.45], speed: 0.92 },
  normal: { id: 'normal', label: 'Normal', bots: 9, skill: [0.35, 0.75], speed: 1 },
  hard: { id: 'hard', label: 'Hard', bots: 12, skill: [0.65, 1], speed: 1.04 },
};

export const PLAYER_SPEED = 6.5; // cells per second
export const TURN_RATE = 10; // radians per second
export const START_RADIUS = 3;
export const BOT_RESPAWN = 2.5; // seconds
export const DEATH_LINGER = 1.25; // seconds before the human's game ends
const MAX_STEP = 0.45; // max cells moved per sub-step, keeps trails 4-connected

const BOT_NAMES = [
  'Pixel', 'Mochi', 'Zigzag', 'Nova', 'Biscuit', 'Comet', 'Pebble', 'Tango', 'Maple',
  'Quark', 'Saffron', 'Rocket', 'Juno', 'Waffle', 'Echo', 'Kiwi', 'Blitz', 'Orbit',
  'Noodle', 'Ziggy', 'Pumpkin', 'Atlas', 'Sprout', 'Domino',
];

export class Game {
  constructor(options = {}) {
    const {
      radius = 64,
      seed = Date.now(),
      mode = 'classic',
      difficulty = 'normal',
      playerName = 'You',
      playerColor = 0,
      colorCount = 16,
      botCount,
      demo = false,
    } = options;
    this.mode = MODES[mode] || MODES.classic;
    this.difficulty = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
    this.demo = demo;
    this.rng = createRng(seed);
    this.arena = new Arena(radius);
    this.players = [];
    this.events = [];
    this.time = 0;
    this.finished = false;
    this.result = null;

    this.human = this.addPlayer({ name: playerName, isBot: demo, color: playerColor, skill: 0.6 });

    const bots = botCount ?? this.difficulty.bots;
    const names = shuffle(BOT_NAMES.slice(), this.rng);
    const colors = [];
    for (let i = 0; i < colorCount; i++) if (i !== playerColor) colors.push(i);
    shuffle(colors, this.rng);
    const [lo, hi] = this.difficulty.skill;
    for (let i = 0; i < bots; i++) {
      this.addPlayer({
        name: names[i % names.length],
        isBot: true,
        color: colors[i % colors.length],
        skill: lo + (hi - lo) * this.rng(),
      });
    }
  }

  addPlayer({ name, isBot, color, skill }) {
    const p = {
      id: this.players.length + 1,
      name,
      color,
      isBot,
      skill,
      x: 0,
      y: 0,
      angle: 0,
      targetAngle: 0,
      speed: PLAYER_SPEED * (isBot && !this.demo ? this.difficulty.speed : 1),
      alive: false,
      cell: -1,
      trail: [],
      // Exact positions where trail cells were entered, for smooth trail drawing.
      path: [],
      box: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      kills: 0,
      deaths: 0,
      peakPct: 0,
      respawnAt: 0,
      deathTime: 0,
      spawnTime: 0,
      countAtDeath: 0,
      brain: null,
    };
    this.players.push(p);
    this.spawn(p);
    return p;
  }

  spawn(p) {
    const a = this.arena;
    const rng = this.rng;
    const r = START_RADIUS;
    const c = a.center + 0.5;
    const discArea = this.discCells(0, 0, r + 2).length;
    let best = null;
    let bestScore = -Infinity;
    for (let attempt = 0; attempt < 60; attempt++) {
      const ang = rng() * Math.PI * 2;
      const dist = Math.sqrt(rng()) * (a.radius - r - 8);
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
    p.angle = rng() * Math.PI * 2 - Math.PI;
    p.targetAngle = p.angle;
    p.spawnTime = this.time;
    if (p.isBot) p.brain = createBrain(p.skill);
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

  setHumanTarget(angle) {
    if (this.human.alive && !this.human.isBot) this.human.targetAngle = angle;
  }

  pctOf(p) {
    const count = p.alive ? this.arena.counts[p.id] : p.countAtDeath;
    return (count / this.arena.playable) * 100;
  }

  timeLeft() {
    return this.mode.timeLimit ? Math.max(0, this.mode.timeLimit - this.time) : null;
  }

  leaderboard() {
    return this.players
      .filter((p) => p.alive)
      .map((p) => ({ player: p, pct: this.pctOf(p) }))
      .sort((x, y) => y.pct - x.pct);
  }

  update(dt) {
    if (this.finished) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;

    for (const p of this.players) {
      if (p.alive) {
        if (p.isBot) updateBot(this, p, dt);
      } else if (p.isBot && this.time >= p.respawnAt) {
        this.spawn(p);
      }
    }

    const steps = Math.max(1, Math.ceil((PLAYER_SPEED * 1.1 * dt) / MAX_STEP));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      for (const p of this.players) if (p.alive) this.stepPlayer(p, h);
    }

    for (const p of this.players) {
      if (p.alive) p.peakPct = Math.max(p.peakPct, this.pctOf(p));
    }
    this.checkEnd();
  }

  stepPlayer(p, dt) {
    const a = this.arena;
    const diff = wrapAngle(p.targetAngle - p.angle);
    const maxTurn = TURN_RATE * dt;
    p.angle = wrapAngle(p.angle + clamp(diff, -maxTurn, maxTurn));

    let nx = p.x + Math.cos(p.angle) * p.speed * dt;
    let ny = p.y + Math.sin(p.angle) * p.speed * dt;
    // The arena edge is solid: slide along it instead of leaving the map.
    const c = a.center + 0.5;
    const dx = nx - c;
    const dy = ny - c;
    const d = Math.hypot(dx, dy);
    const lim = a.radius - 2.5;
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
    if (cx === ox && cy === oy) return;

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
      if (victim && victim.alive) this.kill(victim, p, 'cut');
    }
    if (a.owner[c] === p.id) {
      if (p.trail.length) this.closeLoop(p);
    } else {
      a.setTrail(c, p.id);
      p.trail.push(c);
      p.path.push(p.x, p.y);
    }
  }

  closeLoop(p) {
    const a = this.arena;
    const gained = a.capture(p.id, p.trail, p.box);
    p.trail = [];
    p.path = [];
    this.events.push({ type: 'capture', player: p, gained, pct: (gained / a.playable) * 100, x: p.x, y: p.y });
    for (const q of this.players) {
      if (q !== p && q.alive && a.counts[q.id] <= 0) this.kill(q, p, 'territory');
    }
  }

  kill(victim, killer, reason) {
    if (!victim.alive) return;
    const a = this.arena;
    victim.alive = false;
    victim.deaths++;
    victim.deathTime = this.time;
    victim.countAtDeath = a.counts[victim.id];
    a.clearTrail(victim.trail, victim.id);
    victim.trail = [];
    victim.path = [];
    a.releaseOwner(victim.id);
    if (killer && killer !== victim) killer.kills++;
    if (victim.isBot) victim.respawnAt = this.time + BOT_RESPAWN;
    this.events.push({ type: 'death', victim, killer, reason, x: victim.x, y: victim.y });
  }

  checkEnd() {
    if (this.demo) return;
    const h = this.human;
    if (!h.alive) {
      if (this.time - h.deathTime >= DEATH_LINGER) this.finish('defeat');
      return;
    }
    if (this.pctOf(h) >= this.mode.winPct) {
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
      rank,
      players: this.players.length,
      time: this.time,
      won: reason === 'victory' || (reason === 'timeup' && rank === 1),
    };
    this.events.push({ type: 'finish', result: this.result });
  }
}
