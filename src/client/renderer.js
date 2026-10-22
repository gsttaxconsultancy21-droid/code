// Canvas renderer. Territory outlines are traced with marching squares over
// cell centres whenever land changes, smoothed with Chaikin corner cutting and
// cached as one Path2D per owner, so edges are smooth curves at any zoom.
// Trails are stroked along the exact path each player drove. A
// one-pixel-per-cell bitmap of territory feeds the minimap.
import { WALL } from '../engine/arena.js';
import { nearestOwned } from '../engine/bot.js';
import { colorSet, botLook, DEFAULT_LOOK } from './palette.js';

const FLOOR = '#f6f1e7';
const FLOOR_LINE = 'rgba(80, 60, 30, 0.06)';
const VOID = '#2f3150';
const RIM = '#d8ccb6';
const STORM = 'rgba(58, 30, 92, 0.62)';
const SHADE_DROP = 0.35;
const TRAIL_WIDTH = 0.9;
const DANGER = '#ff3b3b';
const POWERUP_STYLE = {
  speed: { color: '#ffd43b', ring: '#f59f00' },
  shield: { color: '#74c0fc', ring: '#1c7ed6' },
  bomb: { color: '#495057', ring: '#212529' },
};

// Marching squares over the quad between four cell centres. Corner bits:
// top-left 8, top-right 4, bottom-right 2, bottom-left 1. For each case, the
// boundary segments in half-cell units (start, end) with the owned side kept
// consistently on one side, so segments chain into closed, oriented loops.
const ML = [0, 1], MT = [1, 0], MR = [2, 1], MB = [1, 2];
const CUTS = [
  null, [ML, MB], [MB, MR], [ML, MR], [MR, MT], [MR, MB, ML, MT], [MB, MT], [ML, MT],
  [MT, ML], [MT, MB], [MT, MR, MB, ML], [MT, MR], [MR, ML], [MR, MB], [MB, ML], null,
];

function chaikin(pts, iterations) {
  for (let it = 0; it < iterations; it++) {
    const n = pts.length / 2;
    const out = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = pts[i * 2], ay = pts[i * 2 + 1];
      const bx = pts[j * 2], by = pts[j * 2 + 1];
      out[i * 4] = ax * 0.75 + bx * 0.25;
      out[i * 4 + 1] = ay * 0.75 + by * 0.25;
      out[i * 4 + 2] = ax * 0.25 + bx * 0.75;
      out[i * 4 + 3] = ay * 0.25 + by * 0.75;
    }
    pts = out;
  }
  return pts;
}

// Returns Map<ownerId, Path2D> of smoothed territory outlines.
export function buildOutlines(arena, smoothing = 2) {
  const s = arena.size;
  const own = arena.owner;
  const W = 2 * s + 2;
  const segs = new Map();
  const ids = [0, 0, 0, 0];
  for (let qy = 0; qy < s - 1; qy++) {
    for (let qx = 0; qx < s - 1; qx++) {
      const i = qy * s + qx;
      const o0 = own[i];
      const o1 = own[i + 1];
      const o2 = own[i + s + 1];
      const o3 = own[i + s];
      if (o0 === o1 && o1 === o2 && o2 === o3) continue;
      ids[0] = o0; ids[1] = o1; ids[2] = o2; ids[3] = o3;
      const bx = 2 * qx + 1;
      const by = 2 * qy + 1;
      for (let k = 0; k < 4; k++) {
        const id = ids[k];
        if (id === 0 || id === WALL || ids.indexOf(id) !== k) continue;
        const mask = (o0 === id ? 8 : 0) | (o1 === id ? 4 : 0) | (o2 === id ? 2 : 0) | (o3 === id ? 1 : 0);
        const cuts = CUTS[mask];
        if (!cuts) continue;
        let list = segs.get(id);
        if (!list) segs.set(id, (list = []));
        for (let j = 0; j < cuts.length; j += 2) {
          list.push((by + cuts[j][1]) * W + bx + cuts[j][0], (by + cuts[j + 1][1]) * W + bx + cuts[j + 1][0]);
        }
      }
    }
  }

  const paths = new Map();
  for (const [id, list] of segs) {
    const next = new Map();
    for (let j = 0; j < list.length; j += 2) next.set(list[j], list[j + 1]);
    const path = new Path2D();
    for (const [start] of next) {
      if (!next.has(start)) continue;
      const raw = [];
      let k = start;
      do {
        raw.push((k % W) / 2, Math.floor(k / W) / 2);
        const n = next.get(k);
        next.delete(k);
        k = n;
      } while (k !== undefined && k !== start);
      if (raw.length < 6) continue;
      const pts = chaikin(raw, smoothing);
      path.moveTo(pts[0], pts[1]);
      for (let j = 2; j < pts.length; j += 2) path.lineTo(pts[j], pts[j + 1]);
      path.closePath();
    }
    paths.set(id, path);
  }
  return paths;
}

