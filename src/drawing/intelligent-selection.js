import { lab, colorDistance, median, medianColor } from './image-features.js';

const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const detailDirections = [...directions, [1, 1], [1, -1], [-1, 1], [-1, -1]];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Relief/shading changes lightness more than the cartographic base hue. Keep
// achromatic maps on the old metric; attenuate lightness only for colored fills.
const regionDistance = (a, b) => Math.hypot((a[0] - b[0]) * (Math.hypot(b[1], b[2]) >= 8 ? .55 : 1), a[1] - b[1], a[2] - b[2]);
const referenceDistance = (sample, reference) => {
  let distance = regionDistance(sample, reference.color);
  for (const color of reference.variants || []) distance = Math.min(distance, regionDistance(sample, color));
  return distance;
};
const competingColors = (prepared, reference, tolerance) => prepared.palette.filter(p =>
  regionDistance(p.color, reference.color) > Math.max(10, Math.min(18, tolerance)));

function checkedSeed(raster, seed) {
  const point = seed.map(Math.round), [x, y] = point;
  if (!point.every(Number.isFinite) || x < 0 || y < 0 || x >= raster.width || y >= raster.height || raster.data[(y * raster.width + x) * 4 + 3] < 128) {
    throw new Error('Bitte in eine sichtbare Farbfläche klicken.');
  }
  return point;
}

// Immutable, anchored color memory. Later clicks may add bounded nuances, but
// cannot walk the reference step by step from blue through gray into red.
function learnAddition(prepared, point, tolerance, reference) {
  const { raster } = prepared, [sx, sy] = point;
  const limit = Math.min(24, Math.max(12, tolerance + 6));
  const rivals = competingColors(prepared, reference, tolerance);
  const compatible = p => {
    const target = referenceDistance(p, reference);
    return regionDistance(p, reference.color) <= limit && !rivals.some(r => {
      const other = regionDistance(p, r.color);
      return other < 9 && other + 3 < target;
    });
  };
  const clicked = lab(raster.data, (sy * raster.width + sx) * 4);
  const mismatch = () => new Error('Der Klick passt nicht zur bisherigen Flächenfarbe. Bitte den Seitenarm genauer anklicken. Für eine andere Farbe „Auswahl ersetzen“ oder den klassischen Modus verwenden.');
  // Do not relocate an incompatible click into a larger nearby region.
  if (!compatible(clicked)) throw mismatch();
  const samples = [], clusterRadius = Math.max(3, Math.min(8, tolerance * .4 + 3));
  for (let y = Math.max(0, sy - 2); y <= Math.min(raster.height - 1, sy + 2); y++) {
    for (let x = Math.max(0, sx - 2); x <= Math.min(raster.width - 1, sx + 2); x++) {
      const i = (y * raster.width + x) * 4;
      if ((x - sx) ** 2 + (y - sy) ** 2 > 4 || raster.data[i + 3] < 128) continue;
      const p = lab(raster.data, i);
      if (compatible(p) && regionDistance(p, clicked) <= clusterRadius) samples.push(p);
    }
  }
  if (samples.length < 3) throw new Error('Am Klick ist keine ausreichend zusammenhängende Farbstruktur erkennbar. Bitte etwas weiter im Seitenarm klicken.');
  const color = medianColor(samples);
  if (!compatible(color)) throw mismatch();
  const variants = (reference.variants || []).map(p => p.slice());
  if (referenceDistance(color, reference) > 1) variants.push(color);
  // Keep the original anchor, plus the seven most recent distinct nuances.
  return { color: reference.color.slice(), spread: reference.spread, variants: variants.slice(-7) };
}

