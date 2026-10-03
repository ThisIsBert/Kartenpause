const { test, expect } = require('@playwright/test');

let server;
test.beforeAll(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    logLevel: 'error',
    cacheDir: 'node_modules/.vite-test-debug',
    server: { host: '127.0.0.1', port: Number(process.env.TEST_PORT || 4173), strictPort: true }
  });
  await server.listen();
});
test.afterAll(async () => { if (server) await server.close(); });

test('debug geometry collection vertex drag state', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#map.leaflet-container')).toBeVisible();
  await page.locator('#enterDrawing').click();
  const river = { type: 'MultiLineString', coordinates: [
    [[0, 0], [.3, 0], [.5, .5]], [[1, 1], [.7, .5], [.5, .5]]
  ] };
  const group = { type: 'GeometryCollection', geometries: [
    { type: 'MultiPoint', coordinates: [[-.2, 0], [1.2, 1]] }, river,
    { type: 'Polygon', coordinates: [[[2, 0], [3, 0], [3, 1], [2, 0]]] }
  ] };
  await page.locator('#importDrawingFile').setInputFiles({ name: 'group.geojson', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(group)) });
  await expect(page.locator('#drawingObjects button')).toHaveCount(1);
  await expect(page.locator('#drawingSelection')).toBeEnabled();
  const handle = await page.locator('.drawing-vertex').first().boundingBox();
  console.log('before', await page.evaluate(() => ({
    disabled: document.getElementById('drawingSelection').disabled,
    simplify: document.getElementById('simplifyDrawing').value,
    selected: [...document.querySelectorAll('#drawingObjects button')].map(b => b.getAttribute('aria-pressed')),
    status: document.getElementById('drawingStatus').textContent
  })));
  await page.mouse.move(handle.x + 9, handle.y + 9);
  await page.mouse.down();
  await page.mouse.move(handle.x + 25, handle.y + 25, { steps: 3 });
  await page.mouse.up();
  console.log('after', await page.evaluate(() => ({
    disabled: document.getElementById('drawingSelection').disabled,
    simplify: document.getElementById('simplifyDrawing').value,
    selected: [...document.querySelectorAll('#drawingObjects button')].map(b => b.getAttribute('aria-pressed')),
    status: document.getElementById('drawingStatus').textContent,
    active: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName
  })));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  console.log('copy enabled', await page.locator('#copyDrawing').isEnabled());
});