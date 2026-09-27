import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceRaster } from '../src/drawing/trace.js';
import { findMagneticPath, cropSearch } from '../src/drawing/magnetic-path.js';
import { createRasterInverse } from '../src/drawing/raster-source.js';
import { ThinPlateSpline } from '../src/geo/thin-plate-spline.js';
import { continuesSegment } from '../src/drawing/magnetic-click.js';
import { selectColor, paintSelection, selectionPolygons } from '../src/drawing/selection.js';
import { toFeature, objectRings, sampledPoints } from '../src/drawing/geometry.js';
import { simplifyObject, vertexCount, hasValidTopology, topologyReport } from '../src/drawing/simplification.js';
import { linearObject, nearestEdge, replaceArc, selectedArc, rasterizePolygons, shorterArcIsOther } from '../src/drawing/rework-geometry.js';
import { removeSpurs } from '../src/drawing/path-cleanup.js';

test('shorter boundary is independent of anchor order and vertex density', () => {
  const object = { kind: 'polygon', vertices: [[0, 0], [2, 0], [4, 0], [6, 0], [8, 0], [10, 0], [10, 10], [0, 10]] };
  const a = nearestEdge(object, [1, 0], p => p), b = nearestEdge(object, [9, 0], p => p);
  for (const [start, end] of [[a, b], [b, a]]) {
    const other = shorterArcIsOther(object, start, end);
    const result = replaceArc(object, start, end, [start.point, [5, -2], end.point], other);
    assert.ok(result.vertices.some(p => p[0] === 10 && p[1] === 10));
    assert.equal(hasValidTopology(result, object), true);
  }
});

test('magnetic joins remove off-line-anchor spurs before generating vertices', () => {
  const width = 60, height = 60, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 19; x <= 21; x++) data.set([0, 0, 0, 255], (y * width + x) * 4);
  const get = (start, end) => findMagneticPath({ raster: { width, height, data }, start, end, radius: 12, color: [0, 0, 0] }).pixels;
  const first = get([20, 5], [16, 30]), second = get([16, 30], [20, 55]);
  const object = { kind: 'polygon', vertices: [[20, 5], [50, 5], [50, 55], [20, 55]] };
  const a = nearestEdge(object, [20, 5], p => p), b = nearestEdge(object, [20, 55], p => p);
  const raw = [...first, ...second.slice(1)], clean = removeSpurs(raw);
  const invalid = replaceArc(object, a, b, raw, true);
  assert.equal(hasValidTopology(invalid, object), false);
  assert.equal(topologyReport(invalid, object).issues.length, 1);
  assert.equal(hasValidTopology(replaceArc(object, a, b, clean, true), object), true);
  assert.ok(!clean.some(p => p[0] === 16));
  assert.deepEqual(clean[0], raw[0]); assert.deepEqual(clean.at(-1), raw.at(-1));
  assert.deepEqual(removeSpurs([[0, 0], [5, 0], [10, 0], [7, 0], [3, 0], [3, 4]]), [[0, 0], [3, 0], [3, 4]]);
  const bend = [[0, 0], [5, 0], [4, 2], [6, 4]];
  assert.deepEqual(removeSpurs(bend), bend);
  const loop = [[0, 0], [4, 4], [0, 4], [4, 0]];
  assert.deepEqual(removeSpurs(loop), loop);
  const closed = removeSpurs([[0, 0], [2, 0], [2, 2], [4, 2], [4, 0], [2, 0], [0, 0]], 1e-7, true);
  assert.ok(!closed.some(p => p[0] === 0));
  assert.deepEqual(closed[0], closed.at(-1));
  assert.equal(hasValidTopology({ kind: 'polygon', vertices: closed.slice(0, -1) }), true);
});

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

