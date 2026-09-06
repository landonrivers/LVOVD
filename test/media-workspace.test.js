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
  MAX_KEEP_RANGES,
  WORKSPACE_CANCELLED_CODE,
  normalizeDisplayFilename,
  normalizeEditPlan,
  editedOutputFilename,
  parseFrameRate,
  normalizeInspection,
  isDirectPlaybackCompatible,
  playbackProxyArgs,
  editedOutputArgs,
  totalRetainedDuration,
  renderProgressPercent,
  validateEditedOutputInspection,
  parseByteRange,
  createMediaWorkspaceManager
} = require('../media-workspace');
const { localMediaInputArgs } = require('../local-media-input');

const DIRECT_INSPECTION = {
  durationSeconds: 12.5,
  format: 'QuickTime / MOV',
  formatNames: ['mov', 'mp4'],
  video: { streamIndex: 0, codec: 'h264', width: 1280, height: 720, frameRate: 30 },
  audio: { streamIndex: 1, codec: 'aac' },
  trackCounts: { audio: 1, subtitle: 0 }
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

test('URL acquisition workspaces adopt one contained source through the shared preparation path', async (t) => {
  const dir = await sandbox(t);
  const manager = createMediaWorkspaceManager({
    tempDir: dir,
    inspectAsset: async () => DIRECT_INSPECTION
  });
  const workspace = await manager.createUrlWorkspace({
    displayName: 'Preview title',
    sourceName: 'Example source',
    waiting: true
  });
  assert.equal(workspace.status, 'waiting');
  assert.equal(workspace.activeOperation, 'acquiring');
  assert.equal(manager.publicWorkspace(workspace).source.origin, 'url');
  assert.equal(manager.publicWorkspace(workspace).source.sourceName, 'Example source');

  const sourcePath = path.join(workspace.tempDir, 'original-source.mp4');
  const bytes = Buffer.from('synthetic URL-acquired video');
  await fsp.writeFile(sourcePath, bytes);
  await manager.adoptAcquiredFile(workspace.id, sourcePath, { displayName: 'Preview title.mp4' });

  const snapshot = manager.publicWorkspace(workspace);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.source.name, 'Preview title.mp4');
  assert.equal(snapshot.source.size, bytes.length);
  assert.equal(snapshot.source.origin, 'url');
  assert.equal(snapshot.playback.role, 'source');
  assert.deepEqual(snapshot.assets.map((asset) => asset.role), ['source']);
});

test('URL source adoption rejects paths outside the workspace and enforces the byte limit', async (t) => {
  const dir = await sandbox(t);
  const manager = createMediaWorkspaceManager({
    tempDir: dir,
    maxBytes: 8,
    inspectAsset: async () => DIRECT_INSPECTION
  });
  const outside = path.join(dir, 'outside.mp4');
  await fsp.writeFile(outside, 'small');
  const first = await manager.createUrlWorkspace({ displayName: 'outside' });
  await assert.rejects(
    manager.adoptAcquiredFile(first.id, outside),
    /authoritative workspace/i
  );

  const second = await manager.createUrlWorkspace({ displayName: 'large' });
  const tooLarge = path.join(second.tempDir, 'original-source.mp4');
  await fsp.writeFile(tooLarge, 'more than eight bytes');
  await assert.rejects(
    manager.adoptAcquiredFile(second.id, tooLarge),
    (error) => error?.workspaceFailure?.category === 'local_media_too_large'
  );
});

test('discarding a queued URL workspace is prompt and prevents later source adoption', async (t) => {
  const dir = await sandbox(t);
  const manager = createMediaWorkspaceManager({ tempDir: dir, inspectAsset: async () => DIRECT_INSPECTION });
  const workspace = await manager.createUrlWorkspace({ displayName: 'Queued video', waiting: true });
  workspace.activePromise = new Promise(() => {});

  await Promise.race([
    manager.discard(workspace.id),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('queued discard blocked')), 100))
  ]);
  assert.equal(manager.get(workspace.id, { touch: false }), null);
  assert.equal(workspace.abortController.signal.aborted, true);
  await assert.rejects(
    manager.adoptAcquiredFile(workspace.id, path.join(dir, 'never-spawned.mp4')),
    (error) => error?.code === WORKSPACE_CANCELLED_CODE
  );
});

