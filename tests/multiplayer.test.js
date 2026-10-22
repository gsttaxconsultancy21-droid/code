import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkland-mp-'));
process.env.INKLAND_DATA = dataDir;
const { start } = await import('../server/server.js');

let server;
let url;
before(async () => {
  server = await start(0, '127.0.0.1');
  url = `ws://127.0.0.1:${server.address().port}/ws`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function client(name) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    inbox.push(msg);
    for (const w of waiters.splice(0)) w();
  };
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, color: 2, cosmetics: { hat: 'crown', face: '<bad>' } }));
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = inbox.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timeout waiting in ${name}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { ws, inbox, waitFor };
}

test('two players join the LAN room, steer, and see each other', async () => {
  const a = client('Ana');
  const b = client('Ben');
  const wa = await a.waitFor((m) => m.t === 'welcome');
  const wb = await b.waitFor((m) => m.t === 'welcome');
  assert.notEqual(wa.id, wb.id);
  assert.equal(Buffer.from(wa.owner, 'base64').length, (wa.radius * 2 + 1) ** 2);
  const ana = wa.players.find((p) => p.id === wa.id);
  assert.equal(ana.name, 'Ana');
  assert.deepEqual(ana.cosmetics, { hat: 'crown' }, 'unknown cosmetic values are dropped');

  a.ws.send(JSON.stringify({ t: 'in', a: 1.5 }));
  const snap = await a.waitFor((m) => m.t === 's' && m.p.some((r) => r[0] === wb.id));
  const row = snap.p.find((r) => r[0] === wa.id);
  assert.equal(row[4] & 1, 1, 'Ana is alive');

  // Ben leaves: the roster marks his slot as left.
  b.ws.close();
  const roster = await a.waitFor((m) => m.t === 'roster' && m.players.some((p) => p.id === wb.id && p.left));
  assert.ok(roster);
  a.ws.close();
});

test('rejects non-websocket upgrades on other paths', async () => {
  const ws = new WebSocket(url.replace('/ws', '/nope'));
  await new Promise((resolve) => {
    ws.onerror = resolve;
    ws.onclose = resolve;
  });
  assert.notEqual(ws.readyState, 1);
});
