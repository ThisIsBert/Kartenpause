import { test } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { assignLandmarks } from '../src/headless/assignment.js';

const width = 600, height = 400;
const pixels = [[40, 35], [540, 45], [70, 350], [525, 340], [190, 120], [365, 165], [170, 285], [420, 275]];
const target = ([x, y]) => ({ lon: 12 + .003 * (x * Math.cos(.12) + y * Math.sin(.12)), lat: 48 + .003 * (x * Math.sin(.12) - y * Math.cos(.12)) });
const observation = (id, pixel) => ({ id, pixel, evidence: 'Observed feature in an original-raster crop.' });
const candidate = (id, target) => ({ id, target, source: 'independent fixture reference, not a fit result' });
const clean = () => pixels.map((pixel, i) => ({ id: `feature-${i}`, observations: [observation('symbol', pixel)], candidates: [candidate(`place-${i}`, target(pixel))] }));
const options = { codes: ['EPSG:4326'], trials: 256, maxErrorPixels: 4 };

test('consensus selects symbol observations and correct geographic alternatives, and exposes a false correspondence', async () => {
  const landmarks = clean().map((p, i) => ({ ...p,
    observations: i < 3 ? p.observations : [observation('caption', pixels[i].map((v, k) => v + (k ? 10 - i * i : 12 + i * 3))), ...p.observations],
    candidates: [candidate(`wrong-${i}`, { lon: -80 + i * .8, lat: 20 + (i % 3) * .7 }), ...p.candidates]
  }));
  landmarks.push({ id: 'misidentified', observations: [observation('symbol', [300, 375])], candidates: [candidate('unrelated-place', { lon: -20, lat: -40 })] });
  const result = await assignLandmarks(landmarks, width, height, options);
  assert.equal(result.status, 'assigned');
  assert.equal(result.assignments.length, 8);
  for (const p of result.assignments) { assert.equal(p.observationId, 'symbol'); assert.match(p.candidateId, /^place-/); assert.ok(p.errorPixels < 1e-7); }
  assert.deepEqual(result.unresolved.map(p => p.id), ['misidentified']);
  assert.ok(result.diagnostics.imageHullFraction > .5);
});

test('withheld controls do not change hypotheses, source observation selection or assignment', async () => {
  const a = await assignLandmarks(clean(), width, height, options);
  const control = { id: 'withheld', role: 'control', observations: [observation('measured', [280, 180])], candidates: [candidate('control-target', { lon: -110, lat: -50 })] };
  const b = await assignLandmarks([control, ...clean()], width, height, options);
  assert.deepEqual(a.assignments, b.assignments);
  assert.deepEqual(a.diagnostics, b.diagnostics);
  assert.equal(b.points.at(-1).fit, false);
  await assert.rejects(() => assignLandmarks([...clean(), { ...control, candidates: [...control.candidates, candidate('other-control', { lon: 30, lat: 30 })] }], width, height, options), /Controls require/);
});

test('global matching preserves cardinality when two captions share a geographic candidate', async () => {
  const landmarks = clean();
  landmarks[1].observations[0].pixel = [42, 35];
  landmarks[1].candidates = [landmarks[0].candidates[0], candidate('place-1', target([42, 35]))];
  const r = await assignLandmarks(landmarks, width, height, { ...options, ambiguityCostGap: 1e-8 });
  assert.equal(r.assignments.length, 8);
  assert.equal(r.assignments.find(p => p.id === 'feature-1').candidateId, 'place-1');
  assert.equal(new Set(r.assignments.map(p => p.candidateId)).size, r.assignments.length);
});

test('coherent alternatives in different regions remain unresolved instead of being called a successful georeference', async () => {
  const landmarks = clean().map(p => ({ ...p, candidates: [...p.candidates, candidate('alternative-' + p.id, { ...p.candidates[0].target, lon: p.candidates[0].target.lon + 40 })] }));
  const r = await assignLandmarks(landmarks, width, height, options);
  assert.equal(r.status, 'needs-review');
  assert.equal(r.points.length, 0);
  assert.equal(r.unresolved.length, 8);
  assert.ok(r.diagnostics.competingHypotheses > 0);
});

