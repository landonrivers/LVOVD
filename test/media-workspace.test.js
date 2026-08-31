'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const {
  MAX_LOCAL_MEDIA_BYTES,
  WORKSPACE_CANCELLED_CODE,
  normalizeDisplayFilename,
  parseFrameRate,
  normalizeInspection,
  isDirectPlaybackCompatible,
  playbackProxyArgs,
  parseByteRange,
  createMediaWorkspaceManager
} = require('../media-workspace');

const DIRECT_INSPECTION = {
  durationSeconds: 12.5,
  format: 'QuickTime / MOV',
  formatNames: ['mov', 'mp4'],
  video: { codec: 'h264', width: 1280, height: 720, frameRate: 30 },
  audio: { codec: 'aac' }
};

const PROXY_INSPECTION = {
  ...DIRECT_INSPECTION,
  format: 'Matroska / WebM',
  formatNames: ['matroska', 'webm'],
  video: { ...DIRECT_INSPECTION.video, codec: 'vp9' },
  audio: { codec: 'opus' }
};

async function sandbox(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-media-workspace-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitUntil(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('local filename handling keeps bounded display metadata out of filesystem authority', () => {
  assert.equal(normalizeDisplayFilename('C:\\Users\\person\\Videos\\clip.mp4'), 'clip.mp4');
  assert.equal(normalizeDisplayFilename('../../private/movie.mkv'), 'movie.mkv');
  assert.equal(normalizeDisplayFilename('\u0000\u0007'), 'Local video');
  assert.equal(normalizeDisplayFilename(`x${'a'.repeat(400)}.mp4`).length, 255);
});

test('ffprobe inspection normalization keeps only finite video facts', () => {
  const normalized = normalizeInspection({
    format: {
      duration: '83.5014',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      format_long_name: 'QuickTime / MOV'
    },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
      { codec_type: 'audio', codec_name: 'aac' }
    ]
  });

  assert.equal(normalized.durationSeconds, 83.501);
  assert.deepEqual(normalized.formatNames.slice(0, 2), ['mov', 'mp4']);
  assert.deepEqual(normalized.video, { codec: 'h264', width: 1920, height: 1080, frameRate: 29.97 });
  assert.deepEqual(normalized.audio, { codec: 'aac' });
  assert.equal(parseFrameRate('0/0'), null);
  assert.equal(isDirectPlaybackCompatible(normalized), true);
});

test('inspection ignores attached cover art and timed-thumbnail-only video streams', () => {
  for (const disposition of [{ attached_pic: 1 }, { timed_thumbnails: 1 }]) {
    assert.throws(
      () => normalizeInspection({
        format: { duration: '180', format_name: 'mp3' },
        streams: [
          { codec_type: 'audio', codec_name: 'mp3' },
          { codec_type: 'video', codec_name: 'mjpeg', width: 1200, height: 1200, disposition }
        ]
      }),
      (error) => error?.workspaceFailure?.category === 'local_media_invalid'
        && /video stream/i.test(error.workspaceFailure.explanation)
    );
  }
});

test('inspection selects real video instead of attached artwork and preserves normal video', () => {
  const withArtwork = normalizeInspection({
    format: { duration: '42', format_name: 'mov,mp4' },
    streams: [
      {
        codec_type: 'video', codec_name: 'mjpeg', width: 1200, height: 1200,
        disposition: { attached_pic: 1 }
      },
      { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '24/1' },
      { codec_type: 'audio', codec_name: 'aac' }
    ]
  });
  const normal = normalizeInspection({
    format: { duration: '5', format_name: 'matroska' },
    streams: [{ codec_type: 'video', codec_name: 'ffv1', width: 640, height: 360 }]
  });

  assert.deepEqual(withArtwork.video, { codec: 'h264', width: 1280, height: 720, frameRate: 24 });
  assert.deepEqual(normal.video, { codec: 'ffv1', width: 640, height: 360, frameRate: null });
});

test('inspection falls back to the selected real video duration when format duration is unusable', () => {
  const normalized = normalizeInspection({
    format: { duration: 'N/A', format_name: 'matroska' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 640, height: 360, duration: '4.25' }
    ]
  });

  assert.equal(normalized.durationSeconds, 4.25);
});

