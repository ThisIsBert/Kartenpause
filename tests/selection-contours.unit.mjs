import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionPolygons } from '../src/drawing/selection.js';
import { reconstructSelectionContours } from '../src/drawing/selection-contours.js';
import { createSelectionProcessor } from '../src/drawing/selection-operation.js';
import { rasterizePolygons } from '../src/drawing/rework-geometry.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';

const maskFor = (width, height, selected) => Uint8Array.from({ length: width * height }, (_, i) => Number(selected(i % width, Math.floor(i / width))));
const pointsIn = polygons => polygons.flat().reduce((sum, ring) => sum + ring.length, 0);
function valid(polygons) {
  if (!polygons.length) return true;
  const geometry = new GeoJSONReader().read({ type: 'MultiPolygon', coordinates: polygons.map(p => p.map(r => [...r, r[0]])) });
  return new IsValidOp(geometry).isValid();
}
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const boundaryDistance = (p, ring) => Math.min(...ring.map((a, i) => segmentDistance(p, a, ring[(i + 1) % ring.length])));

test('pixel stairs become straight segments while real right and acute corners stay exact', () => {
  const triangle = selectionPolygons(maskFor(100, 100, (x, y) => x >= 10 && y >= 10 && x + y < 105), 100, 100);
  const result = reconstructSelectionContours(triangle);
  assert.equal(result[0][0].length, 3);
  for (const corner of [[9.5, 9.5], [94.5, 9.5], [9.5, 94.5]]) assert.ok(result[0][0].some(p => p[0] === corner[0] && p[1] === corner[1]));
  assert.ok(pointsIn(triangle) > 150);
  const elbow = selectionPolygons(maskFor(100, 100, (x, y) => x >= 10 && x < 90 && y >= 10 && y < 90 && !(x >= 45 && y >= 45)), 100, 100);
  assert.deepEqual(reconstructSelectionContours(elbow), elbow);
  assert.ok(valid(result));
});

test('coarse working cells are not mistaken for protected corners at scales 2, 3, 4 and 8', () => {
  for (const scale of [2, 3, 4, 8]) {
    const width = 80 * scale;
    const mask = maskFor(width, width, (x, y) => {
      x = Math.floor(x / scale); y = Math.floor(y / scale);
      return x >= 10 && y >= 10 && x + y < 75;
    });
    const raw = selectionPolygons(mask, width, width), result = reconstructSelectionContours(raw, .75, scale);
    assert.ok(pointsIn(raw) > 100);
    assert.equal(result[0][0].length, 3, `scale ${scale}`);
    for (const corner of [[10 * scale - .5, 10 * scale - .5], [65 * scale - .5, 10 * scale - .5], [10 * scale - .5, 65 * scale - .5]]) {
      assert.ok(result[0][0].some(p => p[0] === corner[0] && p[1] === corner[1]), `protected corner at scale ${scale}`);
    }
    for (const p of raw[0][0]) assert.ok(boundaryDistance(p, result[0][0]) <= .75 * scale + 1e-6);
    assert.ok(valid(result));
  }
});

test('coarse contour scale survives painting and restored history and resets with a fresh classic selection', () => {
  const width = 720, height = 640, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set(x >= 50 && y >= 50 && x + y < 600 ? [190, 70, 50, 255] : [80, 140, 200, 255], (y * width + x) * 4);
  }
  const process = createSelectionProcessor({ width, height, data });
  const apply = (previous, operation) => process({ ...operation, mask: previous.mask.slice(), referenceModel: previous.referenceModel, contourScale: previous.contourScale });
  const empty = { mask: new Uint8Array(width * height), contourScale: 1 };
  const first = apply(empty, { type: 'select', mode: 'replace', algorithm: 'intelligent', seed: [150, 150], tolerance: 5 });
  assert.equal(first.contourScale, 2);
  assert.ok(pointsIn(first.contours) < pointsIn(first.polygons) / 3);
  const brush = { type: 'paint', stroke: [[150, 150]], diameter: 3, add: false };
  assert.equal(apply(first, brush).contourScale, 2);
  const classic = apply(first, { type: 'select', mode: 'replace', algorithm: 'classic', seed: [150, 150], tolerance: 5, contiguous: true });
  assert.equal(classic.contourScale, 1);
  assert.equal(apply(first, brush).contourScale, 2, 'restored history overrides the newer processor state');
  assert.equal(apply({ ...first, mask: empty.mask }, { type: 'restore' }).contourScale, 1);
});

