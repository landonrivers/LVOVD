'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { PlaylistIntake, pause } = require('../playlist-intake');
const { createSourceRequestCoordinator } = require('../request-safety');
const { createMediaWorkspaceManager } = require('../media-workspace');
const { normalizeMediaInspection } = require('../media-inspection');
const { normalizeWorkspaceAcquisition, normalizePlaylistEntry } = require('../app-server');
const { classifyFailure } = require('../failure-classification');
const choices = { content: 'av', profile: 'maximum', maxHeight: null, sourceFormat: { mode: 'automatic' } };
const facts = () => normalizeMediaInspection({ format: { format_name: 'mov,mp4,m4a', duration: '5', tags: { major_brand: 'isom' } }, streams: [
  { index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 96, height: 64, avg_frame_rate: '10/1', start_time: '0', duration: '5' }
] });
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-intake-unit-'));
  const control = { calls: [], bytes: 100, fail: null, now: 0, inspectFail: false, blockCleanup: false };
  const manager = createMediaWorkspaceManager({ tempDir: root, maxBytes: 1000, localProcessingLimits: { maxSourceBytes: 1000 }, clock: () => control.now,
    ttlMs: 1000, cleanupRetryDelaysMs: [], inspectAsset: async () => { if (control.inspectFail) throw new Error('Synthetic inspection failure'); return facts(); },
    fsPromises: { ...fs, rm: async (...args) => { if (control.blockCleanup) throw Object.assign(new Error('Busy fixture'), { code: 'EACCES' }); return fs.rm(...args); } }, ...options });
  const queue = manager.localProcessing, coordinator = createSourceRequestCoordinator();
  const intake = new PlaylistIntake(queue, { coordinator, normalizeAcquisition: normalizeWorkspaceAcquisition, classifyFailure, wait: async () => {},
    acquire: async (workspace, url, acquisition, display, limits) => {
      assert.equal(queue.get(queue.owners.get(workspace.id)).members.has(workspace.id), true);
      assert.equal(queue.reservations.size > 0, true);
      control.calls.push({ url, acquisition, maximumBytes: limits.maximumBytes, workspaceId: workspace.id });
      manager.update(workspace, { status: 'acquiring', phase: 'acquiring' });
      if (control.onAcquire) await control.onAcquire(workspace);
      if (workspace.cancelRequested) throw new Error('Cancelled');
      const file = path.join(workspace.tempDir, 'original.mp4'); await fs.writeFile(file, Buffer.alloc(control.bytes));
      if (control.fail) throw control.fail;
      await manager.adoptAcquiredFile(workspace.id, file, { maximumBytes: limits.maximumBytes });
    } });
  const collection = queue.get(queue.createCollection().id);
  const preview = intake.remember({ kind: 'playlist', source: { name: 'Synthetic source' }, entries: [0, 1, 2].map(index => ({
    url: `https://fixture.example/item-${index}`, title: `Synthetic item ${index}`, duration: null, filesize: index ? 1 : null, intakeEligible: true
  })) });
  const request = (urls = preview.entries.map(item => item.url)) => ({ collectionId: collection.id, previewId: preview.playlistImportId,
    requestId: crypto.randomUUID(), entryUrls: urls, acquisition: structuredClone(choices) });
  const settle = async () => { await collection.intake?.promise; return queue.snapshot(collection.id); };
  const upload = async (bytes = 50) => { const workspace = await queue.receiveLocalStream(collection.id, Readable.from(Buffer.alloc(bytes)), { displayName: 'existing.mp4', declaredLength: bytes }); await workspace.activePromise; return workspace; };
  t.after(async () => { control.blockCleanup = false; manager.localProcessing.intake?.stop(collection); await manager.clearAll(); await collection.intake?.promise; await fs.rm(root, { recursive: true, force: true }); });
  return { manager, queue, coordinator, collection, intake, control, preview, request, settle, upload };
}

