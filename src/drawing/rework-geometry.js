import { isClosed, isCurved, objectRings, sampledPoints, ringEntries } from './geometry.js';

export function linearObject(object) {
  const result = structuredClone(object);
  if (result.parts) result.parts = result.parts.map(linearObject);
  if (isCurved(object.kind)) {
    result.vertices = sampledPoints(object);
    if (isClosed(object.kind)) result.vertices.pop();
    result.kind = isClosed(object.kind) ? 'polygon' : 'line';
  }
  return result;
}

export function nearestEdge(object, point, toScreen, ringOnly = null) {
  let best = null;
  ringEntries(object).forEach(({ vertices: ring, kind }, ringIndex) => {
    if (ringOnly !== null && ringIndex !== ringOnly) return;
    for (let i = 0; i < ring.length - (isClosed(kind) ? 0 : 1); i++) {
      const a = toScreen(ring[i]), b = toScreen(ring[(i + 1) % ring.length]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      const distance = Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
      if (!best || distance < best.distance) best = { ringIndex, at: (i + t) % (isClosed(kind) ? ring.length : Infinity),
        point: ring[i].map((v, axis) => v + t * (ring[(i + 1) % ring.length][axis] - v)), distance };
    }
  });
  return best;
}

export function arc(ring, start, end, closed) {
  let stop = end.at;
  if (closed && stop <= start.at) stop += ring.length;
  const result = [start.point];
  for (let i = Math.floor(start.at) + 1; i < stop; i++) result.push(ring[i % ring.length]);
  result.push(end.point); return result;
}

export function selectedArc(object, start, end, other = false) {
  const ring = objectRings(object)[start.ringIndex], closed = isClosed(ringEntries(object)[start.ringIndex].kind);
  if (!closed) return start.at < end.at ? arc(ring, start, end, false) : arc(ring, end, start, false).reverse();
  return other ? arc(ring, end, start, true).reverse() : arc(ring, start, end, true);
}

export function shorterArcIsOther(object, start, end) {
  if (!isClosed(ringEntries(object)[start.ringIndex].kind)) return false;
  const length = points => points.reduce((sum, p, i) => i ? sum + Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) : sum, 0);
  const forward = length(selectedArc(object, start, end));
  const backward = length(selectedArc(object, start, end, true));
  // Stable tie break, also when the user reverses A and B.
  return backward < forward || (backward === forward && start.at > end.at);
}

export function replaceArc(object, start, end, path, other = false) {
  const result = structuredClone(object), ring = objectRings(result)[start.ringIndex], closed = isClosed(ringEntries(object)[start.ringIndex].kind);
  let points;
  if (closed) {
    const retained = other ? arc(ring, start, end, true) : arc(ring, end, start, true);
    const replacement = other ? [...path].reverse() : path;
    points = [...replacement, ...retained.slice(1, -1)];
  } else {
    const [a, b, replacement] = start.at < end.at ? [start, end, path] : [end, start, [...path].reverse()];
    points = [...ring.slice(0, Math.ceil(a.at)), ...replacement, ...ring.slice(Math.floor(b.at) + 1)];
  }
  points = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-8);
  if (points.length < (closed ? 3 : 2)) throw new Error('Der Ersatz lässt zu wenige Stützpunkte übrig.');
  if (closed) {
    const area = vertices => vertices.reduce((sum, p, i) => {
      const q = vertices[(i + 1) % vertices.length], origin = vertices[0];
      return sum + (p[0] - origin[0]) * (q[1] - origin[1]) - (q[0] - origin[0]) * (p[1] - origin[1]);
    }, 0);
    // Choosing the complementary arc can legitimately reverse the traversal.
    // Preserve ring winding without rejecting an otherwise valid replacement.
    if (area(points) * area(ring) < 0) points.reverse();
  }
  ring.length = 0; for (const p of points) ring.push([...p]);
  return result;
}

// Pixel centers are integer coordinates. Even/odd scan conversion preserves holes;
// each polygon is unioned into the shared mask, including islands inside holes.
export function rasterizePolygons(polygons, width, height) {
  const mask = new Uint8Array(width * height);
  for (const polygon of polygons) {
    const buckets = new Map(); let first = height, last = 0;
    for (const ring of polygon) for (let i = 0; i < ring.length; i++) {
      let a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[1] === b[1]) continue;
      if (a[1] > b[1]) [a, b] = [b, a];
      const from = Math.max(0, Math.ceil(a[1])), to = Math.min(height, Math.ceil(b[1]));
      if (from >= to) continue;
      const slope = (b[0] - a[0]) / (b[1] - a[1]);
      const edge = { to, x: a[0] + (from - a[1]) * slope, slope };
      if (!buckets.has(from)) buckets.set(from, []);
      buckets.get(from).push(edge); first = Math.min(first, from); last = Math.max(last, to);
    }
    let active = [];
    for (let y = first; y < last; y++) {
      active = active.filter(edge => edge.to > y).concat(buckets.get(y) || []);
      active.sort((a, b) => a.x - b.x);
      for (let i = 0; i + 1 < active.length; i += 2) {
        const left = Math.max(0, Math.ceil(active[i].x)), right = Math.min(width, Math.ceil(active[i + 1].x));
        if (right > left) mask.fill(1, y * width + left, y * width + right);
      }
      for (const edge of active) edge.x += edge.slope;
    }
  }
  return mask;
}
