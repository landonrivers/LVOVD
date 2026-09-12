'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { managedBinaryPath } = require('../../ytdlp-manager');
let root, app, server, base;
const connections = [];
const state = page => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState());
function media(command, args) { return execFileSync(command, args, { windowsHide: true, timeout: 30000 }); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-browser-progress-'));
  process.env.YTDLP_PATH = managedBinaryPath(); process.env.LVOVD_DATA_DIR = path.join(root, 'history');
  process.env.HOST = '127.0.0.1'; process.env.PORT = String(45000 + process.pid % 10000);
  app = require('../../app-server');
  // Playwright reuses this worker/module after the owned cleanup harness. Its
  // old temporary root has been removed; start this fixture with a fresh root.
  expect(app.mediaWorkspaces.workspaces.size).toBe(0); expect(app.mediaWorkspaces.cleanupPending.size).toBe(0);
  app.mediaWorkspaces.tempDir = root; app.mediaWorkspaces.rootPromise = null; app.mediaWorkspaces.fs = fs;
  // Exercise the real HTTP/security handler with a bounded transport buffer.
  // 8 KiB makes backpressure deterministic across Node versions/platforms;
  // no mocked SSE data, processing, browser requests, or production backdoor.
  const handler = require('../../server').server.listeners('request')[0];
  server = http.createServer({ highWaterMark: 8192 }, (req, res) => {
    if (req.url.startsWith('/api/processing/queue/progress?')) {
      const connection = { response: res, writes: 0, pressured: 0, bytes: 0, repeated: 0, maxRepeated: 0 }; connections.push(connection);
      const write = res.write.bind(res);
      res.write = (...args) => {
        const accepted = write(...args);
        if (String(args[0]).startsWith('data:')) {
          connection.writes++; connection.bytes = Buffer.byteLength(args[0]); if (!accepted) connection.pressured++;
          const data = JSON.parse(String(args[0]).slice(6)); delete data.revision;
          const content = JSON.stringify(data);
          connection.repeated = content === connection.last ? connection.repeated + 1 : 0; connection.last = content;
          connection.maxRepeated = Math.max(connection.maxRepeated, connection.repeated);
          // Bound a regressed synchronous drain storm so the test runner itself
          // can report failure rather than starving its own timeout indefinitely.
          if (connection.repeated === 10) { console.log(JSON.stringify({ repeatedSnapshots: connection.repeated, bytes: connection.bytes })); res.destroy(); }
        }
        return accepted;
      };
    }
    handler(req, res);
  });
  await new Promise(resolve => server.listen(Number(process.env.PORT), '127.0.0.1', resolve));
  base = `http://127.0.0.1:${process.env.PORT}`;
  for (const [name, tone] of [['first', 500], ['second', 900]]) {
    media('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=3',
      '-f', 'lavfi', '-i', `sine=frequency=${tone}:sample_rate=48000:duration=3`, '-c:v', 'libx264', '-c:a', 'aac', path.join(root, name + '.mp4')]);
  }
});
test.beforeEach(async ({ page }) => {
  connections.length = 0;
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) { super(...args); this.addEventListener('message', event => { window.progressRevision = JSON.parse(event.data).revision; }); }
    };
  });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  expect((await page.goto(base)).ok()).toBe(true);
});
test.afterEach(async ({ page }) => { await page.goto('about:blank'); await app.mediaWorkspaces.clearAll(); });
test.afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });

// Wait for the real response's drain, not a timeout guessed to outlast a loop.
// An unchanged snapshot must not replenish the buffer from that drain event.
async function expectSettledProgress(collection, label) {
  const queue = app.mediaWorkspaces.localProcessing, connection = connections.at(-1);
  // Let any real terminal updates already in flight finish before the probe.
  await new Promise(resolve => setImmediate(resolve));
  expect(connection.bytes).toBeGreaterThan(connection.response.writableHighWaterMark);
  const drained = once(connection.response, 'drain'); queue.emit(collection);
  await drained; await new Promise(resolve => setImmediate(resolve));
  console.log(JSON.stringify({ label, bytes: connection.bytes, pressuredWrites: connection.pressured, waitingForDrain: Boolean(collection.waitingForDrain) }));
  expect(connection.bytes).toBeGreaterThan(connection.response.writableHighWaterMark);
  expect(connection.pressured).toBeGreaterThan(0);
  expect(collection.waitingForDrain).toBe(false);
}