test('ffprobe inspection normalization keeps only finite video facts', () => {
  const normalized = normalizeInspection({
    format: {
      duration: '83.5014',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      format_long_name: 'QuickTime / MOV'
    },
    streams: [
      { index: 2, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
      { index: 5, codec_type: 'audio', codec_name: 'aac' },
      { index: 7, codec_type: 'subtitle', codec_name: 'mov_text' }
    ]
  });

  assert.equal(normalized.durationSeconds, 83.501);
  assert.deepEqual(normalized.formatNames.slice(0, 2), ['mov', 'mp4']);
  assert.deepEqual(normalized.video, { streamIndex: 2, codec: 'h264', width: 1920, height: 1080, frameRate: 29.97 });
  assert.deepEqual(normalized.audio, { streamIndex: 5, codec: 'aac' });
  assert.deepEqual(normalized.trackCounts, { audio: 1, subtitle: 1 });
  assert.equal(parseFrameRate('0/0'), null);
  assert.equal(isDirectPlaybackCompatible(normalized), true);
});

test('ISO Base Media brands produce truthful MP4 and MOV container labels without extension authority', () => {
  const commonVideo = [
    { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }
  ];
  const mp4 = normalizeInspection({
    format: {
      filename: 'misleading.mov',
      duration: '10',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      format_long_name: 'QuickTime / MOV',
      tags: { major_brand: 'isom', compatible_brands: 'isomiso2avc1mp41' }
    },
    streams: commonVideo
  });
  const quickTime = normalizeInspection({
    format: {
      filename: 'misleading.mp4',
      duration: '10',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      format_long_name: 'QuickTime / MOV',
      tags: { major_brand: 'qt  ', compatible_brands: 'qt  ' }
    },
    streams: commonVideo
  });

  assert.equal(mp4.format, 'MP4');
  assert.equal(quickTime.format, 'MOV / QuickTime');
});

test('inspection ignores attached cover art and timed-thumbnail-only video streams', () => {
  for (const disposition of [{ attached_pic: 1 }, { timed_thumbnails: 1 }]) {
    assert.throws(
      () => normalizeInspection({
        format: { duration: '180', format_name: 'mp3' },
        streams: [
          { index: 0, codec_type: 'audio', codec_name: 'mp3' },
          { index: 1, codec_type: 'video', codec_name: 'mjpeg', width: 1200, height: 1200, disposition }
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
        index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 1200, height: 1200,
        disposition: { attached_pic: 1 }
      },
      { index: 3, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '24/1' },
      { index: 6, codec_type: 'audio', codec_name: 'aac' }
    ]
  });
  const normal = normalizeInspection({
    format: { duration: '5', format_name: 'matroska' },
    streams: [{ index: 4, codec_type: 'video', codec_name: 'ffv1', width: 640, height: 360 }]
  });

  assert.deepEqual(withArtwork.video, { streamIndex: 3, codec: 'h264', width: 1280, height: 720, frameRate: 24 });
  assert.deepEqual(withArtwork.audio, { streamIndex: 6, codec: 'aac' });
  assert.deepEqual(normal.video, { streamIndex: 4, codec: 'ffv1', width: 640, height: 360, frameRate: null });
});

test('inspection falls back to the selected real video duration when format duration is unusable', () => {
  const normalized = normalizeInspection({
    format: { duration: 'N/A', format_name: 'matroska' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360, duration: '4.25' }
    ]
  });

  assert.equal(normalized.durationSeconds, 4.25);
});

test('inspection establishes one finite presentation origin and respects container duration semantics', () => {
  const streams = [
    { index: 2, codec_type: 'video', codec_name: 'h264', width: 160, height: 90, start_time: '7', duration: '5' },
    { index: 9, codec_type: 'audio', codec_name: 'aac', start_time: '7.5' }
  ];
  for (const [format, duration] of [['matroska,webm', '12'], ['mov,mp4', '12'], ['mpegts', '5']]) {
    const inspection = normalizeInspection({ format: { format_name: format, start_time: '7', duration }, streams });
    assert.equal(inspection.timeOriginSeconds, 7);
    assert.equal(inspection.durationSeconds, 5);
    assert.equal(inspection.video.streamIndex, 2);
    assert.equal(inspection.audio.streamIndex, 9);
    assert.equal(isDirectPlaybackCompatible(inspection), false, 'non-zero origins require normalized playback');
  }
  for (const start_time of [undefined, 'N/A', 'Infinity']) {
    const inspection = normalizeInspection({ format: { format_name: 'mov,mp4', start_time, duration: '5' }, streams });
    assert.equal(inspection.timeOriginSeconds, 0, 'unavailable format start follows FFmpeg default, not a per-stream reset');
    assert.equal(inspection.durationSeconds, 5);
  }
  const fallback = normalizeInspection({ format: { format_name: 'matroska', start_time: '7', duration: 'N/A' }, streams });
  assert.equal(fallback.durationSeconds, 5, 'stream duration is elapsed and must not subtract the origin');
});

test('negative presentation origins remain finite and normalize both streams together', () => {
  const inspection = normalizeInspection({
    format: { format_name: 'matroska', start_time: '-0.5', duration: '4.5' },
    streams: [{ index: 0, codec_type: 'video', codec_name: 'ffv1', width: 160, height: 90 }]
  });
  assert.equal(inspection.timeOriginSeconds, -0.5);
  assert.equal(inspection.durationSeconds, 5);
});

test('inspection rejects non-video media and missing duration clearly', () => {
  assert.throws(
    () => normalizeInspection({ format: { duration: '10' }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] }),
    (error) => error?.workspaceFailure?.category === 'local_media_invalid'
      && /video stream/i.test(error.workspaceFailure.explanation)
  );
  assert.throws(
    () => normalizeInspection({ format: {}, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }] }),
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
  let closed = false;
  const manager = createMediaWorkspaceManager({
    tempDir,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        killCount += 1;
        setImmediate(() => { closed = true; child.emit('close', 1); });
      };
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
  assert.equal(closed, true, 'cleanup must not start until the stopped child has closed');
});

