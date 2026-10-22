// Replays store the game options plus the human's steering input per fixed
// step. Re-running the deterministic engine with the same inputs reproduces
// the whole game. A coarse position track doubles as the "ghost" of your best run.
import { quantizeAngle } from '../engine/game.js';

const GHOST_EVERY = 6; // steps between ghost samples
const MAX_INPUTS = 120000;

export class Recorder {
  constructor(options) {
    this.options = options;
    this.inputs = [];
    this.ghost = [];
    this.last = null;
  }

  // Call before game.update(); returns the quantized angle to apply.
  input(step, angle) {
    const a = quantizeAngle(angle);
    if (a !== this.last && this.inputs.length < MAX_INPUTS) {
      this.inputs.push(step, a);
      this.last = a;
    }
    return a;
  }

  sample(game) {
    if (game.steps % GHOST_EVERY !== 0) return;
    const h = game.human;
    this.ghost.push(Math.round(h.x * 10) / 10, Math.round(h.y * 10) / 10, Math.round(game.pctOf(h) * 100) / 100, h.alive ? 1 : 0);
  }

  finish(game) {
    return {
      v: 1,
      options: this.options,
      inputs: this.inputs,
      ghost: this.ghost,
      steps: game.steps,
      result: game.result,
      date: Date.now(),
    };
  }
}

export class ReplayDriver {
  constructor(replay) {
    this.replay = replay;
    this.k = 0;
  }

  // Applies the inputs recorded for the game's current step.
  apply(game) {
    const inp = this.replay.inputs;
    while (this.k < inp.length && inp[this.k] <= game.steps) {
      game.setHumanTarget(inp[this.k + 1]);
      this.k += 2;
    }
  }

  done(game) {
    return game.finished || game.steps >= this.replay.steps + 120;
  }
}

// Ghost position/progress at a given step, interpolated.
export function ghostAt(replay, step) {
  const g = replay.ghost;
  const n = g.length / 4;
  if (!n) return null;
  const f = step / GHOST_EVERY;
  const i = Math.floor(f);
  if (i >= n - 1) {
    const k = (n - 1) * 4;
    return { x: g[k], y: g[k + 1], pct: g[k + 2], alive: false, over: true };
  }
  const t = f - i;
  const k = i * 4;
  return {
    x: g[k] + (g[k + 4] - g[k]) * t,
    y: g[k + 1] + (g[k + 5] - g[k + 1]) * t,
    pct: g[k + 2] + (g[k + 6] - g[k + 2]) * t,
    alive: g[k + 3] === 1,
    over: false,
  };
}