function growAddition(prepared, seed, tolerance, previousReference, existingMask) {
  const { raster, settings } = prepared, { width, height, data } = raster;
  const point = checkedSeed(raster, seed), reference = learnAddition(prepared, point, tolerance, previousReference);
  const threshold = Math.max(2, tolerance) + Math.min(4, reference.spread * .5);
  const rivals = competingColors(prepared, reference, threshold);
  const mask = new Uint8Array(width * height), states = new Uint8Array(mask.length);
  // Lazy original-pixel features: only reached pixels and short look-ahead
  // probes are converted to Lab. A thin arm is not lost to coarse-cell medians.
  const state = i => {
    if (states[i]) return states[i];
    if (data[i * 4 + 3] < 128) return states[i] = 3;
    const color = lab(data, i * 4), target = referenceDistance(color, reference);
    if (rivals.some(r => { const other = regionDistance(color, r.color); return other < 9 && other + 3 < target; })) return states[i] = 3;
    return states[i] = target <= threshold ? 1 : 2;
  };
  const chunks = [], chunkSize = 65536;
  let head = 0, tail = 0;
  const push = i => {
    if (mask[i]) return;
    mask[i] = 1;
    // An add click repairs the missing part. Do not flood the whole already
    // selected continent or refill earlier brush corrections through its core.
    if (existingMask?.[i] && i !== first) return;
    const c = Math.floor(tail / chunkSize);
    if (!chunks[c]) chunks[c] = new Int32Array(chunkSize);
    chunks[c][tail++ % chunkSize] = i;
  };
  const first = point[1] * width + point[0];
  if (state(first) !== 1) throw new Error('Die Farbnuance am Klick ist zu unruhig. Bitte einen benachbarten Punkt im Seitenarm wählen.');
  push(first);
  while (head < tail) {
    const i = chunks[Math.floor(head / chunkSize)][head++ % chunkSize], x = i % width, y = Math.floor(i / width);
    // A one-pixel diagonal arm has corner contacts, but no four-neighbor path.
    for (const [dx, dy] of detailDirections) {
      const at = d => {
        const nx = x + dx * d, ny = y + dy * d;
        return nx < 0 || ny < 0 || nx >= width || ny >= height ? -1 : ny * width + nx;
      };
      const next = at(1);
      if (next < 0 || mask[next] || state(next) === 3) continue;
      if (state(next) === 1) { push(next); continue; }
      for (let d = 2; d <= Math.floor(settings.bridgeWidth / Math.hypot(dx, dy)) + 1; d++) {
        const end = at(d);
        if (end < 0 || state(end) === 3) break;
        if (state(end) !== 1) continue;
        let sustained = true;
        for (let k = 1; k < settings.supportLength; k++) {
          const p = at(d + k);
          if (p < 0 || state(p) !== 1) { sustained = false; break; }
        }
        if (!sustained) continue;
        // Queue matching cells only; crossed ink does not seed sideways leaks.
        for (let k = 1; k < d; k++) mask[at(k)] = 1;
        push(end); break;
      }
    }
  }
  return { mask, reference, threshold, rivals };
}

