'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createFfmpegCapabilityDiscovery } = require('../ffmpeg-capabilities');
const {
  MAX_LOCAL_MEDIA_BYTES,
  createMediaWorkspaceManager
} = require('../media-workspace');

const CAPABILITIES = Object.freeze({
  available: true,
  encoders: new Set(['libx264', 'aac']),
  decoders: new Set(['h264', 'aac', 'flac']),
  muxers: new Set(['mp4'])
});

const VIDEO_INSPECTION = Object.freeze({
  mediaKind: 'video',
  durationSeconds: 8,
  sourceSize: 24,
  format: 'MP4',
  container: { kind: 'mp4', evidence: 'brand' },
  formatNames: ['mov', 'mp4'],
  video: {
    streamIndex: 0,
    codec: 'h264',
    profile: 'High',
    width: 640,
    height: 360,
    frameRate: 30,
    pixelFormat: 'yuv420p'
  },
  audio: {
    streamIndex: 1,
    codec: 'aac',
    sampleRate: 48000,
    channels: 2,
    channelLayout: 'stereo',
    bitRate: 192000
  },
  trackCounts: { video: 1, audio: 1, subtitle: 0 }
});

const AUDIO_INSPECTION = Object.freeze({
  mediaKind: 'audio',
  durationSeconds: 4,
  sourceSize: 16,
  format: 'FLAC',
  formatNames: ['flac'],
  video: null,
  audio: {
    streamIndex: 0,
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    channelLayout: 'stereo',
    bitRate: null
  },
  trackCounts: { video: 0, audio: 1, subtitle: 0 }
});

async function sandbox(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-conversion-workspace-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitUntil(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function managerOptions(tempDir, inspection, extra = {}) {
  return {
    tempDir,
    inspectAsset: async () => inspection,
    discoverCapabilities: async () => CAPABILITIES,
    createProxyAsset: async () => {
      throw new Error('Convert inspection must not create a playback proxy.');
    },
    ...extra
  };
}

test('Convert intake accepts video and becomes inspection-ready without playback or render output', async (t) => {
  const tempDir = await sandbox(t);
  let proxyCalls = 0;
  const manager = createMediaWorkspaceManager(managerOptions(tempDir, VIDEO_INSPECTION, {
    createProxyAsset: async () => { proxyCalls += 1; }
  }));
  t.after(() => manager.clearAll());

  const workspace = await manager.receiveLocalStream(Readable.from('synthetic video media'), {
    displayName: 'C:\\private\\clip.mp4',
    claimedType: 'video/mp4',
    purpose: 'convert'
  });
  await waitUntil(() => workspace.status === 'ready', 'video conversion inspection');
  const snapshot = manager.publicWorkspace(workspace);

  assert.equal(snapshot.purpose, 'convert');
  assert.equal(snapshot.source.name, 'clip.mp4');
  assert.equal(snapshot.inspection.mediaKind, 'video');
  assert.equal(snapshot.compatibility.status, 'already-compatible');
  assert.equal(snapshot.playback, null);
  assert.equal(snapshot.render, null);
  assert.equal(snapshot.editedOutput, null);
  assert.equal(proxyCalls, 0);
  assert.deepEqual(snapshot.assets.map((asset) => asset.role), ['source']);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|source\.bin|tempDir|filePath/i);
  assert.throws(
    () => manager.startRender(workspace.id, {
      version: 1,
      keepRanges: [{ startSeconds: 0, endSeconds: 4 }]
    }),
    (error) => error?.statusCode === 409 && /Prepare Edit/i.test(error.message)
  );
});

test('Convert intake accepts audio-only media without loosening editor eligibility', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager(managerOptions(tempDir, AUDIO_INSPECTION));
  t.after(() => manager.clearAll());

  const convertWorkspace = await manager.receiveLocalStream(Readable.from('synthetic audio'), {
    displayName: 'track.flac',
    claimedType: 'audio/flac',
    purpose: 'convert'
  });
  await waitUntil(() => convertWorkspace.status === 'ready', 'audio conversion inspection');
  assert.equal(convertWorkspace.compatibility.status, 'not-applicable');
  assert.equal(convertWorkspace.playbackAssetId, null);

  const editorWorkspace = await manager.receiveLocalStream(Readable.from('synthetic audio'), {
    displayName: 'track.flac',
    claimedType: 'audio/flac',
    purpose: 'edit'
  });
  await waitUntil(() => editorWorkspace.status === 'error', 'editor audio rejection');
  assert.equal(editorWorkspace.failure.category, 'local_media_invalid');
  assert.match(editorWorkspace.failure.help, /audio-only files cannot be opened/i);
});

