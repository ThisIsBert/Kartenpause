import { t } from '../i18n.js';
import { simplify } from './simplify-path.js';
import { pixelContrast } from './image-features.js';

export function cropSearch(raster, start, end, radius) {
  if (![...start, ...end, radius].every(Number.isFinite)) throw new Error(t('Ungültiger Suchbereich.'));
  const left = Math.max(0, Math.floor(Math.min(start[0], end[0]) - radius - 8));
  const top = Math.max(0, Math.floor(Math.min(start[1], end[1]) - radius - 8));
  const right = Math.min(raster.width - 1, Math.ceil(Math.max(start[0], end[0]) + radius + 8));
  const bottom = Math.min(raster.height - 1, Math.ceil(Math.max(start[1], end[1]) + radius + 8));
  const width = right - left + 1, height = bottom - top + 1;
  if (width * height > 400000) throw new Error(t('Der Abschnitt ist zu groß. Bitte einen näheren Zwischenanker setzen oder den Suchraum verkleinern.'));
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

// First follow connected image evidence; only a failed connected search may
// bridge missing evidence. The corridor remains a hard geometric limit.
export function findMagneticPath({ raster, start, end, radius = 32, color = null, color2 = null, tolerance = 50, fidelity = 80, maxGap = 8 }) {
  const { width, height, data } = raster, n = width * height;
  if (![...start, ...end, radius, tolerance, fidelity, maxGap].every(Number.isFinite) || radius <= 0 || tolerance <= 0 || maxGap < 0 || maxGap > 64) throw new Error(t('Ungültiger Suchbereich.'));
  const faithfulness = Math.max(0, Math.min(100, fidelity)) / 100;
  const a = start.map(Math.round), b = end.map(Math.round);
  if ([a, b].some(p => p[0] < 0 || p[1] < 0 || p[0] >= width || p[1] >= height)) throw new Error(t('Anker liegt außerhalb der Pixelkarte.'));
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 2) throw new Error(t('Bitte den nächsten Anker etwas weiter entfernt setzen.'));
  const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
  const evidence = new Float32Array(n).fill(-1), costs = new Float32Array(n).fill(-1);
  const boundary = color && color2;
  // Infer dark/light stroke polarity near the anchors, also with picked colors.
  // Otherwise a white break between dark line ends looks like a bright ridge
  // and could masquerade as continuous evidence even with bridging disabled.
  const polarity = boundary ? 0 : strokePolarity(raster, [a, b], color, tolerance);
  const colorGap = boundary ? Math.hypot(...color.map((v, i) => v - color2[i])) : 0;
  if (boundary && colorGap < 12) throw new Error(t('Die beiden Farben sind zu ähnlich. Bitte unterschiedliche Flächenfarben aufnehmen.'));
  const matchColor = (offset, sample) => {
    let delta = 0;
    for (let c = 0; c < 3; c++) delta += (data[offset + c] - sample[c]) ** 2;
    return Math.exp(-delta / (6 * tolerance * tolerance));
  };
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
      if (boundary) {
        const contrast = Math.min(1, pixelContrast(data, ia, ib) / colorGap);
        const pair = Math.max(matchColor(ia, color) * matchColor(ib, color2), matchColor(ia, color2) * matchColor(ib, color));
        ridge = Math.max(ridge, Math.sqrt(pair) * contrast / (1 + (gap - 1) * .18));
        continue;
      }
      let dot = 0;
      for (let c = 0; c < 3; c++) dot += (data[ia + c] - data[offset + c]) * (data[ib + c] - data[offset + c]);
      const contrastSign = data[ia] + data[ia + 1] + data[ia + 2] + data[ib] + data[ib + 1] + data[ib + 2]
        - 2 * (data[offset] + data[offset + 1] + data[offset + 2]);
      if (polarity && polarity * contrastSign <= 0) continue;
      ridge = Math.max(ridge, Math.sqrt(Math.max(0, dot) / 3) / 255);
    }
    let match = 1;
    if (boundary) {
      evidence[index] = ridge;
    } else {
      if (color) {
        let delta = 0;
        for (let c = 0; c < 3; c++) delta += (data[offset + c] - color[c]) ** 2;
        match = Math.exp(-delta / (6 * tolerance * tolerance));
      }
      // Normalize stroke contrast so a pale but distinct river is not charged
      // almost as much per pixel as empty land. Flat matching areas stay weak.
      evidence[index] = Math.min(1, ridge / .18) * match;
    }
    return costs[index] = .1 + (1 - evidence[index]) ** 2 * (.5 + 12 * faithfulness);
  }
  const first = a[1] * width + a[0], last = b[1] * width + b[0];
  if (!Number.isFinite(cost(first)) || !Number.isFinite(cost(last))) throw new Error(t('Kein Verlauf zwischen den Ankern gefunden. Bitte einen Zwischenanker setzen.'));
  // Exact pinned anchors may sit on the edge of a stroke. Only those two
  // pixels get this allowance; intervening off-line pixels consume the budget.
  const supported = index => evidence[index] >= .5 || index === first || index === last;
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
      const nextCost = cost(next);
      if (!supported(next) || !Number.isFinite(nextCost)) continue;
      const candidate = distances[index] + (currentCost + nextCost) * .5 * (ox && oy ? Math.SQRT2 : 1);
      if (candidate < distances[next]) {
        distances[next] = candidate; parents[next] = index;
        heap.push({ index: next, score: candidate + .1 * Math.hypot(x + ox - b[0], y + oy - b[1]) });
      }
    }
  }
  let indices = [];
  if (Number.isFinite(distances[last])) {
    for (let index = last; index !== -1; index = parents[index]) indices.push(index);
    indices.reverse();
  } else if (maxGap > 0) {
    indices = bridgePath({ width, height, n, first, last, end: b, maxGap, faithfulness, cost, supported });
  }
  if (!indices.length) throw new Error(t('Keine ausreichend zusammenhängende Bildlinie gefunden. Suchraum prüfen, Zwischenanker setzen oder „Lücken überbrücken“ vorsichtig erhöhen.'));
  let matching = 0, gap = 0, longestGap = 0, bridges = 0;
  const pixels = indices.map((index, i) => {
    const point = [index % width, Math.floor(index / width)];
    if (supported(index)) { matching++; gap = 0; }
    else {
      if (!gap) bridges++;
      const previous = indices[i - 1];
      gap += Math.hypot(point[0] - previous % width, point[1] - Math.floor(previous / width));
      longestGap = Math.max(longestGap, gap);
    }
    return point;
  });
  if (matching / pixels.length < .4) throw new Error(t('Keine ausreichend passende Bildlinie gefunden. Bitte Anker, Farbvorgabe oder Suchraum anpassen.'));
  return { pixels: simplify(pixels, .65), support: matching / pixels.length, bridges, longestGap };
}

