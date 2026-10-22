// Entry point: wires the engine, renderer, input, audio and UI together.
import { Game } from '../engine/game.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { loadSave, writeSave, recordGame, remote } from './storage.js';
import { SKINS, COLORS, skinUnlocked } from './palette.js';
import { UI, $ } from './ui.js';

const save = loadSave();
const renderer = new Renderer($('#game'), $('#minimap'));
const input = new Input($('#game'));
const sfx = new Sfx(save.muted);

let game = null;
let state = 'menu'; // menu | how | playing | paused | over
let lastDeath = null;
let last = performance.now();

const ui = new UI(save, {
  onPlay: startGame,
  onResume: resume,
  onMenu: toMenu,
  onPause: pause,
  onHowDone: () => {
    save.seenHelp = true;
    writeSave(save);
    beginRound();
  },
  onMute: () => {
    save.muted = !save.muted;
    sfx.muted = save.muted;
    writeSave(save);
    ui.renderMute();
  },
  onSettings: () => writeSave(save),
});

input.onPause = () => {
  if (state === 'playing') pause();
  else if (state === 'paused') resume();
};
input.onFirstInput = () => sfx.unlock();
document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });

function demoGame() {
  game = new Game({ demo: true, difficulty: 'normal', playerColor: save.skin, colorCount: COLORS.length });
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

function beginRound() {
  writeSave(save);
  game = new Game({
    mode: save.mode,
    difficulty: save.difficulty,
    playerName: save.name || 'You',
    playerColor: save.skin,
    colorCount: COLORS.length,
  });
  renderer.attach(game);
  input.reset();
  input.enabled = true;
  lastDeath = null;
  ui.resetHud();
  ui.show(null);
  ui.banner(save.mode === 'rush' ? '2:00 — GO!' : 'GO!', 1.1);
  state = 'playing';
}

function pause() {
  if (state !== 'playing') return;
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

function handleEvents() {
  const h = game.human;
  for (const e of game.events) {
    renderer.onEvent(e);
    if (state !== 'playing') continue;
    if (e.type === 'capture' && e.player === h) {
      sfx.capture(e.pct);
      if (e.pct >= 3) ui.banner(`+${e.pct.toFixed(1)}%!`, 0.9);
    } else if (e.type === 'death') {
      if (e.victim === h) {
        lastDeath = e;
        sfx.death();
        ui.feed(ui.deathMessage(e));
      } else if (e.killer === h) {
        sfx.kill();
        ui.banner(`You got ${e.victim.name}!`, 1.2);
        ui.feed(`You ⚔ ${e.victim.name}`);
      } else if (e.killer && e.killer !== e.victim) {
        ui.feed(`${e.killer.name} ⚔ ${e.victim.name}`);
      }
    }
  }
  game.events.length = 0;
}

function endGame() {
  state = 'over';
  input.enabled = false;
  const result = game.result;
  const before = SKINS.map((s) => skinUnlocked(s, save.stats));
  const outcome = recordGame(save, result);
  const unlocked = SKINS.filter((s, i) => !before[i] && skinUnlocked(s, save.stats)).map((s) => s.name);
  writeSave(save);
  remote.submit(outcome.entry);
  if (result.won) sfx.victory();
  ui.showGameOver(result, outcome, lastDeath ? ui.deathMessage(lastDeath) : '', unlocked);
}

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (game) {
    if (state === 'playing') {
      if (input.angle !== null) game.setHumanTarget(input.angle);
      game.update(dt);
      handleEvents();
      ui.updateHud(game, dt);
      if (game.finished) endGame();
    } else if (state === 'menu' || state === 'how' || state === 'over') {
      // Keep the world alive behind menus.
      game.update(dt);
      handleEvents();
    }
    renderer.render(state === 'paused' ? 0 : dt, input);
  }
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

toMenu();
requestAnimationFrame(frame);
