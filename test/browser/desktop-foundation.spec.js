'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../desktop');
require('../../scripts/desktop.cjs').prepare();
const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'];

async function setup(page, bridge = true, retired = false) {
  await page.setContent(html);
  if (bridge) await page.evaluate(({ids,retired}) => {
    let channel, connection = 0;
    const workbenchId = '20000000-0000-4000-8000-000000000001';
    const otherId = '20000000-0000-4000-8000-000000000002';
    const state = (id, revision = 0, indices = [], cleanup = []) => ({
      workbenchId: id, revision, queueRevision: 0, sources: indices.map(i => fixture.sources[i]),
      cleanup, jobs: [], results: [], importing: false, discarded: false, previews: [], waveforms: [], editors: [], processingRevisions: [], failedCleanup: []
    });
    const fixture = window.fixture = {
      workbenchId, otherId, channels: [], retired,
      sources: ids.map((assetId, i) => ({ assetId, name: `Synthetic ${i + 1}`, size: 10, inspection: { format: 'test', mime: null, streams: [] } })),
      snapshot(revision, indices, cleanup = [], intakeFailure = null, extra = {}) { channel.onmessage({ connectionId: connection, snapshot: { ...state(this.active || workbenchId, revision, indices, cleanup), intakeFailure, ...extra } }); },
      stale(revision, indices) { this.channels[0].onmessage({ connectionId: 1, snapshot: state(workbenchId, revision, indices) }); }
    };
    window.__TAURI__ = { core: {
      Channel: class {},
      convertFileSrc: id => `lvovd-media://localhost/${id}`,
      async invoke(command, args) {
        if (command === 'desktop_handshake') return { protocolVersion: 1, connectionGeneration: 0, appVersion: 'test', webviewVersion: 'test' };
        if (command === 'list_workbenches') return [state(workbenchId), ...(fixture.retired ? [{...state(otherId,1,[],[ids[2]]),discarded:true,failedCleanup:[ids[2]]}] : [])];
        if (command === 'create_workbench') { return state(workbenchId); }
        if (command === 'subscribe_workbench') {
          channel = args.channel; fixture.channels.push(channel); fixture.active = args.request.workbenchId;
          return { connectionId: ++connection, snapshot: state(fixture.active) };
        }
        if (command === 'acknowledge_workbench') return;
        if (command === 'runtime_health') return Object.fromEntries(['ffmpeg', 'ffprobe', 'ytdlp', 'providerRuntime'].map(key => [key, { installed: true, version: 'test' }]));
        if (command === 'pick_source') return new Promise(resolve => { fixture.resolvePick = i => resolve({ sources: [fixture.sources[i]], failure: null }); });
        if (command === 'edit_download_source') return new Promise(resolve => {
          fixture.acquisitions = (fixture.acquisitions || 0) + 1;
          fixture.acquisition = args.request;
          fixture.finishAcquisition = (revision, indices) => resolve({
            sourceId: ids[1], snapshot: state(args.request.workbenchId, revision, indices)
          });
        });
        if (command === 'cancel_edit_download_source') { fixture.cancelledAcquisition = args.request; return; }
        if (command === 'remove_source') return new Promise((resolve, reject) => {
          fixture.rejectRemoval = () => reject({ message: 'obsolete failure' });
          fixture.resolveRemoval = () => resolve(state(args.request.workbenchId, 2, [1], [fixture.sources[0].assetId]));
        });
        if (command === 'cancel_editor') return;
        if (command === 'cancel_processing') {
          fixture.cancelledJob = args.request;
          return state(args.request.workbenchId, 5);
        }
        if (command === 'prepare_editor') {
          fixture.previewAttempts = (fixture.previewAttempts || 0) + 1;
          return new Promise(resolve => { fixture.ackPreview = () => resolve({
            ...state(args.request.workbenchId, fixture.previewAttempts, [0]),
            editors: [{sourceId: ids[0], eligible: true, durationSeconds: 2}],
            previews: [{sourceAssetId: ids[0], status: 'preparing'}]
          }); });
        }
        if (command === 'save_result') return new Promise(resolve => { fixture.resolveSave = resolve; });
        if (command === 'cleanup_workbench') return new Promise(resolve => { fixture.resolveCleanup = () => { fixture.retired=false; resolve(null); }; });
        throw new Error('Unexpected command: ' + command);
      }
    } };
  }, {ids,retired});
  await page.addScriptTag({ path: path.join(root, 'native.js') });
  await page.addScriptTag({ path: path.join(root, 'workspace-transport.js') });
  for (const name of ['edit-plan','audio-waveform','media-editor','conversion-inspector','processing-profile','progress-meter','local-workspace']) await page.addScriptTag({ path: path.join(root, '../public/' + name + '.js') });
  await page.addScriptTag({ path: path.join(root, 'app.js') });
  if (bridge) await page.waitForFunction(() => window.fixture.channels.length > 0);
  page.on('dialog', dialog => dialog.accept());
}

