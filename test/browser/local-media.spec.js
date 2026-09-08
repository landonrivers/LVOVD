"use strict";

const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let root;
function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 30000 }); }
function probe(file) { return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', windowsHide: true })); }
test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-browser-fixtures-'));
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=20:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=5',
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', path.join(root, 'generated.mp4')]);
  ffmpeg(['-i', path.join(root, 'generated.mp4'), '-c', 'copy', path.join(root, 'generated.mov')]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000:duration=3', path.join(root, 'generated.wav')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=15', '-c:v', 'libx264', '-preset', 'ultrafast', path.join(root, 'longer.mp4')]);
});
test.afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/');
});
test.afterEach(async ({ page }) => {
  page.removeAllListeners('dialog'); page.on('dialog', dialog => dialog.accept());
  const discard = page.locator('#workspace-discard');
  if (await discard.isVisible()) { await discard.click(); await expect(page.locator('#media-drop-zone')).toBeVisible(); }
});
async function intake(page, filename = 'generated.mp4') {
  const connection = page.waitForRequest(request => request.url().includes('/api/workspace/progress?workspace='));
  await page.locator('#media-file-input').setInputFiles(path.join(root, filename));
  const id = new URL((await connection).url()).searchParams.get('workspace');
  await expect(page.locator('#local-media-ready')).toBeVisible();
  await expect(page.locator('#workspace-progress')).toBeHidden();
  await expect(page.locator('#conversion-start')).toBeEnabled();
  return id;
}
async function snapshot(workspaceId) {
  const response = await fetch(`http://127.0.0.1:3017/api/workspace/progress?workspace=${workspaceId}`);
  const reader = response.body.getReader(); let text = '';
  try { while (!text.includes('\n\n')) { const next = await reader.read(); text += Buffer.from(next.value).toString(); }
    return JSON.parse(text.split('\n\n')[0].replace(/^data: /, ''));
  } finally { await reader.cancel(); }
}
async function downloaded(page, filename = 'downloaded.mp4') {
  const waiting = page.waitForEvent('download'); await page.locator('#conversion-download').click();
  const result = await waiting; expect(await result.failure()).toBeNull();
  const bytes = await fs.readFile(await result.path()), file = path.join(root, filename); await fs.writeFile(file, bytes);
  return { name: result.suggestedFilename(), bytes, file };
}
async function exact(page, id, value) { await page.locator(`#${id}`).fill(value); await page.locator(`#${id}`).press('Enter'); }
async function cut(page) {
  await exact(page, 'editor-start-time', '0.5'); await exact(page, 'editor-end-time', '4.5');
  await exact(page, 'cut-start-time', '1'); await exact(page, 'cut-end-time', '2'); await page.locator('#remove-section').click();
}
async function processFile(page) {
  await expect(page.locator('#conversion-plan-title')).not.toContainText('Reviewing current cuts');
  for (const box of await page.locator('#conversion-warnings input').all()) await box.check();
  await expect(page.locator('#conversion-start')).toBeEnabled();
  const revision = await page.evaluate(() => window.LVOVDLocalWorkspace.profileState().draftRevision);
  await page.locator('#conversion-start').click(); await expect(page.locator('#conversion-download')).toBeVisible();
  await expect(page.locator('#conversion-output-target')).toContainText(`Draft ${revision}`);
  await expect(page.locator('#conversion-output-target')).not.toContainText('Previous draft');
}

test('unified workbench offers default no-op, keyboard access, byte-exact download and security gate', async ({ page, request }) => {
  await expect(page.getByRole('heading', { name: 'Local Media', exact: true })).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(1);
  await expect(page.locator('#local-open-editor, #local-open-converter, #convert-edited-file, #create-edited-file')).toHaveCount(0);
  await page.locator('#media-choose-button').focus(); await expect(page.locator('#media-choose-button')).toBeFocused();
  const id = await intake(page);
  await expect(page.getByRole('heading', { name: 'Trim Video Length' })).toBeVisible();
  await expect(page.locator('#processing-settings')).toBeVisible(); await expect(page.locator('#timeline-track')).toBeVisible();
  await expect(page.locator('#conversion-plan-title')).toContainText('No processing');
  await page.locator('#conversion-start').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#conversion-download')).toBeVisible();
  const result = await downloaded(page); expect(result.bytes).toEqual(await fs.readFile(path.join(root, 'generated.mp4')));
  const state = await snapshot(id); expect(state.assets.map(asset => asset.role)).toEqual(['source']); expect(state.playback).toBeNull();
  expect(state.conversion.output.processingSnapshot.draftRevision).toBe(0);
  expect((await request.post('/api/processing/plan', { headers: { Origin: 'https://invalid.example' }, data: {} })).status()).toBe(403);
});

