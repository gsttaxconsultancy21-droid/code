// DOM screens and HUD. Keeps all document access out of the game loop.
import { SKINS, colorSet, skinUnlocked, requirementLabel } from './palette.js';

export const $ = (sel) => document.querySelector(sel);

const MODE_HELP = {
  classic: 'Grow until you own 90% of the map. One life.',
  rush: 'Two minutes. Hold the most land when the clock stops.',
};

const DEATH_TEXT = {
  self: 'You crossed your own trail.',
  cut: 'cut your trail.',
  territory: 'swallowed all of your land.',
};

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class UI {
  constructor(save, handlers) {
    this.save = save;
    this.handlers = handlers;
    this.boardTimer = 0;
    this.bannerTimer = 0;

    $('#name').value = save.name;
    $('#name').addEventListener('input', (e) => {
      save.name = e.target.value.trim().slice(0, 14);
      handlers.onSettings();
    });
    this.bindSeg('#mode', 'mode', () => this.renderModeHelp());
    this.bindSeg('#difficulty', 'difficulty');
    $('#play').addEventListener('click', () => handlers.onPlay());
    $('#resume').addEventListener('click', () => handlers.onResume());
    $('#quit').addEventListener('click', () => handlers.onMenu());
    $('#again').addEventListener('click', () => handlers.onPlay());
    $('#to-menu').addEventListener('click', () => handlers.onMenu());
    $('#btn-pause').addEventListener('click', () => handlers.onPause());
    $('#btn-mute').addEventListener('click', () => handlers.onMute());
    $('#how-go').addEventListener('click', () => handlers.onHowDone());
    $('#name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlers.onPlay();
    });
    this.renderMenu();
  }

  bindSeg(sel, key, after) {
    const root = $(sel);
    const sync = () => {
      for (const b of root.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === this.save[key]);
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this.save[key] = b.dataset.v;
      sync();
      if (after) after();
      this.handlers.onSettings();
    });
    sync();
  }

  renderMenu() {
    const save = this.save;
    const st = save.stats;
    if (!skinUnlocked(SKINS[save.skin] || SKINS[0], st)) save.skin = 0;

    const skins = $('#skins');
    skins.textContent = '';
    SKINS.forEach((skin, i) => {
      const b = document.createElement('button');
      const unlocked = skinUnlocked(skin, st);
      b.className = 'skin' + (i === save.skin ? ' sel' : '') + (unlocked ? '' : ' locked');
      b.style.background = colorSet(i).css;
      b.title = unlocked ? skin.name : `${skin.name}: ${requirementLabel(skin.req)}`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        if (!unlocked) {
          $('#skin-name').textContent = `· ${skin.name} (locked: ${requirementLabel(skin.req)})`;
          return;
        }
        save.skin = i;
        this.handlers.onSettings();
        this.renderMenu();
      });
      skins.appendChild(b);
    });
    $('#skin-name').textContent = `· ${SKINS[save.skin].name}`;
    document.documentElement.style.setProperty('--accent', colorSet(save.skin).css);
    document.documentElement.style.setProperty('--accent-dark', colorSet(save.skin).cssDark);

    $('#stats').innerHTML = [
      [`${st.best.toFixed(1)}%`, 'best'],
      [st.kills, 'kills'],
      [st.games, 'games'],
      [st.wins, 'wins'],
    ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
    this.renderModeHelp();
    this.renderMute();
    this.renderScores(save.scores, false);
  }

  renderModeHelp() {
    $('#mode-help').textContent = MODE_HELP[this.save.mode] || '';
  }

  renderMute() {
    $('#btn-mute').textContent = this.save.muted ? '🔇 Sound off' : '🔊 Sound on';
  }

  renderScores(scores, fromServer) {
    const ol = $('#scores');
    ol.textContent = '';
    if (!scores || !scores.length) {
      const li = document.createElement('li');
      li.textContent = 'No games yet. Go claim some land!';
      ol.appendChild(li);
    }
    for (const s of (scores || []).slice(0, 20)) {
      const li = document.createElement('li');
      li.textContent = `${s.name} `;
      const span = document.createElement('span');
      span.textContent = `${Number(s.score).toFixed(1)}% · ${s.kills}☠ · ${s.mode === 'rush' ? 'Rush' : 'Classic'}`;
      li.appendChild(span);
      ol.appendChild(li);
    }
    let src = ol.parentElement.querySelector('.src');
    if (!src) {
      src = document.createElement('p');
      src.className = 'src';
      ol.parentElement.appendChild(src);
    }
    src.textContent = fromServer ? 'Synced with your local Inkland server' : 'Saved on this device';
  }

  show(screen) {
    for (const id of ['menu', 'pause', 'gameover', 'how']) $(`#${id}`).hidden = id !== screen;
    $('#hud').hidden = screen === 'menu';
  }

  resetHud() {
    $('#hud-feed').textContent = '';
    $('#banner').classList.remove('show');
    this.boardTimer = 0;
  }

  banner(text, seconds = 1.4) {
    const el = $('#banner');
    el.textContent = text;
    el.classList.add('show');
    this.bannerTimer = seconds;
  }

  feed(text) {
    const box = $('#hud-feed');
    const div = document.createElement('div');
    div.textContent = text;
    box.prepend(div);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => div.classList.add('fade'), 2600);
    setTimeout(() => div.remove(), 3200);
  }

  updateHud(game, dt) {
    const h = game.human;
    const pct = game.pctOf(h);
    $('#hud-pct').textContent = `${pct.toFixed(pct < 10 ? 2 : 1)}%`;
    $('#hud-bar').style.width = `${Math.min(100, (pct / game.mode.winPct) * 100)}%`;
    $('#hud-kills').textContent = h.kills;
    const left = game.timeLeft();
    $('#hud-time').textContent = left === null ? formatTime(game.time) : `⏱ ${formatTime(left)}`;

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) $('#banner').classList.remove('show');
    }

    this.boardTimer -= dt;
    if (this.boardTimer > 0) return;
    this.boardTimer = 0.25;
    const board = game.leaderboard();
    const rows = board.slice(0, 5);
    const myRank = board.findIndex((r) => r.player === h);
    if (myRank >= 5) rows.push(board[myRank]);
    const ol = $('#hud-board');
    ol.textContent = '';
    for (const r of rows) {
      const li = document.createElement('li');
      if (r.player === h) li.className = 'me';
      const rank = document.createElement('span');
      rank.className = 'rk';
      rank.textContent = `${board.indexOf(r) + 1}.`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = colorSet(r.player.color).css;
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = r.player.name;
      const pc = document.createElement('span');
      pc.textContent = `${r.pct.toFixed(1)}%`;
      li.append(rank, dot, nm, pc);
      ol.appendChild(li);
    }
  }

  deathMessage(e) {
    if (e.reason === 'self') return DEATH_TEXT.self;
    const who = e.killer && e.killer !== e.victim ? e.killer.name : 'Someone';
    return `${who} ${DEATH_TEXT[e.reason] || 'got you.'}`;
  }

  showGameOver(result, outcome, deathText, unlocked) {
    const titles = { victory: 'Victory!', timeup: result.won ? 'Time! You win!' : "Time's up!", defeat: 'Knocked out!' };
    $('#go-title').textContent = titles[result.reason] || 'Game over';
    $('#go-sub').textContent = result.reason === 'defeat' ? deathText : `You finished #${result.rank} of ${result.players}.`;
    $('#go-pct').textContent = `${result.peakPct.toFixed(1)}%`;
    $('#go-rank').textContent = `#${result.rank}`;
    $('#go-kills').textContent = result.kills;
    $('#go-time').textContent = formatTime(result.time);
    $('#go-best').hidden = !outcome.newBest;
    const unlock = $('#go-unlock');
    unlock.hidden = !unlocked.length;
    unlock.textContent = unlocked.length ? `Unlocked: ${unlocked.join(', ')}` : '';
    this.show('gameover');
  }
}
