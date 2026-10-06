import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { prepareIntelligent, selectIntelligent } from '../src/drawing/intelligent-selection.js';
import { selectColor, selectionPolygons, paintSelection } from '../src/drawing/selection.js';
import { rasterizePolygons } from '../src/drawing/rework-geometry.js';
import { createSelectionProcessor } from '../src/drawing/selection-operation.js';

const pink = [220, 155, 171], green = [122, 184, 125], beige = [222, 207, 163];
const black = [35, 33, 30], blue = [65, 114, 187], white = [246, 239, 217];
function raster(width = 160, height = 110, color = pink) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...color, 255], i * 4);
  return { width, height, data };
}
function rect(r, x, y, w, h, color) {
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) r.data.set([...color, 255].slice(0, 4), (py * r.width + px) * 4);
}
const run = (r, seed = [25, 50], settings = {}) => selectIntelligent(prepareIntelligent(r, settings), seed, 18, true);
const at = (r, mask, x, y) => mask[y * r.width + x];
const total = mask => mask.reduce((s, v) => s + v, 0);
function split() { const r = raster(); rect(r, 80, 0, 80, r.height, green); return r; }
function checkBoundary(r, mask, expected = 80, error = 2, from = 0, to = r.height) {
  for (let y = from; y < to; y++) {
    for (let x = 0; x < expected - error; x++) assert.equal(at(r, mask, x, y), 1, `inside ${x},${y}`);
    for (let x = expected + error; x < r.width; x++) assert.equal(at(r, mask, x, y), 0, `outside ${x},${y}`);
  }
}

test('1: two plain color areas retain the original boundary', () => {
  const r = split(), { mask } = run(r);
  checkBoundary(r, mask);
  assert.ok(Math.abs(total(mask) - 80 * r.height) <= r.height);
});

test('2: black text creates no holes, including a click on a letter', () => {
  const r = raster();
  for (let x = 30; x < 130; x += 18) {
    rect(r, x, 40, 3, 24, black); rect(r, x + 10, 40, 3, 24, black); rect(r, x, 49, 13, 3, black);
  }
  const { mask } = run(r, [31, 44]);
  assert.equal(total(mask), r.width * r.height);
  assert.equal(selectionPolygons(mask, r.width, r.height)[0].length, 1);
  assert.ok(total(selectColor(r, [20, 20], 18, true)) < total(mask));
});

for (const thickness of [3, 8]) test(`3: a ${thickness}px river crossing the whole area is bridged`, () => {
  const r = raster(160, 110, beige); rect(r, 75, 0, thickness, r.height, blue);
  const { mask } = run(r);
  assert.equal(total(mask), r.width * r.height);
});

test('4: bright/dark double road is an overlay', () => {
  const r = raster(); rect(r, 74, 0, 7, r.height, black); rect(r, 76, 0, 3, r.height, white);
  assert.equal(total(run(r).mask), r.width * r.height);
});

test('5: a border line followed by persistent green is not bridged', () => {
  const r = split(); rect(r, 78, 0, 4, r.height, black);
  checkBoundary(r, run(r).mask, 80, 4);
});

test('6: a soft transition refines toward the center, within the corridor only', () => {
  const r = split();
  for (let x = 74; x <= 85; x++) rect(r, x, 0, 1, r.height, pink.map((v, c) => Math.round(v + (green[c] - v) * (x - 74) / 11)));
  const { mask, debug } = run(r);
  checkBoundary(r, mask, 80, 2, 12, r.height - 12);
  assert.notDeepEqual(mask, debug.coarse, 'refinement actually moves the blurred boundary');
  for (let i = 0; i < mask.length; i++) if (debug.corridor[i] === 255) assert.equal(mask[i], debug.coarse[i]);
});

test('7: letters crossing a boundary do not redirect it around the text', () => {
  const r = split();
  for (let y = 25; y < 80; y += 22) { rect(r, 67, y, 28, 3, black); rect(r, 76, y, 3, 14, black); }
  const { mask } = run(r);
  checkBoundary(r, mask, 80, 5, 12, r.height - 12);
});

test('8: a genuine enclosed region remains a hole with exact polygon roundtrip', () => {
  const r = raster(); rect(r, 65, 35, 25, 27, green);
  const { mask } = run(r), polygons = selectionPolygons(mask, r.width, r.height);
  assert.equal(at(r, mask, 76, 46), 0);
  assert.equal(polygons.length, 1); assert.equal(polygons[0].length, 2);
  assert.deepEqual(rasterizePolygons(polygons, r.width, r.height), mask);
});

