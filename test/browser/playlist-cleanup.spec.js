'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { once } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const { playlistSource } = require('../helpers/playlist-source');
const { managedBinaryPath } = require('../../ytdlp-manager');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
let sourceSpawns = 0;
let root, fixture, app, server, base;
const blocked = new Set(), transient = new Map();
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const state = page => page.evaluate(() => window.LVOVDLocalWorkspace.collectionState());
const profile = page => page.evaluate(() => window.LVOVDLocalWorkspace.profileState());
async function download(page) { const waiting = page.waitForEvent('download'); await page.locator('#conversion-download').click(); const result = await waiting; expect(await result.failure()).toBeNull(); return fs.readFile(await result.path()); }
async function exact(page, id, value) { await page.locator('#' + id).fill(value); await page.locator('#' + id).press('Enter'); }

test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-playlist-cleanup-')); fixture = await playlistSource(root);
  process.env.YTDLP_PATH = managedBinaryPath(); process.env.LVOVD_DATA_DIR = path.join(root, 'history');
  process.env.HOST = '127.0.0.1'; process.env.PORT = String(45000 + process.pid % 10000);
  childProcess.spawn = (command, ...args) => { if (command === process.env.YTDLP_PATH) sourceSpawns++; return originalSpawn(command, ...args); };
  app = require('../../app-server'); ({ server } = require('../../server'));
  const manager = app.mediaWorkspaces; manager.tempDir = root; manager.maxBytes = 1000000;
  manager.localProcessing.limits = Object.freeze({ ...manager.localProcessing.limits, maxSourceBytes: 1000000 });
  // Test-only filesystem seam: the real security gate, endpoints, coordinator,
  // managed yt-dlp, FFprobe, and browser are unchanged. Only this owned rm fails.
  manager.fs = { ...fs, rm: async (file, options) => {
    const control = transient.get(path.resolve(file));
    if (control) {
      if (control.failures-- > 0) throw Object.assign(new Error('Synthetic transient deletion failure'), { code: 'EBUSY' });
      control.started.resolve(); await control.release.promise;
    }
    if (blocked.has(path.resolve(file))) throw Object.assign(new Error('Synthetic owned-directory deletion failure'), { code: 'EACCES' });
    return fs.rm(file, options);
  } };
  await new Promise(resolve => server.listen(Number(process.env.PORT), '127.0.0.1', resolve));
  base = `http://127.0.0.1:${process.env.PORT}`;
});
test.beforeEach(async ({ page }) => {
  test.setTimeout(90000); fixture.requests.length = 0; sourceSpawns = 0; app.mediaWorkspaces.cleanupRetryDelaysMs = [];
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(base);
});
test.afterEach(async () => {
  blocked.clear(); for (const control of transient.values()) control.release.resolve(); transient.clear();
  const batches = [...app.mediaWorkspaces.localProcessing.collections.values()].map(collection => collection.intake?.promise).filter(Boolean);
  await app.mediaWorkspaces.clearAll(); await Promise.all(batches);
  for (const id of app.mediaWorkspaces.cleanupPending.keys()) await app.mediaWorkspaces.retryCleanup(id);
});
test.afterAll(async () => { childProcess.spawn = originalSpawn; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fixture.close(); await fs.rm(root, { recursive: true, force: true }); });