test('Convert purpose remains bounded and uses the existing 100 GiB intake boundary', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager(managerOptions(tempDir, VIDEO_INSPECTION));
  t.after(() => manager.clearAll());

  await assert.rejects(
    manager.receiveLocalStream(Readable.from('x'), {
      displayName: 'huge.mkv',
      declaredLength: MAX_LOCAL_MEDIA_BYTES + 1,
      purpose: 'convert'
    }),
    (error) => error?.statusCode === 413
      && error?.workspaceFailure?.category === 'local_media_too_large'
  );
  await assert.rejects(
    manager.receiveLocalStream(Readable.from('x'), {
      displayName: 'invalid.bin',
      purpose: 'arbitrary-operation'
    }),
    (error) => error?.statusCode === 400
  );
  assert.equal(manager.workspaces.size, 0);
});

test('Convert workspaces reuse Discard and inactivity expiry cleanup', async (t) => {
  const tempDir = await sandbox(t);
  let now = 1000;
  const manager = createMediaWorkspaceManager(managerOptions(tempDir, VIDEO_INSPECTION, {
    clock: () => now,
    ttlMs: 50
  }));
  t.after(() => manager.clearAll());

  const discarded = await manager.receiveLocalStream(Readable.from('discard me'), {
    displayName: 'discard.mp4', purpose: 'convert'
  });
  await waitUntil(() => discarded.status === 'ready', 'discard-ready inspection');
  const discardedDir = discarded.tempDir;
  assert.equal(await manager.discard(discarded.id), true);
  assert.equal(manager.get(discarded.id, { touch: false }), null);
  await assert.rejects(fsp.stat(discardedDir), { code: 'ENOENT' });

  const expiring = await manager.receiveLocalStream(Readable.from('expire me'), {
    displayName: 'expire.mp4', purpose: 'convert'
  });
  await waitUntil(() => expiring.status === 'ready', 'expiry-ready inspection');
  now += 49;
  assert.deepEqual(await manager.cleanupExpired(), []);
  manager.get(expiring.id);
  now += 51;
  assert.deepEqual(await manager.cleanupExpired(), [expiring.id]);
  assert.equal(manager.get(expiring.id, { touch: false }), null);
});

test('Discard cancels Convert while shared capability discovery is still pending', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager(managerOptions(tempDir, VIDEO_INSPECTION, {
    discoverCapabilities: () => new Promise(() => {})
  }));

  const workspace = await manager.receiveLocalStream(Readable.from('pending capability media'), {
    displayName: 'pending.mp4', purpose: 'convert'
  });
  await waitUntil(() => workspace.inspection != null, 'capability discovery start');
  await Promise.race([
    manager.discard(workspace.id),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Discard blocked.')), 200))
  ]);

  assert.equal(manager.get(workspace.id, { touch: false }), null);
  assert.equal(workspace.abortController.signal.aborted, true);
});

