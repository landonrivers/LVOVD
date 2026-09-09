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
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=390x520:rate=20:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'portrait example.mp4')]);
  await fs.writeFile(path.join(root, 'invalid.mp4'), 'Harmless generated invalid media fixture.');
});
test.afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/');
});
test.afterEach(async ({ page }) => {
  page.removeAllListeners('dialog'); page.on('dialog', dialog => dialog.accept());
  const discard = page.locator('#workspace-discard:visible, #workspace-failure-discard:visible').first();
  while (await discard.isVisible()) {
    const before = await page.locator('#processing-file-list option').count();
    await discard.click();
    await expect(page.locator('#processing-file-list option')).toHaveCount(before - 1);
  }
  await expect(page.locator('#media-drop-zone')).toBeVisible();
});
async function intake(page, filename = 'generated.mp4') {
  const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/media/local');
  await page.locator('#media-file-input').setInputFiles(path.join(root, filename));
  await uploaded;
  await expect(page.locator('#local-media-ready')).toBeVisible();
  await expect(page.locator('#workspace-progress')).toBeHidden();
  await expect(page.locator('#conversion-start')).toBeEnabled();
  return page.evaluate(() => window.LVOVDLocalWorkspace.profileState().workspaceId);
}
async function intakeFiles(page, filenames, { waitForReview = true } = {}) {
  await page.locator('#media-file-input').setInputFiles(filenames.map(filename => path.join(root, filename)));
  await expect(page.locator('#processing-file-list option')).toHaveCount(filenames.length);
  await expect.poll(() => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState().entries.every(entry => entry.sourceAssetId && entry.inspection))).toBe(true);
  await expect(page.locator('#workspace-progress')).toBeHidden();
  if (waitForReview) await expect(page.locator('#conversion-start')).toBeEnabled();
  return page.evaluate(() => window.LVOVDLocalWorkspace.collectionState());
}
async function selectFile(page, workspaceId) {
  await page.locator('#processing-file-list').selectOption(workspaceId);
  await expect.poll(() => page.evaluate(() => window.LVOVDLocalWorkspace.profileState().workspaceId)).toBe(workspaceId);
}
async function submitAll(page) {
  await page.locator('#processing-process-all').click();
  await expect(page.locator('#processing-batch-review')).toBeVisible();
  await expect(page.locator('#processing-batch-review')).not.toContainText('Reviewing');
  for (const box of await page.locator('#processing-batch-review input[type="checkbox"]:enabled').all()) await box.check();
  await expect(page.locator('#processing-batch-submit')).toBeEnabled();
  await page.locator('#processing-batch-submit').click();
}
function decodedTone(file) {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { windowsHide: true, timeout: 30000 });
  const start = 48000, end = Math.min(start + 48000, pcm.length / 4); let crossings = 0;
  for (let sample = start + 1; sample < end; sample++) if (pcm.readFloatLE((sample - 1) * 4) <= 0 && pcm.readFloatLE(sample * 4) > 0) crossings++;
  return crossings * 48000 / (end - start);
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
  const previews = [];
  page.on('request', request => { if (request.url().endsWith('/api/workspace/editor')) previews.push(request.postDataJSON()); });
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
  const state = await snapshot(id); expect(state.assets.map(asset => asset.role)).toEqual(['source']); expect(state.playback.assetId).toBe(state.sourceAssetId); expect(state.playback.proxy).toBe(false);
  await expect(page.locator('#processing-file-list option')).toHaveCount(1);
  await expect(page.locator('#processing-file-list')).toHaveValue(id);
  await page.locator('#processing-file-list').selectOption(id);
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#processing-prepare-preview')).toBeHidden();
  expect(previews).toEqual([{ workspaceId: id, sourceAssetId: state.sourceAssetId }]);
  expect(state.conversion.output.processingSnapshot.draftRevision).toBe(0);
  expect((await request.post('/api/processing/plan', { headers: { Origin: 'https://invalid.example' }, data: {} })).status()).toBe(403);
});

test('portrait selection shows a real file list, contained playback and compact mockup controls', async ({ page }) => {
  await intake(page, 'portrait example.mp4');
  await expect(page.locator('#processing-file-list option')).toHaveText('portrait example.mp4');
  await expect(page.locator('#editor-media-name')).toHaveText('portrait example.mp4');
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.videoHeight)).toBe(520);
  const codec = await page.locator('#processing-video-codec').boundingBox(), output = await page.locator('#processing-container').boundingBox();
  expect(Math.abs(codec.y - output.y)).toBeLessThan(2); expect(codec.height).toBeLessThanOrEqual(30);
  const cut = await page.locator('#cut-start-time').boundingBox(), end = await page.locator('#cut-end-time').boundingBox();
  expect(cut.width).toBeLessThanOrEqual(181); expect(end.width).toBeLessThanOrEqual(181);
  expect(Math.abs(cut.y - end.y)).toBeLessThan(2);
  expect(await page.locator('#editor-video').evaluate(video => getComputedStyle(video).objectFit)).toBe('contain');
  await page.locator('#processing-scale').selectOption('854x480');
  await expect(page.locator('#processing-plan-facts')).toContainText('360 × 480');
  expect((await page.evaluate(() => window.LVOVDLocalWorkspace.profileState())).settings.scale).toEqual({ mode: 'fit', width: 854, height: 480, percent: null, allowUpscale: false });
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.readyState)).toBe(4);
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.seeking)).toBe(false);
  expect(await page.locator('#editor-video').evaluate(video => video.paused)).toBe(true);
  await page.locator('input[name="processing-rate"][value="size"]').check();
  await exact(page, 'processing-maximum-mb', '0.75');
  await expect(page.locator('#processing-plan-facts')).toContainText('Maximum 0.75 MB');
  await page.locator('#media-workspace-panel').screenshot({ path: path.join(os.tmpdir(), 'lvovd-compact-portrait.png') });
});