for (const action of ['Cancel Import', 'Remove waiting item']) {
  test(`${action} exposes failed cleanup of the different removed acquisition`, async ({ page }) => {
    await page.locator('#media-file-input').setInputFiles(fixture.files[1].file);
    await expect(page.locator('#conversion-start')).toBeEnabled(); await page.locator('#conversion-start').click();
    await expect(page.locator('#conversion-download')).toBeVisible(); const previousBytes = await download(page);
    const originalId = (await profile(page)).workspaceId;
    await exact(page, 'editor-start-time', '1'); await exact(page, 'editor-end-time', '4');
    await page.locator('#go-to-start').click(); await page.locator('#timeline-zoom-in').click(); await exact(page, 'cut-start-time', '2');
    const authored = await profile(page);
    await page.locator('#video-url').fill(fixture.url); await page.locator('#preview-button').click();
    await expect(page.locator('[data-playlist-entry]')).toHaveCount(3);
    await page.locator('[data-playlist-entry]').nth(1).uncheck();
    await page.locator('label:has([name="profile"][value="maximum"])').click();
    const hold = fixture.hold('/source-0.mp4', { afterBytes: 16384 }), accepted = gate(), releaseResponse = gate();
    let first = true, closeReader = () => {};
    await page.route('**/api/processing/import', async route => {
      if (!first) return route.continue(); first = false;
      const response = await route.fetch(); accepted.resolve(); await releaseResponse.promise; await route.fulfill({ response });
    });
    try {
      await page.locator('#open-editor-button').click(); await accepted.promise; await hold.accepted;
      const collection = app.mediaWorkspaces.localProcessing.get((await state(page)).collectionId);
      const active = collection.intake.current, directory = active.tempDir;
      await expect.poll(async () => (await fs.readdir(directory)).some(name => name.endsWith('.part'))).toBe(true);
      blocked.add(path.resolve(directory));
      const partial = (await fs.readdir(directory)).find(name => name.endsWith('.part'));
      const reader = createReadStream(path.join(directory, partial)); reader.pause(); await once(reader, 'open');
      const readerClosing = gate(); closeReader = reader.destroy.bind(reader);
      reader.destroy = () => { readerClosing.resolve(); return reader; };
      active.readStreams.set(reader, { response: { destroyed: false, destroy() { this.destroyed = true; } } });
      if (action === 'Cancel Import') await page.locator('#processing-import-cancel').click();
      else {
        await page.locator('#processing-file-list').selectOption(collection.intake.items[1].id);
        page.once('dialog', dialog => dialog.accept()); await page.locator('#workspace-discard').click();
      }
      await readerClosing.promise;
      await expect(page.locator('#workspace-removed-cleanup')).toContainText('cleanup pending');
      await expect(page.locator('#workspace-retry-cleanup')).toBeVisible(); await expect(page.locator('#workspace-retry-cleanup')).toBeDisabled();
      await expect.poll(() => active.child).toBeNull();
      expect(app.mediaWorkspaces.cleanupPending.has(active.id)).toBe(false);
      expect(app.mediaWorkspaces.localProcessing.snapshot(collection.id).sourceBytesReserved).toBe(1000000);
      reader.destroy = closeReader; closeReader(); await once(reader, 'close');
      await expect.poll(() => collection.intake.active).toBe(false);
      const queue = app.mediaWorkspaces.localProcessing;
      expect(app.mediaWorkspaces.get(active.id)).toBeNull();
      expect(app.mediaWorkspaces.cleanupStatus(active.id).status).toBe('failed');
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
      expect(queue.snapshot(collection.id).sourceBytesReserved).toBe(1000000);
      expect(fixture.requests.some(request => /(?:item|source)-2/.test(request.path))).toBe(false);
      await expect(page.locator('#processing-file-list option')).toHaveCount(1);
      expect((await state(page)).selectedId).toBe(originalId);
      const restored = await profile(page); expect(restored.editPlan).toEqual(authored.editPlan);
      expect(restored.editorState.pendingCut).toEqual(authored.editorState.pendingCut);
      expect(restored.editorState.visibleWindow).toEqual(authored.editorState.visibleWindow);
      expect(await download(page)).toEqual(previousBytes);
      console.log(JSON.stringify({ action, liveFiles: collection.members.size, cleanup: app.mediaWorkspaces.cleanupStatus(active.id).status,
        reservedBytes: queue.snapshot(collection.id).sourceBytesReserved, retryVisible: await page.locator('#workspace-retry-cleanup').isVisible() }));
      await expect(page.locator('#workspace-retry-cleanup')).toBeVisible();
      await expect(page.locator('#workspace-removed-cleanup')).toContainText('cleanup failed');
      const admissionDone = page.waitForResponse(response => new URL(response.url()).pathname === '/api/processing/import');
      releaseResponse.resolve(); await (await admissionDone).finished();
      await expect(page.locator('#workspace-removed-cleanup')).toContainText('cleanup failed');
      await expect(page.locator('#processing-file-list option')).toHaveCount(1);
      const firstImport = collection.intake.id, sourceRequests = fixture.requests.length, spawnsBefore = sourceSpawns, queuedBefore = JSON.stringify([...collection.jobs.values()]);
      expect(spawnsBefore).toBeGreaterThanOrEqual(2);
      await expect(page.locator('#open-editor-button')).toBeEnabled(); await page.locator('#open-editor-button').click();
      await expect.poll(() => collection.intake.id).not.toBe(firstImport);
      await expect.poll(() => collection.intake.active).toBe(false);
      expect(collection.intake.items.every(item => !item.workspaceId)).toBe(true);
      await expect(page.locator('#processing-import-items')).toContainText('storage budget is full');
      await expect(page.locator('#processing-import-items')).toContainText('pending cleanup');
      await expect(page.locator('#workspace-removed-cleanup')).toContainText('Generated item 0');
      const retry = page.locator('#workspace-retry-cleanup'); await expect(retry).toBeEnabled();
      const failedRetry = page.waitForResponse(response => new URL(response.url()).pathname === '/api/processing/cleanup');
      await retry.click(); expect((await failedRetry).ok()).toBe(true);
      await expect(page.locator('#workspace-removed-cleanup')).toContainText('cleanup failed');
      expect(queue.snapshot(collection.id).sourceBytesReserved).toBe(1000000);
      expect(fixture.requests.length).toBe(sourceRequests); expect(sourceSpawns).toBe(spawnsBefore);
      blocked.delete(path.resolve(directory));
      const successfulRetry = page.waitForResponse(response => new URL(response.url()).pathname === '/api/processing/cleanup');
      await expect(retry).toBeEnabled(); await retry.focus(); await page.keyboard.press('Enter'); expect((await successfulRetry).ok()).toBe(true);
      await expect(retry).toBeHidden(); await expect(page.locator('#workspace-removed-cleanup')).toBeHidden();
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(queue.snapshot(collection.id).sourceBytesReserved).toBe(fixture.files[1].bytes.length);
      expect(queue.entryCount(collection)).toBe(1); expect(fixture.requests.length).toBe(sourceRequests); expect(sourceSpawns).toBe(spawnsBefore);
      expect(JSON.stringify([...collection.jobs.values()])).toBe(queuedBefore);
      expect((await profile(page)).editPlan).toEqual(authored.editPlan); expect(await download(page)).toEqual(previousBytes);
      await page.locator('#media-file-input').setInputFiles(fixture.files[2].file);
      await expect(page.locator('#processing-file-list option')).toHaveCount(2);
      await expect.poll(async () => (await state(page)).entries.every(item => item.sourceAssetId)).toBe(true);
      expect(fixture.requests.length).toBe(sourceRequests); expect(sourceSpawns).toBe(spawnsBefore);
    } finally { closeReader(); hold.release(); releaseResponse.resolve(); }
  });
}

