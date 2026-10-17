import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import proj4 from 'proj4';
import { fitGeoreference, validatePoints, projectTransform, evaluate } from '../src/headless/georeference.js';
import { vectorize } from '../src/headless/vectorize.js';
import { createGeoToPixel, referencePaths } from '../src/headless/overlay.js';
import { loadImage, previewImage } from '../src/headless/image.js';

const width = 100, height = 100;
const target = (x, y) => ({ lon: 10 + (x - 50) / 100, lat: 50 + (50 - y) / 100 });
const points = [[5, 5], [95, 5], [10, 95], [90, 90], [50, 35], [35, 65]].map((pixel, i) => ({ id: i + 1, pixel, target: target(...pixel) }));
const options = { codes: ['EPSG:4326'], families: [], tps: 'never' };

test('fit recovers an independently specified transform, round-trips project and excludes controls', async () => {
  const controls = [{ pixel: [50, 50], target: { lon: -50, lat: -20 }, fit: false }];
  const a = await fitGeoreference(points, width, height, options);
  const b = await fitGeoreference([...points, ...controls], width, height, options);
  assert.deepEqual(a.project.alignment, b.project.alignment);
  const restored = projectTransform(JSON.parse(JSON.stringify(a.project)), width, height);
  for (const pixel of [[0, 0], [50, 50], [100, 100], [23, 72]]) {
    const actual = restored(pixel[0] / width, pixel[1] / height), expected = target(...pixel);
    assert.ok(Math.hypot(actual.lon - expected.lon, actual.lat - expected.lat) < 1e-8);
  }
  assert.ok(b.report.control.rms > 1e6);
  assert.ok(a.report.conditionalLeaveOneOut.statistics.rms < .01);
});

test('TPS correction persists and improves withheld points for a smooth synthetic warp', async () => {
  const warped = points.map(p => ({ ...p, target: { lon: p.target.lon + .02 * ((p.pixel[0] - 50) / 50) ** 2, lat: p.target.lat } }));
  const fit = await fitGeoreference(warped, width, height, { ...options, tps: 'always' });
  assert.equal(fit.project.alignment.method, 'projection+tps');
  const restored = projectTransform(fit.project, width, height);
  assert.ok(fit.report.fit.rms < .1);
  for (const p of fit.project.points) assert.deepEqual(restored(p.source.u, p.source.v), fit.transform(p.source.u, p.source.v));
  const control = validatePoints([{ pixel: [50, 50], target: target(50, 50), fit: false }], width, height);
  assert.ok(evaluate(restored, control).control.rms < 1200);
});

test('invalid coordinates, duplicate IDs and degenerate fits fail before producing artifacts', async () => {
  assert.throws(() => validatePoints([{ pixel: [NaN, 3], target: target(0, 0) }], width, height));
  assert.throws(() => validatePoints([{ ...points[0], fit: 'false' }], width, height));
  assert.throws(() => validatePoints([{ ...points[0], id: 1 }, { ...points[1], id: 1 }], width, height));
  await assert.rejects(fitGeoreference(points.map((p, i) => ({ ...p, pixel: [i * 15, 10] })), width, height, options), /Linie/);
});

test('vector export handles points, densified lines, multipart polygons and holes', () => {
  const raster = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
  const transform = (u, v) => target(u * width, v * height);
  const result = vectorize(raster, transform, [
    { name: 'point', geometry: { type: 'Point', coordinates: [20, 30] } },
    { geometry: { type: 'LineString', coordinates: [[10, 10], [90, 90]] } },
    { geometry: { type: 'MultiPolygon', coordinates: [[[[10, 10], [90, 10], [90, 90], [10, 90]], [[30, 30], [30, 50], [50, 50], [50, 30]]]] } }
  ]);
  assert.deepEqual(result.features[0].geometry.coordinates, [9.7, 50.2]);
  assert.ok(result.features[1].geometry.coordinates.length > 20);
  assert.equal(result.features[2].geometry.coordinates[0].length, 2);
  for (const ring of result.features[2].geometry.coordinates[0]) assert.deepEqual(ring[0], ring.at(-1));
  const area = ring => ring.slice(1).reduce((s, p, i) => s + ring[i][0] * p[1] - p[0] * ring[i][1], 0);
  assert.ok(area(result.features[2].geometry.coordinates[0][0]) > 0);
  assert.ok(area(result.features[2].geometry.coordinates[0][1]) < 0);
  assert.throws(() => vectorize(raster, transform, [{ geometry: { type: 'Point', coordinates: [-1, 2] } }]));
});

test('region extraction retains a hole and disconnected islands in georeferenced output', () => {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((x > 10 && x < 60 && y > 10 && y < 60 && !(x > 25 && x < 40 && y > 25 && y < 40)) || (x > 75 && x < 90 && y > 75 && y < 90)) data.set([220, 30, 30, 255], (y * width + x) * 4);
  }
  const result = vectorize({ width, height, data }, (u, v) => target(u * width, v * height), [{ mode: 'region', seeds: [[15, 15]], algorithm: 'classic', contiguous: false, tolerance: 2 }]);
  const polygons = result.features[0].geometry.coordinates;
  assert.equal(polygons.length, 2);
  assert.ok(polygons.some(p => p.length === 2));
  assert.ok(polygons[0][0].length > 20, 'long contour edges are densified before nonlinear transformation');
});