test('linked rate and size controls review the current cuts and keep a completed custom download name immutable', async ({ page }) => {
  const id = await intake(page);
  await expect(page.getByText('Edit videos or convert video/audio files', { exact: true })).toBeVisible();
  await expect(page.locator('#processing-plan-facts')).toContainText('exact original bytes');
  for (const selector of ['#processing-video-bitrate', '#processing-audio-bitrate', '#processing-maximum-mb']) await expect(page.locator(selector)).toBeVisible();
  const suffixBox = await page.locator('.processing-suffix').boundingBox(), processBox = await page.locator('#conversion-start').boundingBox();
  expect(suffixBox.x + suffixBox.width).toBeLessThanOrEqual(processBox.x);
  await page.locator('#processing-filename-suffix').fill('_original');
  await expect(page.locator('#processing-filename-preview')).toHaveText('generated_original.mp4');
  await processFile(page); const original = await downloaded(page);
  expect(original.name).toBe('generated_original.mp4'); expect(original.bytes).toEqual(await fs.readFile(path.join(root, 'generated.mp4')));
  await cut(page);
  await page.locator('#processing-video-bitrate').fill('250');
  await expect(page.locator('[name="processing-rate"][value="bitrate"]')).toBeChecked();
  await expect(page.locator('#processing-plan-facts')).toContainText('250 kbps');
  const sizeBefore = Number(await page.locator('#processing-maximum-mb').inputValue());
  expect(sizeBefore).toBeGreaterThan(0);
  await page.locator('#processing-audio-bitrate').fill('320');
  await expect.poll(async () => Number(await page.locator('#processing-maximum-mb').inputValue())).toBeGreaterThan(sizeBefore);
  await page.locator('#processing-maximum-mb').fill('0.2');
  await expect(page.locator('[name="processing-rate"][value="size"]')).toBeChecked();
  await expect(page.locator('#processing-plan-facts')).toContainText('Maximum 0.2 MB');
  const videoBefore = Number(await page.locator('#processing-video-bitrate').inputValue());
  await page.locator('#processing-audio-bitrate').fill('64');
  await expect.poll(async () => Number(await page.locator('#processing-video-bitrate').inputValue())).toBeGreaterThan(videoBefore);
  await page.locator('#processing-filename-suffix').fill('_small');
  await expect(page.locator('#processing-filename-preview')).toHaveText('generated_small.mp4');
  expect((await downloaded(page)).name).toBe('generated_original.mp4');
  await processFile(page); const small = await downloaded(page, 'linked-small.mp4');
  expect(small.name).toBe('generated_small.mp4'); expect(small.bytes.length).toBeLessThanOrEqual(200000);
  expect(Math.abs(Number(probe(small.file).format.duration) - 3)).toBeLessThanOrEqual(0.08);
  expect((await snapshot(id)).conversion.output.processingSnapshot.settings.filenameSuffix).toBe('_small');
  await page.locator('#processing-suffix-enabled').uncheck();
  await expect(page.locator('#processing-filename-preview')).toHaveText('generated.mp4');
  expect((await downloaded(page)).name).toBe('generated_small.mp4');
  await page.locator('[name="processing-rate"][value="quality"]').check();
  await expect(page.locator('#processing-plan-facts')).toContainText('Size varies with quality and content');
  await expect(page.locator('#processing-maximum-mb')).toHaveValue('');
  await page.locator('#processing-suffix-enabled').check(); await page.locator('#processing-filename-suffix').fill('../bad');
  await expect(page.locator('#conversion-start')).toBeDisabled();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#processing-reset').click();
  await expect(page.locator('#processing-filename-suffix')).toHaveValue(' - processed');
  await expect(page.locator('#processing-suffix-enabled')).toBeChecked();
});

