// DOM screens and HUD. Keeps all document access out of the game loop.
import { SKINS, COSMETICS, SLOTS, colorSet, unlocked, requirementLabel, findItem } from './palette.js';
import { progressOf } from './storage.js';
import { ensureDaily, describeDaily, CAREER } from './missions.js';

export const $ = (sel) => document.querySelector(sel);

const MODE_HELP = {
  classic: 'Grow until you own 90% of the map. One life.',
  rush: 'Two minutes. Hold the most land when the clock stops.',
  storm: 'The ink storm closes in and nobody respawns. Be the last blob standing.',
};
const MODE_NAMES = { classic: 'Classic', rush: 'Rush', storm: 'Storm', online: 'Wi-Fi' };

const DEATH_TEXT = {
  self: 'You crossed your own trail.',
  cut: 'cut your trail.',
  territory: 'swallowed all of your land.',
  clash: 'won the head-on crash.',
  storm: 'The ink storm swallowed you.',
};

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const fmtGoal = (v) => (Number.isInteger(v) ? v : v.toFixed(1));

export class UI {
  constructor(save, handlers) {
    this.save = save;
    this.handlers = handlers;
    this.boardTimer = 0;
    this.bannerTimer = 0;
    this.tab = 'play';

    $('#name').value = save.name;
    $('#name').addEventListener('input', (e) => {
      save.name = e.target.value.trim().slice(0, 14);
      handlers.onSettings();
    });
    $('#name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlers.onPlay();
    });
    this.bindSeg('#mode', () => save.mode, (v) => (save.mode = v), () => this.renderModeHelp());
    this.bindSeg('#difficulty', () => save.difficulty, (v) => (save.difficulty = v));
    this.bindSeg('#sensitivity', () => save.settings.sensitivity, (v) => (save.settings.sensitivity = v));