test('direct playback policy requires MP4-family H.264 with AAC or no audio', () => {
  assert.equal(isDirectPlaybackCompatible(DIRECT_INSPECTION), true);
  assert.equal(isDirectPlaybackCompatible({ ...DIRECT_INSPECTION, audio: null }), true);
  assert.equal(isDirectPlaybackCompatible({ ...DIRECT_INSPECTION, video: { ...DIRECT_INSPECTION.video, codec: 'hevc' } }), false);
  assert.equal(isDirectPlaybackCompatible({ ...DIRECT_INSPECTION, audio: { codec: 'opus' } }), false);
  assert.equal(isDirectPlaybackCompatible(PROXY_INSPECTION), false);
});

test('playback proxy arguments are bounded H.264/AAC preview settings without upscaling intent', () => {
  const args = playbackProxyArgs('/private/source.mkv', '/private/proxy.mp4', {
    ...PROXY_INSPECTION,
    video: { ...PROXY_INSPECTION.video, streamIndex: 4 },
    audio: { ...PROXY_INSPECTION.audio, streamIndex: 7 }
  });
  const inputIndex = args.indexOf('-i');
  assert.deepEqual(args.slice(0, inputIndex), ['-y', '-hide_banner', '-loglevel', 'error', '-copyts', '-start_at_zero', ...localMediaInputArgs(PROXY_INSPECTION)]);
  assert.equal(args[inputIndex + 1], '/private/source.mkv');
  assert.deepEqual(args.slice(inputIndex + 2, inputIndex + 6), ['-map', '0:4', '-map', '0:7']);
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('veryfast'));
  assert.ok(args.includes('28'));
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('128k'));
  assert.ok(args.includes('+faststart'));
  assert.match(args[args.indexOf('-vf') + 1], /min\(1280,iw\).*min\(720,ih\)/);
});