test('ordinary scale presets explain fitted dimensions and remain accessible on a narrow layout', async ({ page }) => {
  await intake(page, 'portrait example.mp4');
  for (const value of ['4096x2160', '3840x2160', '2560x1440', '1920x1080', '1440x1080', '1280x720', '1024x768', '1024x576', '854x480', '720x576', '640x360', '320x180', 'width:3840', 'width:1920', 'height:2160', 'height:1080', 'height:720', 'percent:50', 'percent:25']) {
    await expect(page.locator(`#processing-scale option[value="${value}"]`)).toHaveCount(1);
  }
  await page.locator('#processing-scale').selectOption('height:720');
  await expect(page.locator('#processing-plan-facts')).toContainText('390 × 520 (adjusted to fit aspect)');
  await page.locator('#processing-no-upscale').uncheck();
  await expect(page.locator('#processing-plan-facts')).toContainText('540 × 720 (adjusted to fit aspect)');
  await page.locator('#processing-scale').selectOption('percent:50');
  await expect(page.locator('#processing-plan-facts')).toContainText('194 × 260 (adjusted to fit aspect)');
  await processFile(page); const output = await downloaded(page, 'percentage.mp4');
  const actual = probe(output.file).streams.find(stream => stream.codec_type === 'video');
  expect([actual.width, actual.height]).toEqual([194, 260]);
  await expect(page.locator('#conversion-output-settings')).toContainText('Scale 50%');
  await page.locator('#media-workspace-panel').screenshot({ path: path.join(os.tmpdir(), 'lvovd-linked-controls.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#processing-filename-suffix').focus(); await expect(page.locator('#processing-filename-suffix')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#conversion-start')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#media-workspace-panel').screenshot({ path: path.join(os.tmpdir(), 'lvovd-linked-controls-narrow.png') });
});

test.describe('processing help access', () => {
test.use({ hasTouch: true });
test('zoom arrows reveal offscreen timeline and pan by mouse, keyboard and touch without changing edits', async ({ page }) => {
  await intake(page); await cut(page); await exact(page, 'cut-start-time', '3');
  await expect(page.locator('#conversion-start')).toBeEnabled();
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.seeking)).toBe(false);
  const state = () => page.evaluate(() => window.LVOVDEditorView.authoringState());
  const before = await state(), revision = await page.evaluate(() => window.LVOVDLocalWorkspace.profileState().draftRevision);
  const plans = []; page.on('request', request => { if (request.url().endsWith('/api/processing/plan')) plans.push(request); });
  const left = page.locator('#timeline-pan-left'), right = page.locator('#timeline-pan-right'), tip = page.getByRole('tooltip');
  const zoomIn = page.getByRole('button', { name: 'Zoom In', exact: true }), zoomOut = page.getByRole('button', { name: 'Zoom Out', exact: true });
  await expect(zoomIn.locator('.timeline-zoom-glyph')).toHaveText('⊕');
  await expect(zoomOut.locator('.timeline-zoom-glyph')).toHaveText('⊖');
  await expect(left).toBeHidden(); await expect(right).toBeHidden();
  await zoomIn.click(); await expect(left).toBeHidden(); await expect(right).toBeVisible();
  expect((await state()).visibleWindow).toEqual({ startSeconds: 0, endSeconds: 2.5 });
  await right.hover(); await expect(tip).toBeHidden();
  await right.focus(); await expect(tip).toBeHidden();
  await expect(right).not.toHaveAttribute('aria-describedby');
  await expect(page.locator('#timeline-ruler [title], #timeline-ruler[title]')).toHaveCount(0);
  await right.click(); await expect(left).toBeVisible(); await expect(right).toBeVisible();
  expect((await state()).visibleWindow).toEqual({ startSeconds: 1.25, endSeconds: 3.75 });
  await right.click(); await expect(right).toBeHidden(); await expect(left).toBeFocused();
  expect((await state()).visibleWindow).toEqual({ startSeconds: 2.5, endSeconds: 5 });
  await page.keyboard.press('Enter'); await expect(right).toBeVisible();
  expect((await state()).visibleWindow).toEqual({ startSeconds: 1.25, endSeconds: 3.75 });
  const ruler = page.locator('#timeline-ruler'); await ruler.scrollIntoViewIfNeeded();
  const box = await ruler.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height - 8, { steps: 5 }); await page.mouse.up();
  const dragged = (await state()).visibleWindow;
  expect(dragged.startSeconds).toBeLessThan(1.25); expect(dragged.endSeconds).toBeLessThan(3.75);
  expect(dragged.endSeconds - dragged.startSeconds).toBeCloseTo(2.5, 3);
  await page.locator('.timeline-editor').screenshot({ path: path.join(os.tmpdir(), 'lvovd-timeline-arrows.png') });
  await zoomOut.click(); await expect(left).toBeHidden(); await expect(right).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await zoomIn.tap(); await right.tap(); await expect(left).toBeVisible();
  expect((await state()).visibleWindow).toEqual({ startSeconds: 1.25, endSeconds: 3.75 });
  await left.focus(); await expect(tip).toBeHidden(); await right.focus(); await expect(tip).toBeHidden();
  const narrowRuler = await ruler.boundingBox();
  for (const arrow of [left, right]) {
    const arrowBox = await arrow.boundingBox();
    expect(arrowBox.x).toBeGreaterThanOrEqual(narrowRuler.x); expect(arrowBox.x + arrowBox.width).toBeLessThanOrEqual(narrowRuler.x + narrowRuler.width);
  }
  await page.screenshot({ path: path.join(os.tmpdir(), 'lvovd-timeline-arrows-narrow.png') });
  await page.getByRole('button', { name: 'Full Timeline', exact: true }).click();
  await expect(left).toBeHidden(); await expect(right).toBeHidden();
  expect(await state()).toEqual(before);
  expect((await page.evaluate(() => window.LVOVDLocalWorkspace.profileState())).draftRevision).toBe(revision);
  expect(plans).toHaveLength(0);
  await zoomIn.click(); await right.focus(); await expect(tip).toBeHidden();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
  await expect(page.locator('#media-drop-zone')).toBeVisible(); await expect(tip).toBeHidden();
  await intake(page); await expect(left).toBeHidden(); await expect(right).toBeHidden();
});


test('processing help supports hover, keyboard dismissal and touch without changing the draft', async ({ page }) => {
  await intake(page); await exact(page, 'cut-start-time', '1');
  const before = await page.evaluate(() => window.LVOVDLocalWorkspace.profileState());
  const tip = page.getByRole('tooltip'), videoHelp = page.getByRole('button', { name: 'Help: video bitrate', exact: true });
  await videoHelp.hover(); await expect(tip).toBeVisible(); await expect(tip).toContainText('1,000–2,500 kbps');
  await tip.hover(); await expect(tip).toBeVisible();
  await page.mouse.move(1, 1); await expect(tip).toBeHidden();
  await videoHelp.focus(); await expect(tip).toBeVisible();
  await expect(videoHelp).toHaveAttribute('aria-describedby', 'processing-help-tooltip');
  await page.keyboard.press('Escape'); await expect(tip).toBeHidden(); await expect(videoHelp).toBeFocused();
  await expect(page.locator('[name="processing-rate"][value="automatic"]')).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  const sizeHelp = page.getByRole('button', { name: 'Help: file size', exact: true });
  await sizeHelp.tap(); await expect(tip).toContainText('ten seconds of video is about 2.5 MB');
  const box = await tip.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: path.join(os.tmpdir(), 'lvovd-processing-help-narrow.png') });
  await sizeHelp.tap(); await expect(tip).toBeHidden();
  expect((await page.evaluate(() => window.LVOVDLocalWorkspace.profileState())).draftRevision).toBe(before.draftRevision);
  await expect(page.locator('#cut-start-time')).toHaveValue('00:00:01.000');
  await sizeHelp.tap(); await expect(tip).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
  await expect(page.locator('#media-drop-zone')).toBeVisible(); await expect(tip).toBeHidden();
});
});

