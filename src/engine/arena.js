// The arena is a square grid with a circular playable area.
// Each cell stores the id of the player that owns it (territory) and the id
// of the player whose trail currently passes through it.

export const EMPTY = 0;
export const WALL = 255;

export class Arena {
  constructor(radius) {
    this.radius = radius;
    this.size = radius * 2 + 1;
    this.center = radius;
    const n = this.size * this.size;
    this.owner = new Uint8Array(n);
    this.trail = new Uint8Array(n);
    this.counts = new Int32Array(256);
    this.visited = new Uint8Array(n);
    this.stack = new Int32Array(n);
    // Renderers switch this on to receive the indices of cells that changed.
    this.trackChanges = false;
    this.changes = [];
    this.playable = 0;
    const limit = (radius - 1) * (radius - 1);
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const dx = x - this.center;
        const dy = y - this.center;
        if (dx * dx + dy * dy > limit) this.owner[y * this.size + x] = WALL;
        else this.playable++;
      }
    }
  }

  index(x, y) {
    return y * this.size + x;
  }

  isPlayable(x, y) {
    return x >= 0 && y >= 0 && x < this.size && y < this.size && this.owner[y * this.size + x] !== WALL;
  }

  setOwner(i, id) {
    const prev = this.owner[i];
    if (prev === id || prev === WALL) return;
    this.counts[prev]--;
    this.counts[id]++;
    this.owner[i] = id;
    if (this.trackChanges) this.changes.push(i);
  }

  setTrail(i, id) {
    if (this.trail[i] === id) return;
    this.trail[i] = id;
    if (this.trackChanges) this.changes.push(i);
  }

  clearTrail(cells, id) {
    for (const c of cells) if (this.trail[c] === id) this.setTrail(c, EMPTY);
  }

  releaseOwner(id) {
    if (this.counts[id] <= 0) return;
    const owner = this.owner;
    for (let i = 0; i < owner.length; i++) if (owner[i] === id) this.setOwner(i, EMPTY);
  }

  // Turns a closed trail into territory and fills every region it encloses.
  // `box` is the player's territory bounding box and is grown to include the trail.
  // Returns the number of cells gained.
  capture(id, trailCells, box) {
    const before = this.counts[id];
    const s = this.size;
    for (const c of trailCells) {
      if (this.trail[c] === id) this.setTrail(c, EMPTY);
      this.setOwner(c, id);
      const x = c % s;
      const y = (c - x) / s;
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
    }

    // Flood fill "outside" from the border of the (padded) bounding box.
    // Anything inside the box that the flood cannot reach is enclosed.
    const x0 = Math.max(0, box.minX - 1);
    const y0 = Math.max(0, box.minY - 1);
    const x1 = Math.min(s - 1, box.maxX + 1);
    const y1 = Math.min(s - 1, box.maxY + 1);
    const owner = this.owner;
    const visited = this.visited;
    const stack = this.stack;
    for (let y = y0; y <= y1; y++) visited.fill(0, y * s + x0, y * s + x1 + 1);

    let sp = 0;
    const seed = (x, y) => {
      const i = y * s + x;
      if (!visited[i] && owner[i] !== id) {
        visited[i] = 1;
        stack[sp++] = i;
      }
    };
    for (let x = x0; x <= x1; x++) {
      seed(x, y0);
      seed(x, y1);
    }
    for (let y = y0; y <= y1; y++) {
      seed(x0, y);
      seed(x1, y);
    }
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % s;
      const y = (i - x) / s;
      if (x > x0) seed(x - 1, y);
      if (x < x1) seed(x + 1, y);
      if (y > y0) seed(x, y - 1);
      if (y < y1) seed(x, y + 1);
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * s + x;
        if (!visited[i] && owner[i] !== id && owner[i] !== WALL) this.setOwner(i, id);
      }
    }
    return this.counts[id] - before;
  }
}