test('container-only MOV to MP4 remux downloads actual media with no preview or edited intermediate', async ({ page }) => {
  const id = await intake(page, 'generated.mov'); await page.locator('#processing-container').selectOption('mp4');
  await expect(page.locator('#conversion-plan-title')).toContainText('Remux'); await processFile(page);
  const output = await downloaded(page, 'remux.mp4'); expect(probe(output.file).streams.map(stream => stream.codec_name)).toEqual(['h264', 'aac']);
  const state = await snapshot(id); expect(state.assets.some(asset => ['playback-proxy', 'edited-output'].includes(asset.role))).toBe(false);
  expect(state.editor.status).toBe('idle'); expect(state.conversion.output.noOp).toBe(false);
});

test('cuts plus H.264 settings make one real original-source result while pending cuts, playhead and zoom survive', async ({ page }) => {
  const uploads = [], connections = [], processing = [], renders = [];
  page.on('request', request => { if (request.url().endsWith('/api/media/local')) uploads.push(request); if (request.url().includes('/api/workspace/progress')) connections.push(request);
    if (request.url().endsWith('/api/processing/start')) processing.push(request.postDataJSON()); if (request.url().endsWith('/api/workspace/render')) renders.push(request); });
  const id = await intake(page); await page.locator('#processing-prepare-preview').click(); await expect(page.locator('#editor-video')).toHaveAttribute('src', /api/);
  await cut(page); await exact(page, 'cut-start-time', '3'); await page.locator('#timeline-zoom-in').click(); await page.locator('#go-to-start').click();
  const window = await page.locator('#timeline-visible-label').textContent(), time = await page.locator('#editor-video').evaluate(video => video.currentTime);
  await page.evaluate(() => { window.LVOVDEditorView.conversionState().editPlan.keepRanges[0].endSeconds = 99; });
  await page.locator('#processing-rate-mode').selectOption('quality'); await exact(page, 'processing-crf', '24');
  await expect(page.locator('#processing-plan-facts')).toContainText('00:00:03.000'); await processFile(page);
  const output = await downloaded(page, 'combined.mp4'), actual = probe(output.file);
  expect(actual.streams.map(stream => stream.codec_name)).toEqual(['h264', 'aac']); expect(Math.abs(Number(actual.format.duration) - 3)).toBeLessThanOrEqual(0.08);
  const state = await snapshot(id); expect(state.assets.some(asset => asset.role === 'edited-output')).toBe(false);
  expect(state.conversion.output.processingSnapshot.editPlan.keepRanges).toHaveLength(2);
  expect(processing).toHaveLength(1); expect(processing[0].sourceAssetId).toBe(state.sourceAssetId); expect(renders).toHaveLength(0);
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.500'); await expect(page.locator('#editor-end-time')).toHaveValue('00:00:04.500');
  await expect(page.locator('#cut-start-time')).toHaveValue('00:00:03.000'); await expect(page.locator('#timeline-visible-label')).toHaveText(window);
  expect(await page.locator('#editor-video').evaluate(video => video.currentTime)).toBeCloseTo(time, 2);
  expect(uploads).toHaveLength(1); expect(connections).toHaveLength(1);
  await page.locator('#media-workspace-panel').screenshot({ path: path.join(os.tmpdir(), 'lvovd-unified-desktop.png') });
});