// Frequent, spatially broad colors are competing AREAS, even where one of them
// narrows to a peninsula. They must not be treated like rare ink overlays.
function areaPalette(features, valid, width, height, scale, settings) {
  const bins = new Map(), reach = Math.max(2, Math.ceil(settings.bridgeWidth / scale));
  let visible = 0;
  for (let i = 0; i < valid.length; i++) {
    if (!valid[i]) continue;
    visible++;
    const p = features.subarray(i * 3, i * 3 + 3);
    const key = p.map(v => Math.floor(v / 8)).join(',');
    let bin = bins.get(key);
    if (!bin) { bin = { count: 0, broad: 0, sum: [0, 0, 0] }; bins.set(key, bin); }
    bin.count++; for (let c = 0; c < 3; c++) bin.sum[c] += p[c];
    const x = i % width, y = Math.floor(i / width);
    if (x < reach || y < reach || x + reach >= width || y + reach >= height) continue;
    if (directions.every(([dx, dy]) => {
      const q = i + reach * (dy * width + dx);
      return valid[q] && colorDistance(p, features.subarray(q * 3, q * 3 + 3)) < 9;
    })) bin.broad++;
  }
  const entries = [...bins.values()].map(b => ({ ...b, color: b.sum.map(v => v / b.count) })).sort((a, b) => b.count - a.count);
  const palette = [];
  for (const entry of entries.slice(0, 64)) {
    if (palette.some(p => colorDistance(entry.color, p.color) < 14)) continue;
    const cluster = entries.filter(p => colorDistance(p.color, entry.color) < 12);
    const count = cluster.reduce((s, p) => s + p.count, 0), broad = cluster.reduce((s, p) => s + p.broad, 0);
    if (count < visible * .08 || broad < visible * .015) continue;
    palette.push({ color: [0, 1, 2].map(c => cluster.reduce((s, p) => s + p.sum[c], 0) / count), fraction: count / visible });
    if (palette.length === 6) break;
  }
  return palette;
}
const ring = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
// Digital simple-point test: 4-connected foreground, 8-connected background.
// A boundary move must not split a land bridge, merge islands or erase a hole.
const simplePoint = Uint8Array.from({ length: 256 }, (_, bits) => {
  const components = (value, diagonal) => {
    let seen = 0, count = 0;
    for (let p = 0; p < 8; p++) {
      if ((seen & (1 << p)) || Boolean(bits & (1 << p)) !== value) continue;
      count++; const stack = [p]; seen |= 1 << p;
      while (stack.length) {
        const a = ring[stack.pop()];
        for (let q = 0; q < 8; q++) {
          const dx = Math.abs(a[0] - ring[q][0]), dy = Math.abs(a[1] - ring[q][1]);
          if ((seen & (1 << q)) || Boolean(bits & (1 << q)) !== value || (diagonal ? Math.max(dx, dy) > 1 : dx + dy !== 1)) continue;
          seen |= 1 << q; stack.push(q);
        }
      }
    }
    return count;
  };
  return components(true, false) === 1 && components(false, true) === 1 ? 1 : 0;
});

// All geometric settings are in ORIGINAL pixels. Deliberately separate from
// sensitivity, so a future detail control need not change the public algorithm.
export function intelligentSettings(raster, overrides = {}) {
  const unit = clamp(Math.max(raster.width, raster.height) / 1800, 1, 2);
  return {
    maxCoarsePixels: 450000,
    sampleRadius: Math.round(9 * unit),
    bridgeWidth: Math.round(12 * unit),
    supportLength: Math.round(4 * unit),
    corridorRadius: Math.round(7 * unit),
    maxHoleArea: Math.round(64 * unit * unit),
    ...overrides
  };
}

// Cached once per worker/image. A sampled block median suppresses scan impulses;
// a modest 3x3 box filter makes thin ink less dominant. Unlike a bilateral filter,
// this intentionally does NOT preserve every letter/river edge. We never blur or
// replace the source raster. Transparent cells are barriers, including subcells.
export function prepareIntelligent(raster, overrides = {}) {
  const settings = intelligentSettings(raster, overrides);
  const scale = Math.max(1, Math.ceil(Math.sqrt(raster.width * raster.height / settings.maxCoarsePixels)));
  const width = Math.ceil(raster.width / scale), height = Math.ceil(raster.height / scale), n = width * height;
  const valid = new Uint8Array(n).fill(1), rgb = new Uint8ClampedArray(n * 4), features = new Float32Array(n * 3), rawFeatures = new Float32Array(n * 3);
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    if (raster.data[(y * raster.width + x) * 4 + 3] < 128) valid[Math.floor(y / scale) * width + Math.floor(x / scale)] = 0;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const samples = [], i = y * width + x;
    for (let oy = 0; oy < 3; oy++) for (let ox = 0; ox < 3; ox++) {
      const px = clamp(Math.floor((x + (ox + .5) / 3) * scale), 0, raster.width - 1);
      const py = clamp(Math.floor((y + (oy + .5) / 3) * scale), 0, raster.height - 1);
      const p = (py * raster.width + px) * 4;
      if (raster.data[p + 3] >= 128) samples.push(raster.data.subarray(p, p + 3));
    }
    if (samples.length) rgb.set([...medianColor(samples), valid[i] * 255], i * 4);
    rawFeatures.set(lab(rgb, i * 4), i * 3);
  }
  const simplified = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sum = [0, 0, 0]; let count = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || !valid[ny * width + nx]) continue;
      const p = (ny * width + nx) * 4;
      for (let c = 0; c < 3; c++) sum[c] += rgb[p + c];
      count++;
    }
    const i = y * width + x;
    simplified.set([...sum.map(v => count ? Math.round(v / count) : 0), valid[i] * 255], i * 4);
    features.set(lab(simplified, i * 4), i * 3);
  }
  const palette = areaPalette(features, valid, width, height, scale, settings);
  return { raster, settings, scale, width, height, valid, features, rawFeatures, palette, simplified };
}

