import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { detectSymbols } from '../src/headless/symbols.js';
import { lookupRecords } from '../src/headless/gazetteer.js';
import { loadImage } from '../src/headless/image.js';
import { fitGeoreference, evaluate, validatePoints } from '../src/headless/georeference.js';

test('symbol proposals preserve original coordinates and separate compact markers from lines and transparent pixels', async () => {
  const width = 140, height = 110, pixels = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((x - 62) ** 2 + (y - 44) ** 2 <= 9 || (x - 98) ** 2 + (y - 76) ** 2 <= 16 || y === 60) pixels.set([0, 0, 0, 255], (y * width + x) * 4);
    if ((x - 80) ** 2 + (y - 30) ** 2 <= 9) pixels.set([0, 0, 0, 0], (y * width + x) * 4);
  }
  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const image = await loadImage('data:image/png;base64,' + bytes.toString('base64'));
  const r = await detectSymbols(image, { regions: [{ id: 'caption-area', left: 40, top: 20, width: 80, height: 75 }] });
  assert.equal(r.image.sha256, image.sha256);
  assert.equal(r.regions[0].observations.length, 2);
  assert.deepEqual(r.regions[0].observations.map(o => o.pixel).sort((a, b) => a[0] - b[0]), [[62, 44], [98, 76]]);
  assert.ok(r.regions[0].observations.every(o => o.evidence.includes(image.sha256)));
});

test('name lookup retains geographic alternatives, normalizes aliases and applies explicit regional constraints', () => {
  const places = [
    { id: 'FR-paris', name: 'Paris', target: { lon: 2.35, lat: 48.85 }, source: 'fixture:FR', country: 'FR', population: 2000000 },
    { id: 'US-paris', name: 'Paris', target: { lon: -95.55, lat: 33.66 }, source: 'fixture:US', country: 'US', population: 25000 },
    { id: 'DE-mainz', name: 'Mainz', aliases: ['Mogontiacum', 'Mogóntiacum'], target: { lon: 8.27, lat: 50 }, source: 'fixture:DE', country: 'DE' }
  ];
  const r = lookupRecords(places, { queries: ['Paris', 'mogontiacum'] });
  assert.equal(r.queries[0].matchingCount, 2);
  assert.equal(r.queries[1].matchingCount, 1, 'multiple aliases must not duplicate a geographic candidate');
  assert.deepEqual(lookupRecords(places, { queries: ['Paris'], countries: ['FR'] }).queries[0].candidates.map(c => c.id), ['FR-paris']);
  assert.deepEqual(lookupRecords(places, { queries: ['Paris'], bounds: [-100, 30, -90, 40] }).queries[0].candidates.map(c => c.id), ['US-paris']);
});

test('model validation refits custom projection parameters and omits the held-out point and every control', async () => {
  const pixels = [[5, 8], [90, 10], [10, 90], [92, 85], [45, 30], [60, 72]];
  const points = pixels.map((pixel, i) => ({ id: i + 1, pixel, target: { lon: 10 + .012 * pixel[0], lat: 50 - .01 * pixel[1] + (i % 2) * .0005 } }));
  const r = await fitGeoreference([...points, { id: 99, pixel: [50, 50], fit: false, target: { lon: -100, lat: -50 } }], 100, 100, { codes: [], families: ['eqc'], tps: 'never' });
  assert.equal(r.report.selection, 'cross-validation');
  assert.equal(r.report.validation.refitsProjectionParameters, true);
  for (const row of r.report.validation.rows) {
    assert.equal(row.trainingIds.length, 5);
    assert.ok(!row.trainingIds.includes(row.id) && !row.trainingIds.includes(99));
  }
  assert.ok(new Set(r.report.validation.rows.map(r => JSON.stringify(r.projection.parameters))).size > 1, 'projection parameters must actually be re-estimated in each fold');
});

test('cross-validation protects unseen locations from a noisy anchor that exact TPS would interpolate', async () => {
  const target = ([x, y]) => ({ lon: 10 + .01 * x, lat: 50 - .01 * y });
  const pixels = [[5, 5], [95, 5], [5, 95], [95, 95], [35, 35], [65, 65], [25, 75], [75, 25]];
  const points = pixels.map((pixel, i) => ({ id: i + 1, pixel, target: { ...target(pixel), lon: target(pixel).lon + (i === 4 ? .12 : 0) } }));
  const options = { codes: ['EPSG:4326'], families: [] };
  const selected = await fitGeoreference(points, 100, 100, options);
  const interpolated = await fitGeoreference(points, 100, 100, { ...options, selection: 'training', tps: 'always' });
  const checks = validatePoints([[25, 30], [40, 30], [40, 45], [50, 55], [80, 70]].map((pixel, i) => ({ id: i + 1, pixel, fit: false, target: target(pixel) })), 100, 100);
  assert.ok(evaluate(selected.transform, checks).control.rms < evaluate(interpolated.transform, checks).control.rms);
  assert.ok(selected.project.alignment.method === 'projection' || selected.project.alignment.tpsRegularization > 1e-8);
});
