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
  await expect(page.locator('#processing-results-summary')).toHaveText('2 files ready');
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

test('the shared results list keeps an earlier download after failure and exposes the next completed file', async ({ page, request }) => {
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
    await expect(page.locator('#processing-results-summary')).toHaveText('2 files ready · 1 failed');
    const first = page.locator(`[data-processing-result="${firstId}"]`);
    await expect(first).toContainText('Failed'); await expect(first).toContainText('Previous draft; download unchanged');
    await expect(first.locator('a')).toHaveAttribute('href', previousUrl);
    const waiting = page.waitForEvent('download'); await first.locator('a').click(); const downloaded = await waiting;
    expect(await fs.readFile(await downloaded.path())).toEqual(original);
    await expect(page.locator('#processing-results-list a').nth(1)).toHaveAttribute('download', 'second-processed.mp3');
    await expectSettledProgress(manager.localProcessing.get(before.collectionId), 'failed and completed');
    page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
    await expect(first).toHaveCount(0); expect((await request.get(base + previousUrl)).status()).toBe(404);
    await expect(page.locator('#processing-results-list a')).toHaveCount(1);
  } finally { manager.fs = fs; }
});