test('edit plans are normalized to milliseconds and reject malformed, unsafe, or no-op ranges', () => {
  assert.deepEqual(
    normalizeEditPlan({
      version: 1,
      keepRanges: [{ startSeconds: 1.23449, endSeconds: 11.11151 }]
    }, 12.5),
    { version: 1, keepRanges: [{ startSeconds: 1.234, endSeconds: 11.112 }] }
  );
  assert.deepEqual(
    normalizeEditPlan({
      version: 1,
      keepRanges: [
        { startSeconds: 0.5, endSeconds: 3 },
        { startSeconds: 4.25, endSeconds: 8 },
        { startSeconds: 9, endSeconds: 12 }
      ]
    }, 12.5),
    {
      version: 1,
      keepRanges: [
        { startSeconds: 0.5, endSeconds: 3 },
        { startSeconds: 4.25, endSeconds: 8 },
        { startSeconds: 9, endSeconds: 12 }
      ]
    }
  );

  const invalidPlans = [
    null,
    { version: 2, keepRanges: [{ startSeconds: 1, endSeconds: 2 }] },
    { version: 1, keepRanges: [] },
    { version: 1, keepRanges: [{ startSeconds: 3, endSeconds: 4 }, { startSeconds: 1, endSeconds: 2 }] },
    { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 4 }, { startSeconds: 3, endSeconds: 5 }] },
    {
      version: 1,
      keepRanges: Array.from({ length: MAX_KEEP_RANGES + 1 }, (_unused, index) => ({
        startSeconds: index * 0.2,
        endSeconds: index * 0.2 + 0.1
      }))
    },
    { version: 1, keepRanges: [{ startSeconds: '1', endSeconds: 2 }] },
    { version: 1, keepRanges: [{ startSeconds: Number.NaN, endSeconds: 2 }] },
    { version: 1, keepRanges: [{ startSeconds: -1, endSeconds: 2 }] },
    { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 13 }] },
    { version: 1, keepRanges: [{ startSeconds: 3, endSeconds: 3 }] },
    { version: 1, keepRanges: [{ startSeconds: 4, endSeconds: 3 }] }
  ];
  for (const plan of invalidPlans) {
    assert.throws(() => normalizeEditPlan(plan, 12.5), (error) => error?.statusCode === 422);
  }
  assert.throws(
    () => normalizeEditPlan({ version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 12.5 }] }, 12.5),
    (error) => error?.statusCode === 422 && /outer boundary|remove a section/i.test(error.message)
  );
});

test('edited output naming remains path-safe and deterministic', () => {
  assert.equal(editedOutputFilename('C:\\private\\family.mov'), 'family - edited.mp4');
  assert.equal(editedOutputFilename('../../secret.mkv'), 'secret - edited.mp4');
  assert.ok(editedOutputFilename(`${'x'.repeat(300)}.mp4`).length <= 255);
});

