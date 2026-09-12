'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 15000 },
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:3017', viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure' },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3017',
    env: { PORT: '3017', HOST: '127.0.0.1' },
    reuseExistingServer: false,
    timeout: 60000
  }
});