test('bitrate review and actual download use consistent decimal MB and expose the measured video rate', async ({ page }) => {
  const id = await intake(page); await cut(page); await page.locator('#processing-video-bitrate').fill('2000');
  await expect(page.locator('#processing-rate-help')).toContainText('Video bitrate is in control');
  await processFile(page); const result = await downloaded(page, 'rate-example.mp4');
  const output = (await snapshot(id)).conversion.output;
  expect(output.processingSnapshot.settings.rate.twoPass).toBe(false);
  expect(output.size).toBe(result.bytes.length);
  await expect(page.locator('#conversion-output-facts')).toContainText(`${(result.bytes.length / 1e6).toFixed(3)} MB`);
  await expect(page.locator('#conversion-output-facts')).toContainText(`${result.bytes.length.toLocaleString()} bytes`);
  const measured = Number(probe(result.file).streams.find(stream => stream.codec_type === 'video').bit_rate);
  expect(measured).toBeGreaterThan(0);
  await expect(page.locator('#conversion-output-settings')).toContainText(`Measured video ${(measured / 1000).toFixed(1)} kbps average`);
  const budget = output.processingSnapshot.rateBudget;
  expect(budget.estimatedBytes).toBe(Math.ceil(2000000 * 3 / 8 + budget.audioBytes + budget.overheadBytes));
  console.log(JSON.stringify({ bitrateExample: { requestedKbps: 2000, retainedSeconds: 3, estimatedBytes: budget.estimatedBytes,
    actualBytes: result.bytes.length, measuredVideoKbps: measured / 1000 } }));
});

test('failed automatic playback permits processing and retries only on explicit request', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/workspace/editor', route => ++attempts === 1
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Playback preparation unavailable.' }) }) : route.continue());
  const id = await intake(page);
  await expect(page.locator('#processing-prepare-preview')).toBeVisible();
  await expect(page.locator('#processing-preview-note')).toContainText('still review');
  await processFile(page); expect((await downloaded(page)).bytes).toEqual(await fs.readFile(path.join(root, 'generated.mp4')));
  await page.locator('#processing-container').selectOption('mov');
  await expect(page.locator('#conversion-start')).toBeEnabled(); expect(attempts).toBe(1);
  await page.locator('#processing-prepare-preview').click();
  await expect(page.locator('#editor-video')).toHaveAttribute('src', /api\/workspace\/media/);
  await expect(page.locator('#processing-prepare-preview')).toBeHidden();
  expect(attempts).toBe(2); expect((await snapshot(id)).playback.assetId).toBe((await snapshot(id)).sourceAssetId);
});

test('a late automatic preview response cannot resurrect a removed entry or replace the next file', async ({ page }) => {
  let release, arrived;
  const hold = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/workspace/editor', async route => { const response = await route.fetch(); arrived(); await hold; await route.fulfill({ response }); });
  await page.locator('#media-file-input').setInputFiles(path.join(root, 'generated.mp4')); await waiting;
  page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
  await expect(page.locator('#media-drop-zone')).toBeVisible();
  const id = await intake(page, 'generated.wav'); release();
  await expect(page.locator('#processing-file-list option')).toHaveText('generated.wav');
  await expect(page.locator('#media-editor')).toBeHidden();
  expect((await page.evaluate(() => window.LVOVDLocalWorkspace.profileState())).workspaceId).toBe(id);
  expect((await snapshot(id)).playback).toBeNull();
});

test('container-only MOV to MP4 remux keeps automatic original playback separate from processing', async ({ page }) => {
  const id = await intake(page, 'generated.mov'); await page.locator('#processing-container').selectOption('mp4');
  await expect(page.locator('#conversion-plan-title')).toContainText('Remux'); await processFile(page);
  const output = await downloaded(page, 'remux.mp4'); expect(probe(output.file).streams.map(stream => stream.codec_name)).toEqual(['h264', 'aac']);
  const state = await snapshot(id); expect(state.assets.some(asset => ['playback-proxy', 'edited-output'].includes(asset.role))).toBe(false);
  expect(state.editor.status).toBe('ready'); expect(state.conversion.output.noOp).toBe(false);
});

test('cuts plus H.264 settings make one real original-source result while pending cuts, playhead and zoom survive', async ({ page }) => {
  const uploads = [], connections = [], processing = [], renders = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/media/local') uploads.push(request); if (request.url().includes('/api/processing/queue/progress')) connections.push(request);
    if (request.url().endsWith('/api/processing/queue')) processing.push(...request.postDataJSON().entries); if (request.url().endsWith('/api/workspace/render')) renders.push(request); });
  const id = await intake(page); await expect(page.locator('#editor-video')).toHaveAttribute('src', /api/);
  await cut(page); await exact(page, 'cut-start-time', '3'); await page.locator('#timeline-zoom-in').click(); await page.locator('#go-to-start').click();
  const window = await page.locator('#timeline-visible-label').textContent(), time = await page.locator('#editor-video').evaluate(video => video.currentTime);
  await page.evaluate(() => { window.LVOVDEditorView.conversionState().editPlan.keepRanges[0].endSeconds = 99; });
  await page.locator('input[name="processing-rate"][value="quality"]').check(); await exact(page, 'processing-crf', '24');
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
  const id = await intake(page); await cut(page); await page.locator('input[name="processing-rate"][value="quality"]').check(); await processFile(page);
  const previousUrl = await page.locator('#conversion-download').getAttribute('href'), previous = (await downloaded(page)).bytes;
  await page.locator('#processing-scale').selectOption('fit');
  await expect(page.locator('#conversion-output-target')).toContainText('Previous draft');
  await expect(page.locator('#conversion-output-settings')).toContainText('CRF 18');
  await expect(page.locator('#removed-sections')).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#processing-reset').click();
  await expect(page.locator('#processing-scale')).toHaveValue('fit');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#processing-reset').click();
  await expect(page.locator('input[name="processing-rate"][value="automatic"]').first()).toBeChecked(); await expect(page.locator('#processing-container')).toHaveValue('source');
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
  await page.locator('input[name="processing-rate"][value="quality"]').check(); await oldFetched;
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
  await page.locator('input[name="processing-rate"][value="size"]').check(); await exact(page, 'processing-maximum-mb', '0.15');
  await page.locator('#processing-audio-codec').selectOption('aac'); await exact(page, 'processing-audio-bitrate', '32');
  await expect(page.locator('#processing-plan-facts')).toContainText('80 × 44'); await processFile(page);
  const output = await downloaded(page, 'small.mp4'); expect(output.bytes.length).toBeLessThanOrEqual(150000);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#media-workspace-panel').screenshot({ path: path.join(os.tmpdir(), 'lvovd-unified-narrow.png') });
});