test('inspection rejects non-video media and missing duration clearly', () => {
  assert.throws(
    () => normalizeInspection({ format: { duration: '10' }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] }),
    (error) => error?.workspaceFailure?.category === 'local_media_invalid'
      && /video stream/i.test(error.workspaceFailure.explanation)
  );
  assert.throws(
    () => normalizeInspection({ format: {}, streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }] }),
    (error) => error?.workspaceFailure?.category === 'local_media_invalid'
      && /duration/i.test(error.workspaceFailure.title)
  );
});

test('a missing ffprobe executable becomes a path-safe required-local-tool failure', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager({
    tempDir,
    spawnProcess(command, args) {
      assert.equal(command, 'ffprobe');
      assert.ok(args.includes('-show_streams'));
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        const error = new Error('spawn C:\\private\\ffprobe.exe ENOENT');
        error.code = 'ENOENT';
        child.emit('error', error);
      });
      return child;
    }
  });
  t.after(() => manager.clearAll());

  const workspace = await manager.receiveLocalStream(Readable.from('synthetic video bytes'), {
    displayName: 'C:\\private\\missing-tool.mp4'
  });
  await waitUntil(() => workspace.status === 'error', 'missing ffprobe failure');
  assert.equal(workspace.failure.category, 'local_runtime_unavailable');
  assert.equal(workspace.failure.title, 'A required local tool is unavailable');
  assert.doesNotMatch(JSON.stringify(workspace.failure), /C:\\private|ffprobe\.exe/i);
  assert.equal(workspace.tempDir, null);
  assert.equal(workspace.assets.size, 0);
});

test('streamed FFmpeg progress can exceed the captured-output limit without accumulation or termination', async (t) => {
  const tempDir = await sandbox(t);
  let killCount = 0;
  const chunk = Buffer.alloc(64 * 1024, 0x70);
  const chunkCount = 65;
  const manager = createMediaWorkspaceManager({
    tempDir,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { killCount += 1; };
      queueMicrotask(() => {
        for (let index = 0; index < chunkCount; index += 1) child.stdout.write(chunk);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    }
  });
  t.after(() => manager.clearAll());
  const workspace = await manager.createWorkspace({ displayName: 'progress.mkv' });
  let streamedBytes = 0;

  const result = await manager.runOwnedProcess(workspace, 'ffmpeg', [], {
    operation: 'ffmpeg_processing',
    tool: 'ffmpeg',
    captureStdout: false,
    onStdout(chunkValue) { streamedBytes += chunkValue.length; }
  });

  assert.ok(streamedBytes > 4 * 1024 * 1024);
  assert.equal(result.stdout, '');
  assert.equal(killCount, 0);
});

test('commands that return captured stdout retain their bounded-output safety limit', async (t) => {
  const tempDir = await sandbox(t);
  let killCount = 0;
  const manager = createMediaWorkspaceManager({
    tempDir,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { killCount += 1; };
      queueMicrotask(() => child.stdout.write(Buffer.alloc(33)));
      return child;
    }
  });
  t.after(() => manager.clearAll());
  const workspace = await manager.createWorkspace({ displayName: 'inspection.mp4' });

  await assert.rejects(
    manager.runOwnedProcess(workspace, 'ffprobe', [], {
      operation: 'local_processing',
      tool: 'ffprobe',
      maxStdoutBytes: 32
    }),
    /too much output/i
  );
  assert.equal(killCount, 1);
});

test('direct playback policy requires MP4-family H.264 with AAC or no audio', () => {
  assert.equal(isDirectPlaybackCompatible(DIRECT_INSPECTION), true);
  assert.equal(isDirectPlaybackCompatible({ ...DIRECT_INSPECTION, audio: null }), true);
  assert.equal(isDirectPlaybackCompatible({ ...DIRECT_INSPECTION, video: { ...DIRECT_INSPECTION.video, codec: 'hevc' } }), false);
  assert.equal(isDirectPlaybackCompatible({ ...DIRECT_INSPECTION, audio: { codec: 'opus' } }), false);
  assert.equal(isDirectPlaybackCompatible(PROXY_INSPECTION), false);
});

