import { isClosed, objectRings, polygonParts } from './geometry.js';
import { simplify } from './simplify-path.js';

export const vertexCount = object => objectRings(object).reduce((sum, ring) => sum + ring.length, 0);
const area = ring => ring.reduce((sum, a, i) => {
  const b = ring[(i + 1) % ring.length], o = ring[0];
  return sum + (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}, 0);
export function geometryCounts(object) {
  const parts = isClosed(object.kind) ? polygonParts(object) : [];
  return { parts: parts.length, holes: parts.reduce((sum, p) => sum + (p.holes?.length || 0), 0) };
}
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
function validRings(rings, originals, originalNesting, issues = [], local = false) {
  const edgeKey = (a, b) => JSON.stringify([a, b]);
  // Only unchanged, pre-existing contacts may remain during simplification.
  // A new edge never gets this exemption; section replacement stays strict.
  const oldEdges = local ? originals.map(ring => new Set(ring.map((a, i) => edgeKey(a, ring[(i + 1) % ring.length])))) : null;
  const segments = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (ring.length < 3 || area(ring) * area(originals[r]) <= 0) {
      issues.push({ point: ring[0], rings: [r], reason: 'Entarteter Rand' });
      if (!local) return false;
    }
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
        if (local && oldEdges[a.r].has(edgeKey(a.a, a.b)) && oldEdges[b.r].has(edgeKey(b.a, b.b))) return false;
        const dx = a.b[0] - a.a[0], dy = a.b[1] - a.a[1];
        const ex = b.b[0] - b.a[0], ey = b.b[1] - b.a[1], denominator = dx * ey - dy * ex;
        const t = denominator ? ((b.a[0] - a.a[0]) * ey - (b.a[1] - a.a[1]) * ex) / denominator : 0;
        const point = denominator ? [a.a[0] + t * dx, a.a[1] + t * dy] : [(Math.max(a.minX, b.minX) + Math.min(a.maxX, b.maxX)) / 2, (Math.max(a.minY, b.minY) + Math.min(a.maxY, b.maxY)) / 2];
        issues.push({ point, rings: [a.r, b.r], reason: 'Kreuzung oder doppelt durchlaufener Rand' });
      }
      return intersects;
    }) && !local) return false;
  }
  const next = nesting(rings);
  const valid = next.size === originalNesting.size && [...next].every(pair => originalNesting.has(pair));
  if (!valid) {
    for (const pair of new Set([...next, ...originalNesting])) if (next.has(pair) !== originalNesting.has(pair)) {
      const indices = pair.split(':').map(Number);
      issues.push({ point: rings[indices[0]][0], rings: indices, reason: 'Veränderte Zuordnung von Loch oder Teilfläche' });
      if (!local) break;
    }
  }
  return valid && !issues.length;
}

export function topologyReport(object, original = object) {
  if (object.kind === 'collection') {
    const reports = object.parts.map((part, i) => topologyReport(part, original.parts[i]));
    return { valid: reports.every(r => r.valid), issues: reports.flatMap(r => r.issues) };
  }
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
    // Strong simplification must not turn a narrow ring into two points and
    // then restore thousands of original vertices. Reduce only its tolerance.
    for (let attempt = 0; attempt < 40; attempt++) {
      reduced = [...simplify(points.slice(0, opposite + 1), tolerance).slice(0, -1),
        ...simplify([...points.slice(opposite), points[0]], tolerance).slice(0, -1)];
      if (reduced.length >= 3) break;
      tolerance /= 2;
    }
    if (reduced.length < 3) return points.map(p => [...p]);
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
  if (['collection', 'multiLine', 'multiPoint'].includes(original.kind)) return { ...structuredClone(original), parts: original.parts.map(part => simplifyObject(part, amount)) };
  const strength = Math.max(0, Math.min(100, Number(amount) || 0)) / 100;
  const clone = () => structuredClone(original);
  if (!strength || original.kind === 'point') return clone();
  const result = clone(), closed = isClosed(original.kind);
  const allPoints = objectRings(original).flat();
  const box = bounds(allPoints.map(([x, y]) => ({ minX: x, maxX: x, minY: y, maxY: y })));
  const tolerance = Math.hypot(box.maxX - box.minX, box.maxY - box.minY) * (.02 * strength ** 2 + .18 * strength ** 4);
  if (closed) {
    const parts = polygonParts(result);
    const sizes = parts.map(p => Math.max(0, (Math.abs(area(p.vertices)) - (p.holes || []).reduce((sum, r) => sum + Math.abs(area(r)), 0)) / 2));
    const threshold = sizes.reduce((sum, a) => sum + a, 0) * .001 * strength ** 4;
    const largest = sizes.indexOf(Math.max(...sizes));
    const retained = parts.filter((p, i) => i === largest || sizes[i] >= threshold);
    if (result.kind === 'multiPolygon') result.parts = retained;
    for (const part of retained) if (part.holes) part.holes = part.holes.filter(r => Math.abs(area(r)) / 2 >= threshold);
  }
  // Intentional island/hole removal defines the new baseline. Geometry checks
  // below protect the remaining rings, not the discarded specks and holes.
  const originals = objectRings(result).map(r => r.map(p => [...p]));
  const originalNesting = closed ? nesting(originals) : null;
  const rings = objectRings(result), attempts = originals.map(() => 0);
  const recalculate = i => {
    const n = attempts[i];
    const reduced = n >= 12 ? originals[i] : simplifyRing(originals[i], tolerance / 2 ** n, closed, strength / 2 ** n);
    rings[i].splice(0, rings[i].length);
    for (const point of reduced) rings[i].push([...point]);
  };
  originals.forEach((_, i) => recalculate(i));
  if (!closed) return result;
  // Each conflict backs off only its participating rings. Other islands keep
  // their successful reduction. The bound guarantees termination for bad input.
  for (let pass = 0; pass < 24; pass++) {
    const issues = [];
    if (validRings(rings, originals, originalNesting, issues, true)) return result;
    const affected = new Set(issues.flatMap(issue => issue.rings));
    let changed = false;
    for (const i of affected) if (attempts[i] < 12) {
      attempts[i] = pass >= 12 ? 12 : attempts[i] + 1;
      recalculate(i); changed = true;
    }
    if (!changed) break;
  }
  // Unexpected invalid input: keep intentional cleanup, but do not export a
  // contour change we could not validate.
  rings.forEach((ring, i) => { ring.length = 0; for (const p of originals[i]) ring.push([...p]); });
  return result;
}
