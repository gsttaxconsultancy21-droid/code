// Per-game stat tracking, daily challenges and career achievements.
import { createRng } from '../engine/util.js';

// Collects what missions need while a game runs.
export class GameTracker {
  constructor(game) {
    this.game = game;
    this.stats = {
      mode: game.mode.id,
      kills: 0,
      captures: 0,
      bestCapture: 0,
      combo: 0,
      bestCombo: 0,
      powerups: 0,
      blocks: 0,
      bossKills: 0,
      peakPct: 0,
      leftPct: 0,
      leftOnly: true,
      timeAlive: 0,
      rank: 99,
      won: false,
    };
    this.lastCapture = -10;
  }

  step() {
    const g = this.game;
    const h = g.human;
    const st = this.stats;
    if (!h.alive) return;
    st.timeAlive = g.time;
    const pct = g.pctOf(h);
    st.peakPct = Math.max(st.peakPct, pct);
    if (st.leftOnly && h.x > g.arena.center + 0.5) st.leftOnly = false;
    if (st.leftOnly) st.leftPct = Math.max(st.leftPct, pct);
  }

  // Returns the combo count for a capture by the human (1 = no combo).
  onEvent(e) {
    const g = this.game;
    const h = g.human;
    const st = this.stats;
    if (e.type === 'capture' && e.player === h && !e.bomb && e.gained > 0) {
      st.captures++;
      st.bestCapture = Math.max(st.bestCapture, e.pct);
      st.combo = g.time - this.lastCapture <= 4 ? st.combo + 1 : 1;
      st.bestCombo = Math.max(st.bestCombo, st.combo);
      this.lastCapture = g.time;
      return st.combo;
    }
    if (e.type === 'death' && e.killer === h && e.victim !== h) {
      st.kills++;
      if (e.victim.isBoss) st.bossKills++;
    } else if (e.type === 'powerup' && e.player === h) {
      st.powerups++;
    } else if (e.type === 'block' && e.player === h) {
      st.blocks++;
    }
    return 0;
  }

  finish(result) {
    this.stats.rank = result.rank;
    this.stats.won = result.won;
    this.stats.peakPct = Math.max(this.stats.peakPct, result.peakPct);
    return this.stats;
  }
}

// Daily templates: value(stats) is compared against one of three goals.
const DAILY = [
  { id: 'land', goals: [5, 8, 12], text: (n) => `Reach ${n}% land in one game`, value: (s) => s.peakPct },
  { id: 'kills', goals: [2, 3, 5], text: (n) => `Knock out ${n} rivals in one game`, value: (s) => s.kills },
  { id: 'combo', goals: [2, 3, 4], text: (n) => `Chain a ×${n} capture combo`, value: (s) => s.bestCombo },
  { id: 'big', goals: [1.5, 2.5, 4], text: (n) => `Claim ${n}% in a single loop`, value: (s) => s.bestCapture },
  { id: 'left', goals: [3, 5, 8], text: (n) => `Reach ${n}% without leaving the left half`, value: (s) => s.leftPct },
  { id: 'loot', goals: [2, 4, 6], text: (n) => `Grab ${n} power-ups in one game`, value: (s) => s.powerups },
  { id: 'survive', goals: [60, 120, 180], text: (n) => `Survive ${n} seconds`, value: (s) => s.timeAlive },
  { id: 'storm', goals: [3, 2, 1], lower: true, text: (n) => (n === 1 ? 'Win an Ink Storm' : `Finish top ${n} in Ink Storm`),
    value: (s) => (s.mode === 'storm' ? s.rank : Infinity) },
  { id: 'boss', goals: [1, 1, 2], text: (n) => `Knock out the Grand Smudge${n > 1 ? ` ${n} times` : ''}`, value: (s) => s.bossKills },
  { id: 'block', goals: [1, 1, 2], text: (n) => `Block ${n > 1 ? `${n} cuts` : 'a cut'} with a shield`, value: (s) => s.blocks },
];

