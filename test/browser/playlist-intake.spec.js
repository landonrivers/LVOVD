'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { playlistSource } = require('../helpers/playlist-source');
let root, fixture;
const state = page => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState());
const profile = page => page.evaluate(() => window.LVOVDLocalWorkspace.profileState());
async function exact(page, id, value) { await page.locator('#' + id).fill(value); await page.locator('#' + id).press('Enter'); }
async function select(page, id) { await page.locator('#processing-file-list').selectOption(id); await expect(page.locator('#processing-file-list')).toHaveValue(id); }
async function download(page) { const waiting = page.waitForEvent('download'); await page.locator('#conversion-download').click(); const result = await waiting; expect(await result.failure()).toBeNull(); return { bytes: await fs.readFile(await result.path()), name: result.suggestedFilename() }; }
async function existing(page) {
  await page.locator('#media-file-input').setInputFiles(fixture.files[1].file);
  await expect(page.locator('#conversion-start')).toBeEnabled();
  const id = (await profile(page)).workspaceId;
  await page.locator('#conversion-start').click(); await expect(page.locator('#conversion-download')).toBeVisible();
  const result = await download(page); expect(result.bytes).toEqual(fixture.files[1].bytes);
  return { id, result };
}
async function preview(page, indexes = [0, 1, 2]) {
  await page.locator('#video-url').fill(fixture.url);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/info');
  await page.locator('#preview-button').click(); expect((await response).ok()).toBe(true);
  await expect(page.locator('[data-playlist-entry]')).toHaveCount(3);
  for (let i = 0; i < 3; i++) await page.locator('[data-playlist-entry]').nth(i).setChecked(indexes.includes(i));
  await page.locator('label:has([name="profile"][value="maximum"])').click();
  await expect(page.locator('#open-editor-button')).toHaveText(`Add Selected to Local Media (${indexes.length})`);
  await expect(page.locator('#open-editor-button')).toBeEnabled();
}