test('transparent strips are barriers; transparent holes survive cleanup', () => {
  const r = raster(); rect(r, 79, 0, 2, r.height, [0, 0, 0, 0]); rect(r, 40, 40, 2, 2, [0, 0, 0, 0]);
  const { mask } = run(r);
  assert.equal(at(r, mask, 100, 50), 0); assert.equal(at(r, mask, 40, 40), 0);
  for (let i = 0; i < mask.length; i++) if (r.data[i * 4 + 3] === 0) assert.equal(mask[i], 0);
  assert.throws(() => run(r, [79, 25]), /sichtbare/);
});

test('reduced representation is reusable and original pixels are immutable', () => {
  const r = split(), original = r.data.slice(), prepared = prepareIntelligent(r, { maxCoarsePixels: 2000 });
  assert.ok(prepared.scale > 1);
  const left = selectIntelligent(prepared, [25, 50]), right = selectIntelligent(prepared, [130, 50]);
  checkBoundary(r, left.mask, 80, 3, 12, r.height - 12);
  assert.equal(at(r, right.mask, 130, 50), 1); assert.equal(at(r, right.mask, 25, 50), 0);
  assert.deepEqual(r.data, original);
});

test('brush corrections and added disconnected islands retain the mask/polygon contract', () => {
  const r = split(), { mask } = run(r);
  paintSelection(mask, r.width, r.height, [[30, 30]], 10, false);
  paintSelection(mask, r.width, r.height, [[130, 70]], 10, true);
  const polygons = selectionPolygons(mask, r.width, r.height);
  assert.equal(polygons.length, 2); assert.equal(polygons[0].length, 2);
  assert.deepEqual(rasterizePolygons(polygons, r.width, r.height), mask);
});

test('downsampling does not turn an 8px river into an impassable blur halo', () => {
  for (const scale of [2, 3, 4, 8]) {
    const r = raster(320, 240, beige); rect(r, 120, 0, 8, r.height, blue);
    const { mask } = run(r, [30, 70], { maxCoarsePixels: Math.ceil(r.width * r.height / (scale * scale)) });
    assert.equal(total(mask), r.width * r.height, `scale ${scale}`);
  }
});

test('a narrow genuine land bridge connects two regions without closing the exterior', () => {
  const r = raster(160, 110, green);
  rect(r, 10, 20, 50, 70, pink); rect(r, 100, 20, 50, 70, pink); rect(r, 60, 51, 40, 5, pink);
  const { mask } = run(r, [30, 50]);
  assert.equal(at(r, mask, 120, 50), 1); assert.equal(at(r, mask, 80, 53), 1);
  assert.equal(at(r, mask, 80, 30), 0);
  assert.equal(selectionPolygons(mask, r.width, r.height).length, 1);
});

test('dominant land color protects thin peninsulas and islands without protecting rare ink', () => {
  const water = [92, 114, 157], land = [155, 154, 153];
  const r = raster(220, 140, water);
  rect(r, 145, 0, 75, 140, land);
  rect(r, 65, 53, 80, 6, land); // Narrow peninsula connected to broad land.
  rect(r, 30, 30, 6, 24, land); // Narrow but genuine island of the same color.
  rect(r, 45, 0, 3, 140, black); // A rare graphic overlay must still be bridged.
  rect(r, 85, 95, 2, 3, land); // A scan speck shares the dominant land color.
  const prepared = prepareIntelligent(r);
  for (const sensitivity of [5, 12, 18]) {
    const { mask } = selectIntelligent(prepared, [20, 90], sensitivity);
    assert.equal(at(r, mask, 100, 55), 0, `peninsula at ${sensitivity}`);
    assert.equal(at(r, mask, 33, 40), 0, `island at ${sensitivity}`);
    assert.equal(at(r, mask, 180, 90), 0, `land at ${sensitivity}`);
    assert.equal(at(r, mask, 90, 90), 1, `water beyond ink at ${sensitivity}`);
    assert.equal(at(r, mask, 46, 90), 1, `ink at ${sensitivity}`);
    assert.equal(at(r, mask, 85, 96), 1, `small scan mark at ${sensitivity}`);
    assert.deepEqual(rasterizePolygons(selectionPolygons(mask, r.width, r.height), r.width, r.height), mask);
  }
});

test('colored fill tolerates relief lightness variation without raising sensitivity into the land color', () => {
  const r = raster(320, 140, [155, 154, 153]);
  for (let x = 0; x < 220; x++) {
    const shade = Math.round((x - 110) / 110 * 18);
    rect(r, x, 0, 1, r.height, [92, 114, 157].map(v => v + shade));
  }
  const { mask } = selectIntelligent(prepareIntelligent(r), [110, 70], 5);
  for (const x of [10, 30, 180, 210]) assert.equal(at(r, mask, x, 70), 1, `shaded water ${x}`);
  assert.equal(at(r, mask, 280, 70), 0);
});

