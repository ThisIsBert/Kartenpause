const linear = Float64Array.from({ length: 256 }, (_, c) => { const v = c / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
// CIELAB distance handles both color nuances and brightness variations. Always
// compare against the clicked color, never a moving flood-fill average.
function lab(data, i) {
  const r = linear[data[i]], g = linear[data[i + 1]], b = linear[data[i + 2]];
  const f = v => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  const x = f((.4124564 * r + .3575761 * g + .1804375 * b) / .95047);
  const y = f(.2126729 * r + .7151522 * g + .072175 * b);
  const z = f((.0193339 * r + .119192 * g + .9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function selectColor(raster, seed, tolerance, contiguous) {
  const { width, height, data } = raster, size = width * height;
  const [x, y] = seed.map(Math.round);
  if (x < 0 || y < 0 || x >= width || y >= height || data[(y * width + x) * 4 + 3] < 128) throw new Error('Bitte in eine sichtbare Farbfläche klicken.');
  const reference = lab(data, (y * width + x) * 4), mask = new Uint8Array(size);
  const matches = index => {
    if (data[index * 4 + 3] < 128) return false;
    const sample = lab(data, index * 4);
    return sample.reduce((sum, v, i) => sum + (v - reference[i]) ** 2, 0) <= tolerance * tolerance + 1e-8;
  };
  if (!contiguous) { for (let i = 0; i < size; i++) if (matches(i)) mask[i] = 1; return mask; }
  const visited = new Uint8Array(size), queue = new Int32Array(size);
  let head = 0, tail = 1; queue[0] = y * width + x; visited[queue[0]] = 1;
  while (head < tail) {
    const index = queue[head++];
    if (!matches(index)) continue;
    mask[index] = 1;
    const px = index % width, py = Math.floor(index / width);
    for (const next of [px > 0 ? index - 1 : -1, px < width - 1 ? index + 1 : -1, py > 0 ? index - width : -1, py < height - 1 ? index + width : -1]) {
      if (next >= 0 && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
    }
  }
  return mask;
}

export function paintSelection(mask, width, height, stroke, diameter, add) {
  const radius = diameter / 2;
  const stamp = ([cx, cy]) => {
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(width - 1, Math.ceil(cx + radius)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) mask[y * width + x] = add ? 1 : 0;
      }
    }
  };
  if (stroke.length) stamp(stroke[0]);
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1], b = stroke[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(.5, radius / 3)));
    for (let j = 1; j <= steps; j++) stamp(a.map((v, k) => v + (b[k] - v) * j / steps));
  }
  return mask;
}

const area = ring => ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
function contains(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function selectionPolygons(mask, width, height) {
  const edges = [], starts = new Map(), stride = width + 1;
  const edge = (x, y, nx, ny, direction) => {
    if (edges.length >= 1000000) throw new Error('Die Auswahl enthält zu viele kleine Ränder. Bitte zusammenhängend auswählen oder die Toleranz anpassen.');
    const from = y * stride + x, to = ny * stride + nx, id = edges.length;
    edges.push({ from, to, direction, used: false });
    if (!starts.has(from)) starts.set(from, []);
    starts.get(from).push(id);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!mask[i]) continue;
    if (y === 0 || !mask[i - width]) edge(x, y, x + 1, y, 0);
    if (x === width - 1 || !mask[i + 1]) edge(x + 1, y, x + 1, y + 1, 1);
    if (y === height - 1 || !mask[i + width]) edge(x + 1, y + 1, x, y + 1, 2);
    if (x === 0 || !mask[i - 1]) edge(x, y + 1, x, y, 3);
  }
  const rings = [];
  for (const first of edges) {
    if (first.used) continue;
    let current = first;
    const ring = [];
    do {
      current.used = true;
      ring.push([current.from % stride - .5, Math.floor(current.from / stride) - .5]);
      if (current.to === first.from) break;
      const candidates = (starts.get(current.to) || []).map(id => edges[id]).filter(e => !e.used);
      // Turn toward the selected pixel at diagonal contacts: keep islands separate.
      const rank = e => [1, 0, 3, 2].indexOf((e.direction - current.direction + 4) % 4);
      candidates.sort((a, b) => rank(a) - rank(b));
      if (!candidates.length) throw new Error('Der Auswahlrand konnte nicht geschlossen werden.');
      current = candidates[0];
    } while (true);
    const reduced = ring.filter((p, i) => {
      const a = ring[(i - 1 + ring.length) % ring.length], b = ring[(i + 1) % ring.length];
      return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
    });
    if (reduced.length >= 3) rings.push({ ring: reduced, area: area(reduced) });
  }
  const outers = rings.filter(r => r.area > 0).map(r => ({ ...r, holes: [] }));
  for (const hole of rings.filter(r => r.area < 0)) {
    const [a, b] = hole.ring, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const point = [(a[0] + b[0]) / 2 + (b[1] - a[1]) / length * .1, (a[1] + b[1]) / 2 - (b[0] - a[0]) / length * .1];
    const parent = outers.filter(r => contains(r.ring, point)).sort((a, b) => a.area - b.area)[0];
    if (!parent) throw new Error('Ein Loch konnte keiner Fläche zugeordnet werden.');
    parent.holes.push(hole.ring);
  }
  return outers.map(r => [r.ring, ...r.holes]);
}