test.beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-playlist-browser-')); fixture = await playlistSource(root); });
test.afterAll(async () => { await fixture.close(); await fs.rm(root, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => {
  test.setTimeout(90000); fixture.requests.length = 0; fixture.failures.clear();
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/');
});
test.afterEach(async ({ page, request }) => {
  page.removeAllListeners('dialog'); page.on('dialog', dialog => dialog.accept());
  const current = await state(page);
  if (current.intake?.active) await request.post('/api/processing/import/cancel', { data: { collectionId: current.collectionId, requestId: current.intake.id } });
  await expect.poll(async () => (await state(page)).intake?.active || false).toBe(false);
  while (await page.locator('#workspace-discard').isVisible()) {
    const before = await page.locator('#processing-file-list option').count();
    await page.locator('#workspace-discard').click(); await expect(page.locator('#processing-file-list option')).toHaveCount(before - 1);
  }
  await expect(page.locator('#media-drop-zone')).toBeVisible();
});

test('Download All saves both distinct processed playlist MP3s without changing the editor', async ({ page }, testInfo) => {
  await preview(page, [0, 2]); await page.locator('#open-editor-button').click();
  await expect.poll(async () => (await state(page)).intake?.status, { timeout: 30000 }).toBe('ready');
  await expect.poll(async () => (await state(page)).intake?.active).toBe(false);
  await expect(page.locator('#conversion-start')).toBeEnabled();
  const imported = await state(page), selectedId = imported.selectedId;
  expect(imported.entries).toHaveLength(2);
  const acquired = fixture.requests.length;
  await page.locator('#processing-container').selectOption('mp3');
  await page.getByRole('button', { name: 'Review All Files (2)', exact: true }).click();
  await expect(page.locator('#processing-batch-review')).not.toContainText('Reviewing files');
  for (const box of await page.locator('#processing-batch-review input[type=checkbox]:enabled').all()) await box.check();
  await page.getByRole('button', { name: 'Queue And Process', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Processing results', exact: true })).toBeInViewport();
  await expect(page.locator('#processing-results-summary')).toHaveText('2 of 2 completed · 2 downloads available');
  const results = page.locator('#processing-results');
  await expect(results.getByRole('link', { name: /^Download MP3/ })).toHaveCount(2);
  const downloads = [];
  page.on('download', download => downloads.push(download));
  await results.getByRole('button', { name: 'Download All (2)', exact: true }).click();
  await expect.poll(() => downloads.length).toBe(2);
  await expect(page.locator('#processing-download-note')).toContainText('2 of 2 downloads requested');
  expect((await state(page)).selectedId).toBe(selectedId);
  const bytes = [];
  for (const [index, sourceIndex] of [0, 2].entries()) {
    const row = results.locator('[data-processing-result]').nth(index), filename = `Generated item ${sourceIndex}-processed.mp3`;
    await expect(row.getByRole('heading')).toHaveText(filename);
    await expect(row).toContainText(`Source: Generated item ${sourceIndex}.mp4`);
    await expect(row).toContainText('MP3 audio encoded');
    await expect(row.getByRole('link', { name: `Download MP3 — ${filename}`, exact: true })).toBeVisible();
    const downloaded = downloads.find(download => download.suggestedFilename() === filename);
    expect(downloaded).toBeTruthy(); expect(await downloaded.failure()).toBeNull();
    const output = testInfo.outputPath(filename); await downloaded.saveAs(output); bytes.push(await fs.readFile(output));
    const inspected = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8', windowsHide: true }));
    expect(inspected.streams.map(stream => stream.codec_name)).toEqual(['mp3']);
    expect(Math.abs(Number(inspected.format.duration) - 6)).toBeLessThan(.06);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    let crossings = 0;
    for (let sample = 12001; sample < 36000; sample++) if (pcm.readFloatLE((sample - 1) * 4) <= 0 && pcm.readFloatLE(sample * 4) > 0) crossings++;
    expect(Math.abs(crossings * 2 - (400 + sourceIndex * 300))).toBeLessThanOrEqual(4);
    expect((await state(page)).selectedId).toBe(selectedId);
  }
  expect(bytes[0].equals(bytes[1])).toBe(false); expect(fixture.requests.length).toBe(acquired);
  await results.screenshot({ path: testInfo.outputPath('playlist-mp3-results-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await results.screenshot({ path: testInfo.outputPath('playlist-mp3-results-narrow.png') });
  await results.getByRole('button', { name: 'Edit source — Generated item 2.mp4', exact: true }).click();
  expect((await state(page)).selectedId).toBe(imported.entries[1].workspaceId);
  await expect(page.locator('#editor-media-name')).toHaveText('Generated item 2.mp4');
  await expect(page.locator('#processing-file-list')).toBeFocused();
});

test('playlist selection appends inspected files, inherits shared settings and retains individual authoring and downloads', async ({ page }) => {
  const connections = []; page.on('request', request => { if (request.url().includes('/api/processing/queue/progress')) connections.push(request.url()); });
  const prior = await existing(page);
  await exact(page, 'editor-start-time', '1'); await exact(page, 'editor-end-time', '4');
  await page.locator('#go-to-start').click(); await page.locator('#timeline-zoom-in').click(); await exact(page, 'cut-start-time', '2');
  await page.locator('#processing-filename-suffix').fill('_shared');
  const authored = await profile(page);
  await preview(page, [0, 2]);
  expect(fixture.requests.some(item => item.path.startsWith('/item-'))).toBe(false);
  let saves = 0; page.on('download', () => saves++);
  await page.locator('#open-editor-button').click();
  await expect(page.locator('#processing-file-list option')).toHaveCount(3);
  // Two real yt-dlp starts plus the required 5–10 second courtesy pause.
  await expect.poll(async () => (await state(page)).intake?.status, { timeout: 30000 }).toBe('ready');
  await expect.poll(async () => (await state(page)).intake?.active).toBe(false);
  const imported = await state(page);
  expect(imported.selectedId).toBe(prior.id); expect(connections).toHaveLength(1); expect(saves).toBe(0);
  expect(imported.entries.map(entry => entry.workspace.source.name)).toEqual(['source-1.mp4', 'Generated item 0.mp4', 'Generated item 2.mp4']);
  expect(imported.entries.every(entry => entry.settings.filenameSuffix === '_shared')).toBe(true);
  expect(imported.jobs).toHaveLength(1); expect(imported.jobs[0].status).toBe('completed');
  expect(fixture.requests.some(item => /(?:item|source)-1/.test(item.path))).toBe(false);
  const selected = imported.entries[1];
  expect(selected.editPlan.keepRanges).toEqual([{ startSeconds: 0, endSeconds: 6 }]);
  await select(page, selected.workspaceId); await expect(page.locator('#editor-media-name')).toHaveText('Generated item 0.mp4');
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await exact(page, 'editor-start-time', '1'); await exact(page, 'editor-end-time', '3');
  for (const box of await page.locator('#conversion-warnings input').all()) await box.check();
  await expect(page.locator('#conversion-start')).toBeEnabled(); await page.locator('#conversion-start').click();
  await expect(page.locator('#conversion-download')).toBeVisible(); const result = await download(page);
  expect(result.name).toBe('Generated item 0_shared.mp4');
  const output = path.join(root, 'browser-output.mp4'); await fs.writeFile(output, result.bytes);
  const actual = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', output], { encoding: 'utf8', windowsHide: true }));
  expect(Math.abs(Number(actual.format.duration) - 2)).toBeLessThanOrEqual(0.11);
  await select(page, prior.id);
  const after = await profile(page); expect(after.editPlan).toEqual(authored.editPlan);
  expect(after.editorState.pendingCut).toEqual(authored.editorState.pendingCut); expect(after.editorState.visibleWindow).toEqual(authored.editorState.visibleWindow);
  expect(after.editorState.playheadSeconds).toBe(authored.editorState.playheadSeconds);
  expect((await download(page)).bytes).toEqual(prior.result.bytes);
});

for (const action of ['cancel', 'remove']) {
  test(`${action} accepted playlist intake while its HTTP response is held cannot resurrect pending files`, async ({ page }) => {
    const prior = await existing(page); const hold = fixture.hold('/item-1');
    let releaseResponse, accepted;
    const waiting = new Promise(resolve => { accepted = resolve; }), held = new Promise(resolve => { releaseResponse = resolve; });
    await page.route('**/api/processing/import', async route => { const response = await route.fetch(); accepted(); await held; await route.fulfill({ response }); });
    try {
      await preview(page); await page.locator('#open-editor-button').click(); await waiting; await hold.accepted;
      await expect.poll(async () => (await state(page)).intake?.items[0].status).toBe('ready');
      if (action === 'cancel') {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('#processing-import-cancel')).toBeEnabled();
        await page.locator('#processing-import-cancel').focus(); await page.keyboard.press('Enter');
      } else {
        const pending = (await state(page)).intake.items[2]; await select(page, pending.id);
        page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
      }
      await expect.poll(async () => (await state(page)).intake?.active).toBe(false);
      const responseDone = page.waitForResponse(response => new URL(response.url()).pathname === '/api/processing/import');
      releaseResponse(); await (await responseDone).finished(); hold.release();
      await expect(page.locator('#processing-file-list option')).toHaveCount(2);
      await expect(page.locator('#processing-import-status')).toContainText('cancelled');
      await expect(page.locator('#processing-import-items')).toContainText('not started');
      expect(fixture.requests.some(item => /(?:item|source)-2/.test(item.path))).toBe(false);
      await select(page, prior.id); expect((await download(page)).bytes).toEqual(prior.result.bytes);
    } finally { hold.release(); releaseResponse(); }
  });
}

test('source rejection stops import; sharing disabled gives arriving files independent defaults', async ({ page }) => {
  const prior = await existing(page);
  await page.locator('#processing-apply-all').uncheck(); await page.locator('#processing-filename-suffix').fill('_individual');
  fixture.failures.set('/item-1', 429);
  await preview(page); await page.locator('#open-editor-button').click();
  await expect.poll(async () => (await state(page)).intake?.active, { timeout: 30000 }).toBe(false);
  const result = await state(page); expect(result.intake.status).toBe('failed');
  expect(result.intake.items.map(item => item.status)).toEqual(['ready', 'failed', 'cancelled']);
  await expect(page.locator('#processing-import-items')).toContainText('Generated item 1 — failed');
  expect(result.entries.find(entry => entry.workspace.source.name === 'Generated item 0.mp4').settings.filenameSuffix).toBe('-processed');
  expect(fixture.requests.some(item => /(?:item|source)-2/.test(item.path))).toBe(false);
  expect(fixture.requests.filter(item => item.path === '/item-1')).toHaveLength(1);
  expect(result.selectedId).toBe(prior.id); expect((await download(page)).bytes).toEqual(prior.result.bytes);
});