function referenceAt(raster, seed, radius) {
  const samples = [], [sx, sy] = seed;
  const step = Math.max(1, Math.floor(radius / 7));
  for (let y = Math.max(0, sy - radius); y <= Math.min(raster.height - 1, sy + radius); y += step) {
    for (let x = Math.max(0, sx - radius); x <= Math.min(raster.width - 1, sx + radius); x += step) {
      const i = (y * raster.width + x) * 4;
      if ((x - sx) ** 2 + (y - sy) ** 2 <= radius ** 2 && raster.data[i + 3] >= 128) samples.push(lab(raster.data, i));
    }
  }
  const center = medianColor(samples), distances = samples.map(p => colorDistance(p, center));
  const spread = median(distances.slice());
  const inliers = samples.filter((p, i) => distances[i] <= Math.max(2, spread * 2.5));
  return { color: medianColor(inliers), spread };
}

function closeSmallHoles(mask, valid, width, height, maxArea) {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || visited[i]) continue;
    let head = 0, tail = 1, enclosed = true; queue[0] = i; visited[i] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      if (!valid[p] || !x || !y || x === width - 1 || y === height - 1) enclosed = false;
      for (const [dx, dy] of directions) {
        const nx = x + dx, ny = y + dy, q = ny * width + nx;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || mask[q] || visited[q]) continue;
        visited[q] = 1; queue[tail++] = q;
      }
    }
    if (enclosed && tail <= maxArea) for (let j = 0; j < tail; j++) mask[queue[j]] = 1;
  }
}

function releaseSmallColorMarks(traversable, valid, width, height, maxArea) {
  // A common land color may also occur in isolated JPEG specks/letter dots.
  // Protect its spatial regions, not every isolated pixel of that color.
  const visited = new Uint8Array(valid.length), queue = new Int32Array(valid.length);
  for (let i = 0; i < valid.length; i++) {
    if (!valid[i] || traversable[i] || visited[i]) continue;
    let head = 0, tail = 1; queue[0] = i; visited[i] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      for (const [dx, dy] of directions) {
        const nx = x + dx, ny = y + dy, q = ny * width + nx;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !valid[q] || traversable[q] || visited[q]) continue;
        visited[q] = 1; queue[tail++] = q;
      }
    }
    if (tail <= maxArea) for (let j = 0; j < tail; j++) traversable[queue[j]] = 1;
  }
}

