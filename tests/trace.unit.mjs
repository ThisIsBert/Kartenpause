import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceRaster } from '../src/drawing/trace.js';
import { findMagneticPath, cropSearch } from '../src/drawing/magnetic-path.js';
import { createRasterInverse } from '../src/drawing/raster-source.js';
import { ThinPlateSpline } from '../src/geo/thin-plate-spline.js';

function raster(draw) {
  const width = 240, height = 180, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const set = (x, y, rgb = [20, 20, 20]) => data.set([...rgb, 255], (y * width + x) * 4);
  draw(set); return { width, height, data };
}

test('finds the image line instead of reproducing the offset brush path', () => {
  const image = raster(set => { for (let x = 20; x <= 220; x++) for (let y = 79; y <= 81; y++) set(x, y); });
  const result = traceRaster(image, [[25, 88], [100, 88], [215, 88]], 32);
  assert.equal(result.closed, false);
  assert.ok(result.vertices.every(p => Math.abs(p[1] - 80) <= 2));
  assert.ok(result.vertices.length < 10);
});

test('detects colored lines and a closed rectangular boundary', () => {
  const image = raster(set => {
    for (let x = 40; x <= 200; x++) for (const y of [39, 40, 41, 139, 140, 141]) set(x, y, [200, 30, 60]);
    for (let y = 40; y <= 140; y++) for (const x of [39, 40, 41, 199, 200, 201]) set(x, y, [200, 30, 60]);
  });
  const result = traceRaster(image, [[48, 46], [191, 46], [191, 132], [48, 132], [48, 46]], 32);
  assert.equal(result.closed, true);
  assert.ok(result.vertices.length >= 4);
  assert.ok(result.vertices.every(([x, y]) => Math.min(Math.abs(x - 40), Math.abs(x - 200), Math.abs(y - 40), Math.abs(y - 140)) < 6));
});

test('rejects empty image areas and lines outside the painted corridor', () => {
  const blank = raster(() => {});
  assert.throws(() => traceRaster(blank, [[20, 80], [220, 80]], 32), /Keine ausreichend/);
  const image = raster(set => { for (let x = 20; x < 220; x++) set(x, 30); });
  assert.throws(() => traceRaster(image, [[20, 80], [220, 80]], 32), /Keine ausreichend/);
});

test('magnetic color guidance follows a curved red border across a blue river', () => {
  const red = [185, 35, 40];
  const image = raster(set => {
    for (let x = 20; x <= 220; x++) {
      const y = Math.round(85 - 24 * Math.sin((x - 20) / 200 * Math.PI));
      for (let d = -1; d <= 1; d++) set(x, y + d, red);
    }
    for (let x = 20; x <= 220; x++) set(x, 85, [20, 70, 180]);
    for (let y = 35; y < 140; y++) for (let x = 118; x <= 121; x++) set(x, y, [20, 70, 180]);
  });
  const region = cropSearch(image, [23, 84], [217, 84], 40);
  const result = findMagneticPath({ ...region, color: red, tolerance: 40, radius: 40 });
  const points = result.pixels.map(p => [p[0] + region.offset[0], p[1] + region.offset[1]]);
  assert.ok(points.some(([x, y]) => x > 90 && x < 150 && y < 66));
  assert.ok(points.every(([x, y]) => Math.abs(y - (85 - 24 * Math.sin((x - 20) / 200 * Math.PI))) < 5));
});

test('magnetic search rejects blank pixels, transparent endpoints and oversized regions', () => {
  const image = raster(() => {});
  assert.throws(() => findMagneticPath({ raster: image, start: [20, 80], end: [220, 80] }), /Keine ausreichend/);
  image.data.fill(0);
  assert.throws(() => findMagneticPath({ raster: image, start: [20, 80], end: [220, 80] }), /Kein Verlauf/);
  assert.throws(() => cropSearch({ width: 3000, height: 3000 }, [10, 10], [2000, 2000], 32), /zu groß/);
});

test('original-pixel inverse handles rotated and nonlinearly warped coordinates', () => {
  const forward = ([x, y]) => [100000 + 900 * x + 80 * y + 4000 * Math.sin(y / 80), 5000000 - 800 * y + 60 * x + 3000 * Math.sin(x / 60)];
  const inverse = createRasterInverse(240, 180, forward);
  for (const point of [[0, 0], [239, 179], [35.7, 41.1], [105, 80], [190, 150]]) {
    const actual = inverse(forward(point));
    assert.ok(actual); assert.ok(Math.hypot(actual[0] - point[0], actual[1] - point[1]) < .05);
  }
  assert.equal(inverse(forward([-50, 90])), null);
});

test('original-pixel inverse round-trips the application TPS correction', () => {
  const width = 180, height = 120;
  const base = (u, v) => ({ lon: 10 + (u * 2 - 1) * 10, lat: 50 + (1 - v * 2) * 20 / 3 });
  const points = [];
  for (const v of [.08, .5, .92]) for (const u of [.08, .5, .92]) {
    const target = base(u, v);
    target.lon += 1.5 * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * v);
    target.lat += 1.2 * Math.sin(Math.PI * u) * Math.sin(2 * Math.PI * v);
    points.push({ id: points.length + 1, fit: true, source: { u, v }, target });
  }
  const tps = ThinPlateSpline.fitResiduals(points, width, height, base);
  const forward = ([x, y]) => {
    const { lon, lat } = tps.transform((x + .5) / width, (y + .5) / height);
    return [6378137 * lon * Math.PI / 180, 6378137 * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
  };
  const inverse = createRasterInverse(width, height, forward);
  for (const pixel of [[0, 0], [179, 119], [12, 47], [93.4, 72.6], [170, 110]]) {
    const actual = inverse(forward(pixel));
    assert.ok(actual); assert.ok(Math.hypot(actual[0] - pixel[0], actual[1] - pixel[1]) < .05);
  }
});