    $('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) this.showTab(b.dataset.tab);
    });
    for (const input of document.querySelectorAll('[data-set]')) {
      input.addEventListener('change', () => {
        const key = input.dataset.set;
        if (key === 'sound') save.muted = !input.checked;
        else save.settings[key] = input.checked;
        handlers.onSettings();
      });
    }

    const on = (id, fn) => $(id).addEventListener('click', fn);
    on('#play', () => handlers.onPlay());
    on('#resume', () => handlers.onResume());
    on('#quit', () => handlers.onMenu());
    on('#again', () => handlers.onAgain());
    on('#to-menu', () => handlers.onMenu());
    on('#watch', () => handlers.onWatch('last'));
    on('#btn-pause', () => handlers.onPause());
    on('#how-go', () => handlers.onHowDone());
    on('#show-help', () => this.show('how'));
    on('#open-mp', () => this.openMultiplayer());
    on('#mp-cancel', () => handlers.onMpCancel());
    on('#mp-join', () => {
      save.serverUrl = $('#mp-address').value.trim();
      handlers.onSettings();
      handlers.onMpJoin(save.serverUrl);
    });
    on('#replay-speed', () => handlers.onReplaySpeed());
    on('#replay-exit', () => handlers.onMenu());
    this.renderMenu();
  }

  bindSeg(sel, get, set, after) {
    const root = $(sel);
    const sync = () => {
      for (const b of root.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === get());
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      set(b.dataset.v);
      sync();
      if (after) after();
      this.handlers.onSettings();
    });
    sync();
  }

  showTab(tab) {
    this.tab = tab;
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
    for (const s of document.querySelectorAll('.tab')) s.hidden = s.dataset.tab !== tab;
    if (tab === 'records') this.handlers.onRecordsTab();
  }

  renderMenu() {
    const save = this.save;
    const st = save.stats;
    const progress = progressOf(save);
    if (!unlocked(SKINS[save.skin] || SKINS[0], progress)) save.skin = 0;
    for (const { key } of SLOTS) {
      if (!unlocked(findItem(key, save.look[key]), progress)) save.look[key] = COSMETICS[key][0].id;
    }

    // Colours.
    const skins = $('#skins');
    skins.textContent = '';
    SKINS.forEach((skin, i) => {
      const b = document.createElement('button');
      const ok = unlocked(skin, progress);
      b.className = 'skin' + (i === save.skin ? ' sel' : '') + (ok ? '' : ' locked');
      b.style.background = colorSet(i).css;
      b.title = ok ? skin.name : `${skin.name}: ${requirementLabel(skin.req)}`;
      b.setAttribute('aria-label', b.title);
      b.addEventListener('click', () => {
        if (!ok) {
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

    // Cosmetic slots.
    const slots = $('#slots');
    slots.textContent = '';
    for (const { key, label } of SLOTS) {
      const wrap = document.createElement('div');
      wrap.className = 'slot field';
      const l = document.createElement('span');
      l.className = 'label';
      l.textContent = label;
      const row = document.createElement('div');
      row.className = 'chips-row';
      for (const item of COSMETICS[key]) {
        const b = document.createElement('button');
        const ok = unlocked(item, progress);
        b.className = 'chip' + (save.look[key] === item.id ? ' sel' : '') + (ok ? '' : ' locked');
        b.textContent = item.name;
        b.title = ok ? item.name : requirementLabel(item.req);
        if (!ok) b.textContent = `${item.name} · ${requirementLabel(item.req)}`;
        b.addEventListener('click', () => {
          if (!ok) return;
          save.look[key] = item.id;
          this.handlers.onSettings();
          this.renderMenu();
        });
        row.appendChild(b);
      }
      wrap.append(l, row);
      slots.appendChild(wrap);
    }

    // Records.
    $('#stats').innerHTML = [
      [`${st.best.toFixed(1)}%`, 'best'],
      [st.kills, 'KOs'],
      [st.games, 'games'],
      [st.wins, 'wins'],
    ].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');

    // Settings.
    for (const input of document.querySelectorAll('[data-set]')) {
      const key = input.dataset.set;
      input.checked = key === 'sound' ? !save.muted : !!save.settings[key];
    }
    for (const b of document.querySelectorAll('#sensitivity button')) {
      b.classList.toggle('on', b.dataset.v === save.settings.sensitivity);
    }

    this.renderModeHelp();
    this.renderMissions();
    this.renderScores(save.scores, false);
  }

  renderModeHelp() {
    $('#mode-help').textContent = MODE_HELP[this.save.mode] || '';
    for (const b of document.querySelectorAll('#mode button')) b.classList.toggle('on', b.dataset.v === this.save.mode);
  }

  renderMissions() {
    const save = this.save;
    const daily = ensureDaily(save);
    $('#stars-total').textContent = save.stars;
    $('#tab-stars').textContent = save.stars ? `${save.stars}★` : '';
    const doneCount = daily.list.filter((e) => e.done).length;
    $('#daily-line').textContent = `Daily challenges ${doneCount}/3 · ${save.stars} ★`;
    $('#daily-streak').textContent = save.missions.streak ? `· ${save.missions.streak}-day streak` : '';

    const list = $('#daily-list');
    list.textContent = '';
    for (const entry of daily.list) {
      const d = describeDaily(entry);
      const li = document.createElement('li');
      li.className = entry.done ? 'done' : '';
      const best = entry.best == null ? '–' : fmtGoal(Math.round(entry.best * 10) / 10);
      li.innerHTML = `<span class="txt"></span><span class="prog"></span><span class="st">${entry.done ? '✓' : '+1★'}</span>`;
      li.querySelector('.txt').textContent = d.text;
      li.querySelector('.prog').textContent = entry.done ? '' : `best ${best}`;
      list.appendChild(li);
    }
    const career = $('#career-list');
    career.textContent = '';
    for (const c of CAREER) {
      const li = document.createElement('li');
      const done = !!save.missions.career[c.id];
      li.className = done ? 'done' : '';
      li.innerHTML = `<span class="txt"></span><span class="st">${done ? '✓' : `+${c.stars}★`}</span>`;
      li.querySelector('.txt').textContent = c.text;
      career.appendChild(li);
    }
  }

  renderReplays(replays) {
    const box = $('#replays');
    box.textContent = '';
    const add = (label, rec, key) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.disabled = !rec;
      b.textContent = rec ? `${label} · ${rec.result ? rec.result.peakPct.toFixed(1) : '?'}%` : `${label} · none yet`;
      b.addEventListener('click', () => this.handlers.onWatch(key));
      box.appendChild(b);
    };
    add('▶ Last game', replays.last, 'last');
    for (const m of ['classic', 'rush', 'storm']) add(`▶ Best ${MODE_NAMES[m]}`, replays.best[m], m);
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
      span.textContent = `${Number(s.score).toFixed(1)}% · ${s.kills} KO · ${MODE_NAMES[s.mode] || s.mode}`;
      li.appendChild(span);
      ol.appendChild(li);
    }
    $('#scores-src').textContent = fromServer ? 'Synced with your local Inkland server' : 'Saved on this device';
  }

  openMultiplayer() {
    $('#mp-address').value = this.save.serverUrl || '';
    $('#mp-status').textContent = '';
    this.show('mp');
  }

  mpStatus(text) {
    $('#mp-status').textContent = text;
  }

  show(screen) {
    if (screen) this.warn(0);
    for (const id of ['menu', 'pause', 'gameover', 'how', 'mp']) $(`#${id}`).hidden = id !== screen && !(id === 'menu' && screen === 'mp');
    $('#hud').hidden = screen === 'menu' || screen === 'mp';
  }

  resetHud(kind) {
    $('#hud-feed').textContent = '';
    $('#banner').classList.remove('show');
    $('#hud-warn').hidden = true;
    $('#hud-vs').hidden = true;
    $('#replay-bar').hidden = kind !== 'replay';
    $('#btn-pause').hidden = kind === 'replay';
    $('#replay-speed').textContent = '1×';
    this.boardTimer = 0;
    this.warnLevel = 0;
  }

  replaySpeed(speed) {
    $('#replay-speed').textContent = `${speed}×`;
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

  warn(level) {
    if (level === this.warnLevel) return;
    this.warnLevel = level;
    const el = $('#hud-warn');
    el.hidden = !level;
    el.className = level === 1 ? 'warn soft' : 'warn';
    el.textContent = level === 2 ? '⚠ Rival heading for your trail!' : '⌂ Head home!';
  }

  updateHud(game, dt, me, ghost) {
    const pct = game.pctOf(me);
    $('#hud-pct').textContent = `${pct.toFixed(pct < 10 ? 2 : 1)}%`;
    $('#hud-bar').style.width = `${Math.min(100, (pct / game.mode.winPct) * 100)}%`;
    $('#hud-kills').textContent = me.kills;
    const left = game.timeLeft();
    let clock = left === null ? formatTime(game.time) : `⏱ ${formatTime(left)}`;
    if (game.mode.storm && game.time < game.mode.storm.end) {
      clock += game.time < game.mode.storm.start ? ` · storm in ${Math.ceil(game.mode.storm.start - game.time)}s` : ' · storm closing';
    }
    $('#hud-time').textContent = clock;

    const vs = $('#hud-vs');
    if (ghost && !ghost.over) {
      const diff = pct - ghost.pct;
      vs.hidden = false;
      vs.className = `me-vs ${diff >= 0 ? 'up' : 'down'}`;
      vs.textContent = `vs best run ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%`;
    } else {
      vs.hidden = true;
    }

    // Online games only know that a power-up is active, not for how long.
    const secs = (until) => (Number.isFinite(until) ? ` ${Math.ceil(Math.max(0, until - game.time))}s` : '');
    const chips = [];
    if (game.isBoosted(me)) chips.push(`⚡${secs(me.speedUntil)}`);
    if (game.isShielded(me)) chips.push(`🛡${secs(me.shieldUntil)}`);
    const chipText = chips.map((c) => `<span>${c}</span>`).join('');
    const chipBox = $('#hud-chips');
    if (chipBox.innerHTML !== chipText) chipBox.innerHTML = chipText;

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) $('#banner').classList.remove('show');
    }

    this.boardTimer -= dt;
    if (this.boardTimer > 0) return;
    this.boardTimer = 0.25;
    const board = game.leaderboard();
    const rows = board.slice(0, 5);
    const myRank = board.findIndex((r) => r.player === me);
    if (myRank >= 5) rows.push(board[myRank]);
    const ol = $('#hud-board');
    ol.textContent = '';
    for (const r of rows) {
      const li = document.createElement('li');
      if (r.player === me) li.className = 'me';
      const rank = document.createElement('span');
      rank.className = 'rk';
      rank.textContent = `${board.indexOf(r) + 1}.`;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = colorSet(r.player.color).css;
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = (r.player.isBoss ? '👑 ' : '') + r.player.name;
      const pc = document.createElement('span');
      pc.textContent = `${r.pct.toFixed(1)}%`;
      li.append(rank, dot, nm, pc);
      ol.appendChild(li);
    }
  }

  deathMessage(e) {
    if (e.reason === 'self' || e.reason === 'storm') return DEATH_TEXT[e.reason];
    const who = e.killer && e.killer !== e.victim ? e.killer.name : 'Someone';
    return `${who} ${DEATH_TEXT[e.reason] || 'got you.'}`;
  }

  showGameOver({ result, newBest, deathText, missions = [], unlocks = [], online = false, canWatch = false }) {
    const titles = {
      victory: 'Victory!', timeup: result.won ? 'Time! You win!' : "Time's up!", defeat: 'Knocked out!',
    };
    $('#go-title').textContent = titles[result.reason] || 'Game over';
    $('#go-sub').textContent = result.reason === 'defeat' ? deathText : `You finished #${result.rank} of ${result.players}.`;
    $('#go-pct').textContent = `${result.peakPct.toFixed(1)}%`;
    $('#go-rank').textContent = `#${result.rank}`;
    $('#go-kills').textContent = result.kills;
    $('#go-time').textContent = formatTime(result.time);
    $('#go-best').hidden = !newBest;
    const ml = $('#go-missions');
    ml.textContent = '';
    for (const m of missions) {
      const li = document.createElement('li');
      li.textContent = `✓ ${m.text}`;
      const b = document.createElement('b');
      b.textContent = `+${m.stars}★`;
      li.appendChild(b);
      ml.appendChild(li);
    }
    const unlock = $('#go-unlock');
    unlock.hidden = !unlocks.length;
    unlock.textContent = unlocks.length ? `Unlocked: ${unlocks.join(', ')}` : '';
    $('#again').textContent = online ? 'Respawn' : 'Play again';
    $('#watch').hidden = !canWatch;
    this.show('gameover');
  }
}