test('curved pixel outlines use fewer off-grid straight segments with a bounded error in both directions', () => {
  const original = selectionPolygons(maskFor(160, 160, (x, y) => (x - 80) ** 2 + (y - 80) ** 2 < 65 ** 2), 160, 160);
  const snapshot = structuredClone(original), result = reconstructSelectionContours(original);
  assert.ok(pointsIn(result) < pointsIn(original) / 2);
  assert.ok(result[0][0].some(p => p.some(v => Math.abs(v * 2 - Math.round(v * 2)) > .01)));
  for (const p of original[0][0]) assert.ok(boundaryDistance(p, result[0][0]) <= .750001);
  for (const [i, a] of result[0][0].entries()) {
    const b = result[0][0][(i + 1) % result[0][0].length];
    for (let k = 0; k <= 20; k++) assert.ok(boundaryDistance(a.map((v, axis) => v + (b[axis] - v) * k / 20), original[0][0]) <= .750001);
  }
  assert.deepEqual(original, snapshot);
  assert.deepEqual(reconstructSelectionContours(original, 0), original);
  assert.ok(valid(result));
});

test('holes, nested islands, diagonal contacts and a one-pixel bridge retain their topology', () => {
  const selected = (x, y) => {
    const r = (x - 50) ** 2 + (y - 50) ** 2;
    return (r < 43 ** 2 && r > 24 ** 2) || r < 6 ** 2 || (x >= 110 && x < 120 && y >= 20 && y < 30)
      || (x >= 130 && x < 140 && y >= 20 && y < 30) || (x >= 120 && x < 130 && y === 24)
      || (x === 140 && y === 30);
  };
  const raw = selectionPolygons(maskFor(160, 110, selected), 160, 110), result = reconstructSelectionContours(raw);
  assert.deepEqual(result.map(p => p.length), raw.map(p => p.length));
  assert.ok(valid(result));
  const raster = rasterizePolygons(result, 160, 110);
  for (let x = 115; x <= 135; x++) assert.equal(raster[24 * 160 + x], 1, 'bridge stays connected');
  assert.equal(raster[50 * 160 + 50], 1, 'island inside hole remains');
  assert.equal(raster[50 * 160 + 65], 0, 'hole remains');
  assert.equal(raster[30 * 160 + 140], 1, 'single-pixel island remains');
  assert.ok(pointsIn(result) < pointsIn(raw));
});

test('all small mask patterns preserve islands and holes without introducing invalid contours', () => {
  for (let bits = 1; bits < 512; bits++) {
    const mask = Uint8Array.from({ length: 9 }, (_, i) => (bits >> i) & 1);
    const raw = selectionPolygons(mask, 3, 3), result = reconstructSelectionContours(raw);
    assert.deepEqual(result.map(p => p.length), raw.map(p => p.length), `pattern ${bits}`);
    assert.ok(valid(result), `pattern ${bits}`);
    assert.deepEqual(rasterizePolygons(result, 3, 3), mask, `pattern ${bits}`);
  }
});

test('selection worker results reconstruct the preview and accepted outline without changing the mask or exact polygons', () => {
  const width = 100, height = 100, mask = maskFor(width, height, (x, y) => x >= 10 && y >= 10 && x + y < 105);
  const process = createSelectionProcessor({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
  const result = process({ type: 'restore', mask: mask.slice() });
  assert.deepEqual(result.mask, mask);
  assert.deepEqual(result.polygons, selectionPolygons(mask, width, height));
  assert.equal(result.contours[0][0].length, 3);
  assert.equal(result.count, mask.reduce((sum, v) => sum + v, 0));
});
