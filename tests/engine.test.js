import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arena, WALL } from '../src/engine/arena.js';
import { Game } from '../src/engine/game.js';
import { createRng } from '../src/engine/util.js';
import { STEP } from '../src/engine/constants.js';

function ownedCells(arena, id) {
  let n = 0;
  for (let i = 0; i < arena.owner.length; i++) if (arena.owner[i] === id) n++;
  return n;
}

// Drive a player along a path of grid cells (centres), one cell at a time.
function walk(game, p, cells) {
  for (const [x, y] of cells) {
    p.targetAngle = Math.atan2(y + 0.5 - p.y, x + 0.5 - p.x);
    p.angle = p.targetAngle;
    let guard = 0;
    while (p.alive && (Math.floor(p.x) !== x || Math.floor(p.y) !== y) && guard++ < 200) {
      game.stepPlayer(p, 0.02);
    }
  }
}

function line(x0, y0, x1, y1) {
  const out = [];
  const sx = Math.sign(x1 - x0);
  const sy = Math.sign(y1 - y0);
  let x = x0;
  let y = y0;
  out.push([x, y]);
  while (x !== x1 || y !== y1) {
    if (x !== x1) x += sx;
    else y += sy;
    out.push([x, y]);
  }
  return out;
}

test('arena marks cells outside the circle as walls', () => {
  const a = new Arena(20);
  assert.equal(a.owner[a.index(0, 0)], WALL);
  assert.notEqual(a.owner[a.index(20, 20)], WALL);
  assert.ok(a.playable > Math.PI * 18 * 18 && a.playable < Math.PI * 20 * 20);
});

test('capture fills the enclosed area and clears the trail', () => {
  const a = new Arena(30);
  const id = 1;
  // 3x3 home block at (10..12, 10..12)
  for (let y = 10; y <= 12; y++) for (let x = 10; x <= 12; x++) a.setOwner(a.index(x, y), id);
  const box = { minX: 10, minY: 10, maxX: 12, maxY: 12 };
  // Loop leaving the right side, going around a 5x5 area and back into home.
  const trail = [];
  const path = [...line(13, 11, 18, 11), ...line(18, 12, 18, 17), ...line(17, 17, 11, 17), ...line(11, 16, 11, 13)];
  for (const [x, y] of path) {
    const i = a.index(x, y);
    a.setTrail(i, id);
    trail.push(i);
  }
  const gained = a.capture(id, trail, box);
  assert.equal(a.counts[id], ownedCells(a, id));
  // Interior (12..17, 12..16) must now be owned.
  for (let y = 12; y <= 16; y++) for (let x = 12; x <= 17; x++) assert.equal(a.owner[a.index(x, y)], id);
  for (const i of trail) assert.equal(a.trail[i], 0);
  assert.ok(gained.length > trail.length);
  // Outside the loop stays empty.
  assert.equal(a.owner[a.index(20, 20)], 0);
});

test('a player walking a loop out of their land captures it', () => {
  const g = new Game({ seed: 7, botCount: 0, radius: 40 });
  const p = g.human;
  const hx = Math.floor(p.x);
  const hy = Math.floor(p.y);
  const before = g.arena.counts[p.id];
  walk(g, p, [[hx + 6, hy], [hx + 6, hy + 6], [hx, hy + 6], [hx, hy]]);
  assert.ok(p.alive);
  assert.equal(p.trail.length, 0);
  assert.ok(g.arena.counts[p.id] > before + 20, 'territory should grow');
  assert.equal(g.arena.counts[p.id], ownedCells(g.arena, p.id));
});

test('crossing your own trail is fatal', () => {
  const g = new Game({ seed: 3, botCount: 0, radius: 40 });
  const p = g.human;
  const hx = Math.floor(p.x);
  const hy = Math.floor(p.y);
  walk(g, p, [[hx + 8, hy], [hx + 8, hy + 3], [hx + 6, hy + 3], [hx + 6, hy - 2]]);
  assert.equal(p.alive, false);
  assert.ok(g.events.some((e) => e.type === 'death' && e.reason === 'self'));
  assert.equal(g.arena.counts[p.id], 0);
});

test('cutting an enemy trail kills the enemy and credits the kill', () => {
  const g = new Game({ seed: 11, botCount: 1, radius: 40 });
  const [h, bot] = g.players;
  // Lay a fake trail for the bot right in front of the human.
  const hx = Math.floor(h.x);
  const hy = Math.floor(h.y);
  const cell = g.arena.index(hx + 5, hy);
  g.arena.owner[cell] = 0;
  g.arena.setTrail(cell, bot.id);
  bot.trail.push(cell);
  walk(g, h, [[hx + 6, hy]]);
  assert.equal(bot.alive, false);
  assert.equal(h.kills, 1);
  assert.equal(g.arena.trail[cell], h.id, 'cell now carries the human trail');
});

test('the human game ends after death', () => {
  const g = new Game({ seed: 5, botCount: 0, radius: 40 });
  g.kill(g.human, null, 'test');
  for (let i = 0; i < 100 && !g.finished; i++) g.update(1 / 60);
  assert.equal(g.finished, true);
  assert.equal(g.result.reason, 'defeat');
});

test('time rush ends when the clock runs out', () => {
  const g = new Game({ seed: 9, botCount: 2, mode: 'rush', radius: 40 });
  g.time = 119.9;
  for (let i = 0; i < 20 && !g.finished; i++) g.update(1 / 60);
  assert.equal(g.finished, true);
  assert.equal(g.result.reason === 'timeup' || g.result.reason === 'defeat', true);
});

