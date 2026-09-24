import { simplify } from './trace.js';

export function cropSearch(raster, start, end, radius) {
  if (![...start, ...end, radius].every(Number.isFinite)) throw new Error('Ungültiger Suchbereich.');
  const left = Math.max(0, Math.floor(Math.min(start[0], end[0]) - radius - 8));
  const top = Math.max(0, Math.floor(Math.min(start[1], end[1]) - radius - 8));
  const right = Math.min(raster.width - 1, Math.ceil(Math.max(start[0], end[0]) + radius + 8));
  const bottom = Math.min(raster.height - 1, Math.ceil(Math.max(start[1], end[1]) + radius + 8));
  const width = right - left + 1, height = bottom - top + 1;
  if (width * height > 400000) throw new Error('Der Abschnitt ist zu groß. Bitte einen näheren Zwischenanker setzen oder den Suchraum verkleinern.');
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) data.set(raster.data.subarray(((top + y) * raster.width + left) * 4, ((top + y) * raster.width + left + width) * 4), y * width * 4);
  return { raster: { width, height, data }, start: [start[0] - left, start[1] - top], end: [end[0] - left, end[1] - top], offset: [left, top] };
}

class MinHeap {
  items = [];
  push(item) {
    let i = this.items.length; this.items.push(item);
    while (i > 0) { const parent = (i - 1) >> 1; if (this.items[parent].score <= item.score) break; this.items[i] = this.items[parent]; i = parent; }
    this.items[i] = item;
  }
  pop() {
    const first = this.items[0], last = this.items.pop();
    if (this.items.length) {
      let i = 0;
      while (i * 2 + 1 < this.items.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1].score < this.items[child].score) child++;
        if (last.score <= this.items[child].score) break;
        this.items[i] = this.items[child]; i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

// Full-resolution, eight-connected A* search between pinned anchors. A narrow
// corridor limits detours; color and ridge evidence favor the requested stroke.
export function findMagneticPath({ raster, start, end, radius = 32, color = null, tolerance = 50 }) {
  const { width, height, data } = raster, n = width * height;
  const a = start.map(Math.round), b = end.map(Math.round);
  if ([a, b].some(p => p[0] < 0 || p[1] < 0 || p[0] >= width || p[1] >= height)) throw new Error('Anker liegt außerhalb der Pixelkarte.');
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 2) throw new Error('Bitte den nächsten Anker etwas weiter entfernt setzen.');
  const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
  const evidence = new Float32Array(n).fill(-1), costs = new Float32Array(n).fill(-1);
  const corridorDistance = (x, y) => {
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared));
    return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
  };
  function cost(index) {
    if (costs[index] >= 0) return costs[index];
    const x = index % width, y = Math.floor(index / width), offset = index * 4;
    const away = corridorDistance(x, y);
    if (data[offset + 3] < 128 || away > radius) return costs[index] = Infinity;
    let ridge = 0;
    for (const gap of [1, 2, 4, 7]) for (const [nx, ny] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const ax = x + nx * gap, ay = y + ny * gap, bx = x - nx * gap, by = y - ny * gap;
      if (ax < 0 || bx < 0 || ay < 0 || by < 0 || ax >= width || bx >= width || ay >= height || by >= height) continue;
      const ia = (ay * width + ax) * 4, ib = (by * width + bx) * 4;
      if (data[ia + 3] < 128 || data[ib + 3] < 128) continue;
      let dot = 0;
      for (let c = 0; c < 3; c++) dot += (data[ia + c] - data[offset + c]) * (data[ib + c] - data[offset + c]);
      ridge = Math.max(ridge, Math.sqrt(Math.max(0, dot) / 3) / 255);
    }
    let match = 1;
    if (color) {
      let delta = 0;
      for (let c = 0; c < 3; c++) delta += (data[offset + c] - color[c]) ** 2;
      match = Math.exp(-delta / (6 * tolerance * tolerance));
    }
    evidence[index] = color ? ridge * match : ridge;
    return costs[index] = .25 + 4 * (1 - ridge) + (color ? 8 * (1 - match) : 0) + .2 * away / radius;
  }
  const first = a[1] * width + a[0], last = b[1] * width + b[0];
  const distances = new Float64Array(n).fill(Infinity), parents = new Int32Array(n).fill(-1), visited = new Uint8Array(n);
  const heap = new MinHeap(); distances[first] = 0; heap.push({ index: first, score: 0 });
  while (heap.items.length) {
    const { index } = heap.pop();
    if (visited[index]) continue;
    visited[index] = 1;
    if (index === last) break;
    const x = index % width, y = Math.floor(index / width), currentCost = cost(index);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if ((!ox && !oy) || x + ox < 0 || y + oy < 0 || x + ox >= width || y + oy >= height) continue;
      const next = (y + oy) * width + x + ox;
      if (visited[next]) continue;
      const candidate = distances[index] + (currentCost + cost(next)) * .5 * (ox && oy ? Math.SQRT2 : 1);
      if (candidate < distances[next]) {
        distances[next] = candidate; parents[next] = index;
        heap.push({ index: next, score: candidate + .25 * Math.hypot(x + ox - b[0], y + oy - b[1]) });
      }
    }
  }
  if (!Number.isFinite(distances[last])) throw new Error('Kein Verlauf zwischen den Ankern gefunden. Bitte einen Zwischenanker setzen.');
  const pixels = [];
  let supported = 0;
  for (let index = last; index !== -1; index = parents[index]) {
    pixels.push([index % width, Math.floor(index / width)]);
    cost(index); if (evidence[index] > .09) supported++;
  }
  if (supported / pixels.length < .4) throw new Error('Keine ausreichend passende Bildlinie gefunden. Bitte Anker, Farbvorgabe oder Suchraum anpassen.');
  pixels.reverse();
  return { pixels: simplify(pixels, .65), support: supported / pixels.length };
}
