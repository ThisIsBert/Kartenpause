const { test, expect } = require('@playwright/test');

let server;
test.beforeAll(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    logLevel: 'error',
    cacheDir: `node_modules/.vite-test-${process.env.TEST_PORT || 4173}`,
    server: { host: '127.0.0.1', port: Number(process.env.TEST_PORT || 4173), strictPort: true }
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

test('Pixelkarte zoomt während der Animation synchron mit Polygonen', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await loadSyntheticProject(page);
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  await page.locator('[data-tool="polygon"]').click();
  for (const position of [{ x: 400, y: 350 }, { x: 650, y: 350 }, { x: 525, y: 550 }]) await map.click({ position });
  await page.keyboard.press('Enter');
  for (const action of ['in', 'out', 'wheel']) {
    const samples = await page.locator('#map').evaluate(async (container, action) => {
      const raster = container.querySelector('.leaflet-warped-image-layer');
      const polygon = container.querySelector('.leaflet-drawingShapes-pane path');
      const initial = raster.getBoundingClientRect(), shape = polygon.getBoundingClientRect();
      const u = (shape.x + shape.width / 2 - initial.x) / initial.width;
      const v = (shape.y + shape.height / 2 - initial.y) / initial.height;
      const samples = [];
      if (action === 'wheel') {
        const box = container.getBoundingClientRect();
        container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: box.x + 700, clientY: box.y + 300 }));
      } else container.querySelector(`.leaflet-control-zoom-${action}`).click();
      const until = performance.now() + 650;
      while (performance.now() < until) {
        await new Promise(requestAnimationFrame);
        if (!container.querySelector('.leaflet-zoom-anim')) continue;
        const image = raster.getBoundingClientRect(), current = polygon.getBoundingClientRect();
        samples.push({ error: Math.hypot(image.x + image.width * u - current.x - current.width / 2,
          image.y + image.height * v - current.y - current.height / 2),
          scale: new DOMMatrix(getComputedStyle(raster).transform).a });
      }
      return samples;
    }, action);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.some(sample => Math.abs(sample.scale - 1) > .05)).toBe(true);
    expect(Math.max(...samples.map(sample => sample.error))).toBeLessThan(2);
    await expect.poll(() => page.locator('.leaflet-warped-image-layer').evaluate(canvas => new DOMMatrix(getComputedStyle(canvas).transform).a)).toBe(1);
    expect(await paintedPixels(page.locator('.leaflet-warped-image-layer'))).toBeGreaterThan(1000);
  }
  expect(errors).toEqual([]);
});