test('additional local files are accepted and Remove File confirmation invalidates only its selected entry', async ({ page, request }) => {
  const uploads = []; page.on('request', request => { if (request.url().endsWith('/api/media/local')) uploads.push(request); });
  const id = await intake(page);
  const dropped = await Promise.all(['portrait example.mp4', 'generated.wav'].map(async name => ({ name, bytes: [...await fs.readFile(path.join(root, name))] })));
  await page.locator('#media-workspace-panel').evaluate((panel, files) => {
    const dataTransfer = new DataTransfer();
    for (const file of files) dataTransfer.items.add(new File([new Uint8Array(file.bytes)], file.name));
    panel.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  }, dropped);
  await expect(page.locator('#processing-file-list option')).toHaveCount(3); expect(uploads).toHaveLength(3);
  await selectFile(page, id);
  await exact(page, 'editor-start-time', '1'); page.once('dialog', dialog => dialog.dismiss()); await page.locator('#workspace-discard').click();
  await expect(page.locator('#local-media-ready')).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
  await expect(page.locator('#processing-file-list option')).toHaveCount(2); await expect(page.locator('#local-media-ready')).toBeVisible();
  expect((await request.get(`/api/workspace/progress?workspace=${id}`)).status()).toBe(404);
  const remaining = await page.evaluate(() => window.LVOVDLocalWorkspace.collectionState());
  for (const entry of remaining.entries) expect((await snapshot(entry.workspaceId)).sourceAssetId).toBe(entry.sourceAssetId);
});

test('video cuts apply to audio extraction and Reset Range keeps the selected encoding settings', async ({ page }) => {
  const id = await intake(page); await cut(page);
  await page.locator('input[name="processing-rate"][value="quality"]').check();
  await page.locator('#reset-range').click();
  await expect(page.locator('input[name="processing-rate"][value="quality"]').first()).toBeChecked();
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.000');
  await cut(page); await page.locator('#processing-container').selectOption('m4a');
  await expect(page.locator('#processing-rate-mode')).toBeHidden();
  await expect(page.locator('#processing-bitrate-fields')).toBeHidden();
  await expect(page.locator('#processing-size-fields')).toBeHidden();
  await expect(page.locator('#processing-audio-bitrate')).toBeVisible();
  await expect(page.locator('#processing-plan-facts')).toContainText('00:00:03.000');
  await processFile(page); const output = await downloaded(page, 'cut-audio.m4a'), actual = probe(output.file);
  expect(actual.streams.map(stream => stream.codec_type)).toEqual(['audio']);
  expect(Math.abs(Number(actual.format.duration) - 3)).toBeLessThanOrEqual(0.08);
  expect((await snapshot(id)).assets.some(asset => asset.role === 'edited-output')).toBe(false);
  await page.locator('#processing-container').selectOption('mp4');
  await expect(page.locator('input[name="processing-rate"][value="quality"]').first()).toBeChecked();
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.500');
});

test('cancellation preserves current cuts and admits an explicit retry with immutable submitted settings', async ({ page }) => {
  const id = await intake(page, 'longer.mp4'); await page.locator('input[name="processing-rate"][value="quality"]').check();
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

test('multiple local entries restore independent authoring and settings through one browser progress connection', async ({ page }) => {
  const uploads = [], connections = [], previews = [];
  page.on('request', request => {
    const endpoint = new URL(request.url()).pathname;
    if (endpoint === '/api/media/local') uploads.push(request);
    if (endpoint.endsWith('/progress')) connections.push(request.url());
    if (endpoint === '/api/workspace/editor') previews.push(request.postDataJSON());
  });
  const collection = await intakeFiles(page, ['generated.mp4', 'portrait example.mp4', 'generated.wav']);
  const [first, second, audio] = collection.entries;
  await expect(page.locator('#processing-file-list')).toHaveValue(first.workspaceId);
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  expect(previews.map(request => request.workspaceId)).toEqual([first.workspaceId]);
  await cut(page); await exact(page, 'cut-start-time', '3'); await page.locator('#timeline-zoom-in').click();
  await page.locator('#go-to-start').click();
  await page.locator('[name="processing-rate"][value="quality"]').check(); await exact(page, 'processing-crf', '24');
  await page.locator('#processing-filename-suffix').fill('_first');
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.seeking)).toBe(false);
  const firstView = await page.evaluate(() => window.LVOVDEditorView.authoringState());
  const firstProfile = await page.evaluate(() => window.LVOVDLocalWorkspace.profileState());
  await selectFile(page, second.workspaceId);
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.videoHeight)).toBe(520);
  await exact(page, 'editor-end-time', '2'); await exact(page, 'cut-start-time', '0.5');
  await page.locator('#processing-scale').selectOption('percent:50'); await page.locator('#processing-filename-suffix').fill('_portrait');
  await page.locator('#timeline-zoom-in').click();
  const secondView = await page.evaluate(() => window.LVOVDEditorView.authoringState());
  await selectFile(page, audio.workspaceId);
  await expect(page.locator('#media-editor')).toBeHidden();
  await page.locator('#processing-container').selectOption('m4a'); await page.locator('#processing-audio-codec').selectOption('aac');
  await page.locator('#processing-filename-suffix').fill('_audio');
  await selectFile(page, first.workspaceId);
  await expect(page.locator('#processing-filename-suffix')).toHaveValue('_first');
  await expect(page.locator('#processing-crf')).toHaveValue('24');
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.seeking)).toBe(false);
  expect(await page.evaluate(() => window.LVOVDEditorView.authoringState())).toEqual(firstView);
  expect((await page.evaluate(() => window.LVOVDLocalWorkspace.profileState())).draftRevision).toBe(firstProfile.draftRevision);
  await selectFile(page, second.workspaceId);
  expect(await page.evaluate(() => window.LVOVDEditorView.authoringState())).toEqual(secondView);
  await expect(page.locator('#processing-scale')).toHaveValue('percent:50');
  await expect(page.locator('#processing-filename-suffix')).toHaveValue('_portrait');
  await page.evaluate(() => { const state = window.LVOVDLocalWorkspace.collectionState(); state.entries[0].settings.filenameSuffix = '_mutated'; state.entries[0].editPlan.keepRanges.length = 0; });
  await selectFile(page, first.workspaceId);
  await expect(page.locator('#processing-filename-suffix')).toHaveValue('_first');
  expect((await page.evaluate(() => window.LVOVDLocalWorkspace.profileState())).editPlan).toEqual(firstProfile.editPlan);
  expect(uploads).toHaveLength(3); expect(connections).toHaveLength(1);
  expect(connections[0]).toContain('/api/processing/queue/progress?collection=');
  expect(previews.map(request => request.workspaceId)).toEqual([first.workspaceId, second.workspaceId]);
  await expect(page.locator('#conversion-start')).toBeEnabled();
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.readyState)).toBe(4);
  await page.locator('#media-workspace-panel').screenshot({ path: path.join(os.tmpdir(), 'lvovd-multiple-files-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#processing-file-list').focus(); await page.keyboard.press('ArrowDown');
  await expect(page.locator('#processing-file-list')).toHaveValue(second.workspaceId);
  await page.locator('#processing-process-all').focus(); await expect(page.locator('#processing-process-all')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#conversion-start')).toBeEnabled();
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.readyState)).toBe(4);
  await page.locator('#media-workspace-panel').screenshot({ path: path.join(os.tmpdir(), 'lvovd-multiple-files-narrow.png') });
});

