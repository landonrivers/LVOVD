'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { createMediaWorkspaceManager, WORKSPACE_CANCELLED_CODE } = require('../media-workspace');

const inspection = {
  durationSeconds: 2, formatNames: ['mov', 'mp4'],
  video: { streamIndex: 0, codec: 'h264', width: 160, height: 90 }, audio: null
};

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-cleanup-test-'));
  const manager = createMediaWorkspaceManager({
    tempDir: root, inspectAsset: async () => inspection,
    cleanupRetryDelaysMs: [10, 20], ...options
  });
  t.after(async () => {
    manager.fs = fsp;
    await manager.clearAll();
    for (const record of manager.cleanupPending.values()) {
      if (record.timer) clearTimeout(record.timer);
      if (record.promise) await record.promise;
    }
    await fsp.rm(root, { recursive: true, force: true });
  });
  const workspace = await manager.receiveLocalStream(Readable.from('generated test bytes'), { displayName: 'fixture.mp4' });
  await workspace.activePromise;
  return { manager, workspace, root };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'cleanup should settle within its bounded retry window');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const boundary of ['exposure', 'source rename']) {
  test(`Discard during intake ${boundary} cannot inspect or publish the cancelled source`, async t => {
    const { manager } = await fixture(t);
    let release, entered, workspace, discarded, inspections = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const renaming = new Promise(resolve => { entered = resolve; });
    const originalFs = manager.fs;
    manager.inspectAsset = async () => { inspections++; return inspection; };
    manager.fs = { ...originalFs, rename: async (...args) => {
      entered(); await gate; return originalFs.rename(...args);
    } };
    t.after(() => release());
    const receiving = manager.receiveLocalStream(Readable.from('small complete input'), {
      displayName: 'cancelled.mp4', purpose: 'local', onWorkspace: current => {
        workspace = current;
        assert.ok(current.activePromise); assert.equal(current.activePromise, current.receivingPromise);
        if (boundary === 'exposure') discarded = manager.discard(current.id);
      }
    });
    const rejected = assert.rejects(receiving, { code: WORKSPACE_CANCELLED_CODE });
    if (boundary === 'source rename') {
      await renaming;
      discarded = manager.discard(workspace.id);
      assert.equal(manager.get(workspace.id), null);
      assert.equal(manager.cleanupStatus(workspace).status, 'pending');
    }
    release(); await rejected; await discarded;
    assert.equal(manager.get(workspace.id), null); assert.equal(inspections, 0);
    assert.equal(workspace.sourceAssetId, null); assert.equal(workspace.assets.size, 0);
    assert.equal(manager.cleanupStatus(workspace).status, 'complete');
  });
}

test('Discard invalidates immediately, retains pending ownership, and retries a transient deletion once it clears', async t => {
  const { manager, workspace } = await fixture(t);
  const directory = workspace.tempDir;
  const assetId = workspace.playbackAssetId;
  let attempts = 0;
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  manager.fs = { ...fsp, rm: async (...args) => {
    attempts++;
    if (attempts === 1) {
      await firstBlocked;
      throw Object.assign(new Error('Synthetic locked file'), { code: 'EBUSY' });
    }
    return fsp.rm(...args);
  } };
  const first = manager.discard(workspace.id);
  const duplicate = manager.discard(workspace.id);
  assert.equal(first, duplicate);
  assert.equal(manager.get(workspace.id), null);
  assert.equal(manager.resolvePlaybackAsset(workspace.id, assetId), null);
  await waitFor(() => attempts === 1);
  const record = manager.cleanupPending.get(workspace.id);
  assert.equal(record.directory, directory);
  assert.ok(record.assets.has(assetId));
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(manager.cleanupStatus(workspace).status, 'pending');
  assert.doesNotMatch(JSON.stringify(manager.cleanupStatus(workspace)), /lvovd-cleanup-test|Synthetic|EBUSY/);
  await waitFor(() => manager.cleanupStatus(workspace).status === 'complete');
  assert.equal(attempts, 2);
  assert.equal(manager.cleanupPending.size, 0);
  await assert.rejects(fsp.stat(directory), { code: 'ENOENT' });
  assert.equal(await manager.discard(workspace.id), false);
});

