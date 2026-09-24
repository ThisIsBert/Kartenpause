const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function resample(points, step) {
  const result = [points[0]];
  let remaining = step;
  for (let i = 1; i < points.length; i++) {
    let a = points[i - 1];
    const b = points[i];
    let length = distance(a, b);
    while (length >= remaining) {
      a = a.map((v, axis) => v + (b[axis] - v) * remaining / length);
      result.push(a); length = distance(a, b); remaining = step;
    }
    remaining -= length;
  }
  if (distance(result.at(-1), points.at(-1)) > .5) result.push(points.at(-1));
  return result;
}

export function simplify(points, tolerance = 1.2) {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop(), a = points[start], b = points[end];
    const dx = b[0] - a[0], dy = b[1] - a[1], denominator = dx * dx + dy * dy;
    let maximum = tolerance, split = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i], t = denominator ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denominator)) : 0;
      const d = distance(p, [a[0] + t * dx, a[1] + t * dy]);
      if (d > maximum) { maximum = d; split = i; }
    }
    if (split >= 0) { keep.add(split); stack.push([start, split], [split, end]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => points[i]);
}

// Search across brush cross-sections, then find a continuous, high-contrast
// ridge with dynamic programming. Only the raster (never basemap or vectors)
// supplies evidence. The painted path defines the search corridor, not the result.
export function traceRaster(raster, stroke, width) {
  const length = stroke.slice(1).reduce((sum, p, i) => sum + distance(p, stroke[i]), 0);
  if (length < 15) throw new Error('Bitte eine längere Bildlinie mit dem Pinsel abfahren.');
  if (length > 18000) throw new Error('Diese Pinselspur ist zu lang. Bitte in kürzeren Abschnitten arbeiten.');
  const radius = width / 2;
  const closed = length > width * 2 && distance(stroke[0], stroke.at(-1)) <= Math.max(8, radius);
  const path = resample(closed ? [...stroke, stroke[0]] : stroke, Math.max(3, length / 3000));
  const count = Math.floor(radius) * 2 + 1, middle = (count - 1) / 2;
  const sections = [], back = [];
  let previous = new Float64Array(count);
  const pixel = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
    const i = (y * raster.width + x) * 4;
    return raster.data[i + 3] < 128 ? null : [raster.data[i], raster.data[i + 1], raster.data[i + 2]];
  };
  function evidence(p, normal) {
    const center = pixel(...p);
    if (!center) return -1;
    let score = 0;
    for (const gap of [2, 4, 7]) {
      const a = pixel(p[0] + normal[0] * gap, p[1] + normal[1] * gap);
      const b = pixel(p[0] - normal[0] * gap, p[1] - normal[1] * gap);
      if (!a || !b) continue;
      const da = a.map((v, i) => v - center[i]), db = b.map((v, i) => v - center[i]);
      // Both sides must differ in the same direction: detects thin dark,
      // light and colored strokes while rejecting uniform areas and single edges.
      const dot = da.reduce((s, v, i) => s + v * db[i], 0);
      score = Math.max(score, Math.sqrt(Math.max(0, dot) / 3) / 255);
    }
    return score;
  }
  for (let i = 0; i < path.length; i++) {
    const before = path[Math.max(0, i - 2)], after = path[Math.min(path.length - 1, i + 2)];
    const size = distance(before, after) || 1, normal = [-(after[1] - before[1]) / size, (after[0] - before[0]) / size];
    const candidates = [], scores = new Float64Array(count), parents = new Int16Array(count);
    for (let k = 0; k < count; k++) {
      const offset = k - middle, point = path[i].map((v, axis) => v + normal[axis] * offset);
      const strength = evidence(point, normal);
      candidates.push({ point, strength });
      let best = i ? -Infinity : 0, parent = k;
      if (i) for (let j = Math.max(0, k - 8); j <= Math.min(count - 1, k + 8); j++) {
        const value = previous[j] - .045 * Math.abs(k - j);
        if (value > best) { best = value; parent = j; }
      }
      scores[k] = best + strength - .07 * Math.abs(offset) / radius;
      parents[k] = parent;
    }
    sections.push(candidates); back.push(parents); previous = scores;
  }
  let index = previous.indexOf(Math.max(...previous));
  const result = [], strengths = [];
  for (let i = sections.length - 1; i >= 0; i--) {
    result.push(sections[i][index].point); strengths.push(sections[i][index].strength); index = back[i][index];
  }
  result.reverse();
  const supported = strengths.filter(value => value >= .08).length / strengths.length;
  if (supported < .45 || strengths.some(value => value < 0)) {
    throw new Error('Keine ausreichend deutliche, zusammenhängende Bildlinie gefunden. Bitte näher an der Linie malen, hineinzoomen oder die Pinselbreite anpassen.');
  }
  if (closed) result[result.length - 1] = [...result[0]];
  let vertices = simplify(result);
  if (closed) vertices = vertices.slice(0, -1);
  if (vertices.length < (closed ? 3 : 2)) throw new Error('Die erkannte Form ist zu klein. Bitte hineinzoomen und erneut abfahren.');
  return { vertices, closed, supported };
}