test('automatic removed cleanup clears recovery before an older retry acknowledgement arrives', async ({ page }) => {
  await page.locator('#video-url').fill(fixture.url); await page.locator('#preview-button').click();
  await expect(page.locator('[data-playlist-entry]')).toHaveCount(3);
  await page.locator('label:has([name="profile"][value="maximum"])').click();
  const hold = fixture.hold('/source-0.mp4', { afterBytes: 16384 }), responseAccepted = gate(), responseRelease = gate();
  let retryControl;
  try {
    await page.locator('#open-editor-button').click(); await hold.accepted;
    const queue = app.mediaWorkspaces.localProcessing, collection = queue.get((await state(page)).collectionId);
    const active = collection.intake.current, directory = active.tempDir;
    blocked.add(path.resolve(directory)); await page.locator('#processing-import-cancel').click();
    await expect.poll(() => collection.intake.active).toBe(false);
    await expect(page.locator('#workspace-retry-cleanup')).toBeEnabled();
    expect(collection.members.size).toBe(0);
    await page.route('**/api/processing/cleanup', async route => {
      const response = await route.fetch(); responseAccepted.resolve(); await responseRelease.promise; await route.fulfill({ response });
    });
    retryControl = { failures: 1, started: gate(), release: gate() }; transient.set(path.resolve(directory), retryControl);
    app.mediaWorkspaces.cleanupRetryDelaysMs = [1]; blocked.delete(path.resolve(directory));
    const requests = fixture.requests.length, spawnsBefore = sourceSpawns; await page.locator('#workspace-retry-cleanup').click(); await responseAccepted.promise; await retryControl.started.promise;
    await expect(page.locator('#workspace-removed-cleanup')).toContainText('cleanup pending');
    expect(queue.snapshot(collection.id).sourceBytesReserved).toBe(1000000);
    retryControl.release.resolve();
    await expect(page.locator('#workspace-retry-cleanup')).toBeHidden(); await expect(page.locator('#workspace-removed-cleanup')).toBeHidden();
    const responseDone = page.waitForResponse(response => new URL(response.url()).pathname === '/api/processing/cleanup');
    responseRelease.resolve(); await (await responseDone).finished();
    await expect(page.locator('#workspace-retry-cleanup')).toBeHidden(); await expect(page.locator('#workspace-removed-cleanup')).toBeHidden();
    expect(queue.snapshot(collection.id).sourceBytesReserved).toBe(0); expect(queue.entryCount(collection)).toBe(0);
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fixture.requests.length).toBe(requests); expect(sourceSpawns).toBe(spawnsBefore); expect(fixture.requests.some(request => /(?:item|source)-[12]/.test(request.path))).toBe(false);
    await expect(page.locator('#media-drop-zone')).toBeVisible();
  } finally { retryControl?.release.resolve(); responseRelease.resolve(); hold.release(); }
});
