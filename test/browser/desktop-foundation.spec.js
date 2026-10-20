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
    let channel, connection = 0;
    const workbenchId = '20000000-0000-4000-8000-000000000001';
    const otherId = '20000000-0000-4000-8000-000000000002';
    const state = (id, revision = 0, indices = [], cleanup = []) => ({
      workbenchId: id, revision, queueRevision: 0, sources: indices.map(i => fixture.sources[i]),
      cleanup, jobs: [], results: [], importing: false, discarded: false
    });
    const fixture = window.fixture = {
      workbenchId, otherId, channels: [],
      sources: ids.map((assetId, i) => ({ assetId, name: `Synthetic ${i + 1}`, size: 10, inspection: { format: 'test', mime: null, streams: [] } })),
      snapshot(revision, indices, cleanup = [], intakeFailure = null) { channel.onmessage({ connectionId: connection, snapshot: { ...state(this.active || workbenchId, revision, indices, cleanup), intakeFailure } }); },
      stale(revision, indices) { this.channels[0].onmessage({ connectionId: 1, snapshot: state(workbenchId, revision, indices) }); }
    };
    window.__TAURI__ = { core: {
      Channel: class {},
      convertFileSrc: id => `lvovd-media://localhost/${id}`,
      async invoke(command, args) {
        if (command === 'desktop_handshake') return { protocolVersion: 1, connectionGeneration: 0, appVersion: 'test', webviewVersion: 'test' };
        if (command === 'list_workbenches') return [state(workbenchId), ...(fixture.created ? [state(otherId)] : [])];
        if (command === 'create_workbench') { fixture.created = true; return state(otherId); }
        if (command === 'subscribe_workbench') {
          channel = args.channel; fixture.channels.push(channel); fixture.active = args.request.workbenchId;
          return { connectionId: ++connection, snapshot: state(fixture.active) };
        }
        if (command === 'acknowledge_workbench') return;
        if (command === 'runtime_health') return Object.fromEntries(['ffmpeg', 'ffprobe', 'ytdlp', 'providerRuntime'].map(key => [key, { installed: true, version: 'test' }]));
        if (command === 'pick_source') return new Promise(resolve => { fixture.resolvePick = i => resolve({ sources: [fixture.sources[i]], failure: null }); });
        if (command === 'remove_source') return new Promise((resolve, reject) => {
          fixture.rejectRemoval = () => reject({ message: 'obsolete failure' });
          fixture.resolveRemoval = () => resolve(state(args.request.workbenchId, 2, [1], [fixture.sources[0].assetId]));
        });
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

test('desktop workbench switch rejects delayed removal response and prior connection snapshots', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.fixture.snapshot(1, [0, 1]));
  await page.locator('#remove-file').click();
  await page.locator('#new-workbench').click();
  await expect(page.locator('#workbenches')).toHaveValue('20000000-0000-4000-8000-000000000002');
  await page.evaluate(() => window.fixture.snapshot(1, [2]));
  await expect(page.locator('#media-name')).toHaveText('Synthetic 3');
  await page.evaluate(() => { window.fixture.resolveRemoval(); window.fixture.stale(99, [0, 1]); });
  await expect(page.locator('#media-name')).toHaveText('Synthetic 3');
  await expect(page.locator('#files option')).toHaveCount(1);
  await expect(page.locator('#cleanup button')).toHaveCount(0);
});

test('desktop intake failures stay with their workbench and are visible on reopening', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.fixture.snapshot(1, [0], [], { code: 'SOURCE_READ', message: 'Could not open the selected file.' }));
  await expect(page.locator('#status')).toHaveText('Could not open the selected file.');
  await page.locator('#new-workbench').click();
  await expect(page.locator('#workbenches')).toHaveValue('20000000-0000-4000-8000-000000000002');
  await page.evaluate(() => window.fixture.snapshot(1, [1]));
  await expect(page.locator('#status')).not.toContainText('Could not open');
  await page.locator('#workbenches').selectOption('20000000-0000-4000-8000-000000000001');
  await page.evaluate(() => window.fixture.snapshot(2, [0], [], { code: 'SOURCE_READ', message: 'Could not open the selected file.' }));
  await expect(page.locator('#media-name')).toHaveText('Synthetic 1');
  await expect(page.locator('#status')).toHaveText('Could not open the selected file.');
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