test('edited output arguments always re-encode the exact selected streams to the fixed MP4 profile', () => {
  const plan = { version: 1, keepRanges: [{ startSeconds: 1.25, endSeconds: 10.5 }] };
  const args = editedOutputArgs('/private/original.mkv', '/private/edited.mp4', {
    ...PROXY_INSPECTION,
    video: { ...PROXY_INSPECTION.video, streamIndex: 5 },
    audio: { ...PROXY_INSPECTION.audio, streamIndex: 9 }
  }, plan);

  const inputIndex = args.indexOf('-i');
  assert.deepEqual(args.slice(0, inputIndex), ['-y', '-hide_banner', '-loglevel', 'error', '-copyts', '-start_at_zero', ...localMediaInputArgs(PROXY_INSPECTION)]);
  assert.equal(args[inputIndex + 1], '/private/original.mkv');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(graph.includes("[0:5]settb=AVTB,trim=end_pts=10500000,select='gte(pts,1250000)*lt(pts,10500000)'"));
  assert.match(graph, /\[0:9\]aresample=/);
  assert.match(graph, /apad=whole_dur=10.5,atrim=end=10.5/);
  assert.equal(args.includes('-ss'), false);
  assert.equal(args[args.indexOf('-preset') + 1], 'medium');
  assert.equal(args[args.indexOf('-crf') + 1], '18');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.equal(args[args.indexOf('-b:a') + 1], '256k');
  assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
  assert.match(graph, /trunc\(iw\/2\)\*2.*trunc\(ih\/2\)\*2/);
  assert.equal(args.includes('copy'), false);

  const silentArgs = editedOutputArgs('/private/original.mkv', '/private/edited.mp4', {
    ...DIRECT_INSPECTION,
    audio: null
  }, plan);
  assert.equal(silentArgs.includes('-an'), true);
  assert.equal(silentArgs.includes('-c:a'), false);
});

test('multi-range output maps original video PTS and concatenates bounded presentation audio in source order', () => {
  const twoRangePlan = {
    version: 1,
    keepRanges: [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 4, endSeconds: 6 }]
  };
  const inspection = {
    ...DIRECT_INSPECTION,
    video: { ...DIRECT_INSPECTION.video, streamIndex: 5 },
    audio: { ...DIRECT_INSPECTION.audio, streamIndex: 9 }
  };
  const args = editedOutputArgs('/private/original-source.mkv', '/private/edited.mp4', inspection, twoRangePlan);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.equal(args[args.indexOf('-i') + 1], '/private/original-source.mkv');
  assert.equal(args.includes('-ss'), false);
  assert.ok(graph.startsWith("[0:5]settb=AVTB,trim=end_pts=6000000,select='gte(pts,0)*lt(pts,2000000)+gte(pts,4000000)*lt(pts,6000000)'"));
  assert.ok(graph.includes("setpts='PTS-(0+gte(PTS,4000000)*2000000)'"));
  assert.match(graph, /\[0:9\]aresample=async=1:first_pts=0:min_hard_comp=0.001,apad=whole_dur=6,atrim=end=6,asplit=2\[as0\]\[as1\]/);
  assert.match(graph, /\[as1\]atrim=start=4:end=6,asetpts=PTS-4\/TB\[a1\]/);
  assert.match(graph, /\[a0\]\[a1\]concat=n=2:v=0:a=1\[acat\]/);
  assert.doesNotMatch(graph, /STARTPTS|concat=n=\d+:v=1/);
  assert.match(graph, /apad=whole_dur=6,atrim=end=6/);
  assert.equal(args[args.indexOf('-fps_mode:v') + 1], 'vfr');
  assert.equal(args[args.indexOf('-enc_time_base:v') + 1], '1:1000000');
  assert.equal(args.includes('-r'), false);
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 4), ['-map', '[vout]', '-map', '[acat]']);
  assert.equal(totalRetainedDuration(twoRangePlan), 4);
  assert.equal(renderProgressPercent(2, totalRetainedDuration(twoRangePlan)), 50);

  const threeRangePlan = {
    version: 1,
    keepRanges: [
      { startSeconds: 0, endSeconds: 1 },
      { startSeconds: 2.5, endSeconds: 4 },
      { startSeconds: 7, endSeconds: 9.25 }
    ]
  };
  const threeArgs = editedOutputArgs('source', 'output', inspection, threeRangePlan);
  const threeGraph = threeArgs[threeArgs.indexOf('-filter_complex') + 1];
  assert.match(threeGraph, /\[a0\]\[a1\]\[a2\]concat=n=3:v=0:a=1/);
  assert.ok(threeGraph.includes("setpts='PTS-(0+gte(PTS,2500000)*1500000+gte(PTS,7000000)*3000000)'"));
  assert.equal(totalRetainedDuration(threeRangePlan), 4.75);
});

