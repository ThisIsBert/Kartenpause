import { isClosed, objectRings } from './geometry.js';
import { simplify } from './trace.js';

export const vertexCount = object => objectRings(object).reduce((sum, ring) => sum + ring.length, 0);
const area = ring => ring.reduce((sum, a, i) => {
  const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - a[1] * b[0];
}, 0);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const inside = (p, ring) => {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
};

const overlaps = (a, b) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
function bounds(items) {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const item of items) {
    box.minX = Math.min(box.minX, item.minX); box.minY = Math.min(box.minY, item.minY);
    box.maxX = Math.max(box.maxX, item.maxX); box.maxY = Math.max(box.maxY, item.maxY);
  }
  return box;
}
function spatialIndex(items) {
  const box = bounds(items);
  if (items.length <= 8) return { ...box, items };
  const x = box.maxX - box.minX >= box.maxY - box.minY;
  items.sort((a, b) => x ? (a.minX + a.maxX) - (b.minX + b.maxX) : (a.minY + a.maxY) - (b.minY + b.maxY));
  const half = Math.floor(items.length / 2);
  return { ...box, left: spatialIndex(items.slice(0, half)), right: spatialIndex(items.slice(half)) };
}
function someOverlap(node, box, test) {
  if (!overlaps(node, box)) return false;
  if (node.items) return node.items.some(item => overlaps(item, box) && test(item));
  return someOverlap(node.left, box, test) || someOverlap(node.right, box, test);
}
function nesting(rings) {
  const boxes = rings.map((ring, i) => ({ ...bounds(ring.map(([x, y]) => ({ minX: x, maxX: x, minY: y, maxY: y }))), i }));
  const tree = spatialIndex(boxes), result = new Set();
  rings.forEach((ring, i) => {
    const [x, y] = ring[0];
    someOverlap(tree, { minX: x, maxX: x, minY: y, maxY: y }, box => {
      if (box.i !== i && inside(ring[0], rings[box.i])) result.add(`${i}:${box.i}`);
      return false;
    });
  });
  return result;
}

// A 2D index avoids all-pairs checks on long vertical pixel outlines.
function validRings(rings, originals, originalNesting, issues = []) {
  const segments = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (ring.length < 3 || area(ring) * area(originals[r]) <= 0) { issues.push({ point: ring[0], reason: 'Entarteter Rand' }); return false; }
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      segments.push({ a, b, r, i, id: segments.length, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) });
    });
  }
  const tree = spatialIndex([...segments]);
  for (const a of segments) {
    if (someOverlap(tree, a, b => {
      if (b.id <= a.id) return false;
      if (a.r === b.r && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === rings[a.r].length - 1)) return false;
      const intersects = cross(a.a, a.b, b.a) * cross(a.a, a.b, b.b) <= 0 && cross(b.a, b.b, a.a) * cross(b.a, b.b, a.b) <= 0;
      if (intersects) {
        const dx = a.b[0] - a.a[0], dy = a.b[1] - a.a[1];
        const ex = b.b[0] - b.a[0], ey = b.b[1] - b.a[1], denominator = dx * ey - dy * ex;
        const t = denominator ? ((b.a[0] - a.a[0]) * ey - (b.a[1] - a.a[1]) * ex) / denominator : 0;
        const point = denominator ? [a.a[0] + t * dx, a.a[1] + t * dy] : [(Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2, (Math.max(a.minY, b.minY) + Math.min(a.maxY, b.maxY)) / 2];
        issues.push({ point, reason: 'Kreuzung oder doppelt durchlaufener Rand' });
      }
      return intersects;
    })) return false;
  }
  const next = nesting(rings);
  const valid = next.size === originalNesting.size && [...next].every(pair => originalNesting.has(pair));
  if (!valid) {
    const pair = [...next, ...originalNesting].find(pair => next.has(pair) !== originalNesting.has(pair));
    issues.push({ point: rings[Number(pair.split(':')[0])][0], reason: 'Veränderte Zuordnung von Loch oder Teilfläche' });
  }
  return valid;
}

export function topologyReport(object, original = object) {
  const issues = [];
  const valid = !isClosed(object.kind) || validRings(objectRings(object), objectRings(original), nesting(objectRings(original)), issues);
  return { valid, issues };
}

export function hasValidTopology(object, original = object) {
  if (!isClosed(object.kind)) return true;
  const rings = objectRings(object), originals = objectRings(original);
  return validRings(rings, originals, nesting(originals));
}

function simplifyRing(points, tolerance, closed, strength) {
  let reduced;
  if (closed) {
    // Split a ring into two open chains; a duplicated start alone degenerates RDP.
    let opposite = 1, distance = 0;
    points.forEach((p, i) => {
      const d = Math.hypot(p[0] - points[0][0], p[1] - points[0][1]);
      if (d > distance) { distance = d; opposite = i; }
    });
    reduced = [...simplify(points.slice(0, opposite + 1), tolerance).slice(0, -1),
      ...simplify([...points.slice(opposite), points[0]], tolerance).slice(0, -1)];
    if (reduced.length < 3) reduced = points;
  } else reduced = simplify(points, tolerance);
  return reduced.map((p, i) => {
    if (!closed && (i === 0 || i === reduced.length - 1)) return [...p];
    const a = reduced[(i + reduced.length - 1) % reduced.length], b = reduced[(i + 1) % reduced.length];
    const dx = (a[0] + b[0]) / 2 - p[0], dy = (a[1] + b[1]) / 2 - p[1];
    const factor = Math.min(.25 * strength, tolerance * .5 / (Math.hypot(dx, dy) || 1));
    return [p[0] + dx * factor, p[1] + dy * factor];
  });
}

export function simplifyObject(original, amount) {
  const strength = Math.max(0, Math.min(100, Number(amount) || 0)) / 100;
  const clone = () => structuredClone(original);
  if (!strength || original.kind === 'point') return clone();
  const originals = objectRings(original), closed = isClosed(original.kind);
  const originalNesting = closed ? nesting(originals) : null;
  const tolerances = originals.map(ring => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    return Math.hypot(maxX - minX, maxY - minY) * .02 * strength * strength;
  });
  for (let attempt = 0; attempt < 7; attempt++) {
    const result = clone(), rings = objectRings(result);
    rings.forEach((ring, i) => {
      const reduced = simplifyRing(originals[i], tolerances[i] / 2 ** attempt, closed, strength / 2 ** attempt);
      ring.length = 0;
      for (const point of reduced) ring.push(point);
    });
    if (!closed || validRings(rings, originals, originalNesting)) return result;
  }
  // If a touching/invalid original cannot safely be simplified, leave it intact.
  return clone();
}
