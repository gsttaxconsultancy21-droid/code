// Entry point: wires the engine, renderer, input, audio and UI together.
// The simulation advances in fixed steps (engine STEP) so a game can be replayed
// exactly from its recorded inputs.
import { Game, STEP } from '../engine/game.js';
import { Renderer, drawPreview } from './renderer.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { haptics } from './haptics.js';
import { loadSave, writeSave, recordGame, remote, loadReplays, writeReplays, progressOf } from './storage.js';
import { SKINS, COSMETICS, SLOTS, COLORS, unlocked } from './palette.js';
import { GameTracker, evaluateMissions } from './missions.js';
import { Recorder, ReplayDriver, ghostAt } from './replay.js';
import { Connection, serverUrl } from './net.js';
import { UI, $ } from './ui.js';

const save = loadSave();
let replays = loadReplays();
const renderer = new Renderer($('#game'), $('#minimap'));
const input = new Input($('#game'));
const sfx = new Sfx(save.muted);

// Session state.
let game = null;
let state = 'menu'; // menu | how | mp | playing | paused | over
let kind = 'demo'; // demo | local | replay | online
let recorder = null;
let tracker = null;
let driver = null;
let conn = null;
let bestRun = null;
let lastDeath = null;
let acc = 0;
let slowmo = 0;
let replaySpeed = 1;
let warnCooldown = 0;
let slowTime = 0;
let autoLowDone = false;
let last = performance.now();

const ui = new UI(save, {
  onPlay: startGame,
  onAgain: () => (kind === 'online' ? respawnOnline() : startGame()),
  onResume: resume,
  onMenu: toMenu,
  onPause: pause,
  onWatch: watchReplay,
  onHowDone: () => {
    save.seenHelp = true;
    writeSave(save);
    if (state === 'how') beginRound();
    else ui.show('menu');
  },
  onSettings: () => {
    applySettings();
    writeSave(save);
  },
  onRecordsTab: () => {
    ui.renderReplays(replays);
    refreshScores();
  },
  onMpJoin: joinOnline,
  onMpCancel: () => {
    if (conn) conn.close('left');
    toMenu();
  },
  onReplaySpeed: () => {
    replaySpeed = replaySpeed === 1 ? 2 : replaySpeed === 2 ? 4 : 1;
    ui.replaySpeed(replaySpeed);
  },
});

function applySettings() {
  sfx.muted = save.muted;
  haptics.enabled = save.settings.haptics;
  input.setSensitivity(save.settings.sensitivity);
  document.body.classList.toggle('lefty', !!save.settings.leftHanded);
  if (renderer.lowGraphics !== !!save.settings.lowGraphics) renderer.setLowGraphics(!!save.settings.lowGraphics);
}
applySettings();

input.onPause = () => {
  if (state === 'playing') pause();
  else if (state === 'paused') resume();
};
input.onFirstInput = () => sfx.unlock();
document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

function demoGame() {
  kind = 'demo';
  game = new Game({ demo: true, difficulty: 'normal', playerColor: save.skin, colorCount: COLORS.length, playerCosmetics: save.look });
  renderer.attach(game);
}

function startGame() {
  sfx.unlock();
  sfx.click();
  if (!save.seenHelp) {
    state = 'how';
    ui.show('how');
    return;
  }
  beginRound();
}