async function loadSyntheticProject(page, distorted = false, traceKind = null) {
  const project = await page.evaluate(({ useDistortion, traceKind }) => {
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

    if (traceKind) {
      context.fillStyle = '#fff'; context.fillRect(0, 0, 180, 120);
      context.strokeStyle = '#111'; context.lineWidth = 2;
      if (traceKind === 'denseWand') {
        context.fillStyle = '#111';
        for (let y = 20; y < 100; y += 4) for (let x = 20; x < 160; x += 4) context.fillRect(x, y, 2, 2);
      }
      else if (traceKind === 'cleanupWand') {
        context.fillStyle = '#111'; context.fillRect(20, 20, 100, 80); context.fillRect(140, 30, 1, 1);
        context.fillStyle = '#fff'; context.fillRect(40, 40, 1, 1);
      }
      else if (traceKind === 'wand') {
        context.fillStyle = '#111'; context.fillRect(20, 20, 100, 80); context.fillRect(140, 30, 20, 20);
        context.fillStyle = '#323232'; context.fillRect(70, 20, 50, 80);
        context.fillStyle = '#fff'; context.fillRect(40, 40, 25, 25);
      }
      else if (traceKind === 'wandMemory') {
        context.fillStyle = 'rgb(155,154,153)'; context.fillRect(0, 0, 180, 120);
        context.fillStyle = 'rgb(76,100,152)'; context.fillRect(20, 20, 45, 80);
        context.fillStyle = 'rgb(104,132,174)'; context.fillRect(65, 59, 90, 3);
        context.fillStyle = 'rgb(212,105,112)'; context.fillRect(120, 85, 35, 20);
      }
      else if (traceKind === 'boundary') {
        context.fillStyle = '#dda96e'; context.fillRect(0, 0, 90, 120);
        context.fillStyle = '#6eb4dc'; context.fillRect(90, 0, 90, 120);
      }
      else if (traceKind === 'polygon') context.strokeRect(25, 25, 130, 70);
      else { context.beginPath(); context.moveTo(20, 60); context.lineTo(160, 60); context.stroke(); }
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
  }, { useDistortion: distorted, traceKind });
  await page.locator('#projectFile').setInputFiles({
    name: 'synthetische-karte.georeferenzierung.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(project))
  });
}

test('Zeichenmodus: alle Geometrien bearbeiten, kopieren und exportieren', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openApp(page);
  await expect(page.locator('#enterDrawing')).toBeEnabled();
  await loadSyntheticProject(page);
  await page.locator('#enterDrawing').click();
  await expect(page.locator('#drawingSidebar')).toBeVisible();
  await expect(page.locator('#sidebar')).toBeHidden();
  await expect(page.locator('#sourcePanel')).toBeHidden();
  await expect(page.locator('#map .point-marker')).toHaveCount(0);
  await expect.poll(() => paintedPixels(page.locator('.leaflet-warped-image-layer'))).toBeGreaterThan(1000);
  const map = page.locator('#map');
  // Await the grid transition so the same clicks refer to stable map coordinates.
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  for (const kind of ['point', 'line', 'polygon', 'curve', 'curvePolygon']) {
    await page.locator(`[data-tool="${kind}"]`).click();
    await map.click({ position: { x: 320, y: 300 } });
    if (kind !== 'point') {
      await expect(page.locator('#saveDrawing')).toBeDisabled();
      await map.click({ position: { x: 470, y: 210 } });
      await map.click({ position: { x: 600, y: 360 } });
      await page.keyboard.press('Enter');
    }
  }
  await expect(page.locator('#drawingObjects button')).toHaveCount(5);
  await expect(page.locator('.drawing-vertex')).toHaveCount(3);
  await expect(page.locator('.drawing-midpoint')).toHaveCount(3);
  await page.locator('.drawing-midpoint').last().click();
  await expect(page.locator('.drawing-vertex')).toHaveCount(4);
  const vertex = page.locator('.drawing-vertex').last();
  const box = await vertex.boundingBox();
  await page.mouse.move(box.x + 9, box.y + 9);
  await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 45, { steps: 5 }); await page.mouse.up();
  await page.locator('#drawingName').fill('Historische Grenze');
  await page.locator('#drawingName').press('Tab');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copyDrawing').click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.type).toBe('Feature');
  expect(copied.properties.name).toBe('Historische Grenze');
  expect(copied.properties.controlPoints).toHaveLength(4);
  expect(copied.geometry.type).toBe('Polygon');
  expect(copied.geometry.coordinates[0].length).toBeGreaterThan(100);
  expect(copied.geometry.coordinates[0][0]).toEqual(copied.geometry.coordinates[0].at(-1));
  await page.locator('#drawingObjects button').first().click();
  await page.keyboard.press('Control+c');
  const copiedPoint = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copiedPoint.geometry.type).toBe('Point');
  const pointBox = await page.locator('.drawing-vertex').boundingBox();
  await page.mouse.move(pointBox.x + 9, pointBox.y + 9); await page.mouse.down();
  await page.mouse.move(pointBox.x + 60, pointBox.y + 40, { steps: 5 }); await page.mouse.up();
  await page.locator('#copyDrawing').click();
  const movedPoint = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(movedPoint.geometry.coordinates).not.toEqual(copiedPoint.geometry.coordinates);
  await page.locator('#undoDrawing').click();
  await page.locator('#copyDrawing').click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).geometry).toEqual(copiedPoint.geometry);
  await page.locator('#redoDrawing').click();
  await page.locator('#deleteDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(4);
  await page.locator('#undoDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(5);
  await page.locator('#drawingObjects button').last().click();
  await page.locator('.drawing-vertex').last().click();
  await page.locator('#deleteVertex').click();
  await expect(page.locator('.drawing-vertex')).toHaveCount(3);
  await expect(page.locator('#deleteVertex')).toBeDisabled();
  await page.locator('#undoDrawing').click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#saveDrawing').click();
  const download = await downloadEvent;
  const collection = JSON.parse(require('node:fs').readFileSync(await download.path(), 'utf8'));
  expect(download.suggestedFilename()).toBe('kartenpause.geojson');
  expect(collection.type).toBe('FeatureCollection');
  expect(collection.features.map(f => f.geometry.type)).toEqual(['Point', 'LineString', 'Polygon', 'LineString', 'Polygon']);
  for (const f of collection.features) {
    const coordinates = f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates;
    expect(coordinates.every(([lon, lat]) => Number.isFinite(lon) && Math.abs(lon) <= 180 && Number.isFinite(lat) && Math.abs(lat) <= 90)).toBe(true);
  }
  await page.screenshot({ path: 'output/playwright/drawing-mode.png', fullPage: true });
  await page.locator('#leaveDrawing').click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#map .point-marker:not(.predicted-marker)')).toHaveCount(5);
  await page.locator('#enterDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(5);
  await page.locator('[data-tool="polygon"]').click();
  await map.click({ position: { x: 350, y: 450 } });
  await expect(page.locator('#finishDrawing')).toBeDisabled();
  await page.locator('#leaveDrawing').click();
  await expect(page.locator('#drawingSidebar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawing-vertex')).toHaveCount(0);
  await expect(page.locator('#drawingObjects button')).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('Stützpunkte: kleine Quadrate, Cursor und Plus direkt herausziehen', async ({ page }) => {
  await openApp(page); await loadSyntheticProject(page);
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  await page.locator('[data-tool="line"]').click();
  await map.click({ position: { x: 300, y: 250 } });
  await map.click({ position: { x: 600, y: 250 } });
  await page.keyboard.press('Enter');
  const first = page.locator('.drawing-vertex').first();
  expect(await first.evaluate(e => getComputedStyle(e).cursor)).toBe('default');
  expect(await first.locator('span').evaluate(e => e.getBoundingClientRect().width)).toBe(8);
  await first.click();
  expect(await first.evaluate(e => getComputedStyle(e).cursor)).toBe('grab');
  const midpoint = await page.locator('.drawing-midpoint').boundingBox();
  await page.mouse.move(midpoint.x + 9, midpoint.y + 9); await page.mouse.down();
  await page.mouse.move(midpoint.x + 9, midpoint.y + 65, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.drawing-vertex')).toHaveCount(3);
  const added = await page.locator('.drawing-vertex').nth(1).boundingBox();
  expect(added.y - midpoint.y).toBeGreaterThan(50);
  await page.locator('#undoDrawing').click();
  await expect(page.locator('.drawing-vertex')).toHaveCount(2);
  await page.locator('#drawingName').fill('Römische Grenze');
  await page.locator('#drawingName').press('Tab');
  const saved = page.waitForEvent('download');
  await page.locator('#saveDrawing').click();
  expect((await saved).suggestedFilename()).toBe('Römische Grenze.geojson');
});

async function darkRasterBounds(page) {
  return page.locator('.leaflet-warped-image-layer').evaluate(canvas => {
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let left = width, right = 0, top = height, bottom = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 20 && data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return { left, right, top, bottom };
  });
}

test('Magnetisch: Originalpixel, Pipette, Vorschau, Zwischenanker und Export', async ({ page, context }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openApp(page); await loadSyntheticProject(page, false, 'line');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  await page.locator('#map .leaflet-control-zoom-in').click();
  await page.waitForTimeout(400);
  await page.locator('#pixelView').check();
  const { left, right, top, bottom } = await darkRasterBounds(page);
  const y = (top + bottom) / 2, middle = (left + right) / 2;
  await page.locator('[data-tool="magnetic"]').click();
  await map.hover({ position: { x: middle, y } });
  await expect(page.locator('#magneticPixel')).toContainText('Originalpixel');
  expect(await page.locator('#magneticLoupe').evaluate(c => c.getContext('2d').imageSmoothingEnabled)).toBe(false);
  await page.locator('#magneticPick').click();
  await map.click({ position: { x: middle, y } });
  await expect(page.locator('#magneticColor')).toContainText('#111111');
  await expect(page.locator('#cancelDrawing')).toBeDisabled();
  // Color and path must still come from original pixels at opacity zero.
  await page.locator('#drawingOpacity').fill('0');
  await map.click({ position: { x: left + 12, y } });
  await map.click({ position: { x: right - 12, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await expect(page.locator('#drawingObjects button')).toHaveCount(0);
  await expect(page.locator('#finishDrawing')).toBeDisabled();
  // Replace the endpoint with a closer intermediate anchor without committing.
  await map.click({ position: { x: middle, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.locator('#magneticReject').click();
  await expect(page.locator('#magneticAccept')).toBeDisabled();
  await map.click({ position: { x: middle, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.locator('#magneticAccept').click();
  await expect(page.locator('#finishDrawing')).toBeEnabled();
  await page.locator('#leaveDrawing').click();
  await expect(page.locator('#drawingSidebar')).toBeVisible();
  await map.click({ position: { x: right - 12, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page.locator('#finishDrawing')).toBeEnabled();
  await page.locator('#finishDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copyDrawing').click();
  const feature = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(feature.geometry.type).toBe('LineString');
  expect(feature.geometry.coordinates.every(p => Math.abs(p[1] - 50) < .15)).toBe(true);
  expect(feature.geometry.coordinates.at(-1)[0] - feature.geometry.coordinates[0][0]).toBeGreaterThan(12);
  await page.locator('#undoDrawing').click(); await expect(page.locator('#drawingObjects button')).toHaveCount(0);
  await page.locator('#redoDrawing').click(); await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await page.locator('[data-tool="magnetic"]').click();
  await map.click({ position: { x: left + 12, y } });
  await map.click({ position: { x: right - 12, y } });
  await page.keyboard.press('Escape');
  await expect(page.locator('#magneticSettings')).toBeHidden();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Magnetisch: Polygon erst nach bestätigter Schließkante', async ({ page, context }) => {
  await openApp(page); await loadSyntheticProject(page, false, 'polygon');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const { left, right, top, bottom } = await darkRasterBounds(page);
  await page.locator('[data-tool="magnetic"]').click();
  await map.click({ position: { x: left + 1, y: top + 1 } });
  for (const [x, y] of [[right - 1, top + 1], [right - 1, bottom - 1], [left + 1, bottom - 1]]) {
    await map.click({ position: { x, y } });
    await expect(page.locator('#magneticAccept')).toBeEnabled();
    await page.locator('#magneticAccept').click();
  }
  await page.locator('#magneticClose').click();
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await expect(page.locator('#drawingObjects button')).toHaveCount(0);
  await page.screenshot({ path: 'output/playwright/magnetic-preview.png', fullPage: true });
  await page.locator('#magneticAccept').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copyDrawing').click();
  const feature = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(feature.geometry.type).toBe('Polygon');
  expect(feature.geometry.coordinates[0][0]).toEqual(feature.geometry.coordinates[0].at(-1));
  await expect(page.locator('.drawing-vertex')).toHaveCount(feature.properties.controlPoints.length);
});

test('Magnetisch: Weiterklicken übernimmt, Zurückklicken korrigiert', async ({ page, context }) => {
  await openApp(page); await loadSyntheticProject(page, false, 'line');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const { left, right, top, bottom } = await darkRasterBounds(page), y = (top + bottom) / 2, span = right - left;
  await page.locator('[data-tool="magnetic"]').click();
  await map.click({ position: { x: left + 8, y } });
  await map.click({ position: { x: left + span * .45, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await map.click({ position: { x: left + span * .25, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.locator('#magneticReject').click();
  await expect(page.locator('#finishDrawing')).toBeDisabled();
  await map.click({ position: { x: left + span * .45, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await map.click({ position: { x: right - 8, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  // Reject only the new segment: the preceding one was accepted by that click.
  await page.locator('#magneticReject').click();
  await expect(page.locator('#finishDrawing')).toBeEnabled();
  await page.locator('#finishDrawing').click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copyDrawing').click();
  const feature = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(feature.geometry.coordinates.at(-1)[0]).toBeLessThan(11);
  expect(feature.geometry.coordinates[0][0]).toBeLessThan(4);
});

test('Magnetisch: zwei Pipettenfarben erkennen eine reine Flächengrenze', async ({ page, context }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openApp(page); await loadSyntheticProject(page, false, 'boundary');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const size = await map.boundingBox(), center = { x: size.width / 2, y: size.height / 2 };
  await page.locator('[data-tool="magnetic"]').click();
  await page.locator('#magneticPick').click(); await map.click({ position: { x: center.x - 50, y: center.y } });
  await page.locator('#magneticPick2').click(); await map.click({ position: { x: center.x + 50, y: center.y } });
  await expect(page.locator('#magneticColorMode')).toContainText('Übergang');
  await map.click({ position: { x: center.x, y: center.y - 60 } });
  await map.click({ position: { x: center.x, y: center.y + 60 } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.locator('#magneticAccept').click(); await page.locator('#finishDrawing').click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await page.locator('#copyDrawing').click();
  const feature = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(feature.geometry.coordinates.every(p => Math.abs(p[0] - 10) < .15)).toBe(true);
  expect(errors).toEqual([]);
});

test('Intelligenter Zauberstab: Farbgedächtnis, schmaler Seitenarm und atomarer Verlauf', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openApp(page); await loadSyntheticProject(page, false, 'wandMemory');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const colorPixel = async color => page.locator('.leaflet-warped-image-layer').evaluate((canvas, color) => {
    const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), points = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 20 && color.every((v, c) => Math.abs(v - data[i + c]) < 4)) points.push({ x, y });
    }
    if (!points.length) throw new Error('Testfarbe nicht gerendert.');
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length, cy = points.reduce((s, p) => s + p.y, 0) / points.length;
    return points.reduce((best, p) => Math.hypot(p.x - cx, p.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? p : best);
  }, color);
  const main = await colorPixel([76, 100, 152]), arm = await colorPixel([104, 132, 174]), red = await colorPixel([212, 105, 112]);
  await page.locator('[data-tool="wand"]').click();
  await page.locator('#wandAlgorithm').selectOption('intelligent'); await setRange(page, '#wandTolerance', 5);
  await page.evaluate(() => { window.kartenpauseWandDebugEnabled = true; });
  const count = async () => Number((await page.locator('#wandStatus').textContent()).match(/^[\d.]+/)?.[0]?.replaceAll('.', '') ?? NaN);
  const reference = () => page.evaluate(() => window.kartenpauseWandDebug.reference);
  const select = async (mode, position) => {
    await page.locator('#wandMode').selectOption(mode); await map.click({ position });
    await expect(page.locator('#wandStatus')).toContainText('Originalpixel ausgewählt');
  };
  await select('replace', main); const firstCount = await count(), original = await reference();
  await select('add', arm); const both = await count(); expect(both).toBeGreaterThan(firstCount);
  expect((await reference()).color).toEqual(original.color); expect((await reference()).variants).toHaveLength(1);
  await page.locator('#undoDrawing').click(); await expect.poll(count).toBe(firstCount);
  await page.locator('#redoDrawing').click(); await expect.poll(count).toBe(both);
  await page.locator('#undoDrawing').click(); await expect.poll(count).toBe(firstCount);
  await select('add', main); expect((await reference()).variants).toHaveLength(0);
  await select('add', arm); expect((await reference()).variants).toHaveLength(1);
  await map.click({ position: red }); await expect(page.locator('#wandStatus')).toContainText('bisherigen Flächenfarbe');
  await expect(page.locator('#finishDrawing')).toBeEnabled();
  await select('add', main); expect((await reference()).color).toEqual(original.color);
  await page.locator('#wandClear').click(); await expect.poll(count).toBe(0);
  await select('add', red); expect((await reference()).color).not.toEqual(original.color);
  expect((await reference()).variants || []).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('Intelligenter Zauberstab: Worker, Moduswechsel, Verlauf, Pinsel und MultiPolygon-Export', async ({ page, context }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openApp(page); await loadSyntheticProject(page, false, 'wand');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const { left, right, top, bottom } = await darkRasterBounds(page), sx = (right - left) / 140;
  const sample = { x: left + 10 * sx, y: top + (bottom - top) * .16 };
  const island = { x: left + 130 * sx, y: top + (bottom - top) * .25 };
  await page.locator('[data-tool="wand"]').click();
  await expect(page.locator('#wandAlgorithm')).toHaveValue('classic');
  await page.locator('#wandAlgorithm').selectOption('intelligent');
  await expect(page.locator('#wandToleranceLabel')).toHaveText('Empfindlichkeit');
  await expect(page.locator('#wandContiguous')).toBeDisabled();
  await page.evaluate(() => { window.kartenpauseWandDebugEnabled = true; });
  await map.click({ position: sample });
  await expect(page.locator('#wandStatus')).toContainText('1 Fläche(n)');
  const count = async () => Number((await page.locator('#wandStatus').textContent()).match(/^[\d.]+/)?.[0]?.replaceAll('.', '') ?? NaN);
  const first = await count();
  expect(await page.evaluate(() => {
    const d = window.kartenpauseWandDebug;
    return d.coarse.length === d.final.length && d.corridor.length === d.final.length && d.simplified.data.length > 0;
  })).toBe(true);
  await page.evaluate(async () => { await window.kartenpauseShowWandDebug(); });
  await expect(page.locator('#wandDebugDialog canvas')).toHaveCount(4);
  await page.screenshot({ path: 'output/playwright/intelligent-wand-debug.png', fullPage: true });
  await page.locator('#wandDebugDialog button').click();
  await page.locator('#wandMode').selectOption('add'); await map.click({ position: island });
  await expect(page.locator('#wandStatus')).toContainText('2 Fläche(n)');
  const both = await count(); expect(both).toBeGreaterThan(first);
  await page.locator('#wandMode').selectOption('subtract'); await map.click({ position: sample });
  await expect.poll(count).toBe(both - first);
  await page.locator('#undoDrawing').click(); await expect.poll(count).toBe(both);
  await page.locator('#redoDrawing').click(); await expect.poll(count).toBe(both - first);
  await page.locator('#undoDrawing').click(); await expect.poll(count).toBe(both);
  await page.locator('#wandAlgorithm').selectOption('classic');
  await expect(page.locator('#wandContiguous')).toBeEnabled();
  await expect.poll(count).toBe(both);
  await page.locator('#wandAlgorithm').selectOption('intelligent');
  await page.locator('#wandMode').selectOption('paintSubtract');
  const box = await map.boundingBox(), p = { x: box.x + left + 65 * sx, y: box.y + top + (bottom - top) * .78 };
  await page.mouse.click(p.x, p.y); await expect(page.locator('#finishDrawing')).toBeEnabled();
  await expect.poll(count).toBeLessThan(both);
  await page.locator('#wandMode').selectOption('paintAdd'); await page.mouse.click(p.x, p.y);
  await expect.poll(count).toBe(both);
  await page.screenshot({ path: 'output/playwright/intelligent-wand.png', fullPage: true });
  await page.locator('#finishDrawing').click();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await page.locator('#copyDrawing').click();
  const feature = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(feature.geometry.type).toBe('MultiPolygon');
  expect(feature.geometry.coordinates).toHaveLength(2);
  expect(feature.geometry.coordinates.some(polygon => polygon.length === 2)).toBe(true);
  expect(errors).toEqual([]);
});

test('Zauberstab: Auswahl, Inseln, Löcher, Korrekturpinsel und bearbeitbarer Export', async ({ page, context }) => {
  test.setTimeout(150_000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openApp(page); await loadSyntheticProject(page, false, 'wand');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const { left, right, top, bottom } = await darkRasterBounds(page), sx = (right - left) / 140;
  const sample = { x: left + 10 * sx, y: top + (bottom - top) * .16 };
  await page.locator('[data-tool="wand"]').click();
  await map.click({ position: sample });
  await expect(page.locator('#wandStatus')).toContainText('2 Fläche(n)');
  await expect(page.locator('#finishDrawing')).toBeEnabled();
  const selectedCount = async () => {
    const match = (await page.locator('#wandStatus').textContent()).match(/^[\d.]+/);
    return match ? Number(match[0].replaceAll('.', '')) : NaN;
  };
  const broadCount = await selectedCount();
  await setRange(page, '#wandTolerance', 0);
  await page.locator('#wandTolerance').dispatchEvent('change');
  await expect.poll(selectedCount).toBe(broadCount);
  await page.locator('#wandMode').selectOption('subtract');
  await map.click({ position: sample });
  await expect.poll(selectedCount).toBe(4000); // Only the exact dark color was removed, not the gray half.
  await page.locator('#undoDrawing').click(); await expect.poll(selectedCount).toBe(broadCount);
  await setRange(page, '#wandTolerance', 18);
  await page.locator('#wandMode').selectOption('replace');
  await page.locator('#wandContiguous').check();
  await expect(page.locator('#wandStatus')).not.toContainText('1 Fläche(n)');
  await map.click({ position: sample });
  await expect(page.locator('#wandStatus')).toContainText('1 Fläche(n)');
  const originalCount = await selectedCount();
  await page.locator('#wandMode').selectOption('paintSubtract');
  const box = await map.boundingBox(), location = { x: box.x + left + 70 * sx, y: box.y + top + (bottom - top) * .78 };
  await page.mouse.click(location.x, location.y);
  await expect(page.locator('#finishDrawing')).toBeEnabled();
  await expect.poll(selectedCount).toBeLessThan(originalCount);
  const removedCount = await selectedCount();
  await page.locator('#undoDrawing').click(); await expect.poll(selectedCount).toBe(originalCount);
  await page.locator('#redoDrawing').click(); await expect.poll(selectedCount).toBe(removedCount);
  await page.locator('#wandMode').selectOption('paintAdd');
  await page.mouse.click(location.x, location.y);
  await expect.poll(selectedCount).toBe(originalCount);
  await page.locator('#wandMode').selectOption('paintSubtract'); await page.mouse.click(location.x, location.y);
  await expect.poll(selectedCount).toBe(removedCount);
  await page.screenshot({ path: 'output/playwright/wand-selection.png', fullPage: true });
  await page.locator('#finishDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await page.locator('#copyDrawing').click();
  const before = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(before.geometry.type).toBe('Polygon'); expect(before.geometry.coordinates).toHaveLength(3);
  const hole = page.locator('.drawing-vertex[title^="Loch 1:"]').first(), vertex = await hole.boundingBox();
  await page.mouse.move(vertex.x + 9, vertex.y + 9); await page.mouse.down();
  await page.mouse.move(vertex.x + 20, vertex.y + 9, { steps: 5 }); await page.mouse.up();
  await page.locator('#copyDrawing').click();
  const after = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(after.geometry.coordinates[1]).not.toEqual(before.geometry.coordinates[1]);
  expect(after.geometry.coordinates[0]).toEqual(before.geometry.coordinates[0]);
  await page.locator('[data-tool="wand"]').click();
  await page.locator('#wandMode').selectOption('replace'); await page.locator('#wandContiguous').uncheck();
  await map.click({ position: sample }); await expect(page.locator('#finishDrawing')).toBeEnabled();
  await page.locator('#finishDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(2);
  await page.locator('#copyDrawing').click();
  const multi = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(multi.geometry.type).toBe('MultiPolygon');
  expect(multi.geometry.coordinates).toHaveLength(2);
  expect(multi.geometry.coordinates[0]).toHaveLength(2);
  const islandVertex = await page.locator('.drawing-vertex[title^="Teilfläche 2:"]').first().boundingBox();
  await page.mouse.move(islandVertex.x + 9, islandVertex.y + 9); await page.mouse.down();
  await page.mouse.move(islandVertex.x + 20, islandVertex.y + 10, { steps: 4 }); await page.mouse.up();
  await page.locator('#copyDrawing').click();
  const edited = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(edited.geometry.coordinates[0]).toEqual(multi.geometry.coordinates[0]);
  expect(edited.geometry.coordinates[1]).not.toEqual(multi.geometry.coordinates[1]);
  await setRange(page, '#simplifyDrawing', 80);
  await expect(page.locator('#simplifyStatus')).toContainText('Vorschau');
  await setRange(page, '#simplifyDrawing', 20);
  await expect(page.locator('#simplifyValue')).toHaveText('20 %');
  await expect(page.locator('#applySimplification')).toBeEnabled();
  await expect(page.locator('html')).not.toHaveClass(/app-busy/);
  // Changing the value during a pending request must supersede, not queue it.
  const cursor = await page.locator('#simplifyDrawing').evaluate(input => {
    for (const value of [15, 35, 65]) { input.value = value; input.dispatchEvent(new Event('input')); }
    return getComputedStyle(input).cursor;
  });
  expect(cursor).toBe('progress');
  await expect(page.locator('#applySimplification')).toBeEnabled();
  await expect(page.locator('#simplifyValue')).toHaveText('65 %');
  await expect(page.locator('html')).not.toHaveClass(/app-busy/);
  await expect(page.locator('#copyDrawing')).toBeDisabled();
  await setRange(page, '#simplifyDrawing', 0);
  await page.locator('#copyDrawing').click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(edited);
  await setRange(page, '#simplifyDrawing', 80);
  await expect(page.locator('#applySimplification')).toBeEnabled();
  await page.locator('#applySimplification').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/simplification-preview.png', fullPage: true });
  await page.locator('#applySimplification').click();
  await page.locator('#copyDrawing').click();
  const simplified = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(simplified.geometry.type).toBe('MultiPolygon');
  expect(simplified.geometry.coordinates).toHaveLength(2);
  expect(simplified.geometry.coordinates[0]).toHaveLength(2);
  expect(simplified.geometry.coordinates).not.toEqual(edited.geometry.coordinates);
  await page.locator('#undoDrawing').click(); await page.locator('#copyDrawing').click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(edited);
  await page.locator('#redoDrawing').click(); await page.locator('#copyDrawing').click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(simplified);
  await setRange(page, '#simplifyDrawing', 50); await page.locator('#cancelSimplification').click();
  await expect(page.locator('html')).not.toHaveClass(/app-busy/);
  await page.locator('#copyDrawing').click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(simplified);
  await page.locator('#deleteDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await page.locator('[data-tool="wand"]').click();
  await map.click({ position: sample }); await expect(page.locator('#finishDrawing')).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(page.locator('#wandSettings')).toBeHidden();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  expect(errors).toEqual([]);
});

async function paintedPixels(canvasLocator) {
  return canvasLocator.evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]) painted++;
    return painted;
  });
}

test('Vereinfachung: Kleinteile und Löcher verschwinden nur in der Vorschau und sind wiederherstellbar', async ({ page, context }) => {
  test.setTimeout(150_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await loadSyntheticProject(page, false, 'cleanupWand');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const bounds = await darkRasterBounds(page);
  await page.locator('[data-tool="wand"]').click();
  await map.click({ position: { x: bounds.left + 10, y: bounds.top + 10 } });
  await expect(page.locator('#finishDrawing')).toBeEnabled();
  await page.locator('#finishDrawing').click();
  const original = await copiedFeature(page, context);
  expect(original.geometry.coordinates).toHaveLength(2);
  expect(original.geometry.coordinates[0]).toHaveLength(2);
  await setRange(page, '#simplifyDrawing', 100);
  await expect(page.locator('#applySimplification')).toBeEnabled();
  await expect(page.locator('#simplifyStatus')).toContainText('2 → 1 Teilflächen, 1 → 0 Löcher');
  await setRange(page, '#simplifyDrawing', 0);
  expect(await copiedFeature(page, context)).toEqual(original);
  await setRange(page, '#simplifyDrawing', 100);
  await expect(page.locator('#applySimplification')).toBeEnabled();
  await page.locator('#applySimplification').click();
  const result = await copiedFeature(page, context);
  expect(result.id).toBe(original.id);
  expect(result.geometry.coordinates).toHaveLength(1);
  expect(result.geometry.coordinates[0]).toHaveLength(1);
  await page.locator('#undoDrawing').click(); expect(await copiedFeature(page, context)).toEqual(original);
  await page.locator('#redoDrawing').click(); expect(await copiedFeature(page, context)).toEqual(result);
  expect(errors).toEqual([]);
});

test('Vereinfachung: 40000 Punkte im Worker lassen die Oberfläche reagieren', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  const result = await page.evaluate(async () => {
    const vertices = Array.from({ length: 40000 }, (_, i) => {
      const a = i / 40000 * Math.PI * 2, r = 100 + .01 * Math.sin(i);
      return [r * Math.cos(a), r * Math.sin(a)];
    });
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 0);
    const worker = new Worker('/src/drawing/simplification-worker.js', { type: 'module' });
    try {
      const data = await new Promise((resolve, reject) => {
        worker.onmessage = e => resolve(e.data); worker.onerror = e => reject(new Error(e.message));
        worker.postMessage({ object: { kind: 'polygon', vertices }, amount: 50 });
      });
      return { ticks, error: data.error, points: data.result?.vertices.length };
    } finally { clearInterval(heartbeat); worker.terminate(); }
  });
  expect(result.error).toBeUndefined(); expect(result.ticks).toBeGreaterThan(0);
  expect(result.points).toBeLessThan(40000);
});

test('Vereinfachung: große Zauberstab-Objekte begrenzen Griffe und bleiben erneut einstellbar', async ({ page, context }) => {
  test.setTimeout(150_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await loadSyntheticProject(page, false, 'denseWand');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const bounds = await darkRasterBounds(page);
  await page.locator('[data-tool="wand"]').click();
  await map.click({ position: { x: bounds.left + 1, y: bounds.top + 1 } });
  await expect(page.locator('#finishDrawing')).toBeEnabled();
  await page.locator('#finishDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await expect(page.locator('#simplifyStatus')).toContainText('2800 Stützpunkte');
  expect(await page.locator('.drawing-vertex, .drawing-midpoint').count()).toBeLessThanOrEqual(600);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copyDrawing').click();
  const original = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  for (const amount of [25, 70, 100, 10]) {
    await setRange(page, '#simplifyDrawing', amount);
    await expect(page.locator('#applySimplification')).toBeEnabled();
    await expect(page.locator('#simplifyValue')).toHaveText(`${amount} %`);
    await expect(page.locator('#simplifyStatus')).toContainText('Teilflächen');
    await expect(page.locator('#simplifyStatus')).toContainText('Löcher');
    await expect(page.locator('html')).not.toHaveClass(/app-busy/);
  }
  await page.locator('#cancelSimplification').click(); await page.locator('#copyDrawing').click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(original);
  expect(errors).toEqual([]);
});

async function setRange(page, selector, value) {
  await page.locator(selector).evaluate((input, value) => {
    input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function copiedFeature(page, context) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copyDrawing').click();
  return JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
}

test('GeoJSON: Datei und Zwischenablage, Bearbeiten und exaktes Folgen eines Polygonrands ohne Pixelkarte', async ({ page, context }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page);
  await page.locator('#enterDrawing').click();
  await expect.poll(async () => Math.round((await page.locator('#map').boundingBox()).width)).toBe(1120);
  const polygon = { type: 'Feature', properties: { name: 'Quellfläche', category: 'test' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [.7, 1], [.3, 1], [0, 1], [0, 0]]] } };
  await page.locator('#importDrawingFile').setInputFiles({ name: 'test.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(polygon)) });
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  const imported = await copiedFeature(page, context);
  expect(imported.properties.category).toBe('test');
  await page.locator('#drawingName').fill('Neue Fläche'); await page.locator('#drawingName').press('Tab');
  expect((await copiedFeature(page, context)).properties.name).toBe('Neue Fläche');
  await page.locator('[data-tool="magnetic"]').click();
  await page.locator('#magneticSource').selectOption('polygon');
  await expect(page.locator('#magneticRasterSettings')).toBeHidden();
  const outline = page.locator('#map .leaflet-drawingShapes-pane path').first();
  await expect.poll(async () => Math.round((await outline.boundingBox()).width)).toBeGreaterThan(100);
  // Wait for fitBounds to finish before measuring the rendered boundary.
  await page.waitForTimeout(400);
  const box = await outline.boundingBox();
  for (const t of [.15, .5, .85]) await page.mouse.click(box.x + box.width * t, box.y);
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.locator('#magneticAccept').click();
  await page.locator('#finishDrawing').click();
  const line = await copiedFeature(page, context);
  expect(line.geometry.type).toBe('LineString');
  const coords = line.geometry.coordinates;
  for (const p of coords) expect(p[1]).toBeCloseTo(1, 10);
  for (const x of [.3, .7]) expect(coords.some(p => Math.abs(p[0] - x) < 1e-12)).toBe(true);
  await expect(page.locator('#drawingObjects button')).toHaveCount(2);
  await page.locator('#pasteDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(3);
  expect((await copiedFeature(page, context)).id).not.toBe(line.id);
  await page.locator('#undoDrawing').click();
  await expect(page.locator('#drawingObjects button')).toHaveCount(2);
  await page.evaluate(() => document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: (() => { const data = new DataTransfer(); data.setData('text/plain', '{broken'); return data; })() })));
  await expect(page.locator('#drawingStatus')).toContainText('Import fehlgeschlagen');
  await expect(page.locator('#drawingObjects button')).toHaveCount(2);
  expect(errors).toEqual([]);
});

for (const gap of [0, .01]) test(`GeoJSON: Randabschnitt folgt dem Nachbarpolygon mit Abstand ${gap}`,  async ({ page, context }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await page.locator('#enterDrawing').click();
  const feature = (name, ring) => ({ type: 'Feature', properties: { name }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
  const data = { type: 'FeatureCollection', features: [
    feature('Ziel', [[1, 0], [2, 0], [2, 1], [1, 1], [1, .8], [1.1, .5], [1, .2]]),
    feature('Quelle', [[0, 0], [1 - gap, 0], [1 - gap, .3], [1 - gap, .7], [1 - gap, 1], [0, 1]])
  ] };
  await page.locator('#importDrawingFile').setInputFiles({ name: 'neighbor.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await expect(page.locator('#drawingObjects button')).toHaveCount(2);
  await page.waitForTimeout(400);
  await page.locator('#reworkSection').click();
  await page.locator('#magneticSource').selectOption('polygon');
  const box = await page.locator('#map .leaflet-drawingShapes-pane path').first().boundingBox();
  await page.mouse.click(box.x, box.y + box.height * .1);
  await page.mouse.click(box.x, box.y + box.height * .9);
  await page.locator('#sectionMethod').selectOption('magnetic');
  await page.locator('#sectionConnect').click();
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.locator('#magneticAccept').click();
  await expect(page.locator('#sectionApply')).toBeEnabled();
  await page.locator('#sectionApply').click();
  const result = await copiedFeature(page, context);
  expect(result.properties.name).toBe('Ziel');
  expect(result.geometry.coordinates[0].some(p => Math.abs(p[0] - 1.1) < 1e-10)).toBe(false);
  for (const y of [.3, .7]) expect(result.geometry.coordinates[0].some(p => Math.abs(p[0] - (1 - gap)) < 1e-10 && Math.abs(p[1] - y) < 1e-10)).toBe(true);
  expect(errors).toEqual([]);
});

test('Weiterbearbeiten: bestehende Mehrfachfläche mit Pinsel korrigieren, verwerfen und ersetzen', async ({ page, context }) => {
  test.setTimeout(150_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await loadSyntheticProject(page, false, 'wand');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const { left, right, top, bottom } = await darkRasterBounds(page), sx = (right - left) / 140;
  await page.locator('[data-tool="wand"]').click();
  await map.click({ position: { x: left + 10 * sx, y: top + (bottom - top) * .16 } });
  await expect(page.locator('#finishDrawing')).toBeEnabled(); await page.locator('#finishDrawing').click();
  const hole = await page.locator('.drawing-vertex[title^="Teilfläche 1: Loch 1:"]').first().boundingBox();
  await page.mouse.move(hole.x + 9, hole.y + 9); await page.mouse.down();
  await page.mouse.move(hole.x + 13, hole.y + 9, { steps: 3 }); await page.mouse.up();
  const original = await copiedFeature(page, context);
  for (const apply of [false, true]) {
    await page.locator('#reworkArea').click();
    await expect(page.locator('#areaApply')).toBeEnabled();
    await expect(page.locator('[data-tool="line"]')).toBeDisabled();
    const before = await page.locator('#wandStatus').textContent();
    await page.locator('#wandMode').selectOption('paintSubtract');
    const box = await map.boundingBox();
    await page.mouse.click(box.x + left + 70 * sx, box.y + top + (bottom - top) * .78);
    await expect(page.locator('#areaApply')).toBeEnabled();
    await expect(page.locator('#wandStatus')).not.toHaveText(before);
    await page.locator(apply ? '#areaApply' : '#areaCancel').click();
    await expect(page.locator('#drawingObjects button')).toHaveCount(1);
    const result = await copiedFeature(page, context);
    expect(result.id).toBe(original.id); expect(result.properties.name).toBe(original.properties.name);
    if (!apply) expect(result).toEqual(original);
    else { expect(result.geometry.type).toBe('MultiPolygon'); expect(result.geometry.coordinates[0]).toHaveLength(3); }
  }
  await page.locator('#undoDrawing').click(); expect(await copiedFeature(page, context)).toEqual(original);
  await page.locator('#redoDrawing').click();
  await page.locator('#reworkArea').click(); await expect(page.locator('#areaApply')).toBeEnabled();
  await page.locator('#areaCancel').click();
  expect(errors).toEqual([]);
});

test('Weiterbearbeiten: Randabschnitt zwischen Kantenpunkten manuell ersetzen', async ({ page, context }) => {
  test.setTimeout(150_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await loadSyntheticProject(page);
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  await page.locator('[data-tool="polygon"]').click();
  for (const [x, y] of [[300, 300], [600, 300], [600, 600], [300, 600]]) await map.click({ position: { x, y } });
  await page.keyboard.press('Enter');
  const original = await copiedFeature(page, context);
  await page.locator('#reworkSection').click();
  await map.click({ position: { x: 500, y: 300 } }); await map.click({ position: { x: 400, y: 300 } });
  await expect(page.locator('#sectionOther')).toHaveCount(0);
  await map.click({ position: { x: 450, y: 260 } });
  await page.locator('#sectionConnect').click();
  await expect(page.locator('#sectionApply')).toBeEnabled();
  await page.screenshot({ path: 'output/playwright/section-replacement.png', fullPage: true });
  await page.locator('#sectionApply').click();
  const result = await copiedFeature(page, context);
  expect(result.id).toBe(original.id); expect(result.properties.controlPoints).toHaveLength(7);
  for (const point of original.properties.controlPoints) expect(result.properties.controlPoints).toContainEqual(point);
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await page.locator('#undoDrawing').click(); expect(await copiedFeature(page, context)).toEqual(original);
  await page.locator('#redoDrawing').click(); expect(await copiedFeature(page, context)).toEqual(result);
  await page.locator('#reworkSection').click(); await map.click({ position: { x: 600, y: 400 } });
  await page.locator('#sectionCancel').click(); expect(await copiedFeature(page, context)).toEqual(result);
  await page.locator('#undoDrawing').click();
  await page.locator('#reworkSection').click();
  await map.click({ position: { x: 400, y: 300 } }); await map.click({ position: { x: 500, y: 300 } });
  await map.click({ position: { x: 700, y: 450 } }); await map.click({ position: { x: 200, y: 450 } });
  await page.locator('#sectionConnect').click();
  await expect(page.locator('#sectionStatus')).toContainText('rot markiert');
  await expect(page.locator('#sectionApply')).toBeDisabled();
  await expect(page.locator('.leaflet-tooltip').filter({ hasText: 'Kreuzung zweier' }).first()).toBeVisible();
  await page.screenshot({ path: 'output/playwright/section-problem.png', fullPage: true });
  await page.locator('#sectionUndo').click();
  await expect(page.locator('.leaflet-tooltip').filter({ hasText: 'Kreuzung zweier' })).toHaveCount(0);
  await page.locator('#sectionCancel').click(); expect(await copiedFeature(page, context)).toEqual(original);
  expect(errors).toEqual([]);
});

test('Weiterbearbeiten: innerhalb eines Ersatzabschnitts magnetisch und manuell wechseln', async ({ page, context }) => {
  test.setTimeout(150_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await loadSyntheticProject(page, false, 'line');
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const { left, right, top, bottom } = await darkRasterBounds(page), y = (top + bottom) / 2, width = right - left;
  await page.locator('[data-tool="line"]').click();
  await map.click({ position: { x: left, y } }); await map.click({ position: { x: right, y } }); await page.keyboard.press('Enter');
  const original = await copiedFeature(page, context);
  await page.locator('#reworkSection').click();
  await map.click({ position: { x: left + width * .1, y } }); await map.click({ position: { x: left + width * .9, y } });
  await expect(page.locator('#sectionOther')).toHaveCount(0);
  await page.locator('#sectionMethod').selectOption('magnetic');
  await map.click({ position: { x: left + width * .4, y } });
  await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.locator('#sectionMethod').selectOption('manual');
  await expect(page.locator('#sectionMethod')).toHaveValue('magnetic');
  await page.locator('#magneticAccept').click();
  await page.locator('#sectionMethod').selectOption('manual');
  await map.click({ position: { x: left + width * .6, y } });
  await page.locator('#sectionMethod').selectOption('magnetic');
  await page.locator('#sectionConnect').click(); await expect(page.locator('#magneticAccept')).toBeEnabled();
  await page.locator('#magneticAccept').click(); await expect(page.locator('#sectionApply')).toBeEnabled();
  await page.locator('#sectionApply').click();
  const result = await copiedFeature(page, context);
  expect(result.id).toBe(original.id); expect(result.geometry.type).toBe('LineString');
  expect(result.geometry.coordinates[0]).toEqual(original.geometry.coordinates[0]);
  expect(result.geometry.coordinates.at(-1)).toEqual(original.geometry.coordinates.at(-1));
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  expect(errors).toEqual([]);
});

async function sourceImageOffset(page) {
  return page.locator('#sourceMap').evaluate(sourceMap => {
    const imageBox = sourceMap.querySelector('.leaflet-image-layer').getBoundingClientRect();
    const mapBox = sourceMap.getBoundingClientRect();
    return (imageBox.left + imageBox.width / 2) - (mapBox.left + mapBox.width / 2);
  });
}


test('GeoJSON: Fluss als ein Objekt, Punktgruppen und Sammlungen bleiben bearbeitbar', async ({ page, context }) => {
  const rounded = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'number' ? Number(v.toFixed(10)) : v));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await page.locator('#enterDrawing').click();
  const river = { type: 'Feature', properties: { name: 'Fluss' }, geometry: { type: 'MultiLineString', coordinates: [
    [[0, 0], [.3, 0], [.5, .5]], [[1, 1], [.7, .5], [.5, .5]]
  ] } };
  await page.locator('#importDrawingFile').setInputFiles({ name: 'river.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(river)) });
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  expect(rounded((await copiedFeature(page, context)).geometry)).toEqual(river.geometry);
  await page.waitForTimeout(400);
  await page.locator('[data-tool="magnetic"]').click();
  await page.locator('#magneticSource').selectOption('polygon');
  const paths = page.locator('#map .leaflet-drawingShapes-pane path');
  const first = await paths.nth(0).boundingBox(), second = await paths.nth(1).boundingBox();
  await page.mouse.click(first.x + first.width * .2, first.y + first.height);
  await page.mouse.click(second.x + second.width * .9, second.y + second.height * .15);
  await page.locator('#magneticAccept').click(); await page.locator('#finishDrawing').click();
  const traced = await copiedFeature(page, context);
  expect(traced.geometry.coordinates.some(p => Math.abs(p[0] - .5) < 1e-10 && Math.abs(p[1] - .5) < 1e-10)).toBe(true);
  const group = { type: 'GeometryCollection', geometries: [{ type: 'MultiPoint', coordinates: [[-.2, 0], [1.2, 1]] }, river.geometry,
    { type: 'Polygon', coordinates: [[[2, 0], [3, 0], [3, 1], [2, 0]]] }] };
  await page.locator('#importDrawingFile').setInputFiles({ name: 'group.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(group)) });
  await expect(page.locator('#drawingObjects button')).toHaveCount(3);
  await page.waitForTimeout(400);
  expect(rounded((await copiedFeature(page, context)).geometry)).toEqual(group);
  const handleLocator = page.locator('.drawing-vertex').first();
  await handleLocator.hover();
  const handle = await handleLocator.boundingBox();
  await page.mouse.move(handle.x + 9, handle.y + 9); await page.mouse.down();
  await page.mouse.move(handle.x + 25, handle.y + 25, { steps: 3 }); await page.mouse.up();
  await expect(page.locator('#copyDrawing')).toBeEnabled();
  expect((await copiedFeature(page, context)).geometry.geometries[0].coordinates[0]).not.toEqual([-.2, 0]);
  await page.locator('#undoDrawing').click();
  expect(rounded((await copiedFeature(page, context)).geometry)).toEqual(group);
  expect(errors).toEqual([]);
});


test('GeoJSON: Magnet zeichnet ohne nahe Kanten gerade und setzt mit jedem Klick fort', async ({ page, context }) => {
  await openApp(page); await page.locator('#enterDrawing').click();
  await expect.poll(async () => Math.round((await page.locator('#map').boundingBox()).width)).toBe(1120);
  await page.locator('[data-tool="magnetic"]').click();
  await page.locator('#magneticSource').selectOption('polygon');
  for (const [x, y] of [[300, 300], [500, 300], [400, 450]]) await page.locator('#map').click({ position: { x, y } });
  await page.locator('#magneticAccept').click(); await page.locator('#finishDrawing').click();
  const line = await copiedFeature(page, context);
  expect(line.geometry.type).toBe('LineString');
  expect(line.geometry.coordinates).toHaveLength(3);
});


for (const correction of ['points', 'faces']) test(`Randkorrektur: magnetischen Verlauf erhalten und ${correction} bearbeiten`, async ({ page, context }) => {
  test.setTimeout(120_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openApp(page); await page.locator('#enterDrawing').click();
  const target = { type: 'Feature', properties: { name: 'Ziel' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]] } };
  const source = { type: 'Feature', properties: { name: 'Schleife' }, geometry: { type: 'LineString', coordinates: [[1, 4], [3, 6], [1, 6], [3, 4]] } };
  await page.locator('#importDrawingFile').setInputFiles({ name: 'loop.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [target, source] })) });
  await page.waitForTimeout(400);
  const original = await copiedFeature(page, context);
  const box = await page.locator('#map .leaflet-drawingShapes-pane path').first().boundingBox();
  await page.locator('#reworkSection').click();
  await page.locator('#magneticSource').selectOption('polygon');
  await page.mouse.click(box.x + box.width * .25, box.y);
  await page.mouse.click(box.x + box.width * .75, box.y);
  await page.locator('#sectionMethod').selectOption('magnetic');
  await page.locator('#sectionConnect').click();
  await page.locator('#magneticAccept').click();
  await expect(page.locator('#sectionStatus')).toContainText('rot markiert');
  await expect(page.locator('#sectionApply')).toBeDisabled();
  const initialCount = await page.locator('.section-vertex').count();
  expect(initialCount).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#sectionUseRepair')).toBeVisible();
  await page.screenshot({ path: `output/playwright/section-editable-${correction}.png`, fullPage: true });
  if (correction === 'points') {
    const moveCorner = async () => {
      const handles = await page.locator('.section-vertex').all();
      const boxes = await Promise.all(handles.map(handle => handle.boundingBox()));
      const distance = handle => Math.hypot(handle.x + handle.width / 2 - (box.x + box.width * .75), handle.y + handle.height / 2 - (box.y - box.height * .5));
      const handle = boxes.sort((a, b) => distance(a) - distance(b))[0];
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .125, box.y - box.height * .25, { steps: 5 }); await page.mouse.up();
      await expect(page.locator('#sectionApply')).toBeEnabled();
    };
    await moveCorner();
    await page.locator('#sectionUndo').click();
    await expect(page.locator('#sectionApply')).toBeDisabled();
    await expect(page.locator('#sectionStatus')).toContainText('rot markiert');
    await expect(page.locator('.section-vertex')).toHaveCount(initialCount);
    await moveCorner();
    await page.locator('.section-midpoint').first().click();
    await expect(page.locator('.section-vertex')).toHaveCount(initialCount + 1);
    await page.locator('#sectionDeleteVertex').click();
    await expect(page.locator('.section-vertex')).toHaveCount(initialCount);
    await expect(page.locator('#sectionApply')).toBeEnabled();
  } else {
    await page.locator('#sectionUseRepair').click();
    await expect(page.locator('#sectionApply')).toBeEnabled();
  }
  await page.locator('#sectionApply').click();
  const result = await copiedFeature(page, context);
  expect(result.id).toBe(original.id);
  expect(result.geometry.type).toBe(correction === 'points' ? 'Polygon' : 'MultiPolygon');
  expect(result.geometry.coordinates).not.toEqual(original.geometry.coordinates);
  await expect(page.locator('.section-vertex')).toHaveCount(0);
  await page.locator('#undoDrawing').click(); expect(await copiedFeature(page, context)).toEqual(original);
  await page.locator('#redoDrawing').click(); expect(await copiedFeature(page, context)).toEqual(result);
  expect(errors).toEqual([]);
});