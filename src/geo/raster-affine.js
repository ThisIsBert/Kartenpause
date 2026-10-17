import proj4 from 'proj4';
import { GeoFit } from './geo-fit.js';

// Matrix maps centered normalized raster coordinates [u-.5, .5-v] to the
// projected CRS. Independent scale and shear model stretching of the raster.
export function validateAffine(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 4 || !matrix.every(Number.isFinite)) throw new Error('Four finite affine matrix coefficients required.');
  const [a, b, c, d] = matrix, norm = Math.max(...matrix.map(Math.abs));
  if (!norm || (a / norm) * (d / norm) - (b / norm) * (c / norm) <= 1e-8) throw new Error('Affine matrix is singular, ill-conditioned or reflects the raster.');
  return matrix;
}

export function fitAffine(points, definition, width, height) {
  const fit = points.filter(p => p.fit);
  if (fit.length < 3) throw new Error('At least three fit anchors required for affine alignment.');
  const projection = proj4('EPSG:4326', definition);
  const source = fit.map(p => [p.source.u - .5, .5 - p.source.v]);
  const targets = fit.map(p => {
    const q = projection.forward([p.target.lon, p.target.lat]);
    const ll = projection.inverse(q);
    if (!q.every(Number.isFinite) || !ll.every(Number.isFinite) || GeoFit.distance(p.target, { lon: ll[0], lat: ll[1] }) > 2) throw new Error('Affine target outside reliable projection domain.');
    return q;
  });
  const mean = rows => [0, 1].map(k => rows.reduce((sum, p) => sum + p[k], 0) / rows.length);
  const sm = mean(source), tm = mean(targets);
  let xx = 0, xy = 0, yy = 0;
  const cross = [[0, 0], [0, 0]];
  source.forEach((p, i) => {
    const x = p[0] - sm[0], y = p[1] - sm[1];
    xx += x * x; xy += x * y; yy += y * y;
    for (let k = 0; k < 2; k++) { cross[k][0] += (targets[i][k] - tm[k]) * x; cross[k][1] += (targets[i][k] - tm[k]) * y; }
  });
  const determinant = xx * yy - xy * xy;
  if (!Number.isFinite(determinant) || determinant <= 1e-8 * (xx + yy) ** 2) throw new Error('Affine fit anchors are collinear or coincident.');
  const matrix = validateAffine(cross.flatMap(([x, y]) => [(x * yy - y * xy) / determinant, (y * xx - x * xy) / determinant]));
  const [a, b, c, d] = matrix;
  const g = { cx: tm[0] - a * sm[0] - b * sm[1], cy: tm[1] - c * sm[0] - d * sm[1], hw: Math.hypot(a, c) / 2, hh: Math.hypot(b, d) / 2, rot: Math.atan2(c, a), affine: matrix };
  return { code: definition, definition, geometry: 'affine', g, ...GeoFit.evaluate(points, g, definition, width, height) };
}