test('continuation distinguishes corrections, forward clicks and right-angle turns', () => {
  assert.equal(continuesSegment([0, 0], [100, 0], [50, 10]), false);
  assert.equal(continuesSegment([0, 0], [100, 0], [102, 2]), false);
  assert.equal(continuesSegment([0, 0], [100, 0], [140, 5]), true);
  assert.equal(continuesSegment([0, 0], [100, 0], [100, 50]), true);
  assert.equal(continuesSegment([0, 0], [100, 0], [-20, 0]), false);
});

test('two-color magnet follows a boundary without an outline', () => {
  const a = [220, 170, 110], b = [110, 180, 220];
  const boundary = y => Math.round(110 + 15 * Math.sin(y / 50));
  const image = raster(set => { for (let y = 0; y < 180; y++) for (let x = 0; x < 240; x++) set(x, y, x < boundary(y) ? a : b); });
  const result = findMagneticPath({ raster: image, start: [boundary(20), 20], end: [boundary(155), 155], color: a, color2: b, tolerance: 30 });
  assert.ok(result.pixels.every(([x, y]) => Math.abs(x - boundary(y)) <= 2));
  assert.throws(() => findMagneticPath({ raster: image, start: [100, 20], end: [100, 155], color: a, color2: a }), /zu ähnlich/);
});

const signedArea = ring => ring.reduce((sum, a, i) => { const b = ring[(i + 1) % ring.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0) / 2;

test('wand handles nuances, disconnected regions and contiguous selection', () => {
  const image = raster(set => {
    for (let y = 20; y < 70; y++) for (let x = 20; x < 80; x++) set(x, y, x < 50 ? [190, 80, 70] : [199, 88, 77]);
    for (let y = 100; y < 120; y++) for (let x = 140; x < 160; x++) set(x, y, [190, 80, 70]);
  });
  const exact = selectColor(image, [30, 30], 0, false);
  assert.equal(exact.reduce((a, b) => a + b), 1900);
  const nuanced = selectColor(image, [30, 30], 12, false);
  assert.equal(nuanced.reduce((a, b) => a + b), 3400);
  const connected = selectColor(image, [30, 30], 12, true);
  assert.equal(connected.reduce((a, b) => a + b), 3000);
  assert.equal(selectionPolygons(nuanced, 240, 180).length, 2);
});

test('selection outlines preserve holes and diagonally touching islands', () => {
  const mask = new Uint8Array(100);
  for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) mask[y * 10 + x] = 1;
  for (let y = 3; y < 6; y++) for (let x = 3; x < 6; x++) mask[y * 10 + x] = 0;
  mask[88] = 1;
  const polygons = selectionPolygons(mask, 10, 10);
  assert.equal(polygons.length, 2);
  assert.equal(polygons[0].length, 2);
  assert.equal(polygons.flat().reduce((sum, ring) => sum + signedArea(ring), 0), 41);
  const feature = toFeature({ id: 'hole', kind: 'polygon', name: 'Hole', vertices: polygons[0][0], holes: polygons[0].slice(1) }, p => p);
  assert.equal(feature.geometry.coordinates.length, 2);
  assert.ok(signedArea(feature.geometry.coordinates[0]) > 0);
  assert.ok(signedArea(feature.geometry.coordinates[1]) < 0);
});

test('all 3x3 selection patterns preserve their exact selected area', () => {
  for (let bits = 0; bits < 512; bits++) {
    const mask = Uint8Array.from({ length: 9 }, (_, i) => (bits >> i) & 1);
    const polygons = selectionPolygons(mask, 3, 3);
    assert.equal(polygons.flat().reduce((sum, ring) => sum + signedArea(ring), 0), mask.reduce((a, b) => a + b));
  }
});

test('selection brush adds continuous strokes and removes holes', () => {
  const mask = new Uint8Array(80 * 80);
  paintSelection(mask, 80, 80, [[10, 40], [65, 40]], 20, true);
  assert.equal(mask[40 * 80 + 35], 1);
  paintSelection(mask, 80, 80, [[35, 40]], 6, false);
  assert.equal(mask[40 * 80 + 35], 0);
  assert.equal(selectionPolygons(mask, 80, 80)[0].length, 2);
});

test('multipart polygons export as one feature with editable parts and oriented holes', () => {
  const object = { id: 'islands', name: 'Islands', kind: 'multiPolygon', parts: [
    { vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]] },
    { vertices: [[20, 0], [30, 0], [30, 10], [20, 10]], holes: [] }
  ] };
  assert.equal(objectRings(object).length, 3);
  const feature = toFeature(object, p => p);
  assert.equal(feature.geometry.type, 'MultiPolygon');
  assert.equal(feature.geometry.coordinates.length, 2);
  assert.equal(feature.properties.partControlPoints.length, 2);
  assert.ok(signedArea(feature.geometry.coordinates[0][0]) > 0);
  assert.ok(signedArea(feature.geometry.coordinates[0][1]) < 0);
  objectRings(object)[2][0] = [21, 0];
  assert.equal(toFeature(object, p => p).geometry.coordinates[1][0][0][0], 21);
});