export function growIntelligent(prepared, seed, tolerance) {
  const { raster, settings, scale, width, height, features, rawFeatures, valid } = prepared;
  const point = checkedSeed(raster, seed), [sx, sy] = point;
  const reference = referenceAt(raster, point, settings.sampleRadius);
  // Cap adaptation: a mixed probe must not open the floodgate into another area.
  const threshold = Math.max(2, tolerance) + Math.min(4, reference.spread * .5);
  const n = width * height, strong = new Uint8Array(n), eligible = new Uint8Array(n), traversable = valid.slice();
  const rivals = competingColors(prepared, reference, threshold);
  for (let i = 0; i < n; i++) {
    const p = rawFeatures.subarray(i * 3, i * 3 + 3), target = regionDistance(p, reference.color);
    if (rivals.some(r => {
      const other = regionDistance(p, r.color);
      return other < 9 && other + 3 < target;
    })) traversable[i] = 0;
  }
  releaseSmallColorMarks(traversable, valid, width, height, Math.floor(Math.min(12, settings.maxHoleArea) / (scale * scale)));
  const distance = i => regionDistance(features.subarray(i * 3, i * 3 + 3), reference.color);
  for (let i = 0; i < n; i++) strong[i] = traversable[i] && distance(i) <= threshold ? 1 : 0;
  for (let i = 0; i < n; i++) {
    if (strong[i]) { eligible[i] = 1; continue; }
    if (!traversable[i] || distance(i) > threshold * 1.15) continue;
    const x = i % width, y = Math.floor(i / width);
    let support = 0;
    for (const [dx, dy] of directions) if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height) support += strong[i + dy * width + dx];
    if (support >= 2) eligible[i] = 1;
  }
  let start = -1, best = Infinity;
  const cx = Math.floor(sx / scale), cy = Math.floor(sy / scale), probe = Math.ceil(settings.sampleRadius / scale);
  for (let y = Math.max(0, cy - probe); y <= Math.min(height - 1, cy + probe); y++) for (let x = Math.max(0, cx - probe); x <= Math.min(width - 1, cx + probe); x++) {
    const i = y * width + x, d = (x - cx) ** 2 + (y - cy) ** 2;
    if (strong[i] && d < best) { start = i; best = d; }
  }
  if (start < 0) throw new Error('Keine eindeutige Flächenfarbe am Klick gefunden. Bitte neben die Beschriftung klicken oder die Empfindlichkeit erhöhen.');
  const mask = new Uint8Array(n), queued = new Uint8Array(n), queue = new Int32Array(n);
  let head = 0, tail = 1; queue[0] = start; queued[start] = 1;
  // The box filter adds at most one coarse-cell halo on either side of ink.
  // Compensate that halo; otherwise the same 8px river stops being bridgeable
  // merely because a large image was reduced to scale 3 or 4.
  const bridge = Math.max(1, Math.floor(settings.bridgeWidth / scale) + 2), support = Math.max(2, Math.ceil(settings.supportLength / scale));
  while (head < tail) {
    const i = queue[head++], x = i % width, y = Math.floor(i / width); mask[i] = 1;
    for (const [dx, dy] of directions) {
      const at = d => {
        const nx = x + dx * d, ny = y + dy * d;
        return nx < 0 || ny < 0 || nx >= width || ny >= height ? -1 : ny * width + nx;
      };
      const next = at(1);
      if (next < 0 || !traversable[next] || queued[next]) continue;
      if (eligible[next]) { queued[next] = 1; queue[tail++] = next; continue; }
      // A gap is ink only if matching material persists BEYOND it. Neither a
      // single matching scan pixel nor a transparent gap can connect regions.
      for (let d = 2; d <= bridge + 1; d++) {
        const end = at(d);
        if (end < 0 || !traversable[end]) break;
        if (!strong[end]) continue;
        let sustained = true;
        for (let k = 1; k < support; k++) { const p = at(d + k); if (p < 0 || !strong[p]) { sustained = false; break; } }
        if (!sustained) continue;
        for (let k = 1; k < d; k++) mask[at(k)] = 1;
        if (!queued[end]) { queued[end] = 1; queue[tail++] = end; }
        break;
      }
    }
  }
  closeSmallHoles(mask, traversable, width, height, Math.floor(settings.maxHoleArea / (scale * scale)));
  const full = new Uint8Array(raster.width * raster.height);
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const i = y * raster.width + x;
    full[i] = raster.data[i * 4 + 3] >= 128 ? mask[Math.floor(y / scale) * width + Math.floor(x / scale)] : 0;
  }
  return { mask: full, reference, threshold, rivals };
}