test('playback proxy arguments are bounded H.264/AAC preview settings without upscaling intent', () => {
  const args = playbackProxyArgs('/private/source.mkv', '/private/proxy.mp4', true);
  assert.deepEqual(args.slice(0, 6), ['-y', '-hide_banner', '-loglevel', 'error', '-i', '/private/source.mkv']);
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('veryfast'));
  assert.ok(args.includes('28'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('128k'));
  assert.ok(args.includes('+faststart'));
  assert.match(args[args.indexOf('-vf') + 1], /min\(1280,iw\).*min\(720,ih\)/);
});

test('byte Range parsing supports closed, open-ended, and suffix requests', () => {
  assert.equal(parseByteRange(undefined, 100), null);
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19, length: 10 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99, length: 10 });
  assert.deepEqual(parseByteRange('bytes=-12', 100), { start: 88, end: 99, length: 12 });
  assert.deepEqual(parseByteRange('bytes=-500', 100), { start: 0, end: 99, length: 100 });
  assert.deepEqual(parseByteRange('bytes=95-500', 100), { start: 95, end: 99, length: 5 });
});

test('malformed, multiple, reversed, and unsatisfiable ranges use the 416 boundary', () => {
  for (const value of ['items=0-1', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=20-10', 'bytes=100-']) {
    assert.throws(() => parseByteRange(value, 100), (error) => error?.code === 'LVOVD_RANGE_NOT_SATISFIABLE');
  }
});

test('streamed intake creates one authoritative source asset and direct-playback workspace', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager({
    tempDir,
    inspectAsset: async () => DIRECT_INSPECTION
  });
  t.after(() => manager.clearAll());

  const workspace = await manager.receiveLocalStream(Readable.from(Buffer.from('synthetic local media')), {
    displayName: 'C:\\private\\example.mp4',
    claimedType: 'video/not-authoritative',
    declaredLength: 21
  });
  await waitUntil(() => workspace.status === 'ready', 'direct-playback workspace');

  assert.equal(workspace.source.displayName, 'example.mp4');
  assert.equal(workspace.assets.size, 1);
  assert.equal(workspace.sourceAssetId, workspace.playbackAssetId);
  assert.equal(workspace.playbackProxy, false);
  const publicValue = manager.publicWorkspace(workspace);
  assert.equal(publicValue.playback.role, 'source');
  assert.equal(publicValue.playback.mime, 'video/mp4');
  assert.equal(publicValue.inspection.durationSeconds, 12.5);
  assert.doesNotMatch(JSON.stringify(publicValue), /filePath|tempDir|claimedType|C:\\private/i);
});

test('proxy-required intake preserves source ownership and adds a separate playback asset', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager({
    tempDir,
    inspectAsset: async () => PROXY_INSPECTION,
    createProxyAsset: async (workspace) => {
      const filePath = path.join(workspace.tempDir, 'synthetic-proxy.mp4');
      await fsp.writeFile(filePath, 'proxy bytes');
      return { filePath, size: 11 };
    }
  });
  t.after(() => manager.clearAll());

  const workspace = await manager.receiveLocalStream(Readable.from(Buffer.from('source bytes')), {
    displayName: 'source.webm'
  });
  await waitUntil(() => workspace.status === 'ready', 'proxy workspace');

  assert.equal(workspace.assets.size, 2);
  assert.notEqual(workspace.sourceAssetId, workspace.playbackAssetId);
  assert.equal(workspace.assets.get(workspace.sourceAssetId).role, 'source');
  assert.equal(workspace.assets.get(workspace.playbackAssetId).role, 'playback-proxy');
  assert.equal(workspace.playbackProxy, true);
});