test('simplification is reversible, reduces vertices, smooths and fixes line endpoints', () => {
  const object = { kind: 'line', vertices: Array.from({ length: 101 }, (_, i) => [i, 5 * Math.sin(i / 10) + (i % 2) * .3]) };
  const before = structuredClone(object), result = simplifyObject(object, 75);
  assert.deepEqual(object, before);
  assert.ok(vertexCount(result) < vertexCount(object));
  assert.deepEqual(result.vertices[0], object.vertices[0]);
  assert.deepEqual(result.vertices.at(-1), object.vertices.at(-1));
  assert.ok(result.vertices.slice(1, -1).some(p => !object.vertices.some(q => p[0] === q[0] && p[1] === q[1])));
  assert.deepEqual(simplifyObject(object, 0), object);
  assert.deepEqual(simplifyObject({ kind: 'point', vertices: [[1, 2]] }, 100), { kind: 'point', vertices: [[1, 2]] });
});

test('simplification retains small holes and multipart islands without collapsing rings', () => {
  const circle = (x, y, radius) => Array.from({ length: 80 }, (_, i) => [x + radius * Math.cos(i / 40 * Math.PI), y + radius * Math.sin(i / 40 * Math.PI)]);
  const object = { kind: 'multiPolygon', parts: [
    { vertices: circle(0, 0, 100), holes: [circle(0, 0, .01), circle(90, 0, 8)] },
    { vertices: circle(220, 0, 100), holes: [] }
  ] };
  const result = simplifyObject(object, 100), rings = objectRings(result);
  assert.equal(result.parts.length, 2); assert.equal(result.parts[0].holes.length, 2);
  assert.ok(rings.every(ring => ring.length >= 3 && Math.abs(signedArea(ring)) > 0));
  assert.ok(vertexCount(result) < vertexCount(object));
  assert.ok(result.parts[0].holes[1].every(([x, y]) => Math.hypot(x, y) < 100));
  // Near-touching rings may require keeping the original rather than damaging it.
  object.parts[0].holes[1] = circle(90, 0, 9.99);
  const conservative = simplifyObject(object, 100);
  assert.equal(objectRings(conservative).length, 4);
  assert.ok(conservative.parts[0].holes[1].every(([x, y]) => Math.hypot(x, y) < 100));
});

test('large multipart outlines can be simplified repeatedly from the same source', t => {
  const ring = (offset, n, radius) => Array.from({ length: n }, (_, i) => {
    const angle = i * 2 * Math.PI / n, r = radius + .01 * Math.sin(i * .9);
    return [offset + r * Math.cos(angle), r * Math.sin(angle)];
  });
  const object = { kind: 'multiPolygon', parts: [
    { vertices: ring(0, 20000, 100), holes: [ring(0, 10000, 20)] },
    { vertices: ring(300, 10000, 100), holes: [] }
  ] };
  const start = performance.now();
  const low = simplifyObject(object, 5), high = simplifyObject(object, 70), again = simplifyObject(object, 5);
  assert.deepEqual(low, again);
  assert.ok(vertexCount(high) < vertexCount(low));
  assert.equal(vertexCount(object), 40000);
  assert.equal(high.parts[0].holes.length, 1);
  t.diagnostic(`40,000 points, three computations: ${Math.round(performance.now() - start)} ms`);
});

