// Steering input: mouse aims from the screen centre, touch acts as a floating
// joystick, and arrow keys / WASD point in 8 directions.
const KEY_DIRS = {
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};
const STICK_RADIUS = 60;

export class Input {
  constructor(surface) {
    this.angle = null;
    this.enabled = false;
    this.stick = null;
    this.keys = new Set();
    this.onPause = null;
    this.onFirstInput = null;

    surface.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.keys.clear());
  }

  reset() {
    this.angle = null;
    this.stick = null;
    this.keys.clear();
  }

  first() {
    if (this.onFirstInput) this.onFirstInput();
  }

  down(e) {
    if (!this.enabled) return;
    this.first();
    if (e.pointerType === 'mouse') {
      this.aim(e);
      return;
    }
    e.preventDefault();
    this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
  }

  move(e) {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse') {
      this.aim(e);
      return;
    }
    const s = this.stick;
    if (!s || s.id !== e.pointerId) return;
    s.x = e.clientX;
    s.y = e.clientY;
    let dx = s.x - s.ox;
    let dy = s.y - s.oy;
    const len = Math.hypot(dx, dy);
    if (len > 10) this.angle = Math.atan2(dy, dx);
    if (len > STICK_RADIUS) {
      s.ox = s.x - (dx / len) * STICK_RADIUS;
      s.oy = s.y - (dy / len) * STICK_RADIUS;
    }
  }

  up(e) {
    if (this.stick && this.stick.id === e.pointerId) this.stick = null;
  }

  aim(e) {
    const dx = e.clientX - window.innerWidth / 2;
    const dy = e.clientY - window.innerHeight / 2;
    if (Math.hypot(dx, dy) > 8) this.angle = Math.atan2(dy, dx);
  }

  key(e, down) {
    if (down && (e.code === 'Escape' || e.code === 'KeyP')) {
      if (this.onPause) this.onPause();
      return;
    }
    if (!KEY_DIRS[e.code] || !this.enabled) return;
    e.preventDefault();
    if (down) {
      this.first();
      this.keys.add(e.code);
    } else {
      this.keys.delete(e.code);
    }
    let x = 0;
    let y = 0;
    for (const k of this.keys) {
      x += KEY_DIRS[k][0];
      y += KEY_DIRS[k][1];
    }
    if (x || y) this.angle = Math.atan2(y, x);
  }
}
