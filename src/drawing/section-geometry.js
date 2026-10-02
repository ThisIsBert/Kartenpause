import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import RobustLineIntersector from 'jsts/org/locationtech/jts/algorithm/RobustLineIntersector.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import PointLocation from 'jsts/org/locationtech/jts/algorithm/PointLocation.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import { isClosed, objectRings, polygonParts } from './geometry.js';
import { removeSpurs } from './path-cleanup.js';

const reader = new GeoJSONReader(), writer = new GeoJSONWriter();
const coordinate = p => new Coordinate(p[0], p[1]);
const closed = ring => [...ring, ring[0]];
const asGeometry = object => reader.read({ type: 'MultiPolygon', coordinates: polygonParts(object).map(p => [p.vertices, ...(p.holes || [])].map(closed)) });
const numericTolerance = points => points.reduce((max, p) => Math.max(max, Math.abs(p[0]), Math.abs(p[1])), 1) * Number.EPSILON * 64;

// This tolerance covers floating-point roundoff only. It is independent of
// zoom and output scale and never simplifies meaningful bends or small loops.
export function cleanSectionPath(points, closedRing = false) {
  if (!points.length) return [];
  const epsilon = numericTolerance(points);
  if (!closedRing) return removeSpurs(points, epsilon);
  const result = removeSpurs([...points, points[0]], epsilon, true);
  if (result.length > 1 && Math.hypot(result[0][0] - result.at(-1)[0], result[0][1] - result.at(-1)[1]) <= epsilon) result.pop();
  const first = result.findIndex(p => p[0] === points[0][0] && p[1] === points[0][1]);
  return first > 0 ? [...result.slice(first), ...result.slice(0, first)] : result;
}

// Report the actual two edges, not only an unexplained red dot. Robust JTS
// predicates also distinguish proper crossings, overlaps and point contacts.
export function sectionIntersections(object, limit = 32) {
  const tree = new STRtree(), segments = [], issues = [], li = new RobustLineIntersector();
  objectRings(object).forEach((ring, r) => ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length], ca = coordinate(a), cb = coordinate(b);
    if (ca.equals2D(cb)) return;
    const item = { a, b, ca, cb, r, i, n: ring.length, id: segments.length, box: new Envelope(ca, cb) };
    segments.push(item); tree.insert(item.box, item);
  }));
  for (const a of segments) {
    for (const b of tree.query(a.box).toArray()) {
      if (b.id <= a.id) continue;
      li.computeIntersection(a.ca, a.cb, b.ca, b.cb);
      if (!li.hasIntersection()) continue;
      const adjacent = a.r === b.r && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === a.n - 1);
      if (adjacent && li.getIntersectionNum() === 1) continue;
      const p = li.getIntersection(0), type = li.isProper() ? 'crossing' : li.getIntersectionNum() > 1 ? 'overlap' : 'touch';
      issues.push({ point: [p.x, p.y], type, rings: [a.r, b.r], segments: [[a.a, a.b], [b.a, b.b]],
        reason: type === 'crossing' ? 'Kreuzung zweier Randabschnitte' : type === 'overlap' ? 'Doppelt durchlaufener Rand' : 'Berührung zweier Randabschnitte' });
      if (issues.length >= limit) return issues;
    }
  }
  return issues;
}

function polygonized(object) {
  const parts = polygonParts(object).map(p => [p.vertices, ...(p.holes || [])]);
  const rings = parts.flat();
  const linework = reader.read({ type: 'MultiLineString', coordinates: rings.map(closed) });
  const polygonizer = new Polygonizer();
  polygonizer.add(UnaryUnionOp.union(linework));
  const input = parts.map(rings => rings.map(ring => closed(ring).map(coordinate)));
  const faces = polygonizer.getPolygons().toArray().filter(face => {
    const p = InteriorPointArea.getInteriorPoint(face);
    // Same even/odd fill as the display, unioned across polygon parts.
    return input.some(rings => rings.reduce((parity, ring) => parity !== PointLocation.isInRing(p, ring), false));
  });
  if (!faces.length) return null;
  const result = UnaryUnionOp.union(faces[0].getFactory().createGeometryCollection(faces));
  if (!new IsValidOp(result).isValid()) return null;
  const geo = writer.write(result);
  const polygons = geo.type === 'Polygon' ? [geo.coordinates] : geo.coordinates;
  if (!polygons?.length || !['Polygon', 'MultiPolygon'].includes(geo.type)) return null;
  const next = { ...object }; delete next.parts; delete next.vertices; delete next.holes;
  const converted = polygons.map(rings => ({ vertices: rings[0].slice(0, -1), holes: rings.slice(1).map(r => r.slice(0, -1)) }));
  return converted.length === 1 ? { ...next, kind: 'polygon', ...converted[0] } : { ...next, kind: 'multiPolygon', parts: converted };
}

export function prepareSection(result) {
  const cleaned = structuredClone(result);
  if (result.kind === 'collection') {
    const reports = result.parts.map(prepareSection);
    cleaned.parts = reports.map(r => r.result);
    return { result: cleaned, valid: reports.every(r => r.valid), issues: reports.flatMap(r => r.issues),
      cleaned: reports.some(r => r.cleaned),
      normalized: reports.every(r => r.valid || r.normalized) ? { ...cleaned, parts: reports.map(r => r.normalized || r.result) } : null };
  }
  for (const ring of objectRings(cleaned)) {
    const points = cleanSectionPath(ring, isClosed(cleaned.kind));
    ring.length = 0; for (const p of points) ring.push(p);
  }
  const changed = JSON.stringify(objectRings(cleaned)) !== JSON.stringify(objectRings(result));
  if (!isClosed(cleaned.kind)) return { valid: true, result: cleaned, issues: [], cleaned: changed };
  if (objectRings(cleaned).some(r => r.length < 3)) return { valid: false, result: cleaned, issues: [{ point: objectRings(result)[0][0], reason: 'Dieser Rand schließt keine Fläche mehr ein.' }], cleaned: changed };
  const validation = new IsValidOp(asGeometry(cleaned));
  if (validation.isValid()) return { valid: true, result: cleaned, issues: [], cleaned: changed };
  const issues = sectionIntersections(cleaned);
  if (!issues.length) {
    const error = validation.getValidationError(), p = error.getCoordinate();
    issues.push({ point: p ? [p.x, p.y] : null, reason: 'Unklare Zuordnung von Loch oder Teilfläche' });
  }
  let normalized = null;
  try { normalized = polygonized(cleaned); } catch { /* Keep the editable input even if reconstruction fails. */ }
  // True loops remain reviewable: never guess which enclosed area to discard.
  return { valid: false, result: cleaned, normalized, issues, cleaned: changed };
}