test('reopened selections retain holes, islands and boundary pixels', () => {
  for (let bits = 1; bits < 512; bits++) {
    const mask = Uint8Array.from({ length: 9 }, (_, i) => (bits >> i) & 1);
    assert.deepEqual(rasterizePolygons(selectionPolygons(mask, 3, 3), 3, 3), mask);
  }
});

test('section replacement inserts edge anchors and preserves the other arc and all other rings', () => {
  const object = { id: 'a', name: 'A', kind: 'multiPolygon', parts: [
    { vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[2, 2], [3, 2], [3, 3], [2, 3]]] },
    { vertices: [[20, 0], [25, 0], [25, 5], [20, 5]] }
  ] };
  const a = nearestEdge(object, [2, 0], p => p), b = nearestEdge(object, [8, 0], p => p);
  const path = [a.point, [5, -2], b.point], result = replaceArc(object, a, b, path);
  assert.deepEqual(result.parts[0].vertices, [[2, 0], [5, -2], [8, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  assert.deepEqual(result.parts[0].holes, object.parts[0].holes);
  assert.deepEqual(result.parts[1], object.parts[1]);
  assert.equal(result.id, object.id);
  assert.equal(selectedArc(object, a, b, true).length, 6);
  const other = replaceArc(object, a, b, path, true);
  assert.deepEqual(other.parts[0].vertices, [[2, 0], [5, -2], [8, 0]]);
  assert.equal(object.parts[0].vertices.length, 4);
});

test('open line sections support reverse anchor order and hole selection is confined to one ring', () => {
  const object = { kind: 'line', vertices: [[0, 0], [10, 0], [20, 0], [30, 0]] };
  const a = nearestEdge(object, [25, 0], p => p), b = nearestEdge(object, [5, 0], p => p);
  assert.deepEqual(replaceArc(object, a, b, [a.point, [15, 2], b.point]).vertices, [[0, 0], [5, 0], [15, 2], [25, 0], [30, 0]]);
  const polygon = { kind: 'polygon', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]] };
  assert.equal(nearestEdge(polygon, [3, 2], p => p).ringIndex, 1);
  assert.equal(nearestEdge(polygon, [3, 2], p => p, 0).ringIndex, 0);
  const curved = { kind: 'curvePolygon', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]] };
  assert.deepEqual(linearObject(curved).vertices, sampledPoints(curved).slice(0, -1));
});

test('complementary replacement is valid while self-crossing and detached holes are rejected', () => {
  const object = { kind: 'polygon', vertices: [[0, 0], [10, 0], [10, 10], [0, 10]] };
  const a = nearestEdge(object, [2, 0], p => p), b = nearestEdge(object, [8, 0], p => p);
  const result = replaceArc(object, a, b, [a.point, [5, -2], b.point], true);
  assert.equal(hasValidTopology(result, object), true);
  const crossing = replaceArc(object, a, b, [a.point, [12, 8], [-2, 8], b.point]);
  assert.equal(hasValidTopology(crossing, object), false);
  const holed = { ...object, holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]] };
  const cut = replaceArc(holed, a, b, [a.point, [5, -2], b.point], true);
  assert.equal(hasValidTopology(cut, holed), false);
  const h1 = nearestEdge(holed, [2.5, 2], p => p), h2 = nearestEdge(holed, [3.5, 2], p => p);
  const editedHole = replaceArc(holed, h1, h2, [h1.point, [3, 1], h2.point]);
  assert.deepEqual(editedHole.vertices, holed.vertices);
  assert.equal(hasValidTopology(editedHole, holed), true);
});