test('a retained editor source is reused and a delayed acquisition cannot restore removed media or take focus', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    if (!crypto.randomUUID) crypto.randomUUID = () => '30000000-0000-4000-8000-000000000001';
    fixture.snapshot(1, [0]);
    fixture.edit = (preview, profile='maximum') => LVOVDLocalWorkspace.openDownloadSource(preview,
      {content:'av',profile,maxHeight:null,formatIds:['v','a']}, () => true);
    fixture.current = fixture.edit('preview-one');
  });
  await page.waitForFunction(() => !!fixture.finishAcquisition);
  await page.evaluate(async () => {
    document.getElementById('desktop-local').focus();
    fixture.finishAcquisition(3, [0,1]); await fixture.current;
    await fixture.edit('preview-one', 'compatible');
  });
  await expect(page.locator('#processing-file-list')).toHaveValue(ids[1]);
  expect(await page.evaluate(() => fixture.acquisitions)).toBe(1);
  await page.evaluate(() => { fixture.current = fixture.edit('preview-two'); });
  await page.waitForFunction(() => fixture.acquisitions === 2);
  await page.evaluate(() => fixture.snapshot(4, [0,1], [], null, {importing:true, editorAcquisitionId:fixture.acquisition.operationId}));
  await page.getByRole('button', {name:'Cancel acquisition'}).click();
  expect(await page.evaluate(() => fixture.cancelledAcquisition)).toEqual({
    workbenchId:'20000000-0000-4000-8000-000000000001', operationId:await page.evaluate(() => fixture.acquisition.operationId)
  });
  await page.locator('#nav-settings').click();
  await page.evaluate(async () => {
    fixture.snapshot(5, [0]); fixture.finishAcquisition(4, [0,1]); await fixture.current;
  });
  await expect(page.locator('#desktop-settings')).toBeFocused();
  await expect(page.locator('#processing-file-list option')).toHaveCount(1);
  await expect(page.locator('#processing-file-list')).toHaveValue(ids[0]);
});

test.describe('native drop targeting', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 960, height: 640 } });
  test('scales both axes and accepts only visible Local Media in the main workspace', async ({ page }) => {
    await setup(page);
    await page.addStyleTag({ path: path.join(root, 'dist/reference.css') });
    await page.addStyleTag({ path: path.join(root, 'styles.css') });
    await expect(page.locator('.desktop-header nav button')).toHaveText(['Download & Edit', 'Settings']);
    const point = selector => page.locator(selector).evaluate(node => {
      const rect = node.getBoundingClientRect();
      return [(rect.x + rect.width / 2) * devicePixelRatio, (rect.y + rect.height / 2) * devicePixelRatio];
    });
    const dropAt = coords => page.evaluate(coords => LVOVDLocalDropAt(...coords), coords);
    const zone = await point('#media-choose-button');
    expect(await dropAt(zone)).toBe(true);
    expect(await dropAt(await point('#download-url'))).toBe(false);
    expect(await dropAt(await point('#nav-download'))).toBe(false);
    expect(await dropAt([-1, zone[1]])).toBe(false);
    expect(await dropAt([zone[0], -1])).toBe(false);
    await page.evaluate(() => document.querySelector('#result-preview').showModal());
    expect(await dropAt(zone)).toBe(false);
    await page.evaluate(() => document.querySelector('#result-preview').close());
    await page.locator('#nav-settings').click();
    expect(await dropAt(zone)).toBe(false);
    await page.evaluate(() => fixture.snapshot(1, [0]));
    await page.locator('#nav-download').click();
    await page.locator('#desktop-local').evaluate(section => section.scrollIntoView({ block: 'start' }));
    expect(await page.locator('#workspace-scroll').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(await dropAt(await point('#processing-file-list'))).toBe(true);
    const main = page.getByRole('button', { name: 'Download & Edit', exact: true });
    await expect(main).toHaveAttribute('aria-current', 'location');
    await main.click();
    await expect(page.locator('#desktop-download')).toBeFocused();
  });
});

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

