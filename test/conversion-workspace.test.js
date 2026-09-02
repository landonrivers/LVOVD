'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
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
    (error) => error?.statusCode === 409 && /inspection, not editing/i.test(error.message)
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