test('two shared MP3 jobs finish with the first selected and oversized progress settles after completion and reopening', async ({ page }, testInfo) => {
  const errors = [], badRequests = [], plans = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) badRequests.push([response.status(), new URL(response.url()).pathname]); });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/processing/plan') plans.push(request.postDataJSON()); });
  await page.locator('#media-file-input').setInputFiles(['first', 'second'].map(name => path.join(root, name + '.mp4')));
  await expect.poll(async () => (await state(page)).entries.filter(entry => entry.inspection).length).toBe(2);
  await expect(page.locator('#conversion-start')).toBeEnabled();
  const before = await state(page), firstId = before.selectedId;
  await expect(page.locator('#processing-apply-all')).toBeChecked();
  await page.locator('#editor-start-time').fill('0.5'); await page.locator('#editor-start-time').press('Enter');
  await page.locator('#editor-end-time').fill('2.5'); await page.locator('#editor-end-time').press('Enter');
  await page.locator('#timeline-zoom-in').click();
  await page.locator('#cut-start-time').fill('1'); await page.locator('#cut-start-time').press('Enter');
  const authored = (await state(page)).entries[0];
  await page.locator('#processing-container').selectOption('mp3');
  await expect(page.locator('#conversion-plan-title')).not.toContainText('Reviewing');
  await page.locator('#processing-process-all').click();
  await expect(page.locator('#processing-batch-review')).not.toContainText('Reviewing files');
  for (const box of await page.locator('#processing-batch-review input[type=checkbox]:enabled').all()) await box.check();
  await expect(page.locator('#processing-batch-submit')).toHaveText('Queue And Process');
  expect(await page.locator('#processing-batch-submit').evaluate(button => getComputedStyle(button).backgroundImage)).toContain('linear-gradient');
  await page.locator('#processing-batch-review').screenshot({ path: testInfo.outputPath('queue-and-process.png') });
  await page.locator('#processing-batch-submit').click();
  await expect.poll(async () => (await state(page)).jobs.map(job => job.status)).toEqual(['completed', 'completed']);
  expect((await state(page)).selectedId).toBe(firstId);
  expect(Math.max(...connections.map(connection => connection.maxRepeated))).toBeLessThan(10);
  const collection = app.mediaWorkspaces.localProcessing.get(before.collectionId);
  await expectSettledProgress(collection, 'completed');
  expect(errors).toEqual([]); expect(badRequests).toEqual([]);
  const reviewed = plans.length;
  await expect(page.locator('#conversion-download')).toBeVisible();
  await page.evaluate(() => { window.selectedRulerTick = document.querySelector('.timeline-tick'); });
  await expectSettledProgress(collection, 'unchanged'); expect(plans.length).toBe(reviewed);
  await expect.poll(() => page.evaluate(() => window.progressRevision)).toBeGreaterThanOrEqual(collection.revision);
  expect(await page.evaluate(() => window.selectedRulerTick.isConnected)).toBe(true);
  const after = (await state(page)).entries[0];
  expect(after.editPlan).toEqual(authored.editPlan); expect(after.editorState.pendingCut).toEqual(authored.editorState.pendingCut); expect(after.editorState.visibleWindow).toEqual(authored.editorState.visibleWindow);
  await expect(page.getByRole('heading', { name: 'Processing results', exact: true })).toBeVisible();
  await expect(page.locator('#processing-results').getByRole('link', { name: /^Download MP3/ })).toHaveCount(2);
  await expect(page.locator('#processing-results-summary')).toHaveText('2 of 2 completed · 2 downloads available');
  await expect(page.locator('#processing-finish #conversion-output')).toHaveCount(0);
  for (const [index, sourceName] of ['first.mp4', 'second.mp4'].entries()) {
    const row = page.locator('[data-processing-result]').nth(index);
    await expect(row.getByRole('heading')).toHaveText(sourceName.replace('.mp4', '-processed.mp3'));
    await expect(row.getByRole('button', { name: sourceName, exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: `Edit source — ${sourceName}`, exact: true })).toBeVisible();
    await row.getByText('Result details', { exact: true }).click();
    await expect(row).toContainText('MP3 audio encoded'); await expect(row).not.toContainText('Audio codec unchanged');
    await row.getByText('Result details', { exact: true }).click();
  }
  const originals = [];
  for (const [index, tone, duration] of [[0, 500, 2], [1, 900, 3]]) {
    const link = page.locator('#processing-results-list a').nth(index);
    const waiting = page.waitForEvent('download'); await link.click(); const download = await waiting;
    expect(await download.failure()).toBeNull(); const file = path.join(root, `download-${index}.mp3`); await download.saveAs(file);
    const inspected = JSON.parse(media('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
    expect(inspected.streams.map(stream => stream.codec_name)).toEqual(['mp3']);
    expect(Math.abs(Number(inspected.format.duration) - duration)).toBeLessThan(.06);
    const pcm = media('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
    let crossings = 0; for (let sample = 24001; sample < 48000; sample++) if (pcm.readFloatLE((sample - 1) * 4) <= 0 && pcm.readFloatLE(sample * 4) > 0) crossings++;
    expect(Math.abs(crossings * 2 - tone)).toBeLessThanOrEqual(4);
    originals.push({ url: await link.getAttribute('href'), bytes: await fs.readFile(file) });
  }
  expect((await state(page)).selectedId).toBe(firstId);
  await page.locator('#processing-results').screenshot({ path: testInfo.outputPath('local-results-wide.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#processing-results-list a').nth(1).focus(); await expect(page.locator('#processing-results-list a').nth(1)).toBeFocused();
  await page.locator('#processing-results').screenshot({ path: testInfo.outputPath('local-results-narrow.png') });
  await page.locator('[data-processing-result]').nth(1).getByRole('button', { name: 'Edit source — second.mp4', exact: true }).click();
  expect((await state(page)).selectedId).toBe(before.entries[1].workspaceId);
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.000');
  await page.locator('[data-processing-result]').nth(0).getByRole('button', { name: 'Edit source — first.mp4', exact: true }).click();
  expect((await state(page)).entries[0].editPlan).toEqual(authored.editPlan);
  await page.reload();
  await page.locator(`[data-recovery-collection="${collection.id}"]`).getByRole('button', { name: 'Reopen files' }).click();
  await expect(page.locator('#conversion-download')).toBeVisible();
  await expectSettledProgress(collection, 'reopened');
  expect((await state(page)).jobs.map(job => job.status)).toEqual(['completed', 'completed']);
  for (let index = 0; index < 2; index++) {
    const link = page.locator('#processing-results-list a').nth(index);
    await expect(link).toHaveAttribute('href', originals[index].url);
    const waiting = page.waitForEvent('download'); await link.click(); const download = await waiting;
    expect(await fs.readFile(await download.path())).toEqual(originals[index].bytes);
  }
  expect(errors).toEqual([]); expect(badRequests).toEqual([]);
});

test('the shared results list keeps an earlier download after failure and exposes the next completed file', async ({ page, request }, testInfo) => {
  await page.locator('#media-file-input').setInputFiles(['first', 'second'].map(name => path.join(root, name + '.mp4')));
  await expect.poll(async () => (await state(page)).entries.filter(entry => entry.inspection).length).toBe(2);
  await expect(page.locator('#conversion-start')).toBeEnabled(); await page.locator('#conversion-start').click();
  await expect(page.locator('#conversion-download')).toBeVisible();
  const before = await state(page), firstId = before.selectedId, previousUrl = await page.locator('#conversion-download').getAttribute('href');
  const original = await fs.readFile(path.join(root, 'first.mp4'));
  const manager = app.mediaWorkspaces, directory = manager.get(firstId).tempDir;
  // Real encoding/validation, with a scoped publication failure on the first
  // file only. Its previous download must survive and the next job must run.
  manager.fs = { ...fs, rename: async (from, to) => {
    if (path.dirname(to) === directory) throw Object.assign(new Error('Synthetic publication failure'), { code: 'EACCES' });
    return fs.rename(from, to);
  } };
  try {
    await page.locator('#processing-container').selectOption('mp3'); await page.locator('#processing-process-all').click();
    await expect(page.locator('#processing-batch-review')).not.toContainText('Reviewing files');
    for (const box of await page.locator('#processing-batch-review input[type=checkbox]:enabled').all()) await box.check();
    await page.getByRole('button', { name: 'Queue And Process', exact: true }).click();
    await expect.poll(async () => (await state(page)).jobs.map(job => job.status)).toEqual(['failed', 'completed']);
    await expect(page.locator('#processing-results-summary')).toHaveText('1 of 2 completed · 1 failed · 2 downloads available');
    await expect(page.locator('#processing-download-all')).toBeDisabled();
    const first = page.locator(`[data-processing-result="${firstId}"]`);
    await expect(first).toContainText('Latest attempt failed'); await expect(first).toContainText('Previous result available');
    await expect(first.getByRole('link', { name: /^Download MP4/ })).toBeVisible();
    await expect(first.locator('a')).toHaveAttribute('href', previousUrl);
    const waiting = page.waitForEvent('download'); await first.locator('a').click(); const downloaded = await waiting;
    expect(await fs.readFile(await downloaded.path())).toEqual(original);
    await expect(page.locator('#processing-results-list a').nth(1)).toHaveAttribute('download', 'second-processed.mp3');
    await expectSettledProgress(manager.localProcessing.get(before.collectionId), 'failed and completed');
    await page.locator('#processing-results').screenshot({ path: testInfo.outputPath('previous-result-after-failure.png') });
    // A failed repeat of the *same* draft also leaves a previous result, not
    // a successful result of the latest attempt. Revision equality is not enough.
    const second = page.locator('[data-processing-result]').nth(1), secondId = before.entries[1].workspaceId;
    const previousMP3 = await second.locator('a').getAttribute('href');
    const previousBytes = await (await request.get(base + previousMP3)).body();
    await second.getByRole('button', { name: 'Edit source — second.mp4', exact: true }).click();
    const revision = (await state(page)).entries[1].draftRevision;
    manager.fs = { ...fs, rename: async (from, to) => {
      if (path.dirname(to) === manager.get(secondId).tempDir) throw Object.assign(new Error('Synthetic repeated publication failure'), { code: 'EACCES' });
      return fs.rename(from, to);
    } };
    await expect(page.locator('#conversion-start')).toBeEnabled(); await page.locator('#conversion-start').click();
    await expect(second).toContainText('Latest attempt failed'); await expect(second).toContainText('Previous result available');
    expect((await state(page)).entries[1].draftRevision).toBe(revision);
    await expect(second.getByRole('link', { name: /^Download MP3/ })).toHaveAttribute('href', previousMP3);
    expect(await (await request.get(base + previousMP3)).body()).toEqual(previousBytes);
    await first.getByRole('button', { name: 'Edit source — first.mp4', exact: true }).click();
    page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
    await expect(first).toHaveCount(0); expect((await request.get(base + previousUrl)).status()).toBe(404);
    await expect(page.locator('#processing-results-list a')).toHaveCount(1);
  } finally { manager.fs = fs; }
});

test('accepted batch reveals results once and preserves focus and scroll through real sequential progress', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    window.resultsReveals = 0;
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      if (this.id === 'processing-results') window.resultsReveals++;
      return scroll.apply(this, args);
    };
  });
  await page.locator('#media-file-input').setInputFiles(['first', 'second'].map(name => path.join(root, name + '.mp4')));
  await expect.poll(async () => (await state(page)).entries.filter(entry => entry.inspection).length).toBe(2);
  await expect(page.locator('#conversion-start')).toBeEnabled();
  await expect.poll(() => page.locator('#editor-video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  await page.locator('#processing-container').selectOption('mp3');
  await page.locator('#processing-process-all').click();
  await expect(page.locator('#processing-batch-review')).not.toContainText('Reviewing files');
  for (const box of await page.locator('#processing-batch-review input[type=checkbox]:enabled').all()) await box.check();
  const before = await state(page), manager = app.mediaWorkspaces;
  // Hold only real publication after FFmpeg and validation. Advance each file
  // explicitly so assertions observe actual queued/processing/completed states.
  const gates = before.entries.map(entry => ({ directory: manager.get(entry.workspaceId).tempDir, reached: deferred(), release: deferred() }));
  manager.fs = { ...fs, rename: async (from, to) => {
    const gate = gates.find(item => item.directory === path.dirname(to));
    if (gate) { gate.reached.resolve(); await gate.release.promise; }
    return fs.rename(from, to);
  } };
  try {
    await page.getByRole('button', { name: 'Queue And Process', exact: true }).click();
    await gates[0].reached.promise;
    const heading = page.getByRole('heading', { name: 'Processing results', exact: true });
    await expect(heading).toBeFocused(); await expect(heading).toBeInViewport();
    await expect(page.locator('#processing-results-summary')).toHaveText('0 of 2 completed · 1 queued · 1 processing · 0 downloads available');
    await expect(page.locator('#processing-download-all')).toBeDisabled();
    expect(await page.evaluate(() => window.resultsReveals)).toBe(1);
    // Leave space below the viewport: the compact layout can shorten at
    // completion. Test preservation of the user's scroll position without
    // hitting the browser's unavoidable clamp at the end of the document.
    await page.evaluate(() => window.scrollBy(0, -150));
    const collection = manager.localProcessing.get(before.collectionId);
    const stable = async focus => {
      // Observe painted state, including native scroll anchoring from the
      // initial admission layout, before emitting the next real progress update.
      const painted = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await painted();
      const viewport = () => page.evaluate(() => ({ y: window.scrollY, top: document.querySelector('#processing-results').getBoundingClientRect().top, height: document.documentElement.scrollHeight, video: document.querySelector('#editor-video').readyState, active: document.activeElement.id, reveals: window.resultsReveals }));
      const initial = await viewport(), scrollY = initial.y;
      manager.localProcessing.emit(collection);
      await expect.poll(() => page.evaluate(() => window.progressRevision)).toBeGreaterThanOrEqual(collection.revision);
      await painted();
      await expect(focus).toBeFocused();
      console.log(JSON.stringify({ initial, updated: await viewport() }));
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
      expect(await page.evaluate(() => window.resultsReveals)).toBe(1);
      expect((await state(page)).selectedId).toBe(before.selectedId);
    };
    await stable(heading);
    const firstScrollY = await page.evaluate(() => window.scrollY);
    gates[0].release.resolve(); await gates[1].reached.promise;
    await expect(page.locator('#processing-results-summary')).toHaveText('1 of 2 completed · 1 processing · 1 download available');
    await expect(heading).toBeFocused(); expect(await page.evaluate(() => window.scrollY)).toBe(firstScrollY);
    const firstDownload = page.getByRole('link', { name: 'Download MP3 — first-processed.mp3', exact: true });
    await firstDownload.focus(); await stable(firstDownload);
    await page.locator('#processing-results').screenshot({ path: testInfo.outputPath('processing-results-in-progress.png') });
    const scrollY = await page.evaluate(() => window.scrollY);
    gates[1].release.resolve();
    await expect(page.locator('#processing-results-summary')).toHaveText('2 of 2 completed · 2 downloads available');
    await expect(page.locator('#processing-download-all')).toBeEnabled();
    await expect(firstDownload).toBeFocused(); expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await stable(firstDownload);
  } finally { for (const gate of gates) gate.release.resolve(); manager.fs = fs; }
});

test('twenty results stay compact and all downloads retain their own names and exact no-op bytes', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const original = await fs.readFile(path.join(root, 'first.mp4'));
  const names = Array.from({ length: 20 }, (_, index) => `Generated source ${String(index + 1).padStart(2, '0')}.mp4`);
  await page.locator('#media-file-input').setInputFiles(names.map(name => ({ name, mimeType: 'video/mp4', buffer: original })));
  await expect.poll(async () => (await state(page)).entries.filter(entry => entry.inspection).length, { timeout: 30000 }).toBe(20);
  await expect(page.locator('#conversion-start')).toBeEnabled();
  const before = await state(page);
  await page.getByRole('button', { name: 'Review All Files (20)', exact: true }).click();
  await expect(page.locator('#processing-batch-review')).not.toContainText('Reviewing files');
  for (const box of await page.locator('#processing-batch-review input[type=checkbox]:enabled').all()) await box.check();
  await page.getByRole('button', { name: 'Queue And Process', exact: true }).click();
  await expect(page.locator('#processing-results-summary')).toHaveText('20 of 20 completed · 20 downloads available');
  const list = page.getByRole('region', { name: 'Processed files', exact: true });
  await expect(list.locator('[data-processing-result]')).toHaveCount(20);
  const geometry = await list.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, row: element.firstElementChild.getBoundingClientRect().height }));
  expect(geometry.height).toBeLessThanOrEqual(480); expect(geometry.content).toBeGreaterThan(geometry.height * 2);
  expect(geometry.row).toBeLessThanOrEqual(80);
  await list.focus(); await page.keyboard.press('End');
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  const last = list.locator('[data-processing-result]').last();
  await last.getByRole('link', { name: /^Download MP4/ }).focus();
  await expect(last.getByRole('link', { name: /^Download MP4/ })).toBeInViewport();
  const downloads = []; page.on('download', download => downloads.push(download));
  await page.getByRole('button', { name: 'Download All (20)', exact: true }).click();
  await expect.poll(() => downloads.length).toBe(20);
  expect(downloads.map(download => download.suggestedFilename()).sort()).toEqual(names.map(name => name.replace('.mp4', '-processed.mp4')).sort());
  for (const download of downloads) { expect(await download.failure()).toBeNull(); expect(await fs.readFile(await download.path())).toEqual(original); }
  expect((await state(page)).selectedId).toBe(before.selectedId);
  const collection = app.mediaWorkspaces.localProcessing.get(before.collectionId);
  await expectSettledProgress(collection, 'twenty completed downloads');
  await list.evaluate(element => { element.scrollTop = 0; });
  await page.locator('#processing-results').screenshot({ path: testInfo.outputPath('twenty-results-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#processing-results').screenshot({ path: testInfo.outputPath('twenty-results-narrow.png') });
});

