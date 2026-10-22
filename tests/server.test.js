import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkland-'));
process.env.INKLAND_DATA = dataDir;
const { start, sanitizeScore } = await import('../server/server.js');

let server;
let base;
before(async () => {
  server = await start(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('health endpoint identifies the game', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'inkland');
});

test('scores are validated, ranked and persisted', async () => {
  const post = (body) => fetch(`${base}/api/scores`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ name: 'A', score: 12.5, kills: 2, mode: 'classic', time: 60 })).status, 201);
  assert.equal((await post({ name: 'B', score: 40, kills: 0, mode: 'classic', time: 90 })).status, 201);
  assert.equal((await post({ name: 'C', score: 9, kills: 1, mode: 'rush', time: 120 })).status, 201);
  assert.equal((await post({ name: 'X', score: 150, kills: 0, mode: 'classic' })).status, 422);
  assert.equal((await post({ name: 'X', score: 5, kills: 0, mode: 'other' })).status, 422);

  const { scores } = await (await fetch(`${base}/api/scores?mode=classic`)).json();
  assert.deepEqual(scores.map((s) => s.name), ['B', 'A']);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'scores.json'), 'utf8'));
  assert.equal(saved.length, 3);
});

test('rejects invalid JSON and oversized bodies', async () => {
  assert.equal((await fetch(`${base}/api/scores`, { method: 'POST', body: '{nope' })).status, 400);
  const big = JSON.stringify({ name: 'x'.repeat(5000), score: 1, mode: 'classic' });
  const res = await fetch(`${base}/api/scores`, { method: 'POST', body: big }).catch(() => ({ status: 413 }));
  assert.equal(res.status, 413);
});

test('serves the game but nothing outside the public files', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Inkland/);
  assert.equal((await fetch(`${base}/src/engine/game.js`)).status, 200);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/src/../server/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/etc/passwd`)).status, 404);
});

test('sanitizeScore strips markup and clamps names', () => {
  const s = sanitizeScore({ name: '<b>Bob</b> the very long name', score: 3, kills: 0, mode: 'rush' });
  assert.equal(s.name, 'bBob/b the ver');
});