function strokePolarity({ width, height, data }, anchors, color, tolerance) {
  let strongest = 0, polarity = 0;
  const tone = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    return data[i + 3] < 128 ? null : (data[i] + data[i + 1] + data[i + 2]) / 3;
  };
  for (const [ax, ay] of anchors) for (let y = ay - 5; y <= ay + 5; y++) for (let x = ax - 5; x <= ax + 5; x++) {
    const center = tone(x, y);
    if (center === null) continue;
    let surrounding = 0, count = 0;
    for (const [dx, dy] of [[7,0],[-7,0],[0,7],[0,-7],[5,5],[-5,5],[5,-5],[-5,-5]]) {
      const value = tone(x + dx, y + dy);
      if (value !== null) { surrounding += value; count++; }
    }
    if (!count) continue;
    const contrast = surrounding / count - center;
    const offset = (y * width + x) * 4;
    const colorMatch = color ? Math.exp(-color.reduce((sum, v, c) => sum + (data[offset + c] - v) ** 2, 0) / (6 * tolerance * tolerance)) : 1;
    const score = Math.abs(contrast) * colorMatch / (1 + .5 * Math.hypot(x - ax, y - ay));
    if (score > strongest && Math.abs(contrast) > 8) { strongest = score; polarity = Math.sign(contrast); }
  }
  return polarity;
}

// A pixel reached cheaply after a long gap cannot replace a slightly costlier
// arrival with unused gap budget. Retain both until one dominates the other.
// Sparse Pareto labels avoid allocating width × height × gap-limit arrays.
function bridgePath({ width, height, n, first, last, end, maxGap, faithfulness, cost, supported }) {
  const labels = new Array(n), heap = new MinHeap();
  const initial = { index: first, distance: 0, gap: 0, parent: null };
  labels[first] = [initial]; heap.push({ label: initial, score: 0 });
  let created = 1;
  while (heap.items.length) {
    const { label } = heap.pop(), { index } = label;
    if (!labels[index].includes(label)) continue;
    if (index === last) {
      const result = [];
      for (let node = label; node; node = node.parent) result.push(node.index);
      return result.reverse();
    }
    const x = index % width, y = Math.floor(index / width), currentCost = cost(index);
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      if ((!ox && !oy) || x + ox < 0 || y + oy < 0 || x + ox >= width || y + oy >= height) continue;
      const next = (y + oy) * width + x + ox, nextCost = cost(next);
      if (!Number.isFinite(nextCost)) continue;
      const step = ox && oy ? Math.SQRT2 : 1, onLine = supported(next);
      const gap = onLine ? 0 : label.gap + step;
      if (gap > maxGap + 1e-9) continue;
      const bridging = !onLine || !supported(index);
      const penalty = bridging ? (16 + 64 * faithfulness) * (1 + (label.gap + gap) / (2 * maxGap)) : 0;
      const distance = label.distance + ((currentCost + nextCost) * .5 + penalty) * step;
      const existing = labels[next] || [];
      if (existing.some(other => other.distance <= distance + 1e-9 && other.gap <= gap + 1e-9)) continue;
      const nextLabel = { index: next, distance, gap, parent: label };
      labels[next] = existing.filter(other => !(distance <= other.distance + 1e-9 && gap <= other.gap + 1e-9));
      labels[next].push(nextLabel);
      heap.push({ label: nextLabel, score: distance + .1 * Math.hypot(x + ox - end[0], y + oy - end[1]) });
      if (++created > 1000000) throw new Error(t('Die Lückensuche ist zu aufwendig. Bitte einen näheren Zwischenanker setzen oder die Überbrückung verkleinern.'));
    }
  }
  return [];
}