for (const action of ['removed', 'replaced', 'discarded']) {
  test(`Download All stops its pending browser requests when results are ${action}`, async ({ page }) => {
    await page.locator('#media-file-input').setInputFiles(['first', 'second'].map(name => path.join(root, name + '.mp4')));
    await expect.poll(async () => (await state(page)).entries.filter(entry => entry.inspection).length).toBe(2);
    await expect(page.locator('#conversion-start')).toBeEnabled();
    await page.locator('#processing-process-all').click();
    await expect(page.locator('#processing-batch-review')).not.toContainText('Reviewing files');
    for (const box of await page.locator('#processing-batch-review input[type=checkbox]:enabled').all()) await box.check();
    await page.getByRole('button', { name: 'Queue And Process', exact: true }).click();
    await expect(page.locator('#processing-results-summary')).toHaveText('2 of 2 completed · 2 downloads available');
    // Hold only the browser's next paced download dispatch. Real API requests,
    // output bytes, processing, selection and removal remain production code.
    await page.evaluate(() => {
      const native = window.setTimeout;
      window.heldDownloadCallbacks = [];
      window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 250) return native(callback, delay, ...args);
        window.heldDownloadCallbacks.push(() => callback(...args)); return -window.heldDownloadCallbacks.length;
      };
    });
    const downloads = []; page.on('download', download => downloads.push(download));
    await page.getByRole('button', { name: 'Download All (2)', exact: true }).click();
    await expect.poll(() => downloads.length).toBe(1);
    expect(downloads[0].suggestedFilename()).toBe('first-processed.mp4');
    await expect(page.locator('#processing-download-all')).toBeDisabled();
    await page.getByRole('button', { name: 'Edit source — second.mp4', exact: true }).click();
    let downloadReleased = false;
    if (action === 'replaced') {
      await page.locator('#processing-apply-all').uncheck();
      await page.locator('#processing-container').selectOption('mp3');
      await expect(page.locator('#conversion-plan-title')).toContainText('Convert');
      for (const box of await page.locator('#conversion-warnings input').all()) await box.check();
      await expect(page.locator('#conversion-start')).toBeEnabled(); await page.locator('#conversion-start').click();
      await expect(page.locator('#conversion-output-name')).toHaveText('second-processed.mp3');
    } else {
      const removal = deferred(), release = deferred();
      if (action === 'removed') await page.route('**/api/workspace?*', async route => {
        if (route.request().method() === 'DELETE') { removal.resolve(); await release.promise; }
        await route.continue();
      });
      try {
        page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
        if (action === 'removed') {
          await removal.promise;
          // Browser removal intent invalidates pending dispatch even before the
          // server receives DELETE or aggregate progress removes this entry.
          await page.evaluate(() => window.heldDownloadCallbacks.shift()()); downloadReleased = true;
          await expect(page.locator('#processing-download-note')).toHaveText('Results changed. Download All stopped after 1 download request.');
          await expect(page.locator('#processing-download-all')).toBeDisabled();
          expect(downloads.length).toBe(1);
        }
      } finally { release.resolve(); }
      await expect(page.locator('#processing-file-list option')).toHaveCount(1);
      if (action === 'discarded') {
        page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
        await expect(page.locator('#media-drop-zone')).toBeVisible();
      }
    }
    if (!downloadReleased) await page.evaluate(() => window.heldDownloadCallbacks.shift()());
    if (action === 'discarded') {
      await expect(page.locator('#processing-download-note')).toBeHidden();
      await expect(page.locator('#processing-results')).toBeHidden();
    } else await expect(page.locator('#processing-download-note')).toHaveText('Results changed. Download All stopped after 1 download request.');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    expect(downloads.length).toBe(1);
    expect(await downloads[0].failure()).toBeNull();
    expect(await fs.readFile(await downloads[0].path())).toEqual(await fs.readFile(path.join(root, 'first.mp4')));
    expect(await page.evaluate(() => window.heldDownloadCallbacks.length)).toBe(0);
  });
}