test('raster crop keeps all seeds and exported vertices in original image coordinates', () => {
  const raster = { width: 20, height: 20, sourceWidth: 100, sourceHeight: 100, offset: [30, 40], data: new Uint8ClampedArray(20 * 20 * 4).fill(255) };
  const transform = (u, v) => target(u * 100, v * 100);
  const result = vectorize(raster, transform, [{ mode: 'region', seeds: [[35, 45]], algorithm: 'classic', tolerance: 1 }]);
  const coords = result.features[0].geometry.coordinates.flat(2);
  assert.ok(coords.every(([lon, lat]) => lon >= 9.79 && lon <= 10.01 && lat >= 49.9 && lat <= 50.11));
  assert.throws(() => vectorize(raster, transform, [{ mode: 'region', seeds: [[5, 5]], algorithm: 'classic', tolerance: 1 }]), /crop/);
});

test('headless CLI fits, loads, transforms, vectorizes and compares through real files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kartenpause-headless-'));
  const call = args => {
    const p = spawnSync(process.execPath, ['scripts/headless.mjs', ...args], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    return JSON.parse(p.stdout);
  };
  try {
    const image = join(dir, 'map.png'), request = join(dir, 'points.json'), project = join(dir, 'project.json'), report = join(dir, 'report.json');
    await sharp({ create: { width, height, channels: 4, background: '#ffffff' } }).png().toFile(image);
    await writeFile(request, JSON.stringify({ points, options }));
    assert.equal(call(['inspect', '--image', image]).width, width);
    call(['fit', '--image', image, '--request', request, '--out', project, '--report', report]);
    const saved = JSON.parse(await readFile(project));
    assert.ok(saved.image.data.startsWith('data:image/png;base64,'));
    await writeFile(request, JSON.stringify({ pixels: [[50, 50]] }));
    assert.deepEqual(call(['transform', '--project', project, '--request', request]).coordinates[0], target(50, 50));
    await writeFile(request, JSON.stringify({ objects: [{ geometry: { type: 'Point', coordinates: [50, 50] } }] }));
    assert.equal(call(['vectorize', '--project', project, '--request', request]).features.length, 1);
    await writeFile(request, JSON.stringify({ points: [{ pixel: [40, 60], target: target(40, 60), fit: false }] }));
    const compared = call(['compare', '--project', project, '--reference', project, '--request', request]);
    assert.equal(compared.atLeastAsGood, true);
    assert.ok(compared.candidateRms < .01);
    const bad = spawnSync(process.execPath, ['scripts/headless.mjs', 'fit'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(JSON.parse(bad.stderr).error, /required/);
  } finally {
    assert.equal(resolve(dirname(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('kartenpause-headless-'));
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy fixed CRS and custom projects share projection definitions with the UI', () => {
  const project = { format: 'pixelkarte-georeferenzierung', version: 3, alignment: { method: 'projection', code: 'EPSG:3035', center: { lon: 10, lat: 50 }, halfWidth: 100000, rotation: 5 } };
  const t = projectTransform(project, width, height);
  const center = t(.5, .5);
  assert.ok(Math.abs(center.lat - 50) < 1e-7);
  assert.ok(Math.abs(center.lon - 10) < 1e-7);
  assert.ok(proj4.defs('EPSG:3035'));
});

test('geographic reference inverse recovers original pixels including a nonlinear TPS correction', async () => {
  const fit = await fitGeoreference(points.map(p => ({ ...p, target: { ...p.target, lon: p.target.lon + .02 * (p.pixel[0] / width) ** 2 } })), width, height, { ...options, tps: 'always' });
  const inverse = createGeoToPixel(fit.transform, width, height, 10);
  for (const p of [[3, 7], [44, 68], [93, 92]]) {
    const geo = fit.transform(p[0] / width, p[1] / height), restored = inverse([geo.lon, geo.lat]);
    assert.ok(restored && Math.hypot(restored[0] - p[0], restored[1] - p[1]) < .03);
  }
  assert.equal(inverse([100, 20]), null);
  assert.throws(() => inverse([181, 30]));
});

test('reference overlay clips unmapped sections without connecting across missing geometry', () => {
  const result = referencePaths({ type: 'LineString', coordinates: [[0, 0], [1, 0], [2, 0]] }, p => p[0] > .75 && p[0] < 1.25 ? null : p);
  assert.equal(result.paths.length, 2);
  assert.ok(result.unmappedSamples > 0);
  assert.ok(result.paths[0].at(-1)[0] <= .75 && result.paths[1][0][0] >= 1.25);
  assert.throws(() => referencePaths({ type: 'LineString', coordinates: [[181, 0], [1, 0]] }, p => p));
});
