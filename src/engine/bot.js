// Bot brains: leave home, draw a loop, and race back before anyone can cut the trail.
import { wrapAngle } from './util.js';

const PROBE_ANGLES = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.1, -2.1, 2.6, -2.6, Math.PI];
const PROBE_DIST = [0.9, 1.8, 2.7];

export function createBrain(skill) {
  return {
    skill,
    mode: 'home',
    waypoints: [],
    think: 0,
    idleUntil: 0,
    maxTrail: Math.round(22 + skill * 55),
  };
}

export function updateBot(game, p, dt) {
  const b = p.brain;
  b.think -= dt;
  if (b.think > 0) return;
  const rng = game.rng;
  const a = game.arena;
  b.think = 0.06 + (1 - b.skill) * 0.14 + rng() * 0.04;

  let target = null;

  if (b.mode === 'home') {
    if (game.time < b.idleUntil) return;
    planExcursion(game, p, b);
  }

  if (b.mode === 'out') {
    const home = p.trail.length ? pathHome(a, p) : null;
    const homeDist = home ? home.steps : 0;
    const caution = 3 + b.skill * 6;
    if (p.trail.length > b.maxTrail || (p.trail.length > 0 && threatDistance(game, p) < homeDist + caution)) {
      b.mode = 'return';
    } else {
      const prey = b.skill > 0.2 && p.trail.length < b.maxTrail / 2 ? findPrey(game, p, 4 + b.skill * 6) : null;
      if (prey) {
        target = prey;
      } else {
        while (b.waypoints.length && Math.hypot(b.waypoints[0].x - p.x, b.waypoints[0].y - p.y) < 1.5) {
          b.waypoints.shift();
        }
        if (b.waypoints.length) target = b.waypoints[0];
        else b.mode = 'return';
      }
    }
  }

  if (b.mode === 'return') {
    if (p.trail.length === 0) {
      b.mode = 'home';
      b.idleUntil = game.time + rng() * 0.5;
      return;
    }
    const home = pathHome(a, p);
    if (home) target = home;
  }

  if (target) p.targetAngle = steer(game, p, Math.atan2(target.y - p.y, target.x - p.x));
}

function planExcursion(game, p, b) {
  const a = game.arena;
  const rng = game.rng;
  let bestAngle = rng() * Math.PI * 2;
  let bestEdge = 0;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    const ang = rng() * Math.PI * 2;
    const edge = distanceToEdge(a, p, ang);
    if (edge < 0) continue;
    const score = edge + rng() * 6;
    if (score < bestScore) {
      bestScore = score;
      bestAngle = ang;
      bestEdge = edge;
    }
  }
  const out = 2 + rng() * (3 + 7 * b.skill);
  const side = 3 + rng() * (4 + 9 * b.skill);
  const turn = rng() < 0.5 ? 1 : -1;
  const cos = Math.cos(bestAngle);
  const sin = Math.sin(bestAngle);
  const first = clampToArena(a, { x: p.x + cos * (bestEdge + out), y: p.y + sin * (bestEdge + out) });
  const second = clampToArena(a, { x: first.x - sin * turn * side, y: first.y + cos * turn * side });
  b.waypoints = [first, second];
  b.mode = 'out';
}

function distanceToEdge(a, p, ang) {
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  for (let d = 1; d < 50; d++) {
    const x = Math.floor(p.x + cos * d);
    const y = Math.floor(p.y + sin * d);
    if (!a.isPlayable(x, y)) return -1;
    if (a.owner[a.index(x, y)] !== p.id) return d;
  }
  return 50;
}

function clampToArena(a, pt) {
  const c = a.center + 0.5;
  const lim = a.radius - 5;
  const dx = pt.x - c;
  const dy = pt.y - c;
  const d = Math.hypot(dx, dy);
  if (d > lim) {
    pt.x = c + (dx / d) * lim;
    pt.y = c + (dy / d) * lim;
  }
  return pt;
}