test('user river/relief crop: increasing sensitivity covers blue water without swallowing neutral islands', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/river-relief.json', import.meta.url)));
  const r = { width: fixture.width, height: fixture.height, data: new Uint8ClampedArray(inflateRawSync(Buffer.from(fixture.data, 'base64'))) };
  const prepared = prepareIntelligent(r);
  for (const sensitivity of [5, 12, 18]) {
    const { mask } = selectIntelligent(prepared, fixture.seed, sensitivity);
    // Interior colors are unambiguous on this particular blue/gray map. These
    // checks deliberately exclude JPEG/antialias transition pixels; they are
    // regression sentinels, not a claim of manually labeled full ground truth.
    let water = 0, selectedWater = 0, land = 0, selectedLand = 0;
    for (let i = 0; i < mask.length; i++) {
      const [red, green, blue] = r.data.subarray(i * 4, i * 4 + 3);
      if (blue - red > 22 && blue - green > 10) { water++; selectedWater += mask[i]; }
      if (Math.abs(red - green) < 5 && Math.abs(blue - green) < 5) { land++; selectedLand += mask[i]; }
    }
    assert.ok(land > 20000 && water > 20000);
    assert.ok(selectedLand / land < .001, `neutral land must remain outside at ${sensitivity}`);
    assert.ok(selectedWater / water > (sensitivity === 18 ? .93 : sensitivity === 12 ? .87 : .75), `water coverage at ${sensitivity}`);
    assert.equal(at(r, mask, 232, 98), 0, 'large real island');
    for (const [x, y] of [[122, 53], [172, 51], [77, 108]]) assert.equal(at(r, mask, x, y), 1, 'main connected water branches');
  }
});

function sideArm(thickness = 2) {
  const r = raster(240, 160, [155, 154, 153]);
  rect(r, 20, 20, 45, 120, [76, 100, 152]);
  rect(r, 65, 79, 145, thickness, [104, 132, 174]);
  rect(r, 120, 79, 2, thickness, black);
  rect(r, 200, 110, 30, 30, [212, 105, 112]);
  return r;
}

for (const thickness of [1, 2, 3]) test(`add learns a nuance in a ${thickness}px side arm from the original click, despite reduction`, () => {
  const r = sideArm(thickness), prepared = prepareIntelligent(r, { maxCoarsePixels: 1800 });
  assert.ok(prepared.scale >= 4);
  const first = selectIntelligent(prepared, [40, 40], 5);
  const saved = structuredClone(first.referenceModel);
  assert.equal(at(r, first.mask, 180, 79), 0, 'first selection missed the differently colored thin arm');
  const added = selectIntelligent(prepared, [150, 79], 5, true, first.referenceModel);
  for (const x of [80, 121, 150, 180, 205]) assert.equal(at(r, added.mask, x, 79), 1, `arm/ink at ${x}`);
  assert.equal(at(r, added.mask, 150, 70), 0, 'surrounding land is not the new reference');
  assert.equal(at(r, added.mask, 210, 120), 0, 'red area is excluded');
  assert.deepEqual(first.referenceModel, saved, 'history model must never mutate');
  assert.deepEqual(added.referenceModel.color, saved.color, 'the original anchor stays fixed');
  assert.equal(added.referenceModel.variants.length, 1);
  assert.equal(added.debug.continued, true);
  assert.deepEqual(rasterizePolygons(selectionPolygons(added.mask, r.width, r.height), r.width, r.height), added.mask);
});

test('a continued selection rejects land, red, transparent and isolated clicks without moving the seed', () => {
  const r = sideArm(), prepared = prepareIntelligent(r);
  const first = selectIntelligent(prepared, [40, 40], 5);
  for (const seed of [[150, 78], [215, 120]]) assert.throws(() => selectIntelligent(prepared, seed, 5, false, first.referenceModel), /bisherigen Flächenfarbe/);
  rect(r, 170, 50, 1, 1, [76, 100, 152]);
  assert.throws(() => selectIntelligent(prepared, [170, 50], 5, false, first.referenceModel), /zusammenhängende Farbstruktur/);
  rect(r, 180, 50, 1, 1, [0, 0, 0, 0]);
  assert.throws(() => selectIntelligent(prepared, [180, 50], 5, false, first.referenceModel), /sichtbare/);
});