test('a long all-bot simulation keeps territory counts consistent', () => {
  for (const seed of [1, 2, 3]) {
    const g = new Game({ seed, demo: true, difficulty: 'hard' });
    const rng = createRng(seed);
    let captures = 0;
    let deaths = 0;
    for (let i = 0; i < 60 * 90; i++) {
      g.update(1 / 60 + rng() * 0.004);
      for (const e of g.events) {
        if (e.type === 'capture') captures++;
        if (e.type === 'death') deaths++;
      }
      g.events.length = 0;
    }
    const a = g.arena;
    let total = 0;
    for (const p of g.players) {
      assert.equal(a.counts[p.id], ownedCells(a, p.id), `count mismatch for ${p.name}`);
      if (!p.alive) assert.equal(a.counts[p.id], 0);
      total += a.counts[p.id];
      for (const c of p.trail) assert.equal(a.trail[c], p.id);
    }
    assert.ok(total <= a.playable);
    assert.ok(captures > 20, `bots should capture land (seed ${seed}: ${captures})`);
    assert.ok(deaths > 0, `bots should fight (seed ${seed})`);
  }
});

function stateHash(g) {
  let h = 0;
  const a = g.arena;
  for (let i = 0; i < a.owner.length; i++) h = (h * 31 + a.owner[i] + a.trail[i] * 7) | 0;
  for (const p of g.players) h = (h * 31 + Math.round(p.x * 1000) + Math.round(p.y * 1000) * 3 + (p.alive ? 1 : 0)) | 0;
  return h;
}

test('replaying the same inputs reproduces the game exactly', () => {
  const opts = { seed: 1234, mode: 'classic', difficulty: 'hard', bossLevel: 0.5 };
  const rng = createRng(99);
  const inputs = [];
  const g1 = new Game(opts);
  for (let s = 0; s < 60 * 40 && !g1.finished; s++) {
    if (s % 20 === 0) {
      const a = rng() * Math.PI * 2;
      inputs.push([s, a]);
      g1.setHumanTarget(a);
    }
    g1.update(STEP);
  }
  const g2 = new Game(opts);
  let k = 0;
  for (let s = 0; s < g1.steps; s++) {
    while (k < inputs.length && inputs[k][0] === s) g2.setHumanTarget(inputs[k++][1]);
    g2.update(STEP);
  }
  assert.equal(stateHash(g2), stateHash(g1));
  assert.equal(g2.finished, g1.finished);
});

test('ink storm shrinks the arena and ends the game', () => {
  const demo = new Game({ seed: 4, mode: 'storm', difficulty: 'easy', demo: true });
  const startPlayable = demo.arena.playable;
  for (let s = 0; s < 60 * 125; s++) demo.update(STEP);
  const a = demo.arena;
  assert.ok(a.playable < startPlayable * 0.2, 'arena should have shrunk to ~30% radius');
  let open = 0;
  for (let i = 0; i < a.owner.length; i++) if (a.owner[i] !== 255) open++;
  assert.equal(open, a.playable);
  const c = a.center + 0.5;
  for (const p of demo.players) {
    if (p.alive) assert.ok(Math.hypot(p.x - c, p.y - c) <= a.activeRadius);
    assert.equal(a.counts[p.id], ownedCells(a, p.id));
  }

  const g = new Game({ seed: 4, mode: 'storm', difficulty: 'easy' });
  for (let s = 0; s < 60 * 160 && !g.finished; s++) g.update(STEP);
  assert.ok(g.finished);
});

test('power-ups: speed boosts, shield blocks cuts, bomb claims land', () => {
  const g = new Game({ seed: 21, botCount: 1, radius: 40 });
  const [h, bot] = g.players;
  const before = g.arena.counts[h.id];
  g.applyPowerup(h, { type: 'bomb', x: h.x, y: h.y });
  assert.ok(g.arena.counts[h.id] > before);
  assert.ok(g.events.some((e) => e.type === 'capture' && e.bomb));

  g.applyPowerup(h, { type: 'speed', x: h.x, y: h.y });
  assert.ok(g.isBoosted(h));

  // Shielded bot trail survives being crossed.
  g.applyPowerup(bot, { type: 'shield', x: bot.x, y: bot.y });
  const hx = Math.floor(h.x) + 8;
  const hy = Math.floor(h.y);
  const cell = g.arena.index(hx, hy);
  g.arena.owner[cell] = 0;
  g.arena.setTrail(cell, bot.id);
  bot.trail.push(cell, cell, cell);
  walk(g, h, [[hx + 1, hy]]);
  assert.equal(bot.alive, true);
  assert.ok(g.events.some((e) => e.type === 'block'));
});

test('head-on: the shorter trail wins', () => {
  const g = new Game({ seed: 8, botCount: 1, radius: 40 });
  const [h, bot] = g.players;
  h.trail = [1, 2];
  bot.trail = [3, 4, 5, 6];
  g.headOn(h, bot);
  assert.equal(h.alive, true);
  assert.equal(bot.alive, false);
});

test('multiplayer slots: humans can join, leave and respawn', () => {
  const g = new Game({ seed: 3, noHuman: true, persistent: true, botCount: 3 });
  assert.equal(g.human, null);
  const a = g.addHuman({ name: 'Ana', color: 1 });
  const b = g.addHuman({ name: 'Ben', color: 2 });
  assert.equal(g.players.length, 5);
  g.removePlayer(a);
  assert.equal(a.alive, false);
  assert.equal(g.arena.counts[a.id], 0);
  const c = g.addHuman({ name: 'Cy', color: 3 });
  assert.equal(c.id, a.id, 'slot reused');
  g.kill(b, null, 'test');
  g.respawnHuman(b);
  assert.equal(b.alive, true);
  for (let s = 0; s < 600; s++) g.update(STEP);
  assert.equal(g.finished, false);
});