test('a delayed preview for another entry cannot replace the selected player or its profile', async ({ page }) => {
  let release, arrived;
  const hold = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  let firstRequest = true;
  await page.route('**/api/workspace/editor', async route => {
    if (!firstRequest) return route.continue();
    firstRequest = false; const response = await route.fetch(); arrived(); await hold; await route.fulfill({ response });
  });
  const collection = await intakeFiles(page, ['generated.mp4', 'portrait example.mp4'], { waitForReview: false }); await waiting;
  const [first, second] = collection.entries;
  await selectFile(page, second.workspaceId);
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.videoHeight)).toBe(520);
  await exact(page, 'editor-end-time', '2'); await page.locator('#processing-filename-suffix').fill('_selected');
  release(); await expect(page.locator('#editor-media-name')).toHaveText('portrait example.mp4');
  await expect(page.locator('#editor-end-time')).toHaveValue('00:00:02.000');
  await expect(page.locator('#editor-video')).toHaveAttribute('src', new RegExp(second.sourceAssetId));
  await selectFile(page, first.workspaceId);
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.videoHeight)).toBe(90);
  await expect(page.locator('#editor-end-time')).toHaveValue('00:00:05.000');
  await selectFile(page, second.workspaceId); await expect(page.locator('#processing-filename-suffix')).toHaveValue('_selected');
});

test('an older queue HTTP snapshot cannot overwrite newer progress or remove a subsequently added file', async ({ page }) => {
  const connections = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/processing/queue/progress') connections.push(request); });
  const firstId = await intake(page);
  let release, arrived;
  const hold = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  let firstResponse = true;
  await page.route('**/api/processing/queue', async route => {
    if (!firstResponse) return route.continue();
    firstResponse = false; const response = await route.fetch(); arrived(); await hold; await route.fulfill({ response });
  });
  await page.locator('#conversion-start').click(); await waiting;
  await expect(page.locator('#conversion-download')).toBeVisible();
  const originalUrl = await page.locator('#conversion-download').getAttribute('href');
  await page.locator('#media-file-input').setInputFiles(path.join(root, 'portrait example.mp4'));
  await expect(page.locator('#processing-file-list option')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState().entries.every(entry => entry.sourceAssetId && entry.inspection))).toBe(true);
  const secondId = (await page.evaluate(() => window.LVOVDLocalWorkspace.collectionState())).entries.find(entry => entry.workspaceId !== firstId).workspaceId;
  const released = page.waitForResponse(response => new URL(response.url()).pathname === '/api/processing/queue');
  release(); await released;
  await expect(page.locator('#processing-file-list option')).toHaveCount(2);
  await expect(page.locator('#conversion-download')).toHaveAttribute('href', originalUrl);
  expect((await downloaded(page)).bytes).toEqual(await fs.readFile(path.join(root, 'generated.mp4')));
  await selectFile(page, secondId); await expect(page.locator('#editor-media-name')).toHaveText('portrait example.mp4');
  await processFile(page); expect((await downloaded(page)).bytes).toEqual(await fs.readFile(path.join(root, 'portrait example.mp4')));
  await selectFile(page, firstId); await expect(page.locator('#conversion-download')).toHaveAttribute('href', originalUrl);
  expect(connections).toHaveLength(1);
});

