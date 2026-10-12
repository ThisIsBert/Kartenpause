import { topologyReport } from './simplification.js';

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const at = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - at * dx, p[1] - a[1] - at * dy);
}

function fitChain(points, originals, tolerance) {
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop(), a = points[start], b = points[end];
    let maximum = 1, split = -1;
    for (let i = start + 1; i < end; i++) {
      // Fit the averaged contour, but check the actual pixel boundary as well.
      // This allows a whole diagonal stair to become one straight segment.
      const error = Math.max(segmentDistance(points[i], a, b) / (tolerance * .8),
        segmentDistance(originals[i], a, b) / tolerance);
      if (error > maximum) { maximum = error; split = i; }
    }
    if (split >= 0) { keep.add(split); stack.push([start, split], [split, end]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => points[i]);
}

// Integrate along the boundary, not over its vertices: long horizontal runs
// and densely stepped diagonals must have the same influence per pixel.
function boundary(ring) {
  const lengths = [0], integrals = [[0, 0]];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], length = distance(a, b);
    lengths.push(lengths[i] + length);
    integrals.push(a.map((v, axis) => integrals[i][axis] + (v + b[axis]) * length / 2));
  }
  const perimeter = lengths.at(-1);
  function locate(at) {
    const turns = Math.floor(at / perimeter);
    at -= turns * perimeter;
    let low = 0, high = ring.length;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (lengths[middle] <= at) low = middle; else high = middle;
    }
    return { i: low, offset: at - lengths[low], turns };
  }
  function point(at) {
    const { i, offset } = locate(at), a = ring[i], b = ring[(i + 1) % ring.length];
    const fraction = offset / (lengths[i + 1] - lengths[i]);
    return a.map((v, axis) => v + (b[axis] - v) * fraction);
  }
  function integral(at) {
    const { i, offset, turns } = locate(at), a = ring[i], b = ring[(i + 1) % ring.length];
    const fraction = offset / (lengths[i + 1] - lengths[i]);
    return a.map((v, axis) => turns * integrals.at(-1)[axis] + integrals[i][axis]
      + offset * (v + (b[axis] - v) * fraction / 2));
  }
  return { lengths, perimeter, point, integral };
}

function protectedCorners(ring, path, pixelSize) {
  const { lengths, perimeter, point } = path;
  const support = Math.min(4 * pixelSize, perimeter / 8);
  const turn = at => {
    const a = point(at - support), p = point(at), b = point(at + support);
    const u = [p[0] - a[0], p[1] - a[1]], v = [b[0] - p[0], b[1] - p[1]];
    return Math.atan2(Math.abs(u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1]);
  };
  return ring.flatMap((p, i) => {
    const previous = ring[(i + ring.length - 1) % ring.length], next = ring[(i + 1) % ring.length];
    // Long straight runs meeting at a corner are exact anchors. A pixel stair
    // has short alternating runs; use wider support to find its actual bends.
    const exact = distance(previous, p) >= 2 * pixelSize && distance(p, next) >= 2 * pixelSize;
    const at = lengths[i], angle = turn(at);
    const peak = angle > .9 && angle > turn(at - pixelSize) + 1e-6 && angle >= turn(at + pixelSize) - 1e-6;
    return exact || peak ? [i] : [];
  });
}

function reconstructRing(ring, tolerance, pixelSize) {
  const path = boundary(ring);
  // Keep tiny islands/holes intact instead of rounding them out of existence.
  const area = Math.abs(ring.reduce((sum, a, i) => {
    const b = ring[(i + 1) % ring.length], origin = ring[0];
    return sum + (a[0] - origin[0]) * (b[1] - origin[1]) - (b[0] - origin[0]) * (a[1] - origin[1]);
  }, 0)) / 2;
  if (!tolerance || path.perimeter <= 12 || area <= 16) return ring.map(p => [...p]);
  const corners = protectedCorners(ring, path, pixelSize), fixed = new Set(corners);
  const radius = tolerance * 1.2;
  const points = ring.map((p, i) => {
    if (fixed.has(i)) return [...p];
    const a = path.integral(path.lengths[i] - radius), b = path.integral(path.lengths[i] + radius);
    return a.map((v, axis) => (b[axis] - v) / (2 * radius));
  });
  // Averaging moves endpoints by at most radius/2. Every fitted segment is
  // also checked against all original vertices of its corresponding arc.
  if (!corners.length) corners.push(0);
  if (corners.length === 1) {
    let opposite = (corners[0] + 1) % ring.length;
    for (let i = 0; i < ring.length; i++) if (distance(points[i], points[corners[0]]) > distance(points[opposite], points[corners[0]])) opposite = i;
    corners.push(opposite);
  }
  corners.sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < corners.length; i++) {
    const start = corners[i], end = corners[(i + 1) % corners.length];
    const chain = start < end ? points.slice(start, end + 1) : [...points.slice(start), ...points.slice(0, end + 1)];
    const originalChain = start < end ? ring.slice(start, end + 1) : [...ring.slice(start), ...ring.slice(0, end + 1)];
    result.push(...fitChain(chain, originalChain, tolerance).slice(0, -1));
  }
  return result.length >= 3 ? result : ring.map(p => [...p]);
}

// Selection masks and their history stay pixel-exact. Only the vector preview
// and the geometry accepted by the editor use these reconstructed contours.
export function reconstructSelectionContours(polygons, tolerance = .75, pixelSize = 1) {
  if (!polygons.length) return [];
  pixelSize = Math.max(1, Number(pixelSize) || 1);
  // Intelligent selection expands a reduced working raster back to source
  // pixels. Its steps and their uncertainty scale with that working cell.
  tolerance = Math.max(0, Math.min(1, Number(tolerance) || 0)) * pixelSize;
  const originals = polygons.flat(), attempts = originals.map(() => 0);
  const rings = originals.map(ring => reconstructRing(ring, tolerance, pixelSize));
  const asObject = values => {
    let i = 0;
    return { kind: 'multiPolygon', parts: polygons.map(polygon => ({
      vertices: values[i++], holes: polygon.slice(1).map(() => values[i++])
    })) };
  };
  const original = asObject(originals);
  for (let pass = 0; pass < 12; pass++) {
    const report = topologyReport(asObject(rings), original, { allowExistingContacts: true });
    if (report.valid) break;
    let changed = false;
    for (const i of new Set(report.issues.flatMap(issue => issue.rings))) {
      if (attempts[i] >= 6) continue;
      attempts[i] = pass >= 6 ? 6 : attempts[i] + 1;
      rings[i] = reconstructRing(originals[i], attempts[i] === 6 ? 0 : tolerance / 2 ** attempts[i], pixelSize);
      changed = true;
    }
    if (!changed) return polygons.map(polygon => polygon.map(ring => ring.map(p => [...p])));
  }
  let i = 0;
  return polygons.map(polygon => polygon.map(() => rings[i++]));
}