test('Discard of one Convert waiter preserves shared discovery and another waiting workspace', async t => {
  const tempDir = await sandbox(t);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let calls = 0, kills = 0;
  child.kill = () => { kills++; };
  const outputs = {
    '-hide_banner -encoders': ' V..... libx264 H.264 encoder\n A..... aac AAC encoder\n',
    '-hide_banner -decoders': ' V....D h264 H.264 decoder\n A....D aac AAC decoder\n',
    '-hide_banner -muxers': ' E mp4 MP4 muxer\n'
  };
  const discover = createFfmpegCapabilityDiscovery({ spawnProcess(_command, args) {
    calls++;
    if (calls === 1) return child;
    const next = new EventEmitter();
    next.stdout = new PassThrough(); next.stderr = new PassThrough(); next.kill = () => { kills++; };
    queueMicrotask(() => { next.stdout.end(outputs[args.join(' ')]); next.stderr.end(); next.emit('close', 0); });
    return next;
  } });
  const manager = createMediaWorkspaceManager(managerOptions(tempDir, VIDEO_INSPECTION, { discoverCapabilities: discover }));
  t.after(() => manager.clearAll());
  const first = await manager.receiveLocalStream(Readable.from('first'), { displayName: 'first.mp4', purpose: 'convert' });
  const second = await manager.receiveLocalStream(Readable.from('second'), { displayName: 'second.mp4', purpose: 'convert' });
  await waitUntil(() => first.inspection && second.inspection, 'both capability waiters');
  assert.equal(calls, 1);
  await manager.discard(first.id);
  assert.equal(manager.get(first.id), null);
  assert.equal(second.abortController.signal.aborted, false);
  assert.equal(kills, 0);
  child.stdout.end('ffmpeg version 7.1-test\n'); child.stderr.end(); child.emit('close', 0);
  await waitUntil(() => second.status === 'ready', 'remaining waiter ready');
  assert.equal(second.compatibility.status, 'already-compatible');
  assert.equal((await discover()).available, true);
  assert.equal(calls, 4);
  assert.equal(kills, 0);
});

test('a hung shared discovery settles Convert with unknown capabilities and keeps its source', async t => {
  const tempDir = await sandbox(t);
  let calls = 0;
  const discover = createFfmpegCapabilityDiscovery({ timeoutMs: 10, terminationGraceMs: 5, spawnProcess() {
    calls++;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    return child;
  } });
  const inspection = { ...VIDEO_INSPECTION, container: { kind: 'mov', evidence: 'brand' } };
  const manager = createMediaWorkspaceManager(managerOptions(tempDir, inspection, { discoverCapabilities: discover }));
  t.after(() => manager.clearAll());
  for (let i = 0; i < 2; i++) {
    const workspace = await manager.receiveLocalStream(Readable.from('timed-out discovery'), { displayName: 'clip.mov', purpose: 'convert' });
    await waitUntil(() => workspace.status === 'ready', 'finite discovery failure');
    assert.equal(workspace.compatibility.status, 'unknown');
    assert.deepEqual(workspace.compatibility.missing, []);
    assert.equal(workspace.compatibility.actions.container, 'remux');
    assert.ok(workspace.assets.has(workspace.sourceAssetId));
    assert.equal(workspace.playbackAssetId, null);
    await manager.discard(workspace.id);
  }
  assert.equal(calls, 1, 'a later inspector reuses the resolved failure during cooldown');
});

test('Convert preparation failure and Discard retain failed cleanup ownership for retry', async t => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager(managerOptions(tempDir, VIDEO_INSPECTION, {
    inspectAsset: async () => { throw new Error('Synthetic inspection failure'); },
    fsPromises: { ...fsp, rm: async () => { throw Object.assign(new Error('Synthetic denied cleanup'), { code: 'EACCES' }); } }
  }));
  t.after(async () => { manager.fs = fsp; await manager.clearAll(); });
  const workspace = await manager.receiveLocalStream(Readable.from('bad media'), { displayName: 'bad.bin', purpose: 'convert' });
  await workspace.activePromise;
  const directory = manager.cleanupPending.get(workspace.id).directory;
  assert.equal(workspace.status, 'error');
  assert.equal(manager.publicWorkspace(workspace).cleanup.status, 'failed');
  assert.equal(workspace.tempDir, null, 'workspace invalidates its path while cleanup retains ownership');
  await manager.discard(workspace.id);
  assert.equal(manager.get(workspace.id), null);
  assert.equal(manager.cleanupStatus(workspace).status, 'failed');
  assert.ok((await fsp.stat(directory)).isDirectory());
  manager.fs = fsp;
  await manager.retryCleanup(workspace.id);
  assert.equal(manager.cleanupStatus(workspace).status, 'complete');
  await assert.rejects(fsp.stat(directory), { code: 'ENOENT' });
});
