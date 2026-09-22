const { test, expect } = require('@playwright/test');

let server;
test.beforeAll(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 4173, strictPort: true }
  });
  await server.listen();
});
test.afterAll(async () => {
  if (server) await server.close();
});

test('vereinfachter Georeferenzierungs-Workflow', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await openApp(page);

  await expect(page.getByRole('heading', { name: '2. Referenzpunkte' })).toBeVisible();
  for (const id of ['fitView', 'rotation', 'crs', 'prev', 'next', 'mesh', 'compare', 'searchParameters', 'validateFit', 'ranking']) {
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  }

  const overlay = page.locator('.leaflet-warped-image-layer');
  await expect(overlay).toHaveCount(1);
  await expect.poll(() => paintedPixels(overlay)).toBe(0);

  await loadSyntheticProject(page);
  await expect(page.locator('#pointList tr')).toHaveCount(5);
  await expect(page.locator('#alignmentLabel')).toHaveText('Automatisch angepasst');
  await expect.poll(() => paintedPixels(overlay)).toBeGreaterThan(1_000);

  const marker = page.locator('.point-marker').first();
  await expect(marker).toBeVisible();
  expect(await marker.evaluate(element => getComputedStyle(element).cursor)).toBe('crosshair');
  expect(await marker.evaluate(element => getComputedStyle(element, '::before').content)).not.toBe('none');
  await expect(marker.locator('span')).toHaveText('1');
  expect(await marker.locator('span').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(23, 108, 101)');
  await expect(page.locator('#sourceFit svg')).toHaveCount(1);

  await page.locator('#fitCrs').click();
  await expect(page.locator('#fitCrs')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('#automationInfo')).toContainText('Projektionsmodell');
  await expect(page.locator('#alignmentLabel')).toHaveText('Automatisch angepasst');
  await expect.poll(() => paintedPixels(overlay)).toBeGreaterThan(1_000);

  await page.screenshot({ path: 'output/playwright/workflow-smoke.png', fullPage: true });
  expect(pageErrors).toEqual([]);
});

test('eskaliert bei lokalen Verzerrungen automatisch zu TPS', async ({ page }) => {
  test.setTimeout(150_000);
  await openApp(page);
  await loadSyntheticProject(page, true);
  await expect(page.locator('#pointList tr')).toHaveCount(9);

  await page.locator('#fitCrs').click();
  await expect(page.locator('#fitCrs')).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator('#automationInfo')).toContainText('TPS-Korrektur verwendet');
  await expect(page.locator('#status')).toContainText('Projektionsmodell mit TPS-Korrektur');
  await expect.poll(() => paintedPixels(page.locator('.leaflet-warped-image-layer'))).toBeGreaterThan(1_000);

  const downloadEvent = page.waitForEvent('download');
  await page.locator('#saveProject').click();
  const download = await downloadEvent;
  const savedProject = await download.path();
  await page.reload();
  await page.locator('#projectFile').setInputFiles(savedProject);
  await expect(page.locator('#automationInfo')).toContainText('Gespeichertes Projektionsmodell mit TPS-Korrektur');
  await expect(page.locator('#pointList tr')).toHaveCount(9);
});

test('Originalbild zoomt ohne seitlichen Versatz', async ({ page }) => {
  await openApp(page);
  await loadSyntheticProject(page);
  await expect(page.locator('#pointList tr')).toHaveCount(5);

  const samples = await page.locator('#sourceMap').evaluate(async sourceMap => {
    const image = sourceMap.querySelector('.leaflet-image-layer');
    const zoomIn = sourceMap.querySelector('.leaflet-control-zoom-in');
    const positions = [];
    const record = () => {
      const imageBox = image.getBoundingClientRect();
      const mapBox = sourceMap.getBoundingClientRect();
      positions.push({
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
  // Leaflet may round the final CSS transform by a few device pixels.
  expect(Math.abs(afterWheel - beforeWheel)).toBeLessThan(5);
});

async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#sourceMap.leaflet-container')).toBeVisible();
  await expect(page.locator('#map.leaflet-container')).toBeVisible();
}

async function loadSyntheticProject(page, distorted = false) {
  const project = await page.evaluate(useDistortion => {
    const canvas = document.createElement('canvas');
    canvas.width = 180;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    context.fillStyle = '#e7ddc2';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#176c65';
    context.lineWidth = 4;
    for (let x = 15; x < canvas.width; x += 30) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, canvas.height); context.stroke();
    }
    for (let y = 15; y < canvas.height; y += 30) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(canvas.width, y); context.stroke();
    }

    const coordinates = useDistortion
      ? [[.08,.08], [.5,.08], [.92,.08], [.08,.5], [.5,.5], [.92,.5], [.08,.92], [.5,.92], [.92,.92]]
      : [[.1,.1], [.9,.1], [.1,.9], [.9,.9], [.5,.5]];
    const points = coordinates.map(([u, v], index) => ({
      id: index + 1,
      fit: true,
      source: { u, v },
      target: {
        lon: 10 + (u * 2 - 1) * 10 + (useDistortion ? 2.5 * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * v) : 0),
        lat: 50 + (1 - v * 2) * (10 * 2 / 3) + (useDistortion ? 1.8 * Math.sin(Math.PI * u) * Math.sin(2 * Math.PI * v) : 0)
      }
    }));
    return {
      format: 'pixelkarte-georeferenzierung',
      version: 2,
      image: { name: 'synthetische-karte.png', data: canvas.toDataURL('image/png') },
      points,
      alignment: { code: 'EPSG:4326', center: { lat: 50, lon: 10 }, halfWidth: 10, rotation: 0 },
      view: { center: { lat: 50, lon: 10 }, zoom: 4, basemap: 'esriTopo', opacity: 55, mesh: 20, showSource: true, showResiduals: true }
    };
  }, distorted);
  await page.locator('#projectFile').setInputFiles({
    name: 'synthetische-karte.georeferenzierung.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project))
  });
}

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
