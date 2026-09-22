const { test, expect } = require('@playwright/test');
const path = require('node:path');

let server;
test.beforeAll(async () => {
  const { startServer } = await import('./server.mjs');
  server = await startServer();
});
test.afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('vereinfachter Georeferenzierungs-Workflow', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await serveDependenciesLocally(page);

  await page.goto('/kartenprojektion_prototyp_v2_1.html');
  await page.waitForFunction(() => window.L && window.proj4 && window.numeric);

  await expect(page.getByRole('heading', { name: '2. Referenzpunkte' })).toBeVisible();
  for (const id of ['fitView', 'rotation', 'crs', 'prev', 'next', 'mesh']) {
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  }

  const overlay = page.locator('.leaflet-warped-image-layer');
  await expect(overlay).toHaveCount(1);
  await expect.poll(() => paintedPixels(overlay)).toBe(0);

  const fixture = path.resolve('Australien.angepasst.georeferenzierung.json');
  await page.locator('#projectFile').setInputFiles(fixture);
  await expect(page.locator('#pointList tr')).toHaveCount(5);
  await expect(page.locator('#alignmentLabel')).toHaveText('Automatisch angepasst');
  await expect.poll(() => paintedPixels(overlay)).toBeGreaterThan(1_000);

  const marker = page.locator('.point-marker').first();
  await expect(marker).toBeVisible();
  expect(await marker.evaluate(element => getComputedStyle(element).cursor)).toBe('crosshair');
  expect(await marker.evaluate(element => getComputedStyle(element, '::before').content)).not.toBe('none');
  await expect(marker.locator('span')).toHaveText('1');
  expect(await marker.locator('span').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(23, 108, 101)');
  const iconState = await page.evaluate(() => ({
    global: typeof window.lucide,
    createIcons: typeof window.lucide?.createIcons,
    sourceFitMarkup: document.getElementById('sourceFit').innerHTML
  }));
  expect(iconState).toEqual({ global: 'object', createIcons: 'function', sourceFitMarkup: expect.stringContaining('<svg') });

  await page.locator('#fitCrs').click();
  await expect(page.locator('#ranking button')).toHaveCount(14, { timeout: 45_000 });
  await expect(page.locator('#fitCrs')).toBeEnabled();
  await expect(page.locator('#alignmentLabel')).toHaveText('Automatisch angepasst');
  await expect.poll(() => paintedPixels(overlay)).toBeGreaterThan(1_000);

  await page.screenshot({ path: 'output/playwright/workflow-smoke.png', fullPage: true });
  expect(pageErrors).toEqual([]);
});

test('Originalbild zoomt ohne seitlichen Versatz', async ({ page }) => {
  await serveDependenciesLocally(page);
  await page.goto('/kartenprojektion_prototyp_v2_1.html');
  await page.waitForFunction(() => window.L && window.proj4 && window.numeric);
  await page.locator('#projectFile').setInputFiles(path.resolve('Australien.angepasst.georeferenzierung.json'));
  await expect(page.locator('#pointList tr')).toHaveCount(5);

  const samples = await page.locator('#sourceMap').evaluate(async sourceMap => {
    const image = sourceMap.querySelector('.leaflet-image-layer');
    const zoomIn = sourceMap.querySelector('.leaflet-control-zoom-in');
    const positions = [];
    const record = () => {
      const imageBox = image.getBoundingClientRect();
      const mapBox = sourceMap.getBoundingClientRect();
      positions.push({
        elapsed: performance.now(),
        offsetX: (imageBox.left + imageBox.width / 2) - (mapBox.left + mapBox.width / 2),
        zoomAnimating: sourceMap.classList.contains('leaflet-zoom-anim')
      });
    };
    record();
    zoomIn.click();
    const until = performance.now() + 500;
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame);
      record();
    }
    return positions;
  });

  const initialX = samples[0].offsetX;
  const maximumDrift = Math.max(...samples.map(sample => Math.abs(sample.offsetX - initialX)));
  expect(maximumDrift).toBeLessThan(2);
  expect(samples.some(sample => sample.zoomAnimating)).toBe(false);

  const mapBox = await page.locator('#sourceMap').boundingBox();
  const beforeWheel = await sourceImageOffset(page);
  await page.mouse.move(mapBox.x + mapBox.width * 0.2, mapBox.y + mapBox.height * 0.25);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(500);
  const afterWheel = await sourceImageOffset(page);
  expect(Math.abs(afterWheel - beforeWheel)).toBeLessThan(2);
});

async function paintedPixels(canvasLocator) {
  return canvasLocator.evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]) painted++;
    return painted;
  });
}

async function sourceImageOffset(page) {
  return page.locator('#sourceMap').evaluate(sourceMap => {
    const imageBox = sourceMap.querySelector('.leaflet-image-layer').getBoundingClientRect();
    const mapBox = sourceMap.getBoundingClientRect();
    return (imageBox.left + imageBox.width / 2) - (mapBox.left + mapBox.width / 2);
  });
}

async function serveDependenciesLocally(page) {
  const dependencies = new Map([
    ['https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css', ['leaflet', 'dist', 'leaflet.css']],
    ['https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js', ['leaflet', 'dist', 'leaflet.js']],
    ['https://cdn.jsdelivr.net/npm/proj4@2.21.0/dist/proj4.js', ['proj4', 'dist', 'proj4.js']],
    ['https://cdnjs.cloudflare.com/ajax/libs/numeric/1.2.6/numeric.min.js', ['numeric', 'numeric-1.2.6.js']],
    ['https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js', ['lucide', 'dist', 'umd', 'lucide.min.js']]
  ]);
  for (const [url, parts] of dependencies) {
    await page.route(url, route => route.fulfill({ path: path.resolve('node_modules', ...parts) }));
  }
}
