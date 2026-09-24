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
      if (traceKind === 'polygon') context.strokeRect(25, 25, 130, 70);
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
  await expect(page.locator('#enterDrawing')).toBeDisabled();
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
});

for (const kind of ['line', 'polygon']) test(`Pinsel erkennt ${kind} aus der Pixelkarte`, async ({ page, context }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await openApp(page); await loadSyntheticProject(page, false, kind);
  await page.locator('#enterDrawing').click();
  const map = page.locator('#map');
  await expect.poll(async () => Math.round((await map.boundingBox()).width)).toBe(1120);
  const bounds = await page.locator('.leaflet-warped-image-layer').evaluate(canvas => {
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
  // Recognition must still use full-contrast raster pixels with an invisible overlay.
  await page.locator('#drawingOpacity').fill('0');
  await page.locator('[data-tool="brush"]').click();
  await page.locator('#brushWidth').fill('32');
  await expect(page.locator('#brushWidthValue')).toHaveText('32 px');
  const box = await map.boundingBox();
  const { left, right, top, bottom } = bounds;
  const stroke = kind === 'line' ? [[left + 5, top + 6], [right - 5, top + 6]]
    : [[left + 5, top + 5], [right - 5, top + 5], [right - 5, bottom - 5], [left + 5, bottom - 5], [left + 5, top + 5]];
  await page.mouse.move(box.x + stroke[0][0], box.y + stroke[0][1]); await page.mouse.down();
  for (const p of stroke.slice(1)) await page.mouse.move(box.x + p[0], box.y + p[1], { steps: 20 });
  await page.mouse.up();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await expect(page.locator('#drawingStatus')).toContainText('erkannt');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#copyDrawing').click();
  const object = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(object.geometry.type).toBe(kind === 'line' ? 'LineString' : 'Polygon');
  if (kind === 'line') expect(object.geometry.coordinates.every(p => Math.abs(p[1] - 50) < .2)).toBe(true);
  await page.locator('#undoDrawing').click(); await expect(page.locator('#drawingObjects button')).toHaveCount(0);
  await page.locator('#redoDrawing').click(); await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await page.locator('[data-tool="brush"]').click();
  await page.mouse.move(box.x + 80, box.y + 80); await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 80, { steps: 10 }); await page.mouse.up();
  await expect(page.locator('#drawingStatus')).toContainText('Keine ausreichend');
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await page.mouse.move(box.x + 80, box.y + 80); await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 80, { steps: 5 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('.tracing-brush')).toBeHidden();
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  expect(errors).toEqual([]);
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
  await page.locator('#pixelView').check();
  const { left, right, top, bottom } = await darkRasterBounds(page);
  const y = (top + bottom) / 2, middle = (left + right) / 2;
  await page.locator('[data-tool="magnetic"]').click();
  const bounds = await map.boundingBox();
  await page.mouse.move(bounds.x + middle, bounds.y + y);
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
