// Player colours. The first entries double as selectable skins; the rest are
// bot-only colours so a full lobby never repeats.
export const SKINS = [
  { name: 'Coral', hex: '#ff6b6b', req: null },
  { name: 'Sky', hex: '#4dabf7', req: null },
  { name: 'Mint', hex: '#38d9a9', req: null },
  { name: 'Sunny', hex: '#fcc419', req: null },
  { name: 'Grape', hex: '#9775fa', req: { games: 3 } },
  { name: 'Tangerine', hex: '#ff922b', req: { best: 10 } },
  { name: 'Rose', hex: '#f06595', req: { kills: 10 } },
  { name: 'Lime', hex: '#94d82d', req: { best: 25 } },
  { name: 'Ocean', hex: '#1c7ed6', req: { kills: 30 } },
  { name: 'Ruby', hex: '#e03131', req: { best: 40 } },
  { name: 'Jade', hex: '#0ca678', req: { games: 20 } },
  { name: 'Graphite', hex: '#495057', req: { best: 60 } },
];

const BOT_ONLY = ['#66d9e8', '#e599f7', '#d4a373', '#5c7cfa'];
export const COLORS = [...SKINS.map((s) => s.hex), ...BOT_ONLY];

export function skinUnlocked(skin, stats) {
  const r = skin.req;
  if (!r) return true;
  return (r.best == null || stats.best >= r.best) &&
    (r.kills == null || stats.kills >= r.kills) &&
    (r.games == null || stats.games >= r.games);
}

export function requirementLabel(req) {
  if (!req) return '';
  if (req.best != null) return `Reach ${req.best}%`;
  if (req.kills != null) return `${req.kills} total kills`;
  return `Play ${req.games} games`;
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mixRgb(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const colorCache = new Map();

export function colorSet(index) {
  const key = index % COLORS.length;
  if (colorCache.has(key)) return colorCache.get(key);
  const base = hexToRgb(COLORS[key]);
  const dark = mixRgb(base, [20, 20, 40], 0.32);
  const trail = mixRgb(base, [255, 255, 255], 0.38);
  const set = { base, dark, trail, css: rgbCss(base), cssDark: rgbCss(dark), cssTrail: rgbCss(trail) };
  colorCache.set(key, set);
  return set;
}
