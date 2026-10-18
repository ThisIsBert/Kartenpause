import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFromTriangles } from '../src/geo/reference-capture.js';

const a = { x: 10.25, y: 20.5, sx: 0, sy: 0 };
const b = { x: 210.25, y: 70.5, sx: 100, sy: 0 };
const c = { x: 60.25, y: 220.5, sx: 0, sy: 50 };
test('rendered rotated and sheared triangles recover subpixel source coordinates', () => {
  const point = { x: .3 * a.x + .2 * b.x + .5 * c.x, y: .3 * a.y + .2 * b.y + .5 * c.y };
  const source = sourceFromTriangles(point, [[a, b, c]], 100, 50);
  assert.ok(Math.abs(source.u - .2) < 1e-12);
  assert.ok(Math.abs(source.v - .5) < 1e-12);
  assert.deepEqual(sourceFromTriangles(a, [[a, b, c]], 100, 50), { u: 0, v: 0 });
  assert.deepEqual(sourceFromTriangles(b, [[c, b, a]], 100, 50), { u: 1, v: 0 });
});
test('outside points, missing or degenerate mesh triangles are rejected', () => {
  assert.equal(sourceFromTriangles({ x: 250, y: 250 }, [[a, b, c]], 100, 50), null);
  assert.equal(sourceFromTriangles(a, [], 100, 50), null);
  assert.equal(sourceFromTriangles(a, [[a, a, a]], 100, 50), null);
});
test('overlapping warped triangles select the last visible image fragment', () => {
  const later = [a, b, c].map(p => ({ ...p, sx: p.sx / 2 + 50 }));
  assert.deepEqual(sourceFromTriangles(a, [[a, b, c], later], 100, 50), { u: .5, v: 0 });
});