test('new regional Lambert map and rotation can be assigned without that projection being in the coarse model pool', async () => {
  const definition = '+proj=lcc +lon_0=-96 +lat_0=40 +lat_1=33 +lat_2=45 +datum=WGS84 +units=m';
  const transform = proj4(definition, 'EPSG:4326');
  const landmarks = pixels.map((pixel, i) => {
    const x = (pixel[0] - 300) * 1200, y = (200 - pixel[1]) * 1200;
    const ll = transform.forward([Math.cos(.3) * x - Math.sin(.3) * y, Math.sin(.3) * x + Math.cos(.3) * y]);
    return { id: `new-${i}`, observations: [observation('symbol', pixel)], candidates: [candidate(`new-place-${i}`, { lon: ll[0], lat: ll[1] })] };
  });
  const r = await assignLandmarks(landmarks, width, height, { trials: 128, maxErrorPixels: 6, families: [] });
  assert.equal(r.status, 'assigned');
  assert.equal(r.assignments.length, 8);
});

test('projection refinement recovers a distant anchor rejected by coarse consensus without using a control', async () => {
  const definition = '+proj=eqc +lat_ts=30 +lon_0=0 +datum=WGS84 +units=m';
  const inverse = proj4(definition, 'EPSG:4326');
  const pixels = [[100, 200], [240, 200], [370, 200], [390, 30], [450, 465]];
  const landmarks = pixels.map((pixel, i) => {
    const ll = inverse.forward([12000000 + pixel[0] * 8500, -3000000 + (200 - pixel[1]) * 8500]);
    return { id: `cylinder-${i}`, observations: [observation('symbol', pixel)], candidates: [candidate(`cylinder-place-${i}`, { lon: ll[0], lat: ll[1] })] };
  });
  const options = { trials: 128, families: ['eqc'] };
  const coarse = await assignLandmarks(landmarks, 600, 500, { ...options, families: [] });
  const refined = await assignLandmarks(landmarks, 600, 500, options);
  assert.equal(coarse.status, 'needs-review', 'a northern cluster is not full-image coverage');
  assert.equal(coarse.assignments.length, 4);
  assert.equal(refined.status, 'assigned');
  assert.equal(refined.assignments.length, 5);
  assert.ok(refined.diagnostics.refinedModels > 0);
  assert.ok(refined.assignments.every(p => p.errorPixels < 1e-5));
  const control = { id: 'poison', role: 'control', pixel: [250, 250], evidence: 'Withheld checkpoint', candidates: [candidate('poison', { lon: -100, lat: 50 })] };
  const withControl = await assignLandmarks([...landmarks, control], 600, 500, options);
  assert.deepEqual(withControl.assignments, refined.assignments);
  assert.deepEqual(withControl.diagnostics, refined.diagnostics);
});

test('conflicting target IDs and invalid assignment model options fail explicitly', async () => {
  const landmarks = clean();
  landmarks[1].candidates.push(candidate('place-0', { lon: -100, lat: 40 }));
  await assert.rejects(() => assignLandmarks(landmarks, width, height, options), /Conflicting coordinates/);
  for (const invalid of [{ codes: [] }, { codes: [null] }, { families: ['unknown'] }, { minimumCoverage: 2 }]) {
    await assert.rejects(() => assignLandmarks(clean(), width, height, invalid));
  }
});

test('unproven consensus and incomplete provenance fail explicitly', async () => {
  await assert.rejects(() => assignLandmarks(clean().map(p => ({ ...p, candidates: [{ ...p.candidates[0], source: '' }] })), width, height, options), /source/);
  const r = await assignLandmarks(clean().map((p, i) => ({ ...p, observations: [observation('on-line', [40 + i * 60, 100])] })), width, height, options);
  assert.equal(r.status, 'needs-review');
  assert.deepEqual(r.points, []);
});