test('an added one-pixel diagonal side arm follows corner contacts without filling land', () => {
  const r = raster(240, 160, [155, 154, 153]);
  rect(r, 20, 20, 45, 120, [76, 100, 152]);
  for (let x = 65; x < 210; x++) rect(r, x, 50 + Math.floor((x - 65) / 2), 1, 1, [104, 132, 174]);
  const p = prepareIntelligent(r), first = selectIntelligent(p, [40, 40], 5);
  const added = selectIntelligent(p, [151, 93], 5, false, first.referenceModel, first.mask);
  for (const x of [80, 120, 160, 200]) {
    const y = 50 + Math.floor((x - 65) / 2);
    assert.equal(at(r, added.mask, x, y), 1);
    assert.equal(at(r, added.mask, x, y + 2), 0);
  }
});

test('selection operations carry color history explicitly and reset it only with a new selection', () => {
  const r = sideArm(), process = createSelectionProcessor(r);
  const apply = (previous, operation) => process({ ...operation, mask: previous.mask.slice(), referenceModel: previous.referenceModel });
  const click = (mode, seed) => ({ type: 'select', algorithm: 'intelligent', mode, seed, tolerance: 5 });
  const empty = { mask: new Uint8Array(r.width * r.height), referenceModel: null };
  const first = apply(empty, click('replace', [40, 40]));
  const added = apply(first, click('add', [150, 79]));
  assert.ok(added.count > first.count);
  assert.equal(added.referenceModel.variants.length, 1);
  const painted = apply(added, { type: 'paint', stroke: [[35, 45]], diameter: 5, add: false });
  assert.deepEqual(painted.referenceModel, added.referenceModel);
  const correctedFirst = apply(first, { type: 'paint', stroke: [[35, 45]], diameter: 5, add: false });
  const correctedAddition = apply(correctedFirst, click('add', [150, 79]));
  assert.equal(at(r, correctedAddition.mask, 35, 45), 0, 'adding an arm does not refill an earlier brush correction');
  assert.equal(at(r, correctedAddition.mask, 150, 79), 1);
  const subtracted = apply(added, click('subtract', [215, 120]));
  assert.deepEqual(subtracted.referenceModel, added.referenceModel);
  // Restoring an old history snapshot must also restore its exact color memory,
  // even though the processor has already handled a newer learned variant.
  const afterUndo = apply(first, { type: 'paint', stroke: [[35, 45]], diameter: 5, add: false });
  assert.deepEqual(afterUndo.referenceModel, first.referenceModel);
  assert.equal(afterUndo.referenceModel.variants.length, 0);
  const afterRedo = apply(added, { type: 'paint', stroke: [[35, 45]], diameter: 5, add: false });
  assert.deepEqual(afterRedo.referenceModel, added.referenceModel);
  assert.throws(() => apply(added, click('add', [215, 120])), /bisherigen Flächenfarbe/);
  assert.deepEqual(apply(first, click('add', [150, 79])).referenceModel, added.referenceModel, 'failed requests do not poison the next result');
  const replaced = apply(added, click('replace', [215, 120]));
  assert.notDeepEqual(replaced.referenceModel.color, first.referenceModel.color);
  assert.equal(replaced.referenceModel.variants.length, 0);
  const cleared = apply({ ...added, mask: empty.mask }, { type: 'restore' });
  assert.equal(cleared.referenceModel, null);
  const restarted = apply(cleared, click('add', [215, 120]));
  assert.deepEqual(restarted.referenceModel, replaced.referenceModel);
  const classic = apply(added, { ...click('add', [215, 120]), algorithm: 'classic', contiguous: true });
  assert.equal(classic.referenceModel, null);
  assert.equal(at(r, classic.mask, 215, 120), 1, 'classic additions still allow another color');
});

test('a second click recovers a missed real river branch without learning the gray surroundings', () => {
  const f = JSON.parse(readFileSync(new URL('./fixtures/river-relief.json', import.meta.url)));
  const r = { width: f.width, height: f.height, data: new Uint8ClampedArray(inflateRawSync(Buffer.from(f.data, 'base64'))) };
  const p = prepareIntelligent(r), first = selectIntelligent(p, f.seed, 5);
  const seed = [85, 176];
  assert.equal(at(r, first.mask, ...seed), 0);
  const added = selectIntelligent(p, seed, 5, false, first.referenceModel, first.mask);
  assert.equal(at(r, added.mask, ...seed), 1);
  let recovered = 0, land = 0;
  for (let i = 0; i < added.mask.length; i++) if (added.mask[i] && !first.mask[i]) {
    recovered++;
    const [red, green, blue] = r.data.subarray(i * 4, i * 4 + 3);
    if (Math.abs(red - green) < 5 && Math.abs(blue - green) < 5) land++;
  }
  assert.ok(recovered > 250, 'follow the branch beyond the small click probe');
  assert.ok(land < 5, 'do not turn surrounding gray land into the learned color');
});