for (const code of ['EACCES', 'EPERM', 'EBUSY']) {
  test(`${code} cleanup failure has a bounded budget, retains ownership, and permits explicit retry`, async t => {
    const { manager, workspace } = await fixture(t);
    const directory = workspace.tempDir;
    let attempts = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    manager.fs = { ...fsp, rm: async () => {
      concurrent++; maxConcurrent = Math.max(concurrent, maxConcurrent); attempts++;
      await new Promise(resolve => setImmediate(resolve));
      concurrent--;
      throw Object.assign(new Error('Synthetic denial'), { code });
    } };
    await manager.discard(workspace.id);
    await waitFor(() => manager.cleanupStatus(workspace).status === 'failed');
    assert.equal(attempts, code === 'EACCES' ? 1 : 3);
    assert.equal(maxConcurrent, 1);
    const record = manager.cleanupPending.get(workspace.id);
    assert.equal(record.directory, directory);
    assert.ok(record.assets.size > 0);
    assert.equal(record.timer, null);
    assert.ok((await fsp.stat(directory)).isDirectory());
    await manager.removeWorkspaceFiles(workspace);
    assert.equal(attempts, code === 'EACCES' ? 1 : 3, 'idempotent cleanup does not replenish retries');
    const next = await manager.receiveLocalStream(Readable.from('new source'), { displayName: 'new.mp4' });
    await next.activePromise;
    assert.equal(next.status, 'ready');
    assert.equal(manager.get(workspace.id), null);
    manager.fs = fsp;
    await Promise.all([manager.retryCleanup(workspace.id), manager.retryCleanup(workspace.id)]);
    assert.equal(manager.cleanupStatus(workspace).status, 'complete');
    assert.equal(manager.cleanupPending.has(workspace.id), false);
    await assert.rejects(fsp.stat(directory), { code: 'ENOENT' });
  });
}

test('owned playback/output file handles close before deletion, including on Windows', async t => {
  const { manager, workspace } = await fixture(t);
  const asset = workspace.assets.get(workspace.sourceAssetId);
  const stream = fs.createReadStream(asset.filePath);
  let responseReleased = false;
  manager.ownReadStream(workspace, stream, { destroyed: false, destroy() { responseReleased = true; } });
  await once(stream, 'open');
  manager.fs = { ...fsp, rm: async (...args) => {
    assert.equal(stream.closed, true);
    assert.equal(workspace.readStreams.size, 0);
    assert.equal(responseReleased, true);
    return fsp.rm(...args);
  } };
  await manager.discard(workspace.id);
  assert.equal(manager.cleanupStatus(workspace).status, 'complete');
});

test('failed preparation and cancellation retain failed cleanup ownership instead of reporting removed bytes', async t => {
  for (const cancelled of [false, true]) {
    const { manager, root } = await fixture(t);
    await manager.clearAll();
    manager.inspectAsset = async () => {
      throw Object.assign(new Error('Synthetic inspection stop'), cancelled ? { code: WORKSPACE_CANCELLED_CODE } : {});
    };
    manager.fs = { ...fsp, rm: async () => { throw Object.assign(new Error('Synthetic denial'), { code: 'EACCES' }); } };
    const workspace = await manager.receiveLocalStream(Readable.from('bad fixture'), { displayName: 'fixture.bin' });
    await workspace.activePromise;
    assert.equal(workspace.status, cancelled ? 'cancelled' : 'error');
    const snapshot = manager.publicWorkspace(workspace);
    assert.equal(snapshot.cleanup.status, 'failed');
    assert.equal(snapshot.playback, null);
    assert.deepEqual(snapshot.assets, []);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(manager.cleanupPending.get(workspace.id).directory);
    manager.fs = fsp;
    await manager.retryCleanup(workspace.id);
  }
});

test('expiry invalidates an idle workspace even when cleanup fails and retains the retry record', async t => {
  let now = 100;
  const { manager, workspace } = await fixture(t, { clock: () => now, ttlMs: 10 });
  manager.fs = { ...fsp, rm: async () => { throw Object.assign(new Error('Synthetic denial'), { code: 'EACCES' }); } };
  now += 11;
  assert.deepEqual(await manager.cleanupExpired(), [workspace.id]);
  assert.equal(manager.get(workspace.id), null);
  assert.equal(manager.cleanupStatus(workspace).status, 'failed');
  assert.ok(manager.cleanupPending.get(workspace.id).directory);
  manager.fs = fsp;
  await manager.retryCleanup(workspace.id);
});