// One-off career achievements. value(stats, save) uses lifetime totals too.
export const CAREER = [
  { id: 'first-loop', stars: 1, text: 'Close your first loop', value: (s) => s.captures, goal: 1 },
  { id: 'first-ko', stars: 1, text: 'Knock out a rival', value: (s, sv) => sv.stats.kills, goal: 1 },
  { id: 'pct10', stars: 1, text: 'Reach 10% land', value: (s, sv) => sv.stats.best, goal: 10 },
  { id: 'pct25', stars: 2, text: 'Reach 25% land', value: (s, sv) => sv.stats.best, goal: 25 },
  { id: 'pct50', stars: 3, text: 'Reach 50% land', value: (s, sv) => sv.stats.best, goal: 50 },
  { id: 'ko25', stars: 2, text: '25 knockouts in total', value: (s, sv) => sv.stats.kills, goal: 25 },
  { id: 'ko100', stars: 3, text: '100 knockouts in total', value: (s, sv) => sv.stats.kills, goal: 100 },
  { id: 'combo5', stars: 2, text: 'Chain a ×5 combo', value: (s) => s.bestCombo, goal: 5 },
  { id: 'win', stars: 2, text: 'Win any game', value: (s, sv) => sv.stats.wins, goal: 1 },
  { id: 'storm', stars: 2, text: 'Win an Ink Storm', value: (s) => (s.mode === 'storm' && s.won ? 1 : 0), goal: 1 },
  { id: 'rush', stars: 2, text: 'Win a Time Rush', value: (s) => (s.mode === 'rush' && s.won ? 1 : 0), goal: 1 },
  { id: 'boss5', stars: 3, text: 'Beat the Grand Smudge 5 times', value: (s, sv) => sv.stats.bossKills, goal: 5 },
  { id: 'games25', stars: 2, text: 'Play 25 games', value: (s, sv) => sv.stats.games, goal: 25 },
];

export function today(date = new Date()) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function dayNumber(day) {
  return Math.round(Date.parse(`${day}T12:00:00Z`) / 86400000);
}

// Makes sure save.missions.daily holds today's three challenges.
export function ensureDaily(save, day = today()) {
  const m = save.missions;
  if (m.daily && m.daily.date === day) return m.daily;
  const rng = createRng(dayNumber(day) * 7919);
  const pool = DAILY.slice();
  const picks = [];
  while (picks.length < 3) {
    const t = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    picks.push({ id: t.id, tier: Math.floor(rng() * 3), best: null, done: false });
  }
  m.daily = { date: day, list: picks, bonus: false };
  return m.daily;
}

export function describeDaily(entry) {
  const t = DAILY.find((d) => d.id === entry.id);
  const goal = t.goals[entry.tier];
  return { text: t.text(goal), goal, lower: !!t.lower };
}

const meets = (value, goal, lower) => (lower ? value <= goal : value >= goal);

// Scores a finished game against daily and career missions.
// Returns [{ text, stars }] for everything completed by this game.
export function evaluateMissions(save, stats, day = today()) {
  const done = [];
  const m = save.missions;
  const daily = ensureDaily(save, day);
  for (const entry of daily.list) {
    const t = DAILY.find((d) => d.id === entry.id);
    const goal = t.goals[entry.tier];
    const value = t.value(stats);
    if (Number.isFinite(value)) {
      entry.best = entry.best == null ? value : t.lower ? Math.min(entry.best, value) : Math.max(entry.best, value);
    }
    if (!entry.done && meets(value, goal, t.lower)) {
      entry.done = true;
      done.push({ text: t.text(goal), stars: 1 });
    }
  }
  if (!daily.bonus && daily.list.every((e) => e.done)) {
    daily.bonus = true;
    const yesterday = today(new Date(Date.parse(`${day}T12:00:00Z`) - 86400000));
    m.streak = m.lastFullDay === yesterday ? m.streak + 1 : 1;
    m.lastFullDay = day;
    done.push({ text: `All daily challenges done (streak ${m.streak})`, stars: 2 });
  }
  for (const c of CAREER) {
    if (m.career[c.id]) continue;
    if (c.value(stats, save) >= c.goal) {
      m.career[c.id] = Date.now();
      done.push({ text: c.text, stars: c.stars });
    }
  }
  for (const d of done) save.stars += d.stars;
  return done;
}