test('changed draft keeps previous result provenance; Reset File confirms, restores defaults and preserves source/download', async ({ page }) => {
  const id = await intake(page); await cut(page); await page.locator('#processing-rate-mode').selectOption('quality'); await processFile(page);
  const previousUrl = await page.locator('#conversion-download').getAttribute('href'), previous = (await downloaded(page)).bytes;
  await page.locator('#processing-scale').selectOption('fit');
  await expect(page.locator('#conversion-output-target')).toContainText('Previous draft');
  await expect(page.locator('#conversion-output-settings')).toContainText('CRF 18');
  await expect(page.locator('#removed-sections')).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#processing-reset').click();
  await expect(page.locator('#processing-scale')).toHaveValue('fit');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#processing-reset').click();
  await expect(page.locator('#processing-rate-mode')).toHaveValue('automatic'); await expect(page.locator('#processing-container')).toHaveValue('source');
  await expect(page.locator('#processing-scale')).toHaveValue('unchanged'); await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.000');
  await expect(page.locator('#editor-end-time')).toHaveValue('00:00:05.000'); await expect(page.locator('#removed-sections')).toBeHidden();
  await expect(page.locator('#conversion-output-target')).toContainText('Previous draft'); await expect(page.locator('#conversion-download')).toHaveAttribute('href', previousUrl);
  await expect(page.locator('#conversion-output-settings')).toContainText('CRF 18');
  expect((await downloaded(page)).bytes).toEqual(previous); expect((await snapshot(id)).sourceAssetId).toBe((await page.evaluate(() => window.LVOVDLocalWorkspace.profileState())).sourceAssetId);
  await processFile(page); await expect(page.locator('#conversion-output-target')).toContainText('Existing original bytes');
  expect((await downloaded(page)).bytes).toEqual(await fs.readFile(path.join(root, 'generated.mp4')));
});

test('late real review responses cannot revive an obsolete draft or removed file', async ({ page }) => {
  await intake(page);
  let release, fetched; const arrived = new Promise(resolve => { fetched = resolve; }), hold = new Promise(resolve => { release = resolve; });
  let first = true;
  await page.route('**/api/processing/plan', async route => { const response = await route.fetch(); if (first) { first = false; fetched(); await hold; } await route.fulfill({ response }); });
  await page.locator('#processing-container').selectOption('mov'); await arrived;
  await page.locator('#processing-container').selectOption('matroska'); await exact(page, 'editor-end-time', '4');
  release(); await expect(page.locator('#processing-plan-facts')).toContainText('matroska');
  await expect(page.locator('#processing-plan-facts')).toContainText('00:00:04.000');
  await page.unroute('**/api/processing/plan');
  let releaseOld, oldReady; const oldFetched = new Promise(resolve => { oldReady = resolve; }), oldHold = new Promise(resolve => { releaseOld = resolve; });
  await page.route('**/api/processing/plan', async route => { const response = await route.fetch(); oldReady(); await oldHold; await route.fulfill({ response }); });
  await page.locator('#processing-rate-mode').selectOption('quality'); await oldFetched;
  page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click(); await expect(page.locator('#media-drop-zone')).toBeVisible();
  releaseOld(); await expect(page.locator('#local-media-ready')).toBeHidden(); await page.unroute('**/api/processing/plan');
  await intake(page, 'generated.mov'); await expect(page.locator('#local-media-name')).toHaveText('generated.mov');
  await expect(page.locator('#processing-container')).toHaveValue('source');
});

