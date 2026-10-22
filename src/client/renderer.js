// Canvas renderer. Territory is traced every frame for the visible cells with
// marching squares over cell centres, so edges are smooth vector shapes at any
// zoom instead of pixel staircases. Trails are stroked along the exact path the
// player drove. A one-pixel-per-cell bitmap of territory feeds the minimap.
import { WALL } from '../engine/arena.js';
import { colorSet } from './palette.js';

const FLOOR = '#f6f1e7';
const FLOOR_LINE = 'rgba(80, 60, 30, 0.06)';
const VOID = '#2f3150';
const RIM = '#d8ccb6';
const SHADE_DROP = 0.35;
const TRAIL_WIDTH = 0.9;

// Marching-squares outlines for one owner inside a quad whose corners are four
// cell centres. Bit order: top-left 8, top-right 4, bottom-right 2, bottom-left 1.
// Points are unit offsets: corners plus edge midpoints (which sit on cell edges).
const TL = [0, 0], TR = [1, 0], BR = [1, 1], BL = [0, 1];
const MT = [0.5, 0], MR = [1, 0.5], MB = [0.5, 1], ML = [0, 0.5];
const SHAPES = [
  null,
  [ML, MB, BL],
  [MB, MR, BR],
  [ML, MR, BR, BL],
  [MT, TR, MR],
  [MT, TR, MR, MB, BL, ML],
  [MT, TR, BR, MB],
  [MT, TR, BR, BL, ML],
  [TL, MT, ML],
  [TL, MT, MB, BL],
  [TL, MT, MR, BR, MB, ML],
  [TL, MT, MR, BR, BL],
  [TL, TR, MR, ML],
  [TL, TR, MR, MB, BL],
  [TL, TR, BR, MB, ML],
  [TL, TR, BR, BL],
];

