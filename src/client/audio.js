// Procedural sound effects via WebAudio, so there are no audio files to ship.
export class Sfx {
  constructor(muted) {
    this.muted = muted;
    this.ctx = null;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) this.ctx = new Ctx();
  }

  tone(freq, dur, { type = 'sine', vol = 0.15, slide = 0, delay = 0 } = {}) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  capture(pct) {
    const lift = Math.min(pct, 5) * 60;
    this.tone(520 + lift, 0.12, { type: 'triangle', vol: 0.12 });
    this.tone(780 + lift, 0.16, { type: 'triangle', vol: 0.1, delay: 0.07 });
  }

  kill() {
    this.tone(300, 0.2, { type: 'square', vol: 0.08, slide: 600 });
    this.tone(900, 0.15, { type: 'triangle', vol: 0.08, delay: 0.1 });
  }

  death() {
    this.tone(420, 0.5, { type: 'sawtooth', vol: 0.09, slide: -340 });
  }

  click() {
    this.tone(660, 0.05, { type: 'triangle', vol: 0.08 });
  }

  victory() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.22, { type: 'triangle', vol: 0.11, delay: i * 0.12 }));
  }
}
