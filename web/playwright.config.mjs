import { defineConfig, devices } from '@playwright/test';

const capture = process.env.PLAYWRIGHT_CAPTURE !== '0';

export default defineConfig({
  testDir: './test',
  testMatch: 'browser.spec.mjs',
  fullyParallel: true,
  workers: 2,
  timeout: 30000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4178',
    trace: capture ? 'retain-on-failure' : 'off',
    screenshot: capture ? 'only-on-failure' : 'off',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
    { name: 'iphone-chromium-touch', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
  ],
  webServer: {
    command: 'node test/preview.mjs',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
  },
});
