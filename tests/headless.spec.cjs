const { test, expect } = require('@playwright/test');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

let server, projectPath, affinePath;
test.beforeAll(async () => {
  const sharp = (await import('sharp')).default;
  const folder = path.resolve('output/headless/ui-test');
  mkdirSync(folder, { recursive: true });
  const image = path.join(folder, 'source.png'), request = path.join(folder, 'points.json');
  projectPath = path.join(folder, 'project.json');
  await sharp({ create: { width: 256, height: 256, channels: 4, background: '#2c91c0' } }).png().toFile(image);
  const points = [[20, 20], [230, 20], [25, 230], [230, 230], [120, 80], [80, 160]].map(pixel => ({ pixel, target: { lon: 10 + pixel[0] * .002 + .005 * (pixel[0] / 256) ** 2, lat: 50 - pixel[1] * .002 } }));
  writeFileSync(request, JSON.stringify({ points, options: { codes: ['EPSG:4326'], families: [], alignment: 'similarity', tps: 'always' } }));
  const result = spawnSync(process.execPath, ['scripts/headless.mjs', 'fit', '--image', image, '--request', request, '--out', projectPath], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  affinePath = path.join(folder, 'affine-project.json');
  const affinePoints = points.map(p => ({ pixel: p.pixel, target: { lon: 10 + p.pixel[0] * .002 + p.pixel[1] * .0004, lat: 50 - p.pixel[1] * .0028 + p.pixel[0] * .0003 } }));
  const affineRequest = path.join(folder, 'affine-points.json');
  writeFileSync(affineRequest, JSON.stringify({ points: affinePoints, options: { codes: ['EPSG:4326'], families: [], alignment: 'affine', tps: 'never' } }));
  const affineFit = spawnSync(process.execPath, ['scripts/headless.mjs', 'fit', '--image', image, '--request', affineRequest, '--out', affinePath], { encoding: 'utf8' });
  expect(affineFit.status, affineFit.stderr).toBe(0);
  const { createServer } = await import('vite');
  server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: Number(process.env.TEST_PORT || 4173), strictPort: true } });
  await server.listen();
});

test('an affine CLI project renders, retains its geometry when saved and clears it for a legacy project', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#leaveDrawing').click();
  await page.locator('#projectFile').setInputFiles(affinePath);
  await expect(page.locator('#notice')).toContainText('Projekt geladen.');
  await page.locator('#zoomImage').click();
  await expect.poll(() => page.locator('.leaflet-warped-image-layer').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; for (let i = 3; i < data.length; i += 4) if (data[i]) count++;
    return count;
  })).toBeGreaterThan(1000);
  const pending = page.waitForEvent('download');
  await page.locator('#saveProject').click();
  const saved = JSON.parse(readFileSync(await (await pending).path(), 'utf8'));
  const original = JSON.parse(readFileSync(affinePath, 'utf8'));
  expect(saved.version).toBe(4);
  expect(saved.alignment.affine).toEqual(original.alignment.affine);
  const { projectTransform } = await import('../src/headless/georeference.js');
  const transform = projectTransform(saved, 256, 256);
  const predicted = transform(137 / 256, 91 / 256);
  expect(predicted.lon).toBeCloseTo(10 + 137 * .002 + 91 * .0004, 9);
  expect(predicted.lat).toBeCloseTo(50 - 91 * .0028 + 137 * .0003, 9);
  await page.locator('#projectFile').setInputFiles(projectPath);
  await expect(page.locator('#automationInfo')).toContainText('TPS-Korrektur');
  const legacyPending = page.waitForEvent('download');
  await page.locator('#saveProject').click();
  const legacy = JSON.parse(readFileSync(await (await legacyPending).path(), 'utf8'));
  expect(legacy.version).toBe(3);
  expect(legacy.alignment.affine).toBeUndefined();
  expect(errors).toEqual([]);
});
test.afterAll(async () => { if (server) await server.close(); });

test('a project produced by the actual headless CLI loads and renders with TPS in the UI', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#leaveDrawing').click();
  await page.locator('#projectFile').setInputFiles(projectPath);
  await expect(page.locator('#notice')).toContainText('Projekt geladen.');
  await expect(page.locator('#pointList tr')).toHaveCount(6);
  await expect(page.locator('#automationInfo')).toContainText('TPS-Korrektur');
  await page.locator('#zoomImage').click();
  await expect.poll(async () => page.locator('.leaflet-warped-image-layer').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
    return count;
  })).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});
