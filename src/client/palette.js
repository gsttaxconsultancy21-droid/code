// Player colours and cosmetics. The first colours double as selectable skins;
// the rest are bot-only colours so a full lobby never repeats.
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

// Cosmetic slots. Each item: id, name, unlock requirement.
export const COSMETICS = {
  pattern: [
    { id: 'plain', name: 'Plain', req: null },
    { id: 'stripes', name: 'Stripes', req: { stars: 3 } },
    { id: 'dots', name: 'Dots', req: { stars: 6 } },
    { id: 'checks', name: 'Checks', req: { stars: 10 } },
    { id: 'waves', name: 'Waves', req: { stars: 15 } },
    { id: 'splats', name: 'Splats', req: { stars: 22 } },
  ],
  trail: [
    { id: 'plain', name: 'Ink', req: null },
    { id: 'dashed', name: 'Dashed', req: { stars: 4 } },
    { id: 'glow', name: 'Glow', req: { kills: 15 } },
    { id: 'sparkle', name: 'Sparkle', req: { stars: 12 } },
    { id: 'rainbow', name: 'Rainbow', req: { best: 50 } },
  ],
  hat: [
    { id: 'none', name: 'None', req: null },
    { id: 'cap', name: 'Cap', req: { games: 5 } },
    { id: 'bow', name: 'Bow', req: { stars: 5 } },
    { id: 'party', name: 'Party hat', req: { stars: 8 } },
    { id: 'horns', name: 'Horns', req: { kills: 25 } },
    { id: 'halo', name: 'Halo', req: { stars: 18 } },
    { id: 'crown', name: 'Crown', req: { wins: 3 } },
  ],
  face: [
    { id: 'classic', name: 'Classic', req: null },
    { id: 'happy', name: 'Happy', req: { games: 2 } },
    { id: 'sleepy', name: 'Sleepy', req: { stars: 2 } },
    { id: 'angry', name: 'Fierce', req: { kills: 5 } },
    { id: 'shades', name: 'Shades', req: { stars: 14 } },
  ],
};
export const SLOTS = [
  { key: 'pattern', label: 'Land pattern' },
  { key: 'trail', label: 'Trail' },
  { key: 'hat', label: 'Hat' },
  { key: 'face', label: 'Face' },
];
export const DEFAULT_LOOK = { pattern: 'plain', trail: 'plain', hat: 'none', face: 'classic' };

export function unlocked(item, progress) {
  const r = item.req;
  if (!r) return true;
  return Object.keys(r).every((k) => (progress[k] || 0) >= r[k]);
}

// Backwards-compatible name used for colour skins.
export const skinUnlocked = unlocked;

export function requirementLabel(req) {
  if (!req) return '';
  if (req.best != null) return `Reach ${req.best}%`;
  if (req.kills != null) return `${req.kills} total knockouts`;
  if (req.wins != null) return `Win ${req.wins} games`;
  if (req.stars != null) return `${req.stars} ★`;
  return `Play ${req.games} games`;
}

export function findItem(slot, id) {
  return COSMETICS[slot].find((c) => c.id === id) || COSMETICS[slot][0];
}

// Bots get a stable random look derived from their id and name.
export function botLook(p) {
  if (p.isBoss) return { pattern: 'splats', trail: 'glow', hat: 'crown', face: 'angry' };
  let h = p.id * 2654435761;
  for (let i = 0; i < p.name.length; i++) h = Math.imul(h ^ p.name.charCodeAt(i), 16777619);
  const pick = (slot, salt) => {
    const list = COSMETICS[slot];
    const v = (Math.imul(h ^ salt, 2246822519) >>> 0) % (list.length * 2);
    return v < list.length ? list[v].id : list[0].id; // half the bots stay plain
  };
  return { pattern: pick('pattern', 11), trail: pick('trail', 23), hat: pick('hat', 37), face: pick('face', 41) };
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
  const key = ((index % COLORS.length) + COLORS.length) % COLORS.length;
  if (colorCache.has(key)) return colorCache.get(key);
  const base = hexToRgb(COLORS[key]);
  const dark = mixRgb(base, [20, 20, 40], 0.32);
  const trail = mixRgb(base, [255, 255, 255], 0.38);
  const set = { base, dark, trail, css: rgbCss(base), cssDark: rgbCss(dark), cssTrail: rgbCss(trail) };
  colorCache.set(key, set);
  return set;
}