test('noncontiguous deduplicated selection retains Preview order and immutable source choices', async t => {
  const x = await setup(t); const existing = await x.upload();
  const body = x.request([x.preview.entries[2].url, x.preview.entries[0].url, x.preview.entries[2].url]);
  const accepted = x.intake.admit(body); assert.equal(accepted.intake.items.length, 2); assert.equal(x.collection.intakeSlots.size, 2);
  assert.throws(() => { x.collection.intake.items[0].url = 'https://fixture.example/changed'; }, TypeError);
  assert.throws(() => { x.collection.intake.items.reverse(); }, TypeError);
  assert.throws(() => { x.collection.intake.acquisition.sourceFormat.mode = 'manual'; }, TypeError);
  body.entryUrls.length = 0; body.acquisition.profile = 'compatible';
  const result = await x.settle();
  assert.deepEqual(x.control.calls.map(call => call.url), [x.preview.entries[0].url, x.preview.entries[2].url]);
  assert.deepEqual(x.control.calls.map(call => call.maximumBytes), [950, 850]);
  assert.equal(x.control.calls.every(call => call.acquisition.profile === 'maximum'), true);
  assert.deepEqual(result.intake.items.map(item => item.status), ['ready', 'ready']);
  assert.equal(result.workspaces[0].id, existing.id); assert.equal(result.workspaces.length, 3);
  assert.equal(result.workspaces.every(item => item.playback === null && item.assets.length === 1), true);
  assert.equal(result.sourceBytesReserved, 250); assert.deepEqual(result.jobs, []);
});

test('malformed, unresolved, known-ineligible, manual and oversized selections reject atomically', async t => {
  const x = await setup(t, { localProcessingLimits: { maxEntries: 2, maxSourceBytes: 1000 } });
  for (const patch of [{ entryUrls: ['https://fixture.example/foreign'] }, { entryUrls: [] }, { extra: '-f raw' }, { collectionId: crypto.randomUUID() },
    { acquisition: { ...choices, content: 'audio' } }, { acquisition: { ...choices, sourceFormat: { mode: 'manual', type: 'combined', formatId: '18' } } }]) {
    assert.throws(() => x.intake.admit({ ...x.request(), ...patch }));
  }
  assert.throws(() => x.intake.admit(x.request()), { statusCode: 409 });
  const restricted = x.intake.remember({ kind: 'playlist', entries: [{ url: 'https://fixture.example/live', intakeEligible: false }] });
  assert.throws(() => x.intake.admit({ ...x.request(['https://fixture.example/live']), previewId: restricted.playlistImportId }));
  assert.equal(x.control.calls.length, 0); assert.equal(x.manager.workspaces.size, 0); assert.equal(x.queue.reservations.size, 0); assert.equal(x.collection.intakeSlots.size, 0);
});

test('pending slots exclude concurrent uploads; duplicate admission reuses one bounded import', async t => {
  const x = await setup(t, { localProcessingLimits: { maxEntries: 3, maxSourceBytes: 1000 } });
  const hold = gate(); const blocker = x.coordinator.preview('busy', () => hold.promise);
  const body = x.request(); x.intake.admit(body);
  assert.equal(x.intake.admit(body).intake.id, body.requestId);
  assert.throws(() => x.intake.admit({ ...body, acquisition: { ...choices, maxHeight: 720 } }), { statusCode: 409 });
  assert.throws(() => x.intake.admit(x.request()), { statusCode: 409 });
  const other = x.queue.createCollection();
  assert.throws(() => x.intake.admit({ ...body, collectionId: other.id }), { statusCode: 409 });
  await assert.rejects(x.upload(), { statusCode: 409 });
  assert.equal(x.manager.workspaces.size, 0); assert.equal(x.queue.reservations.size, 0);
  x.intake.cancel({ collectionId: x.collection.id, requestId: body.requestId });
  hold.resolve(); await blocker; await x.settle();
  assert.equal(x.control.calls.length, 0); assert.equal(x.collection.intakeSlots.size, 0);
});