test('asset registration rejects files outside the owning workspace and cross-workspace lookup', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager({ tempDir, inspectAsset: async () => DIRECT_INSPECTION });
  t.after(() => manager.clearAll());
  const first = await manager.receiveLocalStream(Readable.from('first'), { displayName: 'first.mp4' });
  const second = await manager.receiveLocalStream(Readable.from('second'), { displayName: 'second.mp4' });
  await waitUntil(() => first.status === 'ready' && second.status === 'ready', 'two workspaces');

  assert.throws(() => manager.registerAsset(first, {
    role: 'playback-proxy',
    filePath: path.join(tempDir, 'outside.mp4'),
    size: 1,
    mime: 'video/mp4',
    playable: true
  }), /authoritative workspace/i);
  assert.equal(manager.resolvePlaybackAsset(first.id, second.playbackAssetId), null);
});

test('declared and actual streamed input limits clean partial workspaces', async (t) => {
  assert.equal(MAX_LOCAL_MEDIA_BYTES, 100 * 1024 * 1024 * 1024);
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager({ tempDir, maxBytes: 4, inspectAsset: async () => DIRECT_INSPECTION });
  await assert.rejects(
    manager.receiveLocalStream(Readable.from('x'), { displayName: 'huge.mp4', declaredLength: 5 }),
    (error) => error?.statusCode === 413
  );
  await assert.rejects(
    manager.receiveLocalStream(Readable.from('12345'), { displayName: 'lied.mp4' }),
    (error) => error?.statusCode === 413
  );
  assert.equal(manager.workspaces.size, 0);
});

test('aborted streamed intake removes its partial workspace', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager({ tempDir, inspectAsset: async () => DIRECT_INSPECTION });
  const input = new PassThrough();
  const receiving = manager.receiveLocalStream(input, { displayName: 'partial.mp4' });
  input.write('partial bytes');
  await waitUntil(() => manager.workspaces.size === 1, 'receiving workspace');
  input.destroy(new Error('synthetic client abort'));
  await assert.rejects(receiving);
  assert.equal(manager.workspaces.size, 0);
});

test('proxy cancellation aborts active work, removes assets, and discards the registry entry', async (t) => {
  const tempDir = await sandbox(t);
  const manager = createMediaWorkspaceManager({
    tempDir,
    inspectAsset: async () => PROXY_INSPECTION,
    createProxyAsset: async (workspace) => new Promise((_resolve, reject) => {
      workspace.abortController.signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.code = WORKSPACE_CANCELLED_CODE;
        reject(error);
      }, { once: true });
    })
  });

  const workspace = await manager.receiveLocalStream(Readable.from('source bytes'), { displayName: 'proxy.mkv' });
  const ownedDir = workspace.tempDir;
  await waitUntil(() => workspace.status === 'proxying', 'active proxy');
  assert.equal(await manager.discard(workspace.id), true);
  assert.equal(manager.workspaces.has(workspace.id), false);
  await assert.rejects(fsp.access(ownedDir));
});

test('explicit discard and inactivity expiry honor lease touches for terminal workspaces', async (t) => {
  const tempDir = await sandbox(t);
  let now = 1_000;
  const manager = createMediaWorkspaceManager({
    tempDir,
    ttlMs: 100,
    clock: () => now,
    inspectAsset: async () => DIRECT_INSPECTION
  });
  const ready = await manager.receiveLocalStream(Readable.from('ready'), { displayName: 'ready.mp4' });
  await waitUntil(() => ready.status === 'ready', 'ready workspace');
  const active = await manager.createWorkspace({ displayName: 'active.mp4' });
  active.status = 'inspecting';
  active.phase = 'inspecting';
  active.activeOperation = 'inspecting';

  now += 75;
  manager.touch(ready);
  now += 75;
  assert.deepEqual(await manager.cleanupExpired(now), []);
  assert.equal(manager.workspaces.has(ready.id), true);

  now += 26;
  const expired = await manager.cleanupExpired(now);
  assert.deepEqual(expired, [ready.id]);
  assert.equal(manager.workspaces.has(ready.id), false);
  assert.equal(manager.workspaces.has(active.id), true);

  assert.equal(await manager.discard(active.id), true);
  assert.equal(manager.workspaces.size, 0);
});
