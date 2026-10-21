'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../desktop');
require('../../scripts/desktop.cjs').prepare();
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'];

async function setup(page, bridge = true) {
  await page.setContent(html);
  if (bridge) await page.evaluate(ids => {
    let channel, connection = 0;
    const workbenchId = '20000000-0000-4000-8000-000000000001';
    const otherId = '20000000-0000-4000-8000-000000000002';
    const state = (id, revision = 0, indices = [], cleanup = []) => ({
      workbenchId: id, revision, queueRevision: 0, sources: indices.map(i => fixture.sources[i]),
      cleanup, jobs: [], results: [], importing: false, discarded: false, previews: [], waveforms: [], editors: [], processingRevisions: [], failedCleanup: []
    });
    const fixture = window.fixture = {
      workbenchId, otherId, channels: [],
      sources: ids.map((assetId, i) => ({ assetId, name: `Synthetic ${i + 1}`, size: 10, inspection: { format: 'test', mime: null, streams: [] } })),
      snapshot(revision, indices, cleanup = [], intakeFailure = null, extra = {}) { channel.onmessage({ connectionId: connection, snapshot: { ...state(this.active || workbenchId, revision, indices, cleanup), intakeFailure, ...extra } }); },
      stale(revision, indices) { this.channels[0].onmessage({ connectionId: 1, snapshot: state(workbenchId, revision, indices) }); }
    };
    window.__TAURI__ = { core: {
      Channel: class {},
      convertFileSrc: id => `lvovd-media://localhost/${id}`,
      async invoke(command, args) {
        if (command === 'desktop_handshake') return { protocolVersion: 1, connectionGeneration: 0, appVersion: 'test', webviewVersion: 'test' };
        if (command === 'list_workbenches') return [state(workbenchId), ...(fixture.created ? [state(otherId)] : [])];
        if (command === 'create_workbench') { return state(workbenchId); }
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
        if (command === 'cancel_editor') return;
        if (command === 'save_result') return new Promise(resolve => { fixture.resolveSave = resolve; });
        throw new Error('Unexpected command: ' + command);
      }
    } };
  }, ids);
  await page.addScriptTag({ path: path.join(root, 'native.js') });
  await page.addScriptTag({ path: path.join(root, 'workspace-transport.js') });
  for (const name of ['edit-plan','audio-waveform','media-editor','conversion-inspector','processing-profile','local-workspace']) await page.addScriptTag({ path: path.join(root, '../public/' + name + '.js') });
  await page.addScriptTag({ path: path.join(root, 'app.js') });
  if (bridge) await page.waitForFunction(() => window.fixture.channels.length > 0);
  page.on('dialog', dialog => dialog.accept());
}


test('desktop picker acknowledgement waits for authoritative channel membership', async ({ page }) => {
  await setup(page);
  await page.locator('#media-choose-button').click();
  await page.evaluate(() => window.fixture.resolvePick(1));
  await expect(page.locator('#processing-file-list option')).toHaveCount(0);
  await page.evaluate(() => window.fixture.snapshot(1, [0, 1]));
  await expect(page.locator('#processing-file-list option')).toHaveCount(2);
  await expect(page.locator('#local-media-name')).toHaveText('Synthetic 1');
  await expect(page.locator('#new-workbench')).toHaveCount(0);
});
for (const outcome of ['success','error']) test(`desktop late removal ${outcome} cannot replace selection or restore cleanup`, async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.fixture.snapshot(1, [0, 1]));
  await page.locator('#workspace-discard').click();
  await page.evaluate(() => window.fixture.snapshot(3, [1, 2]));
  await page.locator('#processing-file-list').selectOption(ids[2]);
  const status = await page.locator('#workspace-status').textContent();
  await page.evaluate(outcome => { outcome === 'success' ? window.fixture.resolveRemoval() : window.fixture.rejectRemoval(); window.fixture.snapshot(2, [0, 1], [window.fixture.sources[0].assetId]); }, outcome);
  await expect(page.locator('#local-media-name')).toHaveText('Synthetic 3');
  await expect(page.locator('#processing-file-list option')).toHaveCount(2);
  await expect(page.locator('#workspace-removed-cleanup li')).toHaveCount(0);
  await expect(page.locator('#workspace-status')).toHaveText(status);
});
test('desktop intake failure persists across selection and clears with newer intake', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.fixture.snapshot(1, [0,1], [], { code: 'SOURCE_READ', message: 'Could not open the selected file.' }));
  await page.locator('#processing-file-list').selectOption(ids[1]);
  await expect(page.locator('#native-intake-status')).toHaveText('Could not open the selected file.');
  await page.evaluate(() => window.fixture.snapshot(2, [0,1,2]));
  await expect(page.locator('#native-intake-status')).toBeHidden();
});
test('desktop adapter has no browser HTTP fallback', async ({ page }) => {
  const requests = []; page.on('request', request => requests.push(request.url()));
  await setup(page, false);
  await expect(page.locator('#connection')).toHaveText('Desktop unavailable');
  await expect(page.locator('#workspace-status')).toContainText('lvovd.exe');
  expect(requests).toEqual([]);
});

test('desktop save status survives updates and late receipts cannot relabel a replacement', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page);
  await page.evaluate(ids => window.fixture.snapshot(0,[0],[],null,{jobs:[{sourceId:ids[0],status:'queued',draftRevision:0}]}),ids);
  await page.evaluate(ids => {
    const result = window.fixture.result = {resultId:ids[2],sourceId:ids[0],filename:'Synthetic.wav',size:100,draftRevision:0,noOp:true,review:{},inspection:{durationSeconds:2,format:'wav',container:{kind:'wav'},video:null,audio:{codec:'pcm_s16le',sampleRate:48000,channels:1}}};
    window.fixture.snapshot(1,[0,1],[],null,{results:[result]});
  }, ids);
  const row = page.locator(`[data-processing-result="${ids[0]}"]`);
  await row.locator('[data-result="download"]').click();
  await expect(row.locator('[data-result="status"]')).toHaveText('Saving…');
  await page.evaluate(() => { window.fixture.sources[0].name='Updated source label'; window.fixture.snapshot(2,[0,1],[],null,{results:[window.fixture.result]}); });
  await expect(row.locator('[data-result="status"]')).toHaveText('Saving…');
  await page.evaluate(() => window.fixture.resolveSave('Synthetic (1).wav'));
  await expect(row.locator('[data-result="status"]')).toHaveText('Saved Synthetic (1).wav');
  await row.locator('[data-result="download"]').click();
  await page.evaluate(() => { window.fixture.result={...window.fixture.result,resultId:'30000000-0000-4000-8000-000000000001',filename:'Replacement.wav'};window.fixture.snapshot(3,[0,1],[],null,{results:[window.fixture.result]}); });
  await expect(row.locator('[data-result="name"]')).toHaveText('Replacement.wav');
  await page.evaluate(() => window.fixture.resolveSave('obsolete.wav'));
  await expect(row.locator('[data-result="status"]')).not.toContainText('obsolete');
  await expect(row.locator('[data-result="status"]')).not.toContainText('Saving');
  expect(errors).toEqual([]);
});