test('silent multi-range output maps only the authoritative video stream', () => {
  const plan = {
    version: 1,
    keepRanges: [{ startSeconds: 1, endSeconds: 2 }, { startSeconds: 3, endSeconds: 5 }]
  };
  const args = editedOutputArgs('/authoritative/source.webm', '/workspace/output.mp4', {
    ...DIRECT_INSPECTION,
    video: { ...DIRECT_INSPECTION.video, streamIndex: 7 },
    audio: null
  }, plan);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.ok(graph.includes("[0:7]settb=AVTB,trim=end_pts=5000000,select='gte(pts,1000000)*lt(pts,2000000)"));
  assert.ok(graph.includes("setpts='PTS-(1000000+gte(PTS,3000000)*1000000)'"));
  assert.doesNotMatch(graph, /atrim|\[acat\]/);
  assert.equal(args.includes('-an'), true);
  assert.equal(args.includes('-c:a'), false);
});

test('generated video expressions implement half-open source intervals on one common clock', () => {
  const args = editedOutputArgs('original', 'output', DIRECT_INSPECTION, { version: 1, keepRanges: [
    { startSeconds: 0.2, endSeconds: 0.817 },
    { startSeconds: 1.123, endSeconds: 1.927 },
    { startSeconds: 2.233, endSeconds: 3.137 }
  ] });
  const graph = args[args.indexOf('-filter_complex') + 1];
  // Evaluate the emitted arithmetic, with independently specified input/output
  // examples, instead of only checking that a timestamp filter name is present.
  const evaluate = expression => new Function('pts', 'PTS', 'gte', 'lt', `return ${expression};`);
  const select = evaluate(graph.match(/select='([^']+)'/)[1]);
  const pts = evaluate(graph.match(/setpts='([^']+)'/)[1]);
  const gte = (a, b) => Number(a >= b), lt = (a, b) => Number(a < b);
  for (const [input, expected] of [[200000, 0], [500000, 300000], [1123000, 617000], [1500000, 994000], [2233000, 1421000], [3000000, 2188000]]) {
    assert.equal(select(input, input, gte, lt), 1);
    assert.equal(pts(input, input, gte, lt), expected);
  }
  for (const input of [199999, 817000, 1122999, 1927000, 2232999, 3137000]) {
    assert.equal(select(input, input, gte, lt), 0, 'end boundaries and removed gaps are excluded');
  }
});

test('missing encoded durations are recovered without rewriting PTS or DTS, including a one-frame render', () => {
  const args = editedOutputArgs('original', 'output', DIRECT_INSPECTION, {
    version: 1, keepRanges: [{ startSeconds: 0.5, endSeconds: 0.55 }]
  });
  const bsf = args[args.indexOf('-bsf:v') + 1];
  assert.match(bsf, /^setts=pts=PTS:dts=DTS:duration=/);
  const expression = bsf.match(/duration='([^']+)'/)[1].replaceAll('if(', 'choose(');
  const evaluate = new Function('DURATION', 'NEXT_DTS', 'DTS', 'PREV_OUTDTS', 'N', 'PTS', 'TB', 'gt', 'eq', 'choose', `return ${expression};`);
  const duration = (...values) => evaluate(...values, (a, b) => Number(a > b), (a, b) => Number(a === b), (condition, a, b) => condition ? a : b);
  assert.equal(duration(40000, 50000, 0, -50000, 1, 0, 0.000001), 40000, 'known duration is retained');
  assert.equal(duration(0, 80000, 30000, 0, 1, 30000, 0.000001), 50000, 'next DTS establishes missing duration');
  assert.equal(duration(0, -1, 100000, 50000, 2, 100000, 0.000001), 50000, 'last packet uses prior DTS spacing');
  assert.ok(Math.abs(duration(0, -1, 0, -1, 0, 0, 0.000001) - 50000) < 1e-8, 'single packet covers retained duration');
  assert.equal(args[args.indexOf('-x264-params') + 1], 'fps=30', 'source cadence is a header hint only');
  assert.equal(args.includes('-r'), false);
  assert.equal(args.includes('-r:v'), false);
});

test('the 50-range limit also bounds the production timing graph', () => {
  const plan = normalizeEditPlan({ version: 1, keepRanges: Array.from({ length: 50 }, (_, index) => ({
    startSeconds: index * 0.2, endSeconds: index * 0.2 + 0.1
  })) }, 12.5);
  const args = editedOutputArgs('original', 'output', DIRECT_INSPECTION, plan);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /asplit=50/);
  assert.match(graph, /concat=n=50:v=0:a=1/);
  assert.equal((graph.match(/\]atrim=start=/g) || []).length, 50);
  assert.equal(totalRetainedDuration(plan), 5);
});