export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.miniCtx = minimap.getContext('2d');
    this.game = null;
    this.me = null;
    this.cam = { x: 0, y: 0 };
    this.zoom = 20;
    this.particles = [];
    this.popups = [];
    this.flashes = [];
    this.shake = 0;
    this.lowGraphics = false;
    this.ghost = null;
    this.danger = { threats: [], home: null, warn: 0 };
    this.looks = new WeakMap();
    this.patterns = new Map();
    this.frame = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setLowGraphics(on) {
    this.lowGraphics = on;
    this.outlineVersion = -1;
    this.resize();
  }

  resize() {
    this.dpr = this.lowGraphics ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  attach(game, me = game.human) {
    this.game = game;
    this.me = me;
    const a = game.arena;
    const s = a.size;
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const ctx = c.getContext('2d');
    this.terr = { c, ctx, img: ctx.createImageData(s, s) };
    this.colors = [];
    a.trackChanges = true;
    a.changes.length = 0;
    for (let i = 0; i < a.owner.length; i++) this.paintCell(i);
    this.flush();
    this.outlineVersion = -1;
    this.particles.length = 0;
    this.popups.length = 0;
    this.flashes.length = 0;
    this.danger = { threats: [], home: null, warn: 0 };
    this.ghost = null;
    if (me) {
      this.cam.x = me.x;
      this.cam.y = me.y;
    }
    this.zoom = this.targetZoom(0);
  }

  colorOf(id) {
    let cs = this.colors[id];
    if (!cs) {
      const p = this.game.players[id - 1];
      cs = this.colors[id] = colorSet(p ? p.color : 0);
    }
    return cs;
  }

  // Remote players can change colour when slots are reused.
  resetColors() {
    this.colors = [];
    this.looks = new WeakMap();
    this.outlineVersion = -1;
  }

  lookOf(p) {
    let look = this.looks.get(p);
    if (!look) {
      look = { ...DEFAULT_LOOK, ...(p.cosmetics || (p.isBot ? botLook(p) : {})) };
      this.looks.set(p, look);
    }
    return look;
  }

  paintCell(i) {
    const o = this.game.arena.owner[i];
    const T = this.terr.img.data;
    const k = i * 4;
    if (o !== 0 && o !== WALL) {
      const cs = this.colorOf(o);
      T[k] = cs.base[0]; T[k + 1] = cs.base[1]; T[k + 2] = cs.base[2]; T[k + 3] = 255;
    } else {
      T[k + 3] = 0;
    }
  }

  flush() {
    this.terr.ctx.putImageData(this.terr.img, 0, 0);
  }

  targetZoom(pct) {
    // Zoom out gently as the player's land grows.
    return Math.min(this.w, this.h) / (30 + 22 * Math.sqrt(Math.min(pct, 100) / 100));
  }

  // Captured cells as row runs, for the white capture flash.
  flashPath(cells) {
    const s = this.game.arena.size;
    const sorted = Int32Array.from(cells).sort();
    const path = new Path2D();
    let start = -1;
    let prev = -2;
    for (let j = 0; j <= sorted.length; j++) {
      const i = j < sorted.length ? sorted[j] : -10;
      if (i === prev + 1 && i % s !== 0) {
        prev = i;
        continue;
      }
      if (start >= 0) path.rect(start % s, Math.floor(start / s), prev - start + 1, 1);
      start = i;
      prev = i;
    }
    return path;
  }

  onEvent(e) {
    const me = this.me;
    if (e.type === 'death') {
      if (!this.lowGraphics) {
        const cs = this.colorOf(e.victim.id);
        for (let i = 0; i < 26; i++) {
          const ang = Math.random() * Math.PI * 2;
          const sp = 2 + Math.random() * 7;
          this.particles.push({
            x: e.x, y: e.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            life: 0.6 + Math.random() * 0.5, size: 0.25 + Math.random() * 0.45, color: cs.css,
          });
        }
      }
      if (e.victim === me) this.shake = 0.5;
    } else if (e.type === 'capture' && e.player === me) {
      if (e.pct >= 0.05) this.popups.push({ x: e.x, y: e.y - 1, text: `+${e.pct.toFixed(1)}%`, life: 1.1 });
      if (e.cells && e.cells.length) {
        this.flashes.push({ path: this.flashPath(e.cells), x: e.x, y: e.y, life: 0.5, max: 0.5, ring: e.bomb ? 6 : 4 });
      }
    } else if (e.type === 'powerup') {
      const style = POWERUP_STYLE[e.kind];
      this.flashes.push({ path: null, x: e.x, y: e.y, life: 0.4, max: 0.4, ring: 3, color: style.ring });
      if (e.player === me) {
        const label = { speed: 'Speed!', shield: 'Shield!', bomb: 'Ink bomb!' }[e.kind];
        this.popups.push({ x: e.x, y: e.y - 1.5, text: label, life: 1 });
      }
    } else if (e.type === 'block') {
      this.flashes.push({ path: null, x: e.x, y: e.y, life: 0.35, max: 0.35, ring: 2.5, color: '#74c0fc' });
    }
  }

  updateDanger(dt) {
    const g = this.game;
    const me = this.me;
    const d = this.danger;
    d.threats.length = 0;
    d.warn = 0;
    if (!me || !me.alive || me.path.length === 0) {
      d.home = null;
      return;
    }
    const path = me.path;
    const trailCells = path.length / 2;
    for (const q of g.players) {
      if (q === me || !q.alive) continue;
      if (Math.abs(q.x - me.x) > 26 || Math.abs(q.y - me.y) > 26) continue;
      let best = Math.hypot(q.x - me.x, q.y - me.y);
      let tx = me.x;
      let ty = me.y;
      for (let i = 0; i < path.length; i += 6) {
        const dd = Math.hypot(q.x - path[i], q.y - path[i + 1]);
        if (dd < best) {
          best = dd;
          tx = path[i];
          ty = path[i + 1];
        }
      }
      const toward = (Math.cos(q.angle) * (tx - q.x) + Math.sin(q.angle) * (ty - q.y)) / Math.max(best, 0.01);
      if (best < 11 && toward > 0.35) d.threats.push({ player: q, dist: best });
    }

    // Recomputing the way home is a ring search, so do it a few times a second.
    if (this.frame % 10 === 0 || !d.home) {
      const near = nearestOwned(g.arena, me, 70);
      d.home = near ? { x: near.x + 0.5, y: near.y + 0.5, dist: near.d } : null;
    }
    const homeDist = d.home ? d.home.dist : 0;
    if (d.threats.length) d.warn = 2;
    else if (trailCells > 45 || homeDist > 20) d.warn = 1;
  }

  render(dt, input) {
    const g = this.game;
    if (!g) return;
    const a = g.arena;
    const ctx = this.ctx;
    this.frame++;

    if (a.changes.length) {
      for (const i of a.changes) this.paintCell(i);
      a.changes.length = 0;
      this.flush();
    }
    if (this.outlineVersion !== a.ownerVersion) {
      this.outlines = buildOutlines(a, this.lowGraphics ? 1 : 2);
      this.outlineVersion = a.ownerVersion;
    }

    const me = this.me;
    const followTarget = me && me.alive ? me : null;
    const follow = followTarget ? 1 - Math.exp(-dt * 9) : 0;
    if (followTarget) {
      this.cam.x += (followTarget.x - this.cam.x) * follow;
      this.cam.y += (followTarget.y - this.cam.y) * follow;
    }
    this.zoom += (this.targetZoom(me ? g.pctOf(me) : 5) - this.zoom) * (1 - Math.exp(-dt * 2));
    this.shake = Math.max(0, this.shake - dt);
    this.updateDanger(dt);

    const z = this.zoom;
    const shakeX = this.shake ? (Math.random() - 0.5) * this.shake * 14 : 0;
    const shakeY = this.shake ? (Math.random() - 0.5) * this.shake * 14 : 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.translate(this.w / 2 - this.cam.x * z + shakeX, this.h / 2 - this.cam.y * z + shakeY);
    ctx.scale(z, z);

    const c = a.center + 0.5;
    const R = a.radius - 1;
    const active = a.activeRadius;

    // Paper floor with a raised rim.
    ctx.fillStyle = RIM;
    ctx.beginPath();
    ctx.arc(c, c + 0.5, R + 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = FLOOR;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fill();

    const vx0 = this.cam.x - this.w / 2 / z - 1;
    const vx1 = this.cam.x + this.w / 2 / z + 1;
    const vy0 = this.cam.y - this.h / 2 / z - 1;
    const vy1 = this.cam.y + this.h / 2 / z + 1;
    if (!this.lowGraphics) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = FLOOR_LINE;
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      for (let x = Math.floor(vx0 / 2) * 2; x <= vx1; x += 2) {
        ctx.moveTo(x, vy0);
        ctx.lineTo(x, vy1);
      }
      for (let y = Math.floor(vy0 / 2) * 2; y <= vy1; y += 2) {
        ctx.moveTo(vx0, y);
        ctx.lineTo(vx1, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    this.drawTerritory(ctx);
    if (active < R - 0.2) this.drawStorm(ctx, c, R, active, g.time);
    this.drawFlashes(ctx, dt);
    this.drawPowerups(ctx, g);
    this.drawTrails(ctx, g);
    if (this.ghost && this.ghost.alive) this.drawGhost(ctx, this.ghost);
    for (const p of g.players) if (p.alive) this.drawPlayer(ctx, p, g);
    this.drawParticles(ctx, dt);

    // Screen-space overlays: names, popups, warnings, joystick.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const toScreen = (x, y) => [
      this.w / 2 + (x - this.cam.x) * z + shakeX,
      this.h / 2 + (y - this.cam.y) * z + shakeY,
    ];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.font = `700 ${Math.max(11, Math.round(z * 0.62))}px "Trebuchet MS", system-ui, sans-serif`;
    for (const p of g.players) {
      if (!p.alive) continue;
      const lift = this.lookOf(p).hat !== 'none' ? 1.45 : 0.95;
      const [sx, sy] = toScreen(p.x, p.y - lift);
      if (sx < -80 || sx > this.w + 80 || sy < -40 || sy > this.h + 60) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(p.name, sx, sy);
      ctx.fillStyle = p.isBoss ? '#c92a2a' : this.colorOf(p.id).cssDark;
      ctx.fillText(p.name, sx, sy);
    }
    if (this.ghost && this.ghost.alive) {
      const [sx, sy] = toScreen(this.ghost.x, this.ghost.y - 0.95);
      ctx.fillStyle = 'rgba(38,38,58,0.55)';
      ctx.fillText('Best', sx, sy);
    }

    ctx.font = `800 ${Math.round(z * 0.9)}px "Trebuchet MS", system-ui, sans-serif`;
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const pop = this.popups[i];
      pop.life -= dt;
      if (pop.life <= 0) {
        this.popups.splice(i, 1);
        continue;
      }
      pop.y -= dt * 1.4;
      const [sx, sy] = toScreen(pop.x, pop.y);
      ctx.globalAlpha = Math.min(1, pop.life * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'white';
      ctx.strokeText(pop.text, sx, sy);
      ctx.fillStyle = me ? this.colorOf(me.id).cssDark : '#26263a';
      ctx.fillText(pop.text, sx, sy);
    }
    ctx.globalAlpha = 1;

    this.drawDanger(ctx, toScreen);

    if (input && input.stick) {
      const s = input.stick;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.arc(s.ox, s.oy, input.stickCfg.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 24, 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawMinimap();
  }

  drawTerritory(ctx) {
    const paths = this.outlines;
    ctx.save();
    ctx.translate(0, SHADE_DROP);
    for (const [id, path] of paths) {
      ctx.fillStyle = this.colorOf(id).cssDark;
      ctx.fill(path);
    }
    ctx.restore();
    for (const [id, path] of paths) {
      ctx.fillStyle = this.colorOf(id).css;
      ctx.fill(path);
      if (this.lowGraphics) continue;
      const p = this.game.players[id - 1];
      if (!p) continue;
      const pattern = this.patternFor(this.lookOf(p).pattern, id);
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fill(path);
      }
    }
  }

  patternFor(kind, id) {
    if (!kind || kind === 'plain') return null;
    const cs = this.colorOf(id);
    const key = `${kind}:${cs.css}`;
    if (this.patterns.has(key)) return this.patterns.get(key);
    const T = 32;
    const c = document.createElement('canvas');
    c.width = T;
    c.height = T;
    const t = c.getContext('2d');
    t.fillStyle = t.strokeStyle = 'rgba(255,255,255,0.28)';
    t.lineWidth = 3;
    if (kind === 'stripes') {
      t.beginPath();
      for (let k = -T; k <= T; k += 16) {
        t.moveTo(k, T);
        t.lineTo(k + T, 0);
      }
      t.stroke();
    } else if (kind === 'dots') {
      for (const [x, y] of [[8, 8], [24, 24]]) {
        t.beginPath();
        t.arc(x, y, 4, 0, Math.PI * 2);
        t.fill();
      }
    } else if (kind === 'checks') {
      t.fillRect(0, 0, 16, 16);
      t.fillRect(16, 16, 16, 16);
    } else if (kind === 'waves') {
      t.beginPath();
      for (const y of [8, 24]) {
        t.moveTo(0, y);
        t.bezierCurveTo(8, y - 6, 8, y + 6, 16, y);
        t.bezierCurveTo(24, y - 6, 24, y + 6, 32, y);
      }
      t.stroke();
    } else if (kind === 'splats') {
      t.fillStyle = `rgba(${cs.dark.join(',')},0.35)`;
      for (const [x, y, r] of [[9, 10, 5], [14, 6, 2.5], [25, 23, 4], [20, 27, 2]]) {
        t.beginPath();
        t.arc(x, y, r, 0, Math.PI * 2);
        t.fill();
      }
    }
    const pattern = this.ctx.createPattern(c, 'repeat');
    if (pattern.setTransform) pattern.setTransform(new DOMMatrix().scale(1 / 16));
    this.patterns.set(key, pattern);
    return pattern;
  }

  drawStorm(ctx, c, R, active, time) {
    ctx.save();
    ctx.fillStyle = STORM;
    ctx.beginPath();
    ctx.arc(c, c, R + 0.5, 0, Math.PI * 2);
    ctx.arc(c, c, active, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(190, 120, 255, 0.85)';
    ctx.lineWidth = 0.35;
    ctx.setLineDash([1.2, 0.8]);
    ctx.lineDashOffset = -time * 3;
    ctx.beginPath();
    ctx.arc(c, c, active, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawFlashes(ctx, dt) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.flashes.splice(i, 1);
        continue;
      }
      const t = 1 - f.life / f.max;
      if (f.path) {
        ctx.fillStyle = `rgba(255,255,255,${0.55 * (1 - t)})`;
        ctx.fill(f.path);
      }
      ctx.strokeStyle = f.color || 'rgba(255,255,255,0.9)';
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 0.5 + f.ring * t, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  drawPowerups(ctx, g) {
    for (const pu of g.powerups) {
      const style = POWERUP_STYLE[pu.type];
      const bob = Math.sin(g.time * 4 + pu.id) * 0.12;
      const x = pu.x;
      const y = pu.y + bob;
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath();
      ctx.ellipse(pu.x, pu.y + 0.55, 0.5, 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.strokeStyle = style.ring;
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.arc(x, y, 0.62, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = style.color;
      ctx.strokeStyle = style.ring;
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      if (pu.type === 'speed') {
        ctx.moveTo(x + 0.08, y - 0.42);
        ctx.lineTo(x - 0.22, y + 0.06);
        ctx.lineTo(x - 0.02, y + 0.06);
        ctx.lineTo(x - 0.1, y + 0.42);
        ctx.lineTo(x + 0.24, y - 0.08);
        ctx.lineTo(x + 0.04, y - 0.08);
        ctx.closePath();
      } else if (pu.type === 'shield') {
        ctx.moveTo(x, y - 0.38);
        ctx.lineTo(x + 0.3, y - 0.26);
        ctx.quadraticCurveTo(x + 0.3, y + 0.2, x, y + 0.4);
        ctx.quadraticCurveTo(x - 0.3, y + 0.2, x - 0.3, y - 0.26);
        ctx.closePath();
      } else {
        ctx.arc(x - 0.04, y + 0.06, 0.28, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
      if (pu.type === 'bomb') {
        ctx.strokeStyle = '#fd7e14';
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.moveTo(x + 0.14, y - 0.16);
        ctx.quadraticCurveTo(x + 0.3, y - 0.42, x + 0.2, y - 0.44);
        ctx.stroke();
      }
    }
  }

  drawTrails(ctx, g) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const me = this.me;
    const blink = this.danger.warn ? Math.sin(g.time * (this.danger.warn === 2 ? 22 : 12)) > 0 : false;
    for (const p of g.players) {
      const path = p.path;
      if (!p.alive || path.length < 2) continue;
      const cs = this.colorOf(p.id);
      const style = this.lowGraphics ? 'plain' : this.lookOf(p).trail;
      ctx.beginPath();
      ctx.moveTo(path[0], path[1]);
      for (let i = 2; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
      ctx.lineTo(p.x, p.y);

      if (style === 'glow') {
        ctx.strokeStyle = cs.cssTrail;
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = TRAIL_WIDTH * 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = TRAIL_WIDTH;
      ctx.strokeStyle = cs.cssTrail;
      if (style === 'dashed') ctx.setLineDash([0.7, 0.5]);
      if (style === 'rainbow') {
        const grad = ctx.createLinearGradient(path[0], path[1], p.x, p.y);
        const shift = (g.time * 60) % 360;
        for (let k = 0; k <= 6; k++) grad.addColorStop(k / 6, `hsl(${(shift + k * 60) % 360}, 85%, 70%)`);
        ctx.strokeStyle = grad;
      }
      if (p === me && blink) ctx.strokeStyle = DANGER;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      if (style === 'sparkle' && Math.random() < 0.5) {
        this.particles.push({
          x: p.x + (Math.random() - 0.5) * 0.6, y: p.y + (Math.random() - 0.5) * 0.6, vx: 0, vy: -0.6,
          life: 0.5, size: 0.18, color: Math.random() < 0.5 ? 'white' : cs.css,
        });
      }
    }
  }

  drawParticles(ctx, dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.life -= dt;
      if (q.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vx *= 0.93;
      q.vy *= 0.93;
      ctx.globalAlpha = Math.min(1, q.life / 0.4);
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
    }
    ctx.globalAlpha = 1;
  }

  drawGhost(ctx, gh) {
    const size = 1.3;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = 'white';
    roundRect(ctx, gh.x - size / 2, gh.y - size / 2, size, size, 0.38);
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([0.25, 0.18]);
    ctx.strokeStyle = '#26263a';
    ctx.lineWidth = 0.08;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  drawPlayer(ctx, p, g) {
    const cs = this.colorOf(p.id);
    const look = this.lookOf(p);
    const t = g.time;
    const size = p.isBoss ? 1.5 : 1.3;
    const bob = Math.sin(t * 10 + p.id) * 0.04;
    const x = p.x - size / 2;
    const y = p.y - size / 2 + bob;

    if (g.isShielded(p)) {
      ctx.strokeStyle = `rgba(116,192,252,${0.55 + 0.25 * Math.sin(t * 8)})`;
      ctx.lineWidth = 0.14;
      ctx.beginPath();
      ctx.arc(p.x, p.y + bob, size * 0.85, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (g.isBoosted(p) && !this.lowGraphics) {
      const bx = -Math.cos(p.angle);
      const by = -Math.sin(p.angle);
      ctx.strokeStyle = 'rgba(255,212,59,0.8)';
      ctx.lineWidth = 0.1;
      ctx.beginPath();
      for (const off of [-0.35, 0, 0.35]) {
        const ox = p.x - by * off + bx * 0.8;
        const oy = p.y + bx * off + by * 0.8;
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + bx * (0.5 + Math.random() * 0.3), oy + by * (0.5 + Math.random() * 0.3));
      }
      ctx.stroke();
    }

    if (!this.lowGraphics) {
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      roundRect(ctx, x + 0.08, y + 0.5, size, size, 0.38);
      ctx.fill();
    }
    ctx.fillStyle = cs.cssDark;
    roundRect(ctx, x, y + 0.3, size, size, 0.38);
    ctx.fill();
    ctx.fillStyle = cs.css;
    roundRect(ctx, x, y, size, size, 0.38);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    roundRect(ctx, x + 0.18, y + 0.12, size - 0.36, 0.28, 0.14);
    ctx.fill();

    this.drawFace(ctx, p, look.face, p.x, p.y + bob, t, cs);
    if (look.hat !== 'none') this.drawHat(ctx, look.hat, p.x, y, size, t);
  }

  drawFace(ctx, p, face, cx, cy, t, cs) {
    const lx = Math.cos(p.angle);
    const ly = Math.sin(p.angle);
    const blink = (t + p.id * 1.7) % 4 < 0.12;
    const eyes = [-1, 1].map((side) => [cx + -ly * side * 0.26 + lx * 0.12, cy + lx * side * 0.26 + ly * 0.12, side]);
    const pupil = (ex, ey) => {
      ctx.fillStyle = '#26263a';
      ctx.beginPath();
      ctx.arc(ex + lx * 0.07, ey + ly * 0.07, 0.085, 0, Math.PI * 2);
      ctx.fill();
    };
    if (face === 'shades') {
      ctx.strokeStyle = '#1b1b2a';
      ctx.lineWidth = 0.32;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(eyes[0][0], eyes[0][1]);
      ctx.lineTo(eyes[1][0], eyes[1][1]);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(eyes[0][0] - 0.05, eyes[0][1] - 0.1, 0.07, 0.05);
      return;
    }
    for (const [ex, ey] of eyes) {
      if (face === 'happy') {
        ctx.strokeStyle = '#26263a';
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.arc(ex, ey + 0.05, 0.12, Math.PI * 1.1, Math.PI * 1.9);
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = 'white';
      ctx.beginPath();
      if (blink) ctx.ellipse(ex, ey, 0.17, 0.04, 0, 0, Math.PI * 2);
      else ctx.arc(ex, ey, 0.17, 0, Math.PI * 2);
      ctx.fill();
      if (blink) continue;
      pupil(ex, ey);
      if (face === 'sleepy') {
        ctx.fillStyle = cs.css;
        ctx.fillRect(ex - 0.19, ey - 0.19, 0.38, 0.17);
      }
    }
    if (face === 'angry') {
      ctx.strokeStyle = '#26263a';
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      for (const [ex, ey, side] of eyes) {
        ctx.moveTo(ex - 0.16 * side, ey - 0.26);
        ctx.lineTo(ex + 0.12 * side, ey - 0.16);
      }
      ctx.stroke();
    } else if (face === 'happy') {
      ctx.strokeStyle = '#26263a';
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.arc(cx + lx * 0.12, cy + 0.12 + ly * 0.12, 0.16, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
  }

  drawHat(ctx, hat, cx, top, size, t) {
    const y = top + 0.02;
    ctx.lineWidth = 0.06;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    if (hat === 'crown') {
      ctx.fillStyle = '#fcc419';
      ctx.moveTo(cx - 0.45, y);
      ctx.lineTo(cx - 0.45, y - 0.45);
      ctx.lineTo(cx - 0.22, y - 0.22);
      ctx.lineTo(cx, y - 0.55);
      ctx.lineTo(cx + 0.22, y - 0.22);
      ctx.lineTo(cx + 0.45, y - 0.45);
      ctx.lineTo(cx + 0.45, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e03131';
      ctx.beginPath();
      ctx.arc(cx, y - 0.14, 0.07, 0, Math.PI * 2);
      ctx.fill();
    } else if (hat === 'cap') {
      ctx.fillStyle = '#364fc7';
      ctx.arc(cx, y, 0.42, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(cx - 0.05, y - 0.08, 0.7, 0.12);
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.arc(cx, y - 0.42, 0.06, 0, Math.PI * 2);
      ctx.fill();
    } else if (hat === 'bow') {
      ctx.fillStyle = '#f06595';
      ctx.moveTo(cx, y - 0.12);
      ctx.lineTo(cx - 0.4, y - 0.36);
      ctx.lineTo(cx - 0.4, y + 0.08);
      ctx.closePath();
      ctx.moveTo(cx, y - 0.12);
      ctx.lineTo(cx + 0.4, y - 0.36);
      ctx.lineTo(cx + 0.4, y + 0.08);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, y - 0.12, 0.1, 0, Math.PI * 2);
      ctx.fill();
    } else if (hat === 'party') {
      ctx.fillStyle = '#20c997';
      ctx.moveTo(cx - 0.32, y + 0.02);
      ctx.lineTo(cx, y - 0.75);
      ctx.lineTo(cx + 0.32, y + 0.02);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#fcc419';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(cx - 0.2, y - 0.28);
      ctx.lineTo(cx + 0.14, y - 0.4);
      ctx.stroke();
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.arc(cx, y - 0.77, 0.1, 0, Math.PI * 2);
      ctx.fill();
    } else if (hat === 'horns') {
      ctx.fillStyle = '#f1e3c6';
      for (const side of [-1, 1]) {
        ctx.moveTo(cx + side * 0.18, y + 0.04);
        ctx.quadraticCurveTo(cx + side * 0.62, y - 0.1, cx + side * 0.5, y - 0.55);
        ctx.quadraticCurveTo(cx + side * 0.42, y - 0.2, cx + side * 0.42, y + 0.04);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    } else if (hat === 'halo') {
      ctx.strokeStyle = '#ffd43b';
      ctx.lineWidth = 0.12;
      ctx.ellipse(cx, y - 0.35 + Math.sin(t * 3) * 0.05, 0.42, 0.13, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawDanger(ctx, toScreen) {
    const me = this.me;
    if (!me || !me.alive) return;
    const d = this.danger;
    const pulse = 0.5 + 0.5 * Math.sin(this.game.time * 14);
    for (const th of d.threats) {
      const [sx, sy] = toScreen(th.player.x, th.player.y);
      if (this.onScreen(sx, sy, 30)) {
        ctx.strokeStyle = DANGER;
        ctx.globalAlpha = 0.5 + 0.5 * pulse;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx, sy, this.zoom * (1.1 + 0.2 * pulse), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        this.edgeArrow(ctx, sx, sy, DANGER, '!');
      }
    }
    if (d.home && me.path.length) {
      const [sx, sy] = toScreen(d.home.x, d.home.y);
      if (!this.onScreen(sx, sy, 20)) this.edgeArrow(ctx, sx, sy, this.colorOf(me.id).cssDark, '⌂');
    }
  }

  onScreen(sx, sy, m) {
    return sx > m && sy > m && sx < this.w - m && sy < this.h - m;
  }

  edgeArrow(ctx, sx, sy, color, label) {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const dx = sx - cx;
    const dy = sy - cy;
    const m = 44;
    const k = Math.min(Math.abs((cx - m) / (dx || 1e-6)), Math.abs((cy - m) / (dy || 1e-6)));
    const x = cx + dx * k;
    const y = cy + dy * k;
    const ang = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(0, 0, 17, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(26, 0);
    ctx.lineTo(16, -8);
    ctx.lineTo(16, 8);
    ctx.closePath();
    ctx.fill();
    ctx.rotate(-ang);
    ctx.font = '900 18px "Trebuchet MS", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 1);
    ctx.restore();
  }

  drawMinimap() {
    const m = this.miniCtx;
    const ms = this.mini.width;
    const g = this.game;
    const a = g.arena;
    const scale = ms / a.size;
    m.clearRect(0, 0, ms, ms);
    m.save();
    m.beginPath();
    m.arc(ms / 2, ms / 2, ms / 2 - 2, 0, Math.PI * 2);
    m.fillStyle = 'rgba(246,241,231,0.92)';
    m.fill();
    m.clip();
    if (a.activeRadius < a.radius - 1.2) {
      m.fillStyle = STORM;
      m.fillRect(0, 0, ms, ms);
      m.fillStyle = 'rgba(246,241,231,0.95)';
      m.beginPath();
      m.arc((a.center + 0.5) * scale, (a.center + 0.5) * scale, a.activeRadius * scale, 0, Math.PI * 2);
      m.fill();
    }
    m.imageSmoothingEnabled = false;
    m.drawImage(this.terr.c, 0, 0, a.size, a.size, 0, 0, ms, ms);
    for (const p of g.players) {
      if (!p.alive) continue;
      const isMe = p === this.me;
      m.fillStyle = isMe ? '#ffffff' : this.colorOf(p.id).cssDark;
      m.strokeStyle = '#26263a';
      m.lineWidth = isMe ? 3 : 0;
      m.beginPath();
      m.arc(p.x * scale, p.y * scale, isMe ? 6 : p.isBoss ? 5 : 3.5, 0, Math.PI * 2);
      m.fill();
      if (isMe) m.stroke();
    }
    m.restore();
  }
}

// Draws one blob on a patch of land with a trail (Style preview in the menu).
export function drawPreview(canvas, colorIndex, look, time) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const r = Object.create(Renderer.prototype);
  r.lowGraphics = false;
  r.colors = [null, colorSet(colorIndex)];
  r.looks = new WeakMap();
  r.patterns = new Map();
  r.particles = [];
  r.ctx = ctx;
  const p = { id: 1, name: '', angle: Math.sin(time) * 0.5, x: 0, y: -0.9, isBot: false, cosmetics: look, path: [] };
  const game = { players: [p], time, isShielded: () => false, isBoosted: () => false };
  r.game = game;
  const cs = r.colors[1];

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const z = w / 7.5;
  ctx.setTransform(z, 0, 0, z, w / 2, h / 2 + z * 0.3);
  const land = new Path2D();
  roundRect(land, -2.6, -0.6, 5.2, 2.2, 0.6);
  ctx.save();
  ctx.translate(0, SHADE_DROP);
  ctx.fillStyle = cs.cssDark;
  ctx.fill(land);
  ctx.restore();
  ctx.fillStyle = cs.css;
  ctx.fill(land);
  const pattern = r.patternFor(look.pattern, 1);
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fill(land);
  }

  const trail = new Path2D();
  trail.moveTo(-2.4, -1.7);
  trail.quadraticCurveTo(-1.2, -2.7, 0, -1.0);
  ctx.lineCap = 'round';
  if (look.trail === 'glow') {
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = TRAIL_WIDTH * 2;
    ctx.strokeStyle = cs.cssTrail;
    ctx.stroke(trail);
    ctx.globalAlpha = 1;
  }
  ctx.lineWidth = TRAIL_WIDTH;
  ctx.strokeStyle = cs.cssTrail;
  if (look.trail === 'dashed') ctx.setLineDash([0.7, 0.5]);
  if (look.trail === 'rainbow') {
    const grad = ctx.createLinearGradient(-2.4, 0, 0, 0);
    for (let k = 0; k <= 6; k++) grad.addColorStop(k / 6, `hsl(${(time * 60 + k * 60) % 360}, 85%, 70%)`);
    ctx.strokeStyle = grad;
  }
  ctx.stroke(trail);
  ctx.setLineDash([]);
  if (look.trail === 'sparkle') {
    ctx.fillStyle = 'white';
    for (let k = 0; k < 5; k++) {
      const a = time * 3 + k * 1.3;
      ctx.fillRect(-1.2 + Math.cos(a) * 0.9 - 0.08, -1.9 + Math.sin(a * 1.3) * 0.5, 0.16, 0.16);
    }
  }
  r.drawPlayer(ctx, p, game);
}

// Adds a rounded rectangle; starts a new path when given a canvas context.
function roundRect(ctx, x, y, w, h, r) {
  if (ctx.beginPath) ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
