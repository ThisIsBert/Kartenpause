import { createRasterInverse } from '../drawing/raster-source.js';

const radians = Math.PI / 180, radius = 6378137;
const wrap = lon => ((lon + 180) % 360 + 360) % 360 - 180;

// Use the existing numerical inverse, including TPS, in continuous map metres.
export function createGeoToPixel(transform, width, height, referenceLongitude) {
  const mercator = ([lon, lat]) => [
    radius * (referenceLongitude + wrap(lon - referenceLongitude)) * radians,
    radius * Math.log(Math.tan(Math.PI / 4 + lat * radians / 2))
  ];
  const inverse = createRasterInverse(width, height, p => {
    const q = transform(p[0] / width, p[1] / height);
    return mercator([q.lon, q.lat]);
  });
  return position => {
    if (!Array.isArray(position) || position.length < 2 || !position.slice(0, 2).every(Number.isFinite) || Math.abs(position[0]) > 180 || Math.abs(position[1]) > 90) throw new Error('Invalid WGS84 reference position.');
    if (Math.abs(position[1]) > 85.05112878) return null;
    return inverse(mercator(position));
  };
}

export function referencePaths(geojson, inverse) {
  const paths = [], markers = [];
  let mappedSamples = 0, unmappedSamples = 0;
  const project = p => { const q = inverse(p); if (q) mappedSamples++; else unmappedSamples++; return q; };
  function line(coordinates) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error('Reference line needs at least two positions.');
    let path = [];
    const append = p => {
      const q = project(p);
      if (q) path.push(q);
      else { if (path.length > 1) paths.push(path); path = []; }
    };
    for (let i = 1; i < coordinates.length; i++) {
      const a = coordinates[i - 1], b = coordinates[i];
      if ([a, b].some(p => !Array.isArray(p) || p.length < 2 || !p.slice(0, 2).every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) throw new Error('Invalid reference line coordinates.');
      const dlon = wrap(b[0] - a[0]);
      // Sparse lines can cross the image with both endpoints outside it.
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dlon), Math.abs(b[1] - a[1])) / .25));
      for (let j = 0; j < steps; j++) append([wrap(a[0] + dlon * j / steps), a[1] + (b[1] - a[1]) * j / steps]);
    }
    append(coordinates.at(-1));
    if (path.length > 1) paths.push(path);
  }
  function geometry(g) {
    if (!g) return;
    switch (g.type) {
      case 'Point': { const pixel = project(g.coordinates); if (pixel) markers.push({ id: markers.length + 1, pixel }); break; }
      case 'MultiPoint': g.coordinates.forEach(p => geometry({ type: 'Point', coordinates: p })); break;
      case 'LineString': line(g.coordinates); break;
      case 'MultiLineString': case 'Polygon': g.coordinates.forEach(line); break;
      case 'MultiPolygon': g.coordinates.forEach(p => p.forEach(line)); break;
      case 'GeometryCollection': g.geometries.forEach(geometry); break;
      default: throw new Error('Unsupported reference geometry.');
    }
  }
  if (geojson?.type === 'FeatureCollection') geojson.features.forEach(f => geometry(f.geometry));
  else if (geojson?.type === 'Feature') geometry(geojson.geometry);
  else geometry(geojson);
  return { paths, markers, mappedSamples, unmappedSamples };
}