test('processing progress uses the captured two-pass duration and clears the value during validation', async ({ page }) => {
  await setup(page);
  await page.addStyleTag({path:path.join(root, 'styles.css')});
  await page.evaluate(ids => {
    const f = window.fixture;
    f.sources[0].inspection.media = {durationSeconds: 20, container: {kind:'mp4'}, video: {codec:'h264', width:320, height:180}};
    f.job = {id: ids[1], sourceId: ids[0], draftRevision: 1, status: 'running', durationSeconds: 10,
      progress: {outTimeUs: 5000000, pass: 2, passes: 2, attempt: 1, validating: false}};
    f.snapshot(1,[0],[],null,{jobs:[f.job]});
  }, ids);
  const track = page.getByRole('progressbar', {name:'File processing'});
  await expect(track).toHaveAttribute('aria-valuenow', '75');
  await expect(page.locator('#conversion-status')).toContainText('Pass 2 of 2 · Attempt 1 · 75%');
  await page.evaluate(() => {
    window.fixture.job.progress.validating = true;
    window.fixture.snapshot(2,[0],[],null,{jobs:[window.fixture.job]});
  });
  await expect(track).toBeVisible();
  await expect(track).not.toHaveAttribute('aria-valuenow', /.+/);
  await expect(page.locator('#conversion-status')).toHaveText('Validating output…');
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
    window.fixture.snapshot(1,[0,1],[],null,{results:[result],jobs:[{sourceId:ids[0],status:'completed',progress:{validating:true}}]});
  }, ids);
  const row = page.locator(`[data-processing-result="${ids[0]}"]`);
  await expect(page.locator('#conversion-status')).not.toContainText('Validating output');
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

test('retired native work is cleanup only and its late reply cannot replace the active workbench', async ({ page }) => {
  await setup(page, true, true);
  await page.evaluate(() => window.fixture.snapshot(1,[0,1]));
  const panel=page.locator('#workspace-recovery');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-recovery-action="reopen"], [data-recovery-action="remove"]')).toHaveCount(0);
  await panel.locator('[data-recovery-action="retry"]').click();
  await page.locator('#processing-file-list').selectOption(ids[1]);
  await page.evaluate(() => window.fixture.resolveCleanup());
  await expect(panel).toBeHidden();
  await page.evaluate(() => window.fixture.snapshot(2,[0,1]));
  await expect(page.locator('#local-media-name')).toHaveText('Synthetic 2');
  await expect(page.locator('#processing-file-list option')).toHaveCount(2);
});

test('a delayed removal cannot redirect Cancel Selected after the workbench changes', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async ids => {
    const t = window.LVOVDWorkspaceTransport, f = window.fixture;
    const remove = t.request('/api/workspace?workspace=' + ids[0], {method: 'DELETE'});
    while (!f.resolveRemoval) await new Promise(resolve => setTimeout(resolve, 0));
    const close = await t.subscribe(f.otherId, () => {}, () => {});
    f.snapshot(4, [2], [], null, {jobs: [{id: ids[1], sourceId: ids[2], status: 'running'}]});
    f.resolveRemoval();
    await remove;
    const response = await t.request('/api/processing/queue/cancel', {method: 'POST',
      body: JSON.stringify({collectionId: f.otherId, workspaceId: ids[2], jobId: ids[1]})});
    close();
    return {ok: response.ok, request: f.cancelledJob, owner: f.otherId};
  }, ids);
  expect(result.ok).toBe(true);
  expect(result.request).toEqual({workbenchId: result.owner, jobId: ids[1]});
});

test('interrupted playback preparation can be retried on the selected file', async ({ page }) => {
  await setup(page);
  await page.evaluate(ids => {
    const f = window.fixture;
    f.sources[0].inspection.media = {durationSeconds: 2, container: {kind: 'wav'}, audio: {codec: 'pcm_s16le', channels: 1, sampleRate: 48000}};
    f.eligible = {editors: [{sourceId: ids[0], eligible: true, durationSeconds: 2}]};
    f.snapshot(1, [0], [], null, f.eligible);
  }, ids);
  await page.waitForFunction(() => window.fixture.previewAttempts === 1);
  await page.evaluate(ids => {
    const f = window.fixture;
    f.ackPreview();
    f.snapshot(3, [0], [], null, {...f.eligible, previews: [{sourceAssetId: ids[0], status: 'cancelled'}]});
  }, ids);
  const retry = page.locator('#processing-prepare-preview');
  await expect(retry).toBeEnabled();
  await retry.click();
  await page.waitForFunction(() => window.fixture.previewAttempts === 2);
  await expect(page.locator('#processing-file-list')).toHaveValue(ids[0]);
});
