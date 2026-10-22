// Inkland local server. Zero dependencies: serves the game and a small
// leaderboard API backed by a JSON file. Runs fully offline on localhost/LAN.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.INKLAND_DATA || path.join(ROOT, 'server', 'data');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const MODES = new Set(['classic', 'rush']);
const MAX_STORED = 200;
const MAX_BODY = 2048;

const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icon.svg']);
const PUBLIC_DIRS = ['src'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

let scores = [];
let writeChain = Promise.resolve();

async function loadScores() {
  try {
    const data = JSON.parse(await fs.readFile(SCORES_FILE, 'utf8'));
    if (Array.isArray(data)) scores = data.filter(validScore);
  } catch {
    scores = [];
  }
}

function persistScores() {
  writeChain = writeChain.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${SCORES_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(scores, null, 1));
    await fs.rename(tmp, SCORES_FILE);
  }).catch((err) => console.error('Failed to save scores:', err.message));
  return writeChain;
}

function validScore(s) {
  return s && typeof s.name === 'string' && Number.isFinite(s.score) && MODES.has(s.mode);
}

export function sanitizeScore(body) {
  if (!body || typeof body !== 'object') return null;
  const name = String(body.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14) || 'Player';
  const score = Number(body.score);
  const kills = Number(body.kills ?? 0);
  const time = Number(body.time ?? 0);
  const mode = String(body.mode ?? '');
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  if (!Number.isInteger(kills) || kills < 0 || kills > 9999) return null;
  if (!Number.isFinite(time) || time < 0 || time > 86400) return null;
  if (!MODES.has(mode)) return null;
  return { name, score: Math.round(score * 100) / 100, kills, time: Math.round(time), mode, date: Date.now() };
}

function topScores(mode, limit = 20) {
  return scores
    .filter((s) => !mode || s.mode === mode)
    .sort((a, b) => b.score - a.score || a.date - b.date)
    .slice(0, limit);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, name: 'inkland', scores: scores.length });
  }
  if (url.pathname === '/api/scores' && req.method === 'GET') {
    const mode = url.searchParams.get('mode');
    return send(res, 200, { scores: topScores(MODES.has(mode) ? mode : null) });
  }
  if (url.pathname === '/api/scores' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return send(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
    }
    const entry = sanitizeScore(body);
    if (!entry) return send(res, 422, { error: 'Invalid score' });
    scores.push(entry);
    scores = topScores(null, MAX_STORED);
    await persistScores();
    const rank = topScores(entry.mode, MAX_STORED).indexOf(entry) + 1;
    return send(res, 201, { ok: true, rank: rank || null });
  }
  return send(res, 404, { error: 'Not found' });
}

async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    return send(res, 400, 'Bad request');
  }
  const file = path.resolve(ROOT, rel);
  const inRoot = file.startsWith(ROOT + path.sep);
  const top = rel.split('/')[0];
  const allowed = inRoot && (PUBLIC_FILES.has(rel) || PUBLIC_DIRS.includes(top));
  if (!allowed) return send(res, 404, 'Not found');
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    send(res, 404, 'Not found');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(req, res, url);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'Server error' });
    }
  });
}

export async function start(port = PORT, host = HOST) {
  await loadScores();
  const server = createServer();
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().then((server) => {
    const { port } = server.address();
    console.log(`Inkland running at http://localhost:${port}  (Ctrl+C to stop)`);
  });
}