// Original-pixel samples along a tangent. The median rejects thin crossing ink;
// depths on both sides then test whether the change persists beyond an ink line.
function sideColor(raster, x, y, nx, ny, depth) {
  const samples = [];
  for (const t of [-4, -2, 0, 2, 4]) {
    const px = Math.round(x + nx * depth - ny * t), py = Math.round(y + ny * depth + nx * t);
    if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) continue;
    const i = (py * raster.width + px) * 4;
    if (raster.data[i + 3] >= 128) samples.push(lab(raster.data, i));
  }
  return samples.length >= 3 ? medianColor(samples) : null;
}

export function refineIntelligent(raster, coarse, reference, threshold, settings, rivals = []) {
  const { width, height } = raster, n = coarse.length, radius = settings.corridorRadius;
  const mask = coarse.slice(), owner = new Int32Array(n).fill(-1), distance = new Uint8Array(n).fill(255);
  // Chunked queue avoids reserving another 4 * imagePixels bytes for an often
  // tiny corridor. Bounds are explicit, so memory stays linear even on noise.
  const chunks = [], chunkSize = 65536;
  let head = 0, tail = 0;
  const push = i => { const c = Math.floor(tail / chunkSize); if (!chunks[c]) chunks[c] = new Int32Array(chunkSize); chunks[c][tail++ % chunkSize] = i; };
  const points = [], normals = [], shifts = [];
  // Extend the mask at the image edge for normals; the frame is not evidence
  // for a second, perpendicular cartographic boundary.
  const inside = (x, y) => coarse[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!coarse[i]) continue;
    // Image borders cannot move out of the raster; only internal edges seed a corridor.
    if ((x === 0 || coarse[i - 1]) && (x === width - 1 || coarse[i + 1]) &&
        (y === 0 || coarse[i - width]) && (y === height - 1 || coarse[i + width])) continue;
    let nx = 0, ny = 0;
    const normalRadius = Math.min(5, radius);
    for (let t = -normalRadius; t <= normalRadius; t++) {
      nx += inside(x - normalRadius, y + t) - inside(x + normalRadius, y + t);
      ny += inside(x + t, y - normalRadius) - inside(x + t, y + normalRadius);
    }
    const length = Math.hypot(nx, ny);
    if (length) { nx /= length; ny /= length; }
    owner[i] = points.length; distance[i] = 0; points.push(i); normals.push([nx, ny]); push(i);
  }
  const depth = Math.max(3, Math.ceil(settings.bridgeWidth / 2) + 1);
  for (let j = 0; j < points.length; j++) {
    const i = points[j], x = i % width, y = Math.floor(i / width), [nx, ny] = normals[j];
    let bestScore = .12, shift = 0;
    // Adjacent candidate edges share their side samples. Cache this short
    // normal profile, not Lab for all original pixels (25MP would cost 300MB).
    const extent = radius + depth + settings.supportLength, profile = [];
    const sample = offset => {
      const key = offset + extent;
      if (profile[key] === undefined) profile[key] = sideColor(raster, x + nx * .5, y + ny * .5, nx, ny, offset);
      return profile[key];
    };
    if (nx || ny) for (let s = -radius; s <= radius; s++) {
      const a = sample(s - depth), b = sample(s + depth), far = sample(s + depth + settings.supportLength);
      if (!a || !b || !far) continue;
      const fit = referenceDistance(a, reference), outside = Math.min(referenceDistance(b, reference), referenceDistance(far, reference));
      if (fit > threshold || outside < threshold * 1.2) continue;
      const gap = colorDistance(a, b);
      if (gap < threshold * 1.2) continue;
      const nearA = sample(s - 1), nearB = sample(s + 1);
      if (!nearA || !nearB) continue;
      // Gradient is gated by persistent DIFFERENT base colors. A dark line
      // between identical areas gets no edge reward at all.
      const gradient = Math.min(1, colorDistance(nearA, nearB) / gap);
      const middle = nearA.map((v, c) => (v + nearB[c]) / 2);
      const balance = Math.abs(colorDistance(middle, a) - colorDistance(middle, b)) / gap;
      const score = .45 * (1 - fit / threshold) + .3 * Math.min(1, outside / (threshold * 2)) + .45 * gradient - .35 * Math.min(1, balance) - .018 * Math.abs(s);
      if (score > bestScore) { bestScore = score; shift = s; }
    }
    shifts.push(shift);
  }
  // A small local displacement penalty suppresses single-pixel scan jitter.
  // No polygon simplification/erosion: narrow cores and large holes stay pinned.
  const smooth = shifts.map((s, j) => {
    const i = points[j], x = i % width, y = Math.floor(i / width), values = [s, s];
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      if (x + ox < 0 || y + oy < 0 || x + ox >= width || y + oy >= height) continue;
      const other = owner[i + oy * width + ox];
      if (other >= 0 && normals[j][0] * normals[other][0] + normals[j][1] * normals[other][1] > .7) values.push(shifts[other]);
    }
    return median(values);
  });
  while (head < tail) {
    const i = chunks[Math.floor(head / chunkSize)][head++ % chunkSize], x = i % width, y = Math.floor(i / width);
    if (distance[i] >= radius) continue;
    for (const [dx, dy] of directions) {
      const nx = x + dx, ny = y + dy, p = ny * width + nx;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || distance[p] !== 255) continue;
      distance[p] = distance[i] + 1; owner[p] = owner[i]; push(p);
    }
  }
  const evidence = i => {
    if (raster.data[i * 4 + 3] < 128 || !rivals.length) return 0;
    const p = lab(raster.data, i * 4), target = referenceDistance(p, reference);
    let other = Infinity;
    for (const rival of rivals) other = Math.min(other, regionDistance(p, rival.color));
    if (target <= Math.max(8, threshold) && target + 3 < other) return 1;
    if (other < 9 && other + 3 < target) return -1;
    return 0; // Ink/unexplained colors defer to the spatial boundary evidence.
  };
  for (let k = 0; k < tail; k++) {
    const i = chunks[Math.floor(k / chunkSize)][k % chunkSize], j = owner[i], shift = smooth[j];
    // Signed distance keeps the original topology where evidence is absent.
    // With no displacement this is EXACTLY the coarse mask, even at corners.
    const d = coarse[i] ? -distance[i] - .5 : distance[i] - .5;
    const x = i % width, y = Math.floor(i / width);
    let value = raster.data[i * 4 + 3] >= 128 && d < shift ? 1 : 0;
    // In the corridor, a reliable original-pixel area color outranks the
    // displacement inherited from a coarse normal. This restores small bends
    // and side branches that a normal profile cannot geometrically represent.
    const vote = evidence(i);
    if (vote) {
      let support = 0;
      for (const [dx, dy] of directions) {
        if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height && evidence(i + dy * width + dx) === vote) support++;
      }
      if (support >= 2) value = vote > 0 ? 1 : 0;
    }
    if (value === mask[i]) continue;
    let bits = 0;
    for (let p = 0; p < 8; p++) {
      const px = x + ring[p][0], py = y + ring[p][1];
      if (px >= 0 && py >= 0 && px < width && py < height && mask[py * width + px]) bits |= 1 << p;
    }
    if (simplePoint[bits]) mask[i] = value;
  }
  return { mask, corridor: distance };
}

export function selectIntelligent(prepared, seed, tolerance = 18, debug = false, previousReference = null, existingMask = null) {
  const coarse = previousReference ? growAddition(prepared, seed, tolerance, previousReference, existingMask) : growIntelligent(prepared, seed, tolerance);
  const refined = refineIntelligent(prepared.raster, coarse.mask, coarse.reference, coarse.threshold, prepared.settings, coarse.rivals);
  return {
    mask: refined.mask,
    referenceModel: { ...coarse.reference, variants: coarse.reference.variants || [] },
    ...(debug ? { debug: {
      simplified: { width: prepared.width, height: prepared.height, data: prepared.simplified },
      coarse: coarse.mask, corridor: refined.corridor, final: refined.mask,
      width: prepared.raster.width, height: prepared.raster.height,
      reference: coarse.reference, settings: prepared.settings, scale: prepared.scale, rivals: coarse.rivals,
      continued: !!previousReference
    } } : {})
  };
}
