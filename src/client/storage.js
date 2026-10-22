// Saves live in localStorage so the game works fully offline. When the page is
// served by the bundled local server, scores are also mirrored to its API.
const SAVE_KEY = 'inkland.save.v1';
const MAX_SCORES = 20;

function defaultSave() {
  return {
    name: '',
    skin: 0,
    mode: 'classic',
    difficulty: 'normal',
    muted: false,
    stats: { best: 0, kills: 0, games: 0, wins: 0, timePlayed: 0 },
    scores: [],
  };
}

export function loadSave() {
  const save = defaultSave();
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      Object.assign(save, data, { stats: { ...save.stats, ...(data.stats || {}) } });
      if (!Array.isArray(save.scores)) save.scores = [];
    }
  } catch {
    // Private mode or corrupted data: fall back to defaults.
  }
  return save;
}

export function writeSave(save) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    // Storage unavailable; progress lasts for this session only.
  }
}

// Folds a finished game into the save. Returns { newBest, entry }.
export function recordGame(save, result) {
  const st = save.stats;
  const score = Math.round(result.peakPct * 100) / 100;
  const newBest = score > st.best;
  st.games++;
  st.kills += result.kills;
  st.timePlayed += Math.round(result.time);
  if (result.won) st.wins++;
  if (newBest) st.best = score;
  const entry = {
    name: save.name || 'Player',
    score,
    kills: result.kills,
    mode: result.mode,
    time: Math.round(result.time),
    date: Date.now(),
  };
  save.scores.push(entry);
  save.scores.sort((a, b) => b.score - a.score);
  save.scores.length = Math.min(save.scores.length, MAX_SCORES);
  return { newBest, entry };
}

async function request(path, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(path, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const remote = {
  available: null,

  async check() {
    if (this.available !== null) return this.available;
    if (!/^https?:$/.test(location.protocol)) return (this.available = false);
    try {
      const info = await request('api/health');
      this.available = info && info.name === 'inkland';
    } catch {
      this.available = false;
    }
    return this.available;
  },

  async scores(mode) {
    if (!(await this.check())) return null;
    try {
      return (await request(`api/scores?mode=${encodeURIComponent(mode)}`)).scores;
    } catch {
      return null;
    }
  },

  async submit(entry) {
    if (!(await this.check())) return null;
    try {
      return await request('api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch {
      return null;
    }
  },
};