test('audio-only conversion remains useful without video preparation and fits a narrow keyboard workflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const id = await intake(page, 'generated.wav');
  await expect(page.locator('#media-editor')).toBeHidden(); await expect(page.locator('#processing-prepare-preview')).toBeHidden();
  await page.getByText('Media Details', { exact: true }).click(); await expect(page.locator('#conversion-facts')).toBeVisible();
  await page.locator('#processing-container').selectOption('m4a'); await page.locator('#processing-audio-codec').selectOption('aac');
  await expect(page.locator('#conversion-start')).toBeEnabled(); await page.locator('#conversion-start').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#conversion-download')).toBeVisible(); const output = await downloaded(page, 'audio.m4a');
  expect(probe(output.file).streams.map(stream => stream.codec_type)).toEqual(['audio']); expect((await snapshot(id)).playback).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('narrow video workflow exposes keyboard timeline, scale and maximum-size review without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await intake(page);
  await page.locator('#timeline-start-handle').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.100');
  await page.locator('#processing-scale').selectOption('fit'); await exact(page, 'processing-width', '80'); await exact(page, 'processing-height', '80');
  await page.locator('#processing-rate-mode').selectOption('size'); await exact(page, 'processing-maximum-mb', '0.15');
  await page.locator('#processing-audio-codec').selectOption('aac'); await exact(page, 'processing-audio-bitrate', '32');
  await expect(page.locator('#processing-plan-facts')).toContainText('80 × 44'); await processFile(page);
  const output = await downloaded(page, 'small.mp4'); expect(output.bytes.length).toBeLessThanOrEqual(150000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#media-workspace-panel').screenshot({ path: path.join(os.tmpdir(), 'lvovd-unified-narrow.png') });
});

test('additional dropped files are rejected and Remove File confirmation preserves or invalidates the entry', async ({ page, request }) => {
  const uploads = []; page.on('request', request => { if (request.url().endsWith('/api/media/local')) uploads.push(request); });
  const id = await intake(page);
  await page.locator('#media-workspace-panel').evaluate(panel => { const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['x'], 'extra-a.mp4')); dataTransfer.items.add(new File(['x'], 'extra-b.mp4')); panel.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true })); });
  await expect(page.locator('#workspace-status')).toContainText('exactly one'); expect(uploads).toHaveLength(1);
  await exact(page, 'editor-start-time', '1'); page.once('dialog', dialog => dialog.dismiss()); await page.locator('#workspace-discard').click();
  await expect(page.locator('#local-media-ready')).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click(); await expect(page.locator('#media-drop-zone')).toBeVisible();
  expect((await request.get(`/api/workspace/progress?workspace=${id}`)).status()).toBe(404);
});

test('video cuts apply to audio extraction and Reset Range keeps the selected encoding settings', async ({ page }) => {
  const id = await intake(page); await cut(page);
  await page.locator('#processing-rate-mode').selectOption('quality');
  await page.locator('#reset-range').click();
  await expect(page.locator('#processing-rate-mode')).toHaveValue('quality');
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.000');
  await cut(page); await page.locator('#processing-container').selectOption('m4a');
  await expect(page.locator('#processing-rate-settings')).toBeHidden();
  await expect(page.locator('#processing-plan-facts')).toContainText('00:00:03.000');
  await processFile(page); const output = await downloaded(page, 'cut-audio.m4a'), actual = probe(output.file);
  expect(actual.streams.map(stream => stream.codec_type)).toEqual(['audio']);
  expect(Math.abs(Number(actual.format.duration) - 3)).toBeLessThanOrEqual(0.08);
  expect((await snapshot(id)).assets.some(asset => asset.role === 'edited-output')).toBe(false);
  await page.locator('#processing-container').selectOption('mp4');
  await expect(page.locator('#processing-rate-mode')).toHaveValue('quality');
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.500');
});

test('cancellation preserves current cuts and admits an explicit retry with immutable submitted settings', async ({ page }) => {
  const id = await intake(page, 'longer.mp4'); await page.locator('#processing-rate-mode').selectOption('quality');
  await page.locator('#processing-preset').selectOption('veryslow'); await exact(page, 'editor-start-time', '0.5');
  await expect(page.locator('#conversion-start')).toBeEnabled(); await page.locator('#conversion-start').click(); await expect(page.locator('#conversion-cancel')).toBeVisible();
  const submitted = await page.evaluate(() => window.LVOVDLocalWorkspace.profileState().submitted);
  await page.locator('#processing-preset').selectOption('ultrafast');
  await expect(page.locator('#processing-draft-status')).toContainText('Newer settings');
  expect((await page.evaluate(() => window.LVOVDLocalWorkspace.profileState().submitted)).settings.rate.preset).toBe(submitted.settings.rate.preset);
  await page.locator('#conversion-cancel').click(); await expect(page.locator('#conversion-cancel')).toBeHidden();
  expect((await snapshot(id)).conversion.status).toBe('cancelled'); await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.500');
  await processFile(page); await expect(page.locator('#conversion-output-target')).not.toContainText('Previous draft');
  expect((await snapshot(id)).conversion.output.processingSnapshot.settings.rate.preset).toBe('ultrafast');
});