// Breadth-first search from the head to the closest owned cell that never
// crosses the player's own trail. Returns a point a few cells along that path.
export function pathHome(a, p, lookahead = 3) {
  const n = a.owner.length;
  if (!a.bfsPrev) {
    a.bfsPrev = new Int32Array(n);
    a.bfsStamp = new Uint32Array(n);
    a.bfsQueue = new Int32Array(n);
    a.bfsGen = 0;
  }
  const prev = a.bfsPrev;
  const stamp = a.bfsStamp;
  const queue = a.bfsQueue;
  const gen = ++a.bfsGen;
  const s = a.size;
  const start = a.index(Math.floor(p.x), Math.floor(p.y));
  const recent = new Set(p.trail.slice(-2));
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  stamp[start] = gen;
  prev[start] = -1;
  let found = -1;
  while (head < tail && head < 6000) {
    const i = queue[head++];
    if (a.owner[i] === p.id) {
      found = i;
      break;
    }
    const x = i % s;
    const y = (i - x) / s;
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? x + 1 : k === 1 ? x - 1 : x;
      const ny = k === 2 ? y + 1 : k === 3 ? y - 1 : y;
      if (!a.isPlayable(nx, ny)) continue;
      const j = ny * s + nx;
      if (stamp[j] === gen) continue;
      if (a.trail[j] === p.id && !recent.has(j)) continue;
      stamp[j] = gen;
      prev[j] = i;
      queue[tail++] = j;
    }
  }
  if (found < 0) {
    const near = nearestOwned(a, p);
    return near ? { x: near.x + 0.5, y: near.y + 0.5, steps: near.d } : null;
  }
  const path = [];
  for (let i = found; i !== -1; i = prev[i]) path.push(i);
  path.reverse();
  const pick = path[Math.min(lookahead, path.length - 1)];
  return { x: (pick % s) + 0.5, y: Math.floor(pick / s) + 0.5, steps: path.length - 1 };
}

// Nearest cell owned by `p`, searched in growing square rings around the head.
export function nearestOwned(a, p) {
  const hx = Math.floor(p.x);
  const hy = Math.floor(p.y);
  const s = a.size;
  for (let r = 0; r < s; r++) {
    let best = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      const y = hy + dy;
      if (y < 0 || y >= s) continue;
      const edgeRow = dy === -r || dy === r;
      const step = edgeRow ? 1 : 2 * r || 1;
      for (let dx = -r; dx <= r; dx += step) {
        const x = hx + dx;
        if (x < 0 || x >= s) continue;
        if (a.owner[y * s + x] === p.id) {
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x, y, d: Math.sqrt(d) };
          }
        }
      }
    }
    if (best) return best;
  }
  return null;
}

// How close the nearest enemy head is to this player's head or trail.
function threatDistance(game, p) {
  const s = game.arena.size;
  let best = Infinity;
  for (const q of game.players) {
    if (!q.alive || q === p) continue;
    const head = Math.hypot(q.x - p.x, q.y - p.y);
    if (head > 40) continue;
    if (head < best) best = head;
    for (let i = 0; i < p.trail.length; i += 3) {
      const c = p.trail[i];
      const x = (c % s) + 0.5;
      const y = Math.floor(c / s) + 0.5;
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < best) best = d;
    }
  }
  return best;
}

function findPrey(game, p, radius) {
  const a = game.arena;
  const hx = Math.floor(p.x);
  const hy = Math.floor(p.y);
  const r = Math.ceil(radius);
  let best = null;
  let bestD = radius * radius;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = hx + dx;
      const y = hy + dy;
      if (!a.isPlayable(x, y)) continue;
      const t = a.trail[a.index(x, y)];
      if (t === 0 || t === p.id) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = { x: x + 0.5, y: y + 0.5 };
      }
    }
  }
  return best;
}

function steer(game, p, desired) {
  for (const off of PROBE_ANGLES) {
    const ang = desired + off;
    if (isSafe(game, p, ang)) return wrapAngle(ang);
  }
  return desired;
}

function isSafe(game, p, ang) {
  const a = game.arena;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const recent = p.trail.length - 3;
  const c = a.center + 0.5;
  for (const d of PROBE_DIST) {
    const px = p.x + cos * d;
    const py = p.y + sin * d;
    if (Math.hypot(px - c, py - c) > a.radius - 2.5) return false;
    const x = Math.floor(px);
    const y = Math.floor(py);
    if (!a.isPlayable(x, y)) return false;
    const i = a.index(x, y);
    if (a.trail[i] === p.id && p.trail.lastIndexOf(i) < recent) return false;
  }
  return true;
}
