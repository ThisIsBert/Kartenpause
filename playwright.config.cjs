const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'output/playwright/report', open: 'never' }]
  ],
  outputDir: 'output/playwright/test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    channel: process.env.CI ? undefined : 'msedge',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
});