test('Preview, normal Download and imports share serial source access without nested coordinator work', async t => {
  const x = await setup(t); const order = [], hold = gate();
  const preview = x.coordinator.preview('preview', async () => { order.push('preview'); await hold.promise; });
  const download = x.coordinator.download(async () => { order.push('download'); });
  x.control.onAcquire = async () => { order.push('import'); };
  x.intake.admit(x.request([x.preview.entries[0].url]));
  const next = x.coordinator.acquire(async () => { order.push('other URL'); });
  assert.deepEqual(x.control.calls, []); hold.resolve(); await Promise.all([preview, download, x.settle(), next]);
  assert.deepEqual(order, ['preview', 'download', 'import', 'other URL']);
});

for (const phase of ['active acquisition', 'courtesy wait', 'workspace creation', 'expiry']) {
  test(`cancellation during ${phase} prevents later requests and preserves unrelated sources`, async t => {
    const x = await setup(t); const existing = await x.upload(); const arrived = gate(), release = gate();
    if (phase === 'courtesy wait') x.intake.wait = async signal => { arrived.resolve(); await release.promise; if (signal.aborted) throw new Error('Cancelled pause'); };
    else if (phase === 'workspace creation') {
      const create = x.manager.createUrlWorkspace.bind(x.manager);
      x.manager.createUrlWorkspace = async options => { arrived.resolve(); await release.promise; return create(options); };
    } else x.control.onAcquire = async () => { arrived.resolve(); await release.promise; };
    const body = x.request(); x.intake.admit(body); await arrived.promise;
    if (phase === 'expiry') { x.control.now = 1001; x.queue.sweep(x.control.now); }
    else x.intake.cancel({ collectionId: x.collection.id, requestId: body.requestId });
    release.resolve(); const result = await x.settle();
    assert.equal(result.intake.status, 'cancelled');
    assert.equal(x.control.calls.length, phase === 'workspace creation' ? 0 : 1);
    assert.ok(x.manager.get(existing.id)); assert.equal(x.collection.intakeSlots.size, 0);
    assert.equal(result.workspaces.length, phase === 'courtesy wait' ? 2 : 1);
  });
}

test('removing a pending descriptor invalidates the import before any remote work', async t => {
  const x = await setup(t), hold = gate(); const blocker = x.coordinator.download(() => hold.promise);
  x.intake.admit(x.request()); const item = x.collection.intake.items[1];
  assert.equal(x.intake.removed(item.id), true); hold.resolve(); await blocker;
  const result = await x.settle(); assert.equal(x.control.calls.length, 0);
  assert.equal(result.intake.items[1].removed, true); assert.equal(result.intake.status, 'cancelled');
});

for (const failure of ['acquisition', 'inspection', 'over allowance']) {
  test(`${failure} failure stops the remaining intake without erasing previous sources`, async t => {
    const x = await setup(t); const existing = await x.upload();
    if (failure === 'acquisition') x.control.fail = new Error('HTTP Error 429: Too Many Requests');
    if (failure === 'inspection') x.control.inspectFail = true;
    if (failure === 'over allowance') x.control.bytes = 951;
    x.intake.admit(x.request()); const result = await x.settle();
    assert.deepEqual(result.intake.items.map(item => item.status), ['failed', 'cancelled', 'cancelled']);
    assert.equal(x.control.calls.length, 1); assert.ok(x.manager.get(existing.id));
    assert.equal(result.intake.items[1].message, 'Not started'); assert.equal(result.sourceBytesReserved, 50);
  });
}