test('Apply output settings copies only explicit groups and reviews incompatible files without copying cuts', async ({ page }) => {
  const collection = await intakeFiles(page, ['generated.mp4', 'portrait example.mp4', 'generated.wav']);
  const [first, second, audio] = collection.entries;
  await cut(page); await page.locator('#processing-video-codec').selectOption('h264');
  await page.locator('[name="processing-rate"][value="quality"]').check(); await exact(page, 'processing-crf', '24');
  await page.locator('#processing-scale').selectOption('percent:50'); await page.locator('#processing-filename-suffix').fill('_shared');
  await selectFile(page, second.workspaceId); await exact(page, 'editor-end-time', '2'); await exact(page, 'cut-start-time', '0.5');
  await page.locator('#timeline-zoom-in').click(); const before = await page.evaluate(() => window.LVOVDEditorView.authoringState());
  await selectFile(page, first.workspaceId);
  await page.locator('#processing-apply-settings summary').click();
  for (const group of ['video', 'picture', 'rate', 'audio', 'suffix']) await page.locator(`[name="processing-apply-group"][value="${group}"]`).setChecked(['video', 'rate', 'suffix'].includes(group));
  await page.locator('#processing-apply-all').click();
  await selectFile(page, second.workspaceId);
  await expect(page.locator('#processing-crf')).toHaveValue('24'); await expect(page.locator('#processing-filename-suffix')).toHaveValue('_shared');
  await expect(page.locator('#processing-scale')).toHaveValue('unchanged');
  expect(await page.evaluate(() => window.LVOVDEditorView.authoringState())).toEqual(before);
  await selectFile(page, audio.workspaceId); await expect(page.locator('#conversion-start')).toBeDisabled();
  await expect(page.locator('#conversion-plan-title')).not.toContainText('Reviewing');
  await expect(page.locator('#conversion-plan')).toContainText(/video|supported|audio/i);
  await page.locator('#processing-process-all').click(); await expect(page.locator('#processing-batch-review')).toBeVisible();
  await expect(page.locator('#processing-batch-review')).toContainText('generated.wav');
  await expect(page.locator('#processing-batch-review')).toContainText(/review|invalid|unavailable|cannot/i);
  expect((await snapshot(first.workspaceId)).conversion.output).toBeNull();
  expect((await snapshot(second.workspaceId)).conversion.output).toBeNull();
  const unavailable = page.locator('.processing-batch-row').filter({ hasText: 'generated.wav' });
  await expect(unavailable.locator('input[type="checkbox"]')).toBeDisabled();
  for (const box of await page.locator('#processing-batch-review input[type="checkbox"]:enabled').all()) await box.check();
  await page.locator('#processing-batch-submit').click();
  await expect.poll(() => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState().jobs.map(job => job.status))).toEqual(['completed', 'completed']);
  expect((await snapshot(audio.workspaceId)).conversion.output).toBeNull();
  await selectFile(page, first.workspaceId); const firstOutput = probe((await downloaded(page, 'shared-first.mp4')).file);
  expect(firstOutput.streams.find(stream => stream.codec_type === 'video').width).toBe(80);
  expect(Math.abs(Number(firstOutput.format.duration) - 3)).toBeLessThanOrEqual(0.08);
  await selectFile(page, second.workspaceId); const secondOutput = probe((await downloaded(page, 'shared-second.mp4')).file);
  expect(secondOutput.streams.find(stream => stream.codec_type === 'video').width).toBe(390);
  expect(Math.abs(Number(secondOutput.format.duration) - 2)).toBeLessThanOrEqual(0.08);
});

test('a file that fails real inspection leaves the Files list usable and does not prevent processing another entry', async ({ page }) => {
  await page.locator('#media-file-input').setInputFiles([path.join(root, 'invalid.mp4'), path.join(root, 'generated.mp4')]);
  await expect(page.locator('#processing-file-list option')).toHaveCount(2);
  await expect(page.locator('#processing-file-list')).toBeVisible(); await expect(page.locator('#workspace-failure')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState().entries[1].workspace.status)).toBe('ready');
  const collection = await page.evaluate(() => window.LVOVDLocalWorkspace.collectionState());
  const [invalid, valid] = collection.entries;
  expect(invalid.workspace.status).toBe('error');
  await selectFile(page, valid.workspaceId); await processFile(page);
  expect((await downloaded(page)).bytes).toEqual(await fs.readFile(path.join(root, 'generated.mp4')));
  await page.locator('#processing-container').selectOption('mov');
  await page.locator('#processing-file-list').selectOption(invalid.workspace.id);
  await expect(page.locator('#workspace-failure')).toBeVisible();
  await expect(page.locator('#processing-file-list')).toBeVisible();
  await submitAll(page);
  await expect.poll(() => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState().jobs.map(job => job.status))).toEqual(['completed']);
  expect((await snapshot(invalid.workspace.id)).status).toBe('error');
  await selectFile(page, valid.workspaceId);
  await expect(page.locator('#conversion-output-settings')).toContainText('Container: mov');
  const output = await downloaded(page, 'after-invalid.mov');
  expect(probe(output.file).streams.map(stream => stream.codec_name)).toEqual(['h264', 'aac']);
});

