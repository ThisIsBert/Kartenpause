import { createSelectionProcessor } from '../drawing/selection-operation.js';
import { cropSearch, findMagneticPath } from '../drawing/magnetic-path.js';

export function vectorize(raster, transform, requests) {
  if (!Array.isArray(requests)) throw new Error('objects must be an array.');
  const width = raster.sourceWidth ?? raster.width, height = raster.sourceHeight ?? raster.height;
  const offset = raster.offset ?? [0, 0];
  const pixel = p => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[0] < 0 || p[0] >= width || p[1] < 0 || p[1] >= height) throw new Error('Pixel coordinate outside image.');
    return p;
  };
  const localPixel = p => {
    const local = pixel(p).map((v, k) => v - offset[k]);
    if (local[0] < 0 || local[0] >= raster.width || local[1] < 0 || local[1] >= raster.height) throw new Error('Pixel outside requested raster crop.');
    return local;
  };
  const position = p => { const q = transform(p[0] / width, p[1] / height); return [q.lon, q.lat]; };
  const line = (points, closed = false, checkBounds = true) => {
    const input = checkBounds ? points.map(pixel) : points.map(p => p.slice());
    if (input.length < (closed ? 3 : 2)) throw new Error('Insufficient geometry vertices.');
    if (closed && input[0].some((v, k) => v !== input.at(-1)[k])) input.push(input[0]);
    const dense = [];
    for (let i = 1; i < input.length; i++) {
      const a = input[i - 1], b = input[i], steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
      for (let j = 0; j < steps; j++) dense.push(position(a.map((v, k) => v + (b[k] - v) * j / steps)));
    }
    dense.push(position(input.at(-1)));
    return dense;
  };
  const polygon = rings => rings.map((ring, i) => {
    let area = 0, longitude = ring[0][0];
    for (let j = 1; j < ring.length; j++) {
      const nextLongitude = longitude + ((ring[j][0] - longitude + 540) % 360) - 180;
      area += longitude * ring[j][1] - nextLongitude * ring[j - 1][1];
      longitude = nextLongitude;
    }
    return (area > 0) === (i === 0) ? ring : ring.slice().reverse();
  });
  const geometry = g => {
    switch (g?.type) {
      case 'Point': return { type: g.type, coordinates: position(pixel(g.coordinates)) };
      case 'MultiPoint': return { type: g.type, coordinates: g.coordinates.map(p => position(pixel(p))) };
      case 'LineString': return { type: g.type, coordinates: line(g.coordinates) };
      case 'MultiLineString': return { type: g.type, coordinates: g.coordinates.map(p => line(p)) };
      case 'Polygon': return { type: g.type, coordinates: polygon(g.coordinates.map(p => line(p, true))) };
      case 'MultiPolygon': return { type: g.type, coordinates: g.coordinates.map(p => polygon(p.map(r => line(r, true)))) };
      default: throw new Error('Unsupported pixel geometry type.');
    }
  };
  return { type: 'FeatureCollection', features: requests.map((request, i) => {
    let result;
    if (request.mode === 'region') {
      const processor = createSelectionProcessor(raster);
      let state = { mask: new Uint8Array(raster.width * raster.height) };
      if (!Array.isArray(request.seeds) || !request.seeds.length) throw new Error('Region requires seeds.');
      const tolerance = request.tolerance ?? 18;
      if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 150) throw new Error('Invalid color tolerance.');
      if (!['classic', 'intelligent'].includes(request.algorithm ?? 'intelligent')) throw new Error('Unknown region algorithm.');
      request.seeds.forEach((seed, index) => {
        state = processor({ ...state, type: 'select', seed: localPixel(seed), tolerance, algorithm: request.algorithm ?? 'intelligent', mode: index ? 'add' : 'replace', contiguous: request.contiguous ?? true });
      });
      if (!state.count) throw new Error('Empty region.');
      // Selection contours can lie half a pixel outside the image; these are
      // real raster edges, not invalid user-supplied vertices.
      const rings = state.contours.map(p => polygon(p.map(r => line(r.map(p => p.map((v, k) => v + offset[k])), true, false))));
      result = { type: 'MultiPolygon', coordinates: rings };
    } else if (request.mode === 'magnetic') {
      const anchors = request.anchors.map(localPixel), pixels = [];
      const radius = request.radius ?? 32;
      if (anchors.length < 2 || !Number.isFinite(radius) || radius <= 0) throw new Error('Invalid magnetic anchors or radius.');
      for (let j = 1; j < anchors.length; j++) {
        const crop = cropSearch(raster, anchors[j - 1], anchors[j], radius);
        const path = findMagneticPath({ ...crop, radius, color: request.color, color2: request.color2, tolerance: request.tolerance ?? 50 });
        pixels.push(...path.pixels.slice(j > 1 ? 1 : 0).map(p => p.map((v, k) => v + crop.offset[k] + offset[k])));
      }
      result = geometry({ type: 'LineString', coordinates: pixels });
    } else if (request.mode === undefined || request.mode === 'geometry') result = geometry(request.geometry);
    else throw new Error('Unknown vectorization mode.');
    return { type: 'Feature', id: request.id ?? i + 1, properties: { ...request.properties, name: request.name ?? request.properties?.name ?? '', source: 'kartenpause-headless', extraction: request.mode ?? 'geometry' }, geometry: result };
  }) };
}