test('fixed allowance cannot be spent by concurrent uploads and cleanup failure retains capacity', async t => {
  const x = await setup(t); await x.upload(200);
  const arrived = gate(), release = gate(); x.control.onAcquire = async () => { arrived.resolve(); await release.promise; };
  x.control.fail = new Error('Synthetic source failure'); x.control.blockCleanup = true;
  x.intake.admit(x.request()); await arrived.promise;
  await assert.rejects(x.upload(1), { statusCode: 413 });
  const other = x.queue.createCollection();
  await assert.rejects(x.queue.receiveLocalStream(other.id, Readable.from('a'), { declaredLength: 1, displayName: 'other.mp4' }), { statusCode: 413 });
  release.resolve(); let result = await x.settle(); assert.equal(result.sourceBytesReserved, 1000);
  const failed = result.intake.items[0].workspaceId;
  assert.equal(x.manager.cleanupStatus(failed).status, 'failed');
  x.control.blockCleanup = false; await x.manager.discard(failed); await x.manager.retryCleanup(failed); x.queue.reap();
  result = x.queue.snapshot(x.collection.id); assert.equal(result.sourceBytesReserved, 200);
});

test('actual selected page URL normalization retains narrow fallback and conservative eligibility', () => {
  assert.equal(normalizePlaylistEntry({ id: 'abc', ie_key: 'Youtube' }, 0).url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(normalizePlaylistEntry({ url: 'https://cdn.example/bytes', format_id: '18', formats: [] }, 0).url, null);
  assert.equal(normalizePlaylistEntry({ id: 'unknown', title: 'No URL', duration: null }, 0).duration, null);
  assert.equal(normalizePlaylistEntry({ id: 'unknown', title: 'No URL' }, 0).intakeEligible, false);
  assert.equal(normalizePlaylistEntry({ webpage_url: 'https://fixture.example/audio', vcodec: 'none' }, 0).intakeEligible, false);
  assert.equal(normalizePlaylistEntry({ webpage_url: 'https://fixture.example/nested', _type: 'playlist' }, 0).intakeEligible, false);
  assert.equal(normalizePlaylistEntry({ webpage_url: 'https://fixture.example/live', is_live: true }, 0).intakeEligible, false);
  assert.equal(normalizePlaylistEntry({ webpage_url: 'https://fixture.example/protected', has_drm: true }, 0).intakeEligible, false);
  assert.equal(normalizePlaylistEntry({ _type: 'url', url: 'https://fixture.example/item' }, 0).intakeEligible, true);
});

test('real courtesy wait aborts promptly without waiting out the randomized delay', async () => {
  const controller = new AbortController(); const waiting = pause(controller.signal, 10000); controller.abort();
  await assert.rejects(waiting, { code: 'LVOVD_WORKSPACE_CANCELLED' });
});

test('cancellation during adoption stat cannot publish a removed source asset', async t => {
  const x = await setup(t); const existing = await x.upload(); const arrived = gate(), release = gate();
  const stat = x.manager.fs.stat; let active;
  x.manager.fs.stat = async file => { const result = await stat(file); if (String(file).endsWith('original.mp4')) { arrived.resolve(); await release.promise; } return result; };
  x.control.onAcquire = async workspace => { active = workspace; };
  const body = x.request(); x.intake.admit(body); await arrived.promise;
  x.intake.cancel({ collectionId: x.collection.id, requestId: body.requestId }); release.resolve(); await x.settle();
  assert.equal(active.sourceAssetId, null); assert.equal(active.assets.size, 0);
  assert.equal(x.control.calls.length, 1); assert.ok(x.manager.get(existing.id));
});

test('transient cleanup keeps the allowance until confirmed removal, then releases its bytes', async t => {
  const x = await setup(t, { cleanupRetryDelaysMs: [1] });
  const failed = gate(), allowCleanup = gate(); let attempts = 0; const rm = x.manager.fs.rm;
  x.manager.fs.rm = async (...args) => {
    if (++attempts === 1) { failed.resolve(); throw Object.assign(new Error('Transient owned cleanup'), { code: 'EBUSY' }); }
    await allowCleanup.promise; return rm(...args);
  };
  x.control.fail = new Error('Synthetic acquisition failure'); x.intake.admit(x.request());
  await failed.promise; await x.settle(); assert.equal(x.queue.snapshot(x.collection.id).sourceBytesReserved, 1000);
  allowCleanup.resolve();
  const workspace = x.manager.get(x.collection.intake.items[0].workspaceId), record = workspace.cleanupRecord;
  if (record.timer) { clearTimeout(record.timer); record.timer = null; await x.manager.attemptCleanup(record); }
  else if (record.promise) await record.promise;
  assert.equal(record.status, 'complete'); assert.equal(x.queue.snapshot(x.collection.id).sourceBytesReserved, 0);
  assert.equal(x.control.calls.length, 1);
});

test('workspace creation holds its source allowance through concurrent reaping and cancellation', async t => {
  const x = await setup(t), arrived = gate(), release = gate();
  const create = x.manager.createUrlWorkspace.bind(x.manager);
  x.manager.createUrlWorkspace = async options => { arrived.resolve(); await release.promise; return create(options); };
  const body = x.request(); x.intake.admit(body); await arrived.promise;
  const other = x.queue.get(x.queue.createCollection().id);
  x.queue.reap(); assert.equal(x.queue.snapshot(other.id).sourceBytesReserved, 1000);
  assert.throws(() => x.queue.reserve(other, 1), { statusCode: 413 });
  x.intake.cancel({ collectionId: x.collection.id, requestId: body.requestId });
  assert.throws(() => x.queue.reserve(other, 1), { statusCode: 413 });
  release.resolve(); await x.settle();
  assert.equal(x.control.calls.length, 0); assert.equal(x.queue.snapshot(other.id).sourceBytesReserved, 0);
});

test('two collections serialize their actual imports and reserve only remaining capacity', async t => {
  const x = await setup(t), arrived = gate(), release = gate();
  x.control.onAcquire = async () => { if (x.control.calls.length === 1) { arrived.resolve(); await release.promise; } };
  x.intake.admit(x.request([x.preview.entries[0].url])); await arrived.promise;
  const other = x.queue.get(x.queue.createCollection().id);
  x.intake.admit({ ...x.request([x.preview.entries[2].url]), collectionId: other.id });
  assert.equal(x.control.calls.length, 1); assert.equal(other.members.size, 0); assert.equal(other.intakeSlots.size, 1);
  release.resolve(); await Promise.all([x.settle(), other.intake.promise]);
  assert.deepEqual(x.control.calls.map(call => call.maximumBytes), [1000, 900]);
  assert.deepEqual(x.control.calls.map(call => call.url), [x.preview.entries[0].url, x.preview.entries[2].url]);
  assert.equal(other.intake.status, 'ready'); assert.equal(x.collection.intake.status, 'ready');
});

test('a full retained source budget stops all selected intake before any source request', async t => {
  const x = await setup(t); const existing = await x.upload(1000);
  x.intake.admit(x.request()); const result = await x.settle();
  assert.equal(x.control.calls.length, 0); assert.equal(result.intake.status, 'failed');
  assert.equal(result.intake.items[0].failure.category, 'local_source_budget');
  assert.deepEqual(result.intake.items.map(item => item.status), ['failed', 'cancelled', 'cancelled']);
  assert.ok(x.manager.get(existing.id)); assert.equal(result.sourceBytesReserved, 1000);
});

test('Preview admission evidence expires and stays bounded without discarding a waiting import', async t => {
  const x = await setup(t), hold = gate(); const blocker = x.coordinator.preview('busy', () => hold.promise);
  x.intake.admit(x.request()); x.control.now = 2000;
  x.queue.createCollection(); assert.equal(x.queue.collections.has(x.collection.id), true);
  for (let i = 0; i < 4; i++) x.intake.remember({ kind: 'playlist', entries: [] });
  assert.equal(x.intake.previews.size, 4);
  assert.throws(() => x.intake.admit(x.request()), { statusCode: 409 });
  x.intake.stop(x.collection); hold.resolve(); await blocker; await x.settle();
  const fresh = x.intake.remember({ kind: 'playlist', entries: x.preview.entries });
  x.control.now += 600001;
  assert.throws(() => x.intake.admit({ ...x.request(), previewId: fresh.playlistImportId }), { statusCode: 409 });
  assert.equal(x.control.calls.length, 0);
});