test('Process All queues independent immutable drafts and downloads each file with its own retained content', async ({ page }) => {
  test.setTimeout(90000);
  const submitted = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/processing/queue') submitted.push(request.postDataJSON()); });
  const collection = await intakeFiles(page, ['longer.mp4', 'generated.mp4', 'generated.wav']);
  const [first, second, audio] = collection.entries;
  await page.locator('[name="processing-rate"][value="quality"]').check(); await page.locator('#processing-preset').selectOption('veryslow');
  await exact(page, 'editor-start-time', '0.5');
  await selectFile(page, second.workspaceId); await cut(page); await page.locator('[name="processing-rate"][value="quality"]').check();
  await exact(page, 'processing-crf', '24'); await page.locator('#processing-filename-suffix').fill('_second');
  const secondRevision = (await page.evaluate(() => window.LVOVDLocalWorkspace.profileState())).draftRevision;
  await selectFile(page, audio.workspaceId); await page.locator('#processing-container').selectOption('m4a');
  await page.locator('#processing-audio-codec').selectOption('aac'); await page.locator('#processing-filename-suffix').fill('_audio');
  await selectFile(page, first.workspaceId); await submitAll(page);
  expect(submitted).toHaveLength(1); expect(submitted[0].entries.map(entry => entry.workspaceId)).toEqual([first.workspaceId, second.workspaceId, audio.workspaceId]);
  await selectFile(page, second.workspaceId);
  await expect.poll(() => page.evaluate(id => window.LVOVDLocalWorkspace.collectionState().jobs.find(job => job.workspaceId === id)?.status, second.workspaceId)).toBe('queued');
  await page.locator('#processing-filename-suffix').fill('_newer'); await exact(page, 'editor-end-time', '4');
  await expect(page.locator('#conversion-download')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#conversion-output-target')).toContainText('Previous draft');
  const secondOutput = await downloaded(page, 'batch-second.mp4'), secondInspection = probe(secondOutput.file);
  expect(secondOutput.name).toBe('generated_second.mp4');
  expect(Math.abs(Number(secondInspection.format.duration) - 3)).toBeLessThanOrEqual(0.08);
  expect(secondInspection.streams.find(stream => stream.codec_type === 'video').width).toBe(160);
  expect(decodedTone(secondOutput.file)).toBeCloseTo(700, -1);
  expect((await snapshot(second.workspaceId)).conversion.output.processingSnapshot.draftRevision).toBe(secondRevision);
  await expect(page.locator('#editor-end-time')).toHaveValue('00:00:04.000');
  await selectFile(page, audio.workspaceId); await expect(page.locator('#conversion-download')).toBeVisible();
  const audioOutput = await downloaded(page, 'batch-audio.m4a');
  expect(audioOutput.name).toBe('generated_audio.m4a');
  expect(probe(audioOutput.file).streams.map(stream => stream.codec_type)).toEqual(['audio']);
  expect(decodedTone(audioOutput.file)).toBeCloseTo(600, -1);
  await selectFile(page, first.workspaceId); const firstOutput = await downloaded(page, 'batch-first.mp4');
  expect(Math.abs(Number(probe(firstOutput.file).format.duration) - 14.5)).toBeLessThanOrEqual(0.08);
  expect(probe(firstOutput.file).streams.map(stream => stream.codec_type)).toEqual(['video']);
  const jobs = (await page.evaluate(() => window.LVOVDLocalWorkspace.collectionState())).jobs;
  expect(jobs.map(job => job.status)).toEqual(['completed', 'completed', 'completed']);
});

test('queued Remove and Reset affect only their file while Cancel All preserves earlier downloads and stops later starts', async ({ page, request }) => {
  test.setTimeout(90000);
  const previews = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/workspace/editor') previews.push(request.postDataJSON()); });
  const collection = await intakeFiles(page, ['longer.mp4', 'generated.mp4', 'portrait example.mp4']);
  const [first, second, third] = collection.entries;
  await processFile(page); const firstUrl = await page.locator('#conversion-download').getAttribute('href');
  await page.locator('[name="processing-rate"][value="quality"]').check(); await page.locator('#processing-preset').selectOption('veryslow');
  await exact(page, 'editor-start-time', '0.5');
  await selectFile(page, second.workspaceId); await processFile(page);
  const secondUrl = await page.locator('#conversion-download').getAttribute('href'), previous = (await downloaded(page)).bytes;
  await cut(page); await page.locator('[name="processing-rate"][value="quality"]').check();
  await selectFile(page, third.workspaceId); await exact(page, 'editor-end-time', '2');
  await selectFile(page, first.workspaceId); await submitAll(page);
  await selectFile(page, second.workspaceId);
  await expect.poll(() => page.evaluate(id => window.LVOVDLocalWorkspace.collectionState().jobs.find(job => job.workspaceId === id)?.status, second.workspaceId)).toBe('queued');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#processing-reset').click();
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.000');
  await expect(page.locator('#conversion-download')).toHaveAttribute('href', secondUrl);
  await selectFile(page, third.workspaceId);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
  await expect(page.locator('#processing-file-list option')).toHaveCount(2);
  expect((await request.get(`/api/workspace/progress?workspace=${third.workspaceId}`)).status()).toBe(404);
  await page.locator('#media-file-input').setInputFiles(path.join(root, 'generated.mov'));
  await expect(page.locator('#processing-file-list option')).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState().entries.every(entry => entry.sourceAssetId && entry.inspection))).toBe(true);
  const waitingPreview = (await page.evaluate(() => window.LVOVDLocalWorkspace.collectionState())).entries.find(entry => ![first.workspaceId, second.workspaceId].includes(entry.workspaceId));
  await selectFile(page, waitingPreview.workspaceId);
  await expect(page.locator('#processing-preview-note')).toContainText('after');
  expect(previews.some(body => body.workspaceId === waitingPreview.workspaceId)).toBe(false);
  await page.locator('#processing-cancel-all').click();
  await expect(page.locator('#processing-cancel-all')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState().jobs.map(job => job.status))).toEqual(['cancelled', 'cancelled']);
  await expect(page.locator('#editor-video')).toHaveAttribute('src', new RegExp(waitingPreview.sourceAssetId));
  expect(previews.filter(body => body.workspaceId === waitingPreview.workspaceId)).toHaveLength(1);
  await selectFile(page, second.workspaceId);
  await expect(page.locator('#conversion-download')).toHaveAttribute('href', secondUrl);
  expect((await downloaded(page)).bytes).toEqual(previous);
  expect((await snapshot(second.workspaceId)).conversion.output.processingSnapshot.editPlan.keepRanges).toEqual([{ startSeconds: 0, endSeconds: 5 }]);
  await selectFile(page, first.workspaceId);
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.500');
  await expect(page.locator('#processing-preset')).toHaveValue('veryslow');
  await expect(page.locator('#conversion-download')).toHaveAttribute('href', firstUrl);
  expect((await downloaded(page)).bytes).toEqual(await fs.readFile(path.join(root, 'longer.mp4')));
  await selectFile(page, second.workspaceId); await processFile(page);
  expect((await downloaded(page)).bytes).toEqual(previous);
});
