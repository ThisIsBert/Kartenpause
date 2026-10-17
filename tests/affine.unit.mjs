import { test } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { fitAffine, validateAffine } from '../src/geo/raster-affine.js';
import { GeoFit } from '../src/geo/geo-fit.js';
import { fitGeoreference, projectTransform, validatePoints } from '../src/headless/georeference.js';
import { createGeoToPixel } from '../src/headless/overlay.js';

const width = 600, height = 400;
const pixels = [[30, 30], [550, 35], [35, 365], [560, 360], [180, 120], [410, 150], [160, 290], [420, 280]];
const projection = proj4('EPSG:3857', 'EPSG:4326');
const center = projection.inverse([-85, 35]);
function truth(pixel, angle = .2, stretch = 1.2, shear = .2) {
  const x = (pixel[0] - width / 2) * 1100 * stretch + (pixel[1] - height / 2) * 1100 * shear;
  const y = (height / 2 - pixel[1]) * 1100;
  const ll = projection.forward([center[0] + Math.cos(angle) * x - Math.sin(angle) * y, center[1] + Math.sin(angle) * x + Math.cos(angle) * y]);
  return { lon: ll[0], lat: ll[1] };
}
const anchors = (angle, stretch, shear) => pixels.map((pixel, i) => ({ id: i + 1, pixel, target: truth(pixel, angle, stretch, shear) }));
const options = { codes: ['EPSG:3857'], families: [], tps: 'never' };

test('cross-validation selects affine raster geometry for independent stretching and shear, without consulting controls', async () => {
  const points = anchors(.2, 1.2, .2);
  const a = await fitGeoreference(points, width, height, options);
  const b = await fitGeoreference([...points, { id: 99, pixel: [350, 170], target: { lon: 30, lat: -40 }, fit: false }], width, height, options);
  const similarity = await fitGeoreference(points, width, height, { ...options, alignment: 'similarity' });
  assert.equal(a.report.validation.geometry, 'affine');
  assert.equal(a.project.version, 4);
  assert.deepEqual(a.project.alignment, b.project.alignment);
  assert.ok(a.report.validation.rms < 1e-5);
  assert.ok(similarity.report.validation.rms > 10000);
  const restored = projectTransform(JSON.parse(JSON.stringify(a.project)), width, height);
  const inverse = createGeoToPixel(restored, width, height, -85);
  for (const pixel of [[0, 0], [600, 400], [599, 399], [137, 228], [300, 200]]) {
    const actual = restored(pixel[0] / width, pixel[1] / height);
    assert.ok(GeoFit.distance(actual, truth(pixel)) < 1e-5);
    const back = inverse([actual.lon, actual.lat]);
    if (pixel[0] < width && pixel[1] < height) assert.ok(back && Math.hypot(back[0] - pixel[0], back[1] - pixel[1]) < .03);
    else assert.equal(back, null, 'raster inverse is bounded to actual pixel centers');
  }
  assert.ok(a.report.basePixelRms < 1e-8);
});

test('affine fit recovers multiple independently rotated and stretched rasters at unseen pixels', async () => {
  for (const [angle, stretch, shear] of [[-.6, .7, -.3], [1.8, 1.4, .5], [3.05, 1.6, -.7], [0, .6, .25]]) {
    const fit = await fitGeoreference(anchors(angle, stretch, shear), width, height, options);
    const restored = projectTransform(fit.project, width, height);
    for (const pixel of [[42, 270], [580, 180], [311, 76]]) assert.ok(GeoFit.distance(restored(pixel[0] / width, pixel[1] / height), truth(pixel, angle, stretch, shear)) < 1e-5);
  }
});

test('affine plus TPS persists and reproduces a nonlinear correction without losing the base matrix', async () => {
  const points = anchors(.4, .8, .3).map(p => ({ ...p, target: { ...p.target, lon: p.target.lon + .03 * ((p.pixel[0] - 300) / 300) ** 2 } }));
  const fitted = await fitGeoreference(points, width, height, { ...options, alignment: 'affine', tps: 'always' });
  assert.equal(fitted.project.version, 4);
  assert.equal(fitted.project.alignment.method, 'projection+tps');
  assert.equal(fitted.report.validation.refitsTPS, true);
  const restored = projectTransform(JSON.parse(JSON.stringify(fitted.project)), width, height);
  for (const pixel of [[300, 200], [100, 200], [500, 80]]) assert.ok(GeoFit.distance(restored(pixel[0] / width, pixel[1] / height), fitted.transform(pixel[0] / width, pixel[1] / height)) < 1e-5);
  assert.ok(fitted.report.fit.rms < 1);
});

test('affine geometry rejects collinear anchors, reflections, singular matrices and unsupported project versions', async () => {
  for (const matrix of [null, [1, 0, 0, 0], [1, 2, 2, 4], [-1, 0, 0, 1], [1, NaN, 0, 1], [1, 0, 0, 1e-12]]) assert.throws(() => validateAffine(matrix));
  const points = validatePoints(anchors().map((p, i) => ({ ...p, pixel: [20 + 60 * i, 100] })), width, height);
  assert.throws(() => fitAffine(points, 'EPSG:3857', width, height), /collinear/);
  const fitted = await fitGeoreference(anchors(), width, height, options);
  assert.throws(() => projectTransform({ ...fitted.project, version: 3 }, width, height), /version 4/);
  assert.throws(() => projectTransform({ ...fitted.project, alignment: { ...fitted.project.alignment, affine: [1, 1, 1, 1] } }, width, height));
  await assert.rejects(() => fitGeoreference(anchors(), width, height, { ...options, alignment: 'unknown' }), /alignment/);
});