function gameOptions() {
  const boss = save.difficulty !== 'easy';
  return {
    mode: save.mode,
    difficulty: save.difficulty,
    playerName: save.name || 'You',
    playerColor: save.skin,
    playerCosmetics: { ...save.look },
    colorCount: COLORS.length,
    powerups: save.settings.powerups,
    bossLevel: boss ? Math.min(1, save.stats.best / 60) : null,
    seed: (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0,
  };
}

function beginRound(options = gameOptions()) {
  writeSave(save);
  kind = 'local';
  game = new Game(options);
  recorder = new Recorder(options);
  tracker = new GameTracker(game);
  driver = null;
  bestRun = save.settings.ghost ? replays.best[options.mode] || null : null;
  startSession('local');
  const intro = { classic: 'GO!', rush: '2:00 — GO!', storm: 'Survive the storm!' }[options.mode];
  ui.banner(intro, 1.4);
  if (game.players.some((p) => p.isBoss)) ui.feed('👑 The Grand Smudge has entered');
}

function startSession(sessionKind) {
  renderer.attach(game, game.human);
  input.reset();
  input.enabled = sessionKind !== 'replay';
  lastDeath = null;
  acc = 0;
  slowmo = 0;
  replaySpeed = 1;
  ui.resetHud(sessionKind);
  ui.show(null);
  state = 'playing';
}

function watchReplay(which) {
  const rec = which === 'last' ? replays.last : replays.best[which];
  if (!rec) return;
  sfx.click();
  kind = 'replay';
  game = new Game(rec.options);
  driver = new ReplayDriver(rec);
  recorder = null;
  tracker = null;
  bestRun = null;
  startSession('replay');
  ui.banner('Replay', 1);
}

function pause() {
  if (state !== 'playing' || kind === 'replay') return;
  state = 'paused';
  input.enabled = false;
  ui.show('pause');
}

function resume() {
  if (state !== 'paused') return;
  state = 'playing';
  input.reset();
  input.enabled = true;
  ui.show(null);
}

function toMenu() {
  if (conn) {
    const c = conn;
    conn = null;
    c.close('left');
  }
  state = 'menu';
  input.enabled = false;
  ui.renderMenu();
  ui.show('menu');
  demoGame();
  refreshScores();
}

async function refreshScores() {
  const server = await remote.scores(save.mode);
  if (server && state === 'menu') ui.renderScores(server, true);
}

// ---------- Online (same Wi-Fi) ----------

function joinOnline(address) {
  const url = serverUrl(address);
  if (!url) {
    ui.mpStatus('Enter the address shown by the server, e.g. 192.168.1.20:8080');
    return;
  }
  sfx.unlock();
  ui.mpStatus('Connecting…');
  if (conn) conn.close('left');
  conn = new Connection(url, { name: save.name || 'Player', color: save.skin, cosmetics: save.look }, {
    onReady: (g) => {
      kind = 'online';
      game = g;
      recorder = null;
      tracker = null;
      driver = null;
      bestRun = null;
      startSession('online');
      ui.banner('Connected — GO!', 1.2);
    },
    onRoster: () => renderer.resetColors(),
    onClose: (reason, wasPlaying) => {
      conn = null;
      if (wasPlaying && kind === 'online') {
        toMenu();
        ui.banner('Disconnected', 1.5);
      } else if (state === 'mp' || state === 'menu') {
        ui.mpStatus(reason === 'full' ? 'That game is full.' : 'Could not connect. Check the address and that both devices are on the same Wi-Fi.');
      }
    },
  });
  state = 'mp';
}

function respawnOnline() {
  if (!conn) return;
  conn.respawn();
  ui.show(null);
  state = 'playing';
  input.reset();
  input.enabled = true;
}

// ---------- Events ----------

function handleEvents() {
  const me = game.human;
  const live = state === 'playing' && kind !== 'demo';
  for (const e of game.events) {
    renderer.onEvent(e);
    if (!live) continue;
    const combo = tracker ? tracker.onEvent(e) : 0;
    if (kind === 'replay') continue;
    if (e.type === 'capture' && e.player === me) {
      sfx.capture(e.pct);
      haptics.capture(e.pct);
      if (combo >= 2) {
        sfx.combo(combo);
        ui.banner(`Combo ×${combo}!`, 0.9);
      } else if (e.pct >= 3) {
        ui.banner(`+${e.pct.toFixed(1)}%!`, 0.9);
      }
    } else if (e.type === 'death') {
      if (e.victim === me) {
        lastDeath = e;
        sfx.death();
        haptics.death();
        ui.feed(ui.deathMessage(e));
      } else if (e.killer === me) {
        sfx.kill();
        haptics.kill();
        if (kind === 'local') slowmo = 0.6;
        ui.banner(e.victim.isBoss ? 'You beat the Grand Smudge!' : `You got ${e.victim.name}!`, 1.2);
        ui.feed(`You ⚔ ${e.victim.name}`);
      } else if (e.killer && e.killer !== e.victim) {
        ui.feed(`${e.killer.name} ⚔ ${e.victim.name}`);
      } else if (e.reason === 'storm') {
        ui.feed(`The storm took ${e.victim.name}`);
      }
    } else if (e.type === 'powerup' && e.player === me) {
      sfx.powerup(e.kind);
      haptics.powerup();
    } else if (e.type === 'block' && e.player === me) {
      sfx.block();
      ui.banner('Shield blocked a cut!', 0.9);
    }
  }
  game.events.length = 0;
}

// Older phones: if the game keeps running below ~40 fps, switch to low
// graphics once and say so (it can be turned back on in Settings).
function watchFrameRate(dt) {
  if (autoLowDone || save.settings.lowGraphics || kind === 'demo') return;
  slowTime = dt > 1 / 40 && dt < 0.1 ? slowTime + dt : Math.max(0, slowTime - dt * 0.5);
  if (slowTime > 3) {
    autoLowDone = true;
    save.settings.lowGraphics = true;
    applySettings();
    writeSave(save);
    ui.feed('Low graphics on for smoother play (see Settings)');
  }
}

function updateWarnings(dt) {
  const me = game.human;
  const level = me && me.alive && kind !== 'replay' ? renderer.danger.warn : 0;
  ui.warn(level);
  warnCooldown -= dt;
  if (level === 2 && warnCooldown <= 0) {
    sfx.warn();
    haptics.warn();
    warnCooldown = 1.5;
  }
}

// ---------- Endings ----------

function endLocalGame() {
  state = 'over';
  input.enabled = false;
  const result = game.result;
  const stats = tracker.finish(result);
  const progressBefore = progressOf(save);
  const lockedBefore = new Set(allUnlockables().filter((u) => !unlocked(u.item, progressBefore)).map((u) => u.label));
  const outcome = recordGame(save, result, { bossKills: stats.bossKills });
  const missions = evaluateMissions(save, stats);
  const progressAfter = progressOf(save);
  const unlocks = allUnlockables().filter((u) => lockedBefore.has(u.label) && unlocked(u.item, progressAfter)).map((u) => u.label);
  writeSave(save);

  const rec = recorder.finish(game);
  replays.last = rec;
  const best = replays.best[result.mode];
  if (!best || !best.result || result.peakPct > best.result.peakPct) replays.best[result.mode] = rec;
  writeReplays(replays);
  remote.submit(outcome.entry);

  if (result.won) sfx.victory();
  ui.showGameOver({
    result,
    newBest: outcome.newBest,
    deathText: lastDeath ? ui.deathMessage(lastDeath) : '',
    missions,
    unlocks,
    canWatch: true,
  });
}

function allUnlockables() {
  const list = SKINS.map((s) => ({ item: s, label: `${s.name} color` }));
  for (const { key } of SLOTS) for (const item of COSMETICS[key]) list.push({ item, label: item.name });
  return list;
}

function showOnlineDeath() {
  state = 'over';
  input.enabled = false;
  const me = game.human;
  ui.showGameOver({
    result: {
      reason: 'defeat', peakPct: me.peakPct, kills: me.kills, rank: 1, players: game.players.length, time: 0, won: false,
    },
    newBest: false,
    deathText: lastDeath ? ui.deathMessage(lastDeath) : 'Knocked out.',
    online: true,
  });
  $('#go-time').textContent = '–';
  $('#go-rank').textContent = '–';
}

// ---------- Main loop ----------

function stepLocal() {
  if (input.angle !== null && game.human.alive) {
    game.setHumanTarget(recorder.input(game.steps, input.angle));
  }
  game.update(STEP);
  recorder.sample(game);
  tracker.step();
}

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (game) {
    let visualDt = dt;
    if (state === 'paused') {
      visualDt = 0;
    } else if (kind === 'online') {
      if (state === 'playing' && input.angle !== null && game.human.alive) conn && conn.steer(input.angle);
      game.update(dt);
      handleEvents();
      const me = game.human;
      if (me.alive) me.peakPct = Math.max(me.peakPct, game.pctOf(me));
      if (state === 'playing' && !me.alive) showOnlineDeath();
      else if (state === 'over' && me.alive) {
        state = 'playing';
        ui.show(null);
        input.enabled = true;
      }
    } else {
      let scale = 1;
      if (slowmo > 0) {
        slowmo -= dt;
        scale = 0.35;
      }
      if (kind === 'replay') scale = replaySpeed;
      visualDt = dt * scale;
      acc += dt * scale;
      let steps = 0;
      while (acc >= STEP && steps < 12) {
        acc -= STEP;
        steps++;
        if (kind === 'local' && state === 'playing') {
          stepLocal();
        } else if (kind === 'replay') {
          driver.apply(game);
          game.update(STEP);
        } else if (state !== 'paused') {
          game.update(STEP);
        }
        handleEvents();
        if (game.finished) break;
      }
      if (steps === 12) acc = 0;

      if (kind === 'local' && state === 'playing' && game.finished) endLocalGame();
      if (kind === 'replay' && state === 'playing' && driver.done(game)) {
        toMenu();
        ui.showTab('records');
      }
    }

    if (bestRun && kind === 'local') {
      renderer.ghost = ghostAt(bestRun, game.steps);
    }
    if (state === 'playing' && kind !== 'demo') {
      ui.updateHud(game, dt, game.human, renderer.ghost);
      updateWarnings(dt);
      watchFrameRate(dt);
    }
    renderer.render(visualDt, input);
  }
  if (state === 'menu' && ui.tab === 'style') drawPreview($('#preview'), save.skin, save.look, now / 1000);
  requestAnimationFrame(frame);
}

// Hardware Back button hook used by the Android wrapper. Returns true when handled.
window.inklandBack = () => {
  if (state === 'playing' && kind === 'replay') toMenu();
  else if (state === 'playing') pause();
  else if (state === 'paused') resume();
  else if (state === 'over' || state === 'how' || state === 'mp') toMenu();
  else if (state === 'menu' && ui.tab !== 'play') ui.showTab('play');
  else return false;
  return true;
};

// Read-only peek at the running session, for automated browser tests.
window.inklandDebug = () => ({ game, state, kind, renderer });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

toMenu();
requestAnimationFrame(frame);
