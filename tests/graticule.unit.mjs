import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { loadImage } from '../src/headless/image.js';
import { extractGraticule } from '../src/headless/graticule.js';
import { fitGeoreference } from '../src/headless/georeference.js';

async function fixture(blank = false) {
  const width = 400, height = 320, data = Buffer.alloc(width * height * 4, 255);
  const ink = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && y >= 0 && x < width && y < height && !(x > 140 && x < 156)) data.set([0, 0, 0, 255], (y * width + x) * 4);
  };
  if (!blank) {
    for (const x of [60, 180, 320]) for (let y = 10; y <= 309; y++) ink(x + .04 * (y - 160), y);
    for (const y of [60, 160, 270]) for (let x = 15; x <= 384; x++) ink(x, y + .0003 * (x - 200) ** 2);
    // Unrelated short strokes cross the corridors, like text and coastlines.
    for (let x = 20; x < 370; x += 27) for (let i = 0; i < 8; i++) ink(x, 150 + i);
  }
  const bytes = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const image = await loadImage('data:image/png;base64,' + bytes.toString('base64'));
  const lines = [
    ...[60, 180, 320].map((x, i) => ({ id: `meridian-${i}`, axis: 'longitude', value: -4 + i, from: [x - 6, 10], to: [x + 6, 309], evidence: 'Independently labelled synthetic meridian.' })),
    ...[60, 160, 270].map((y, i) => ({ id: `parallel-${i}`, axis: 'latitude', value: 52 - i, role: i === 1 ? 'control' : 'fit', from: [15, y + 10], to: [384, y + 10], evidence: 'Independently labelled curved synthetic parallel.' }))
  ];
  return { image, request: { lines, image: { sha256: image.sha256 } } };
}

test('grid extraction measures tilted meridians and curved parallels through gaps and unrelated strokes', async () => {
  const { image, request } = await fixture();
  const result = await extractGraticule(image, request);
  assert.equal(result.status, 'assigned');
  assert.equal(result.points.length, 9);
  assert.equal(result.points.filter(p => p.fit).length, 6);
  assert.equal(result.points.filter(p => !p.fit).length, 3);
  assert.ok(result.lines.filter(p => p.axis === 'latitude').every(p => p.polynomial.length === 3));
  for (const point of result.points) {
    const index = point.target.lon + 4, baseX = [60, 180, 320][index], baseY = [60, 160, 270][52 - point.target.lat];
    const [x, y] = point.pixel;
    assert.ok(Math.abs(x - baseX - .04 * (y - 160)) < 1);
    assert.ok(Math.abs(y - baseY - .0003 * (x - 200) ** 2) < 1);
    assert.ok(point.gridLines.every(id => request.lines.some(l => l.id === id)));
  }
  assert.match(result.provenance.warning, /share line measurements/);
  assert.equal(result.previewRequest.markers.length, 9);
  assert.ok(result.previewRequest.paths.every(path => path.length > 2));
});

test('model selection withholds complete grid lines rather than correlated individual intersections', async () => {
  const points = [30, 180, 320].flatMap((x, column) => [25, 150, 280].map((y, row) => ({ id: column * 3 + row + 1, pixel: [x, y], target: { lon: 10 + .004 * x + .001 * y, lat: 50 - .005 * y + .0003 * x }, gridLines: [`lon-${column}`, `lat-${row}`] })));
  const control = { id: 99, pixel: [200, 200], target: { lon: -100, lat: -50 }, fit: false, gridLines: ['control-lon', 'control-lat'] };
  const result = await fitGeoreference([...points, control], 400, 320, { codes: ['EPSG:4326'], families: [], tps: 'never' });
  const validation = result.report.validation;
  assert.equal(validation.type, 'leave-one-grid-line-out');
  assert.equal(validation.folds, 6);
  assert.equal(validation.rows.length, 18);
  assert.ok(validation.rms < 1e-5);
  for (const row of validation.rows) {
    assert.equal(row.trainingIds.length, 6);
    assert.ok(!row.trainingIds.includes(row.id) && !row.trainingIds.includes(99));
    assert.ok(row.trainingIds.every(id => !points.find(p => p.id === id).gridLines.includes(row.withheldGroup)));
  }
});

test('missing grid ink is unresolved rather than silently converted into the supplied hints', async () => {
  const { image, request } = await fixture(true);
  const result = await extractGraticule(image, request);
  assert.equal(result.status, 'needs-review');
  assert.deepEqual(result.points, []);
  assert.ok(result.lines.every(l => l.status === 'needs-review'));
});

test('grid extraction binds source images and rejects repeated labels and malformed line requests', async () => {
  const { image, request } = await fixture();
  await assert.rejects(() => extractGraticule(image, { ...request, image: { sha256: 'wrong' } }), /different source image/);
  await assert.rejects(() => extractGraticule(image, { ...request, lines: [...request.lines, { ...request.lines[0], id: 'duplicate-label' }] }), /Duplicate grid degree/);
  await assert.rejects(() => extractGraticule(image, { ...request, lines: request.lines.map(l => ({ ...l, evidence: '' })) }), /evidence/);
  await assert.rejects(() => extractGraticule(image, { ...request, options: { degree: 4 } }), /degree/);
  await assert.rejects(() => extractGraticule(image, { ...request, options: { trials: 0 } }), /options/);
});