test('render progress is finite, bounded below completion, and output inspection enforces the final contract', () => {
  assert.equal(renderProgressPercent(5, 10), 50);
  assert.equal(renderProgressPercent(-1, 10), 0);
  assert.equal(renderProgressPercent(20, 10), 99);
  assert.equal(renderProgressPercent(Number.NaN, 10), null);
  assert.doesNotThrow(() => validateEditedOutputInspection(DIRECT_INSPECTION, { expectAudio: true }));
  assert.doesNotThrow(() => validateEditedOutputInspection({ ...DIRECT_INSPECTION, audio: null }));
  assert.throws(
    () => validateEditedOutputInspection({ ...DIRECT_INSPECTION, video: { ...DIRECT_INSPECTION.video, codec: 'hevc' } }),
    (error) => error?.localFailure?.operation === 'output_collection'
  );
  assert.throws(
    () => validateEditedOutputInspection({ ...DIRECT_INSPECTION, video: { ...DIRECT_INSPECTION.video, width: 1279 } }),
    (error) => error?.localFailure?.reason === 'output_inconsistent'
  );
  assert.throws(
    () => validateEditedOutputInspection({ ...DIRECT_INSPECTION, audio: null }, { expectAudio: true }),
    /AAC audio/i
  );
  assert.doesNotThrow(() => validateEditedOutputInspection(
    { ...DIRECT_INSPECTION, durationSeconds: 4.08 },
    { expectAudio: true, expectedDurationSeconds: 4 }
  ));
  assert.throws(
    () => validateEditedOutputInspection(
      { ...DIRECT_INSPECTION, durationSeconds: 7 },
      { expectAudio: true, expectedDurationSeconds: 4 }
    ),
    /duration does not match/i
  );
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
  const readyDir = ready.tempDir;
  const proxyPath = path.join(readyDir, 'synthetic-proxy.mp4');
  const outputPath = path.join(readyDir, 'synthetic-edited.mp4');
  await fsp.writeFile(proxyPath, 'proxy');
  await fsp.writeFile(outputPath, 'edited output');
  manager.registerAsset(ready, {
    role: 'playback-proxy', filePath: proxyPath, size: 5, mime: 'video/mp4', playable: true
  });
  const output = manager.registerAsset(ready, {
    role: 'edited-output', filePath: outputPath, size: 13, mime: 'video/mp4', playable: false,
    filename: 'ready - edited.mp4', inspection: DIRECT_INSPECTION,
    editPlan: { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 10 }] }
  });
  ready.render.outputAssetId = output.id;
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
  await assert.rejects(fsp.access(readyDir));
  assert.equal(manager.workspaces.has(active.id), true);

  assert.equal(await manager.discard(active.id), true);
  assert.equal(manager.workspaces.size, 0);
});
