'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../desktop');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'];

async function setup(page, bridge = true) {
  await page.setContent(html);
  if (bridge) await page.evaluate(ids => {
    let channel;
    const fixture = window.fixture = {
      sources: ids.map((assetId, i) => ({ assetId, name: `Synthetic ${i + 1}`, size: 10, inspection: { format: 'test', mime: null, streams: [] } })),
      snapshot(revision, indices, cleanup = []) { channel.onmessage({ revision, sources: indices.map(i => this.sources[i]), cleanup }); }
    };
    window.__TAURI__ = { core: {
      Channel: class {},
      convertFileSrc: id => `lvovd-media://localhost/${id}`,
      async invoke(command, args) {
        if (command === 'desktop_handshake') return { protocolVersion: 1, appVersion: 'test', webviewVersion: 'test' };
        if (command === 'subscribe_sources') { channel = args.channel; fixture.snapshot(0, []); return; }
        if (command === 'runtime_health') return Object.fromEntries(['ffmpeg', 'ffprobe', 'ytdlp', 'providerRuntime'].map(key => [key, { installed: true, version: 'test' }]));
        if (command === 'pick_source') return new Promise(resolve => { fixture.resolvePick = i => resolve(fixture.sources[i]); });
        if (command === 'remove_source') return new Promise((resolve, reject) => { fixture.rejectRemoval = () => reject({ message: 'obsolete failure' }); });
        throw new Error('Unexpected command');
      }
    } };
  }, ids);
  await page.addScriptTag({ path: path.join(root, 'native.js') });
  await page.addScriptTag({ path: path.join(root, 'app.js') });
}

test('desktop picker acknowledgement waits for authoritative channel membership', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.fixture.snapshot(1, [0]));
  await page.locator('#add-file').click();
  await page.evaluate(() => window.fixture.resolvePick(1));
  await expect(page.locator('#add-file')).toBeEnabled();
  await expect(page.locator('#media-name')).toHaveText('Synthetic 1');
  await page.evaluate(() => window.fixture.snapshot(2, [0, 1]));
  await expect(page.locator('#media-name')).toHaveText('Synthetic 2');
  await expect(page.locator('#remove-file')).toBeEnabled();
});

test('desktop late removal failure and older snapshot cannot revive cleanup or replace selection', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.fixture.snapshot(1, [0, 1]));
  await page.locator('#remove-file').click();
  await page.evaluate(() => window.fixture.snapshot(2, [1, 2]));
  await page.locator('#files').selectOption(ids[2]);
  const status = await page.locator('#status').textContent();
  await page.evaluate(() => { window.fixture.rejectRemoval(); window.fixture.snapshot(1, [0, 1], [window.fixture.sources[0].assetId]); });
  await expect(page.locator('#media-name')).toHaveText('Synthetic 3');
  await expect(page.locator('#files option')).toHaveCount(2);
  await expect(page.locator('#cleanup button')).toHaveCount(0);
  await expect(page.locator('#status')).toHaveText(status);
});

test('desktop adapter does not silently fall back to browser HTTP authority', async ({ page }) => {
  await setup(page, false);
  await expect(page.locator('#connection')).toHaveText('Desktop unavailable');
  await expect(page.locator('#add-file')).toBeDisabled();
  await expect(page.locator('#recheck')).toBeDisabled();
  await expect(page.locator('#status')).toContainText('lvovd.exe');
  await expect(page.locator('#status')).toContainText('npm run build:desktop');
});
