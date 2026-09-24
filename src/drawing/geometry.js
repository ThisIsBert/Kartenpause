// Coordinates are stored in Leaflet's projected plane. Curves therefore retain
// their shape at every zoom level; GeoJSON is always exported in WGS84 lon/lat.
export const isClosed = kind => kind === 'polygon' || kind === 'curvePolygon';
export const isCurved = kind => kind === 'curve' || kind === 'curvePolygon';
export const minimumPoints = kind => kind === 'point' ? 1 : isClosed(kind) ? 3 : 2;

export function segmentPoint(vertices, index, t, curved, closed) {
  const n = vertices.length;
  const at = i => vertices[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  const a = at(index), b = at(index + 1);
  if (!curved || n < 3) return a.map((v, axis) => v + (b[axis] - v) * t);
  const before = at(index - 1), after = at(index + 2);
  // Uniform Catmull–Rom: the curve passes through every editable vertex.
  return a.map((v, axis) => .5 * (2 * v + (-before[axis] + b[axis]) * t
    + (2 * before[axis] - 5 * v + 4 * b[axis] - after[axis]) * t * t
    + (-before[axis] + 3 * v - 3 * b[axis] + after[axis]) * t * t * t));
}

export function sampledPoints(object) {
  const { vertices, kind } = object;
  if (kind === 'point' || vertices.length < 2) return vertices;
  const closed = isClosed(kind), curved = isCurved(kind), result = [];
  const segments = vertices.length - (closed ? 0 : 1);
  for (let i = 0; i < segments; i++) {
    const steps = curved ? 32 : 1;
    for (let step = 0; step < steps; step++) result.push(segmentPoint(vertices, i, step / steps, curved, closed));
  }
  result.push(closed ? [...result[0]] : [...vertices.at(-1)]);
  return result;
}

export function toFeature(object, toLonLat) {
  let coordinates = sampledPoints(object).map(toLonLat);
  const type = object.kind === 'point' ? 'Point' : isClosed(object.kind) ? 'Polygon' : 'LineString';
  if (type === 'Point') coordinates = coordinates[0];
  if (type === 'Polygon') {
    // RFC 7946 exterior rings use counterclockwise winding.
    const area = coordinates.slice(0, -1).reduce((sum, p, i) => {
      const q = coordinates[i + 1]; return sum + p[0] * q[1] - q[0] * p[1];
    }, 0);
    if (area < 0) coordinates.reverse();
    coordinates = [coordinates];
  }
  return { type: 'Feature', id: object.id, properties: { name: object.name,
    drawingTool: object.kind, controlPoints: object.vertices.map(toLonLat),
    ...(isCurved(object.kind) ? { interpolation: 'catmull-rom', samplesPerSegment: 32 } : {})
  }, geometry: { type, coordinates } };
}