export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.miniCtx = minimap.getContext('2d');
    this.game = null;
    this.cam = { x: 0, y: 0 };
    this.zoom = 20;
    this.particles = [];
    this.popups = [];
    this.shake = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  attach(game) {
    this.game = game;
    const a = game.arena;
    const s = a.size;
    const makeLayer = () => {
      const c = document.createElement('canvas');
      c.width = s;
      c.height = s;
      const ctx = c.getContext('2d');
      return { c, ctx, img: ctx.createImageData(s, s) };
    };
    this.terr = makeLayer();
    this.colors = [null, ...game.players.map((p) => colorSet(p.color))];
    a.trackChanges = true;
    a.changes.length = 0;
    for (let i = 0; i < a.owner.length; i++) this.paintCell(i);
    this.flush();
    this.particles.length = 0;
    this.popups.length = 0;
    this.cam.x = game.human.x;
    this.cam.y = game.human.y;
    this.zoom = this.targetZoom(0);
  }

  paintCell(i) {
    const o = this.game.arena.owner[i];
    const T = this.terr.img.data;
    const k = i * 4;
    if (o !== 0 && o !== WALL) {
      const cs = this.colors[o];
      T[k] = cs.base[0]; T[k + 1] = cs.base[1]; T[k + 2] = cs.base[2]; T[k + 3] = 255;
    } else {
      T[k + 3] = 0;
    }
  }

  flush() {
    this.terr.ctx.putImageData(this.terr.img, 0, 0);
  }

  // Builds one Path2D per owner covering the territory in quads [x0..x1] x [y0..y1].
  // Fully owned quads are merged into horizontal runs; only edge quads are traced.
  territoryPaths(x0, y0, x1, y1) {
    const a = this.game.arena;
    const s = a.size;
    const own = a.owner;
    const paths = new Map();
    const pathFor = (id) => {
      let p = paths.get(id);
      if (!p) {
        p = new Path2D();
        paths.set(id, p);
      }
      return p;
    };
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(s - 2, x1);
    y1 = Math.min(s - 2, y1);
    const ids = [0, 0, 0, 0];
    for (let qy = y0; qy <= y1; qy++) {
      let runId = 0;
      let runStart = 0;
      for (let qx = x0; qx <= x1 + 1; qx++) {
        let full = 0;
        let o0 = 0, o1 = 0, o2 = 0, o3 = 0;
        if (qx <= x1) {
          const i = qy * s + qx;
          o0 = own[i];
          o1 = own[i + 1];
          o2 = own[i + s + 1];
          o3 = own[i + s];
          if (o0 === o1 && o0 === o2 && o0 === o3 && o0 !== 0 && o0 !== WALL) full = o0;
        }
        if (full !== runId) {
          if (runId) pathFor(runId).rect(runStart + 0.5, qy + 0.5, qx - runStart, 1);
          runId = full;
          runStart = qx;
        }
        if (full || qx > x1) continue;
        ids[0] = o0; ids[1] = o1; ids[2] = o2; ids[3] = o3;
        for (let k = 0; k < 4; k++) {
          const id = ids[k];
          if (id === 0 || id === WALL || ids.indexOf(id) !== k) continue;
          const mask = (o0 === id ? 8 : 0) | (o1 === id ? 4 : 0) | (o2 === id ? 2 : 0) | (o3 === id ? 1 : 0);
          const shape = SHAPES[mask];
          const p = pathFor(id);
          const bx = qx + 0.5;
          const by = qy + 0.5;
          p.moveTo(bx + shape[0][0], by + shape[0][1]);
          for (let j = 1; j < shape.length; j++) p.lineTo(bx + shape[j][0], by + shape[j][1]);
          p.closePath();
        }
      }
    }
    return paths;
  }

  drawTerritory(ctx, vx0, vy0, vx1, vy1) {
    const paths = this.territoryPaths(Math.floor(vx0) - 1, Math.floor(vy0) - 2, Math.ceil(vx1), Math.ceil(vy1));
    // A thin round-joined stroke in the fill colour softens the corners.
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.22;
    ctx.save();
    ctx.translate(0, SHADE_DROP);
    for (const [id, path] of paths) {
      ctx.fillStyle = ctx.strokeStyle = this.colors[id].cssDark;
      ctx.fill(path);
      ctx.stroke(path);
    }
    ctx.restore();
    for (const [id, path] of paths) {
      ctx.fillStyle = ctx.strokeStyle = this.colors[id].css;
      ctx.fill(path);
      ctx.stroke(path);
    }
  }

  drawTrails(ctx) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = TRAIL_WIDTH;
    ctx.globalAlpha = 0.85;
    for (const p of this.game.players) {
      const path = p.path;
      if (!p.alive || path.length < 2) continue;
      ctx.strokeStyle = this.colors[p.id].cssTrail;
      ctx.beginPath();
      ctx.moveTo(path[0], path[1]);
      for (let i = 2; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  targetZoom(pct) {
    // Zoom out gently as the player's land grows.
    return Math.min(this.w, this.h) / (30 + 22 * Math.sqrt(Math.min(pct, 100) / 100));
  }

  onEvent(e) {
    const g = this.game;
    if (e.type === 'death') {
      const cs = this.colors[e.victim.id];
      for (let i = 0; i < 26; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 2 + Math.random() * 7;
        this.particles.push({
          x: e.x, y: e.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          life: 0.6 + Math.random() * 0.5, max: 1.1, size: 0.25 + Math.random() * 0.45, color: cs.css,
        });
      }
      if (e.victim === g.human) this.shake = 0.5;
    } else if (e.type === 'capture' && e.player === g.human && e.pct >= 0.05) {
      this.popups.push({ x: e.x, y: e.y - 1, text: `+${e.pct.toFixed(1)}%`, life: 1.1 });
    }
  }

  render(dt, input) {
    const g = this.game;
    if (!g) return;
    const a = g.arena;
    const ctx = this.ctx;

    if (a.changes.length) {
      for (const i of a.changes) this.paintCell(i);
      a.changes.length = 0;
      this.flush();
    }

    const h = g.human;
    const follow = h.alive ? 1 - Math.exp(-dt * 9) : 0;
    this.cam.x += (h.x - this.cam.x) * follow;
    this.cam.y += (h.y - this.cam.y) * follow;
    this.zoom += (this.targetZoom(g.pctOf(h)) - this.zoom) * (1 - Math.exp(-dt * 2));
    this.shake = Math.max(0, this.shake - dt);

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

    // Paper floor with a raised rim.
    ctx.fillStyle = RIM;
    ctx.beginPath();
    ctx.arc(c, c + 0.5, R + 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = FLOOR;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.clip();
    const vx0 = this.cam.x - this.w / 2 / z - 1;
    const vx1 = this.cam.x + this.w / 2 / z + 1;
    const vy0 = this.cam.y - this.h / 2 / z - 1;
    const vy1 = this.cam.y + this.h / 2 / z + 1;
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

    this.drawTerritory(ctx, vx0, vy0, vx1, vy1);
    this.drawTrails(ctx);

    const t = g.time;
    for (const p of g.players) if (p.alive) this.drawPlayer(ctx, p, t);

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

    // Screen-space overlays: names, popups, joystick.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const toScreen = (x, y) => [
      this.w / 2 + (x - this.cam.x) * z + shakeX,
      this.h / 2 + (y - this.cam.y) * z + shakeY,
    ];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = `700 ${Math.max(11, Math.round(z * 0.62))}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.lineJoin = 'round';
    for (const p of g.players) {
      if (!p.alive) continue;
      const [sx, sy] = toScreen(p.x, p.y - 0.95);
      if (sx < -80 || sx > this.w + 80 || sy < -40 || sy > this.h + 60) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeText(p.name, sx, sy);
      ctx.fillStyle = this.colors[p.id].cssDark;
      ctx.fillText(p.name, sx, sy);
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
      ctx.fillStyle = this.colors[h.id].cssDark;
      ctx.fillText(pop.text, sx, sy);
    }
    ctx.globalAlpha = 1;

    if (input && input.stick) {
      const s = input.stick;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.arc(s.ox, s.oy, 60, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 24, 0, Math.PI * 2);
      ctx.fill();
    }

    this.drawMinimap();
  }

  drawPlayer(ctx, p, t) {
    const cs = this.colors[p.id];
    const size = 1.3;
    const bob = Math.sin(t * 10 + p.id) * 0.04;
    const x = p.x - size / 2;
    const y = p.y - size / 2 + bob;
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    roundRect(ctx, x + 0.08, y + 0.5, size, size, 0.38);
    ctx.fill();
    ctx.fillStyle = cs.cssDark;
    roundRect(ctx, x, y + 0.3, size, size, 0.38);
    ctx.fill();
    ctx.fillStyle = cs.css;
    roundRect(ctx, x, y, size, size, 0.38);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    roundRect(ctx, x + 0.18, y + 0.12, size - 0.36, 0.28, 0.14);
    ctx.fill();

    // Eyes look where the blob is heading.
    const lx = Math.cos(p.angle);
    const ly = Math.sin(p.angle);
    const blink = (t + p.id * 1.7) % 4 < 0.12;
    for (const side of [-1, 1]) {
      const ex = p.x + -ly * side * 0.26 + lx * 0.12;
      const ey = p.y + bob + lx * side * 0.26 + ly * 0.12;
      ctx.fillStyle = 'white';
      ctx.beginPath();
      if (blink) ctx.ellipse(ex, ey, 0.17, 0.04, 0, 0, Math.PI * 2);
      else ctx.arc(ex, ey, 0.17, 0, Math.PI * 2);
      ctx.fill();
      if (!blink) {
        ctx.fillStyle = '#26263a';
        ctx.beginPath();
        ctx.arc(ex + lx * 0.07, ey + ly * 0.07, 0.085, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
    m.imageSmoothingEnabled = false;
    m.drawImage(this.terr.c, 0, 0, a.size, a.size, 0, 0, ms, ms);
    for (const p of g.players) {
      if (!p.alive) continue;
      const isHuman = p === g.human;
      m.fillStyle = isHuman ? '#ffffff' : this.colors[p.id].cssDark;
      m.strokeStyle = '#26263a';
      m.lineWidth = isHuman ? 3 : 0;
      m.beginPath();
      m.arc(p.x * scale, p.y * scale, isHuman ? 6 : 3.5, 0, Math.PI * 2);
      m.fill();
      if (isHuman) m.stroke();
    }
    m.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
