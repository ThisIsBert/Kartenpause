const { test, expect } = require('@playwright/test');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

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

test('alle veröffentlichten Testkarten lassen sich laden', async ({ page }) => {
  const directory = path.resolve('examples');
  const files = readdirSync(directory).filter(file => file.endsWith('.georeferenzierung.json')).sort();
  expect(files).toHaveLength(6);

  for (const file of files) {
    const project = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
    await page.goto('/');
    await page.locator('#projectFile').setInputFiles(path.join(directory, file));
    await expect(page.locator('#pointList tr')).toHaveCount(project.points.length);
    await expect(page.locator('#notice')).toContainText('Projekt geladen.');
    await expect(page.locator('#alignmentLabel')).toHaveText('Automatisch angepasst');
  }
});
