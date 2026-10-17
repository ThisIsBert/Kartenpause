import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

test('agent CLI workflow resolves raster proposals and place names, fits and binds assignments to the source image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kartenpause-landmarks-'));
  const width = 400, height = 300;
  const pixels = [[40, 40], [360, 40], [40, 260], [360, 260], [100, 100], [220, 110], [120, 210], [300, 200]];
  const target = ([x, y]) => ({ lon: 10 + x * .003, lat: 50 - y * .003 });
  const raster = Buffer.alloc(width * height * 3, 255);
  const disk = ([cx, cy]) => {
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= 4) raster.fill(0, (y * width + x) * 3, (y * width + x) * 3 + 3);
  };
  pixels.forEach((p, i) => { disk(p); disk([p[0] + (i % 2 ? 12 : -12), p[1] + (i % 3 - 1) * 12]); });
  const file = name => join(directory, name);
  const save = (name, value) => writeFile(file(name), JSON.stringify(value));
  const run = (command, args, success = true) => {
    const r = spawnSync(process.execPath, ['scripts/headless.mjs', command, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(r.status, success ? 0 : 1, r.stderr);
    return JSON.parse(success ? r.stdout : r.stderr.trim().split('\n').at(-1));
  };
  try {
    await sharp(raster, { raw: { width, height, channels: 3 } }).png().toFile(file('map.png'));
    await save('regions.json', { regions: pixels.map(([x, y], i) => ({ id: `town-${i}`, left: x - 19, top: y - 19, width: 39, height: 39 })) });
    const symbols = run('symbols', ['--image', file('map.png'), '--request', file('regions.json'), '--out', file('symbols.json')]);
    assert.ok(symbols.regions.every(r => r.observations.length === 2));
    await save('gazetteer.json', pixels.map((p, i) => ({ id: `place-${i}`, name: `Town ${i}`, target: target(p), source: 'independent synthetic gazetteer' })));
    await save('queries.json', { queries: pixels.map((_, i) => `Town ${i}`) });
    const places = run('lookup', ['--reference', file('gazetteer.json'), '--request', file('queries.json')]);
    await save('landmarks.json', { image: symbols.image, options: { codes: ['EPSG:4326'], maxErrorPixels: 2 }, landmarks: symbols.regions.map((r, i) => ({ id: r.id, observations: r.observations, candidates: places.queries[i].candidates })) });
    const assigned = run('assign', ['--image', file('map.png'), '--request', file('landmarks.json'), '--out', file('assignments.json')]);
    assert.equal(assigned.status, 'assigned');
    assert.equal(assigned.assignments.length, pixels.length);
    assigned.assignments.forEach((p, i) => assert.deepEqual(p.pixel, pixels[i]));
    assigned.options = { codes: ['EPSG:4326'], families: [], tps: 'never' };
    await save('fit.json', assigned);
    const fitted = run('fit', ['--image', file('map.png'), '--request', file('fit.json'), '--out', file('project.json')]);
    assert.ok(fitted.report.validation.rms < 1e-5);
    await save('transform.json', { pixels: [[181, 171]] });
    const transformed = run('transform', ['--project', file('project.json'), '--request', file('transform.json')]).coordinates[0];
    assert.ok(Math.abs(transformed.lon - target([181, 171]).lon) < 1e-8);
    assert.ok(Math.abs(transformed.lat - target([181, 171]).lat) < 1e-8);
    await save('review.json', { ...assigned, status: 'needs-review' });
    assert.match(run('fit', ['--image', file('map.png'), '--request', file('review.json'), '--out', file('rejected.json')], false).error, /requires review/);
    await save('wrong-image.json', { ...assigned, image: { sha256: '0'.repeat(64) } });
    assert.match(run('fit', ['--image', file('map.png'), '--request', file('wrong-image.json'), '--out', file('rejected.json')], false).error, /different source image/);
    assert.equal(JSON.parse(await readFile(file('assignments.json'), 'utf8')).image.sha256, symbols.image.sha256);
  } finally {
    const root = resolve(directory), location = relative(resolve(tmpdir()), root);
    assert.ok(location && !location.startsWith('..') && !isAbsolute(location), 'cleanup must stay inside the temporary directory');
    await rm(root, { recursive: true, force: true });
  }
});
