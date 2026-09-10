'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { createMediaWorkspaceManager } = require('../../media-workspace');
const { localMediaInputArgs } = require('../../local-media-input');

const WIDTH = 96, HEIGHT = 64, SAMPLE_RATE = 48000;
let root;
function run(command, args) { return execFileSync(command, args, { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }); }
function ffmpeg(args) { return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); }
function probe(file, frames = false) {
  return JSON.parse(run('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-show_streams', '-show_format', ...(frames ? ['-show_frames'] : []), '-of', 'json', file]));
}
function option(args, name) { return args[args.indexOf(name) + 1]; }
function generate(name, baseLuma, stepLuma, baseTone) {
  ffmpeg(['-f', 'lavfi', '-i', `nullsrc=s=${WIDTH}x${HEIGHT}:r=10:d=6`, '-f', 'lavfi', '-i', `aevalsrc=0.125*sin(2*PI*(${baseTone}+100*floor(t))*t):s=${SAMPLE_RATE}:d=6:n=480`,
    '-vf', `geq=lum='${baseLuma}+${stepLuma}*floor(T)':cb=128:cr=128`, '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', path.join(root, name)]);
}
test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-multiple-real-'));
  console.log(run('ffmpeg', ['-version']).toString().split(/\r?\n/)[0]); run('ffprobe', ['-version']);
  generate('first.mkv', 32, 24, 400); generate('second.mkv', 96, 16, 1400);
});
test.after(async () => { if (root) await fsp.rm(root, { recursive: true, force: true }); });

async function setup(t) {
  const calls = []; let activeEncoders = 0, maximumEncoders = 0;
  const manager = createMediaWorkspaceManager({ tempDir: root, spawnProcess(command, args, options) {
    assert.equal(options.shell, false); assert.ok(args.includes('-format_whitelist')); assert.equal(option(args, '-protocol_whitelist'), 'file');
    calls.push({ command, args: [...args] });
    const child = spawn(command, args, options);
    const encoding = command === 'ffmpeg';
    if (encoding) maximumEncoders = Math.max(maximumEncoders, ++activeEncoders);
    const timeout = setTimeout(() => child.kill(), 30000);
    child.once('close', () => { clearTimeout(timeout); if (encoding) activeEncoders--; });
    return child;
  } });
  t.after(() => manager.clearAll());
  const collection = manager.localProcessing.createCollection();
  const files = [];
  for (const name of ['first.mkv', 'second.mkv']) {
    const file = path.join(root, name), size = (await fsp.stat(file)).size;
    const actual = probe(file, true), frames = actual.frames.filter(frame => frame.media_type === 'video');
    assert.equal(Number(actual.format.start_time), 0); assert.equal(frames.length, 60);
    assert.equal(Number(frames[0].best_effort_timestamp_time), 0); assert.equal(Number(frames.at(-1).best_effort_timestamp_time), 5.9);
    const workspace = await manager.localProcessing.receiveLocalStream(collection.id, fs.createReadStream(file), { displayName: name, declaredLength: size });
    await workspace.activePromise; assert.equal(workspace.status, 'ready', JSON.stringify(workspace.failure));
    files.push(workspace);
  }
  return { manager, collection, files, calls, maximumEncoders: () => maximumEncoders };
}
async function review(manager, workspace, pairs, settings, draftRevision = 0) {
  const body = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision,
    editPlan: { version: 1, keepRanges: pairs.map(([startSeconds, endSeconds]) => ({ startSeconds, endSeconds })) }, settings };
  const plan = await manager.processing.plan(body); assert.ok(['executable', 'no-op'].includes(plan.status), JSON.stringify(plan));
  return { ...body, planKey: plan.key, acknowledgedWarnings: plan.warnings.map(warning => warning.id) };
}
async function settled(manager, id) {
  const deadline = Date.now() + 30000;
  while (manager.localProcessing.snapshot(id).jobs.some(job => ['queued', 'starting', 'running', 'cancelling'].includes(job.status))) {
    assert.ok(Date.now() < deadline, 'real queue finishes inside test deadline'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  const jobs = manager.localProcessing.snapshot(id).jobs;
  assert.ok(jobs.every(job => job.status === 'completed'), JSON.stringify(jobs));
}
function checkMarkers(file, pairs, { width, height, fps, baseLuma, stepLuma, baseTone }) {
  const raw = probe(file, true), frames = raw.frames.filter(frame => frame.media_type === 'video');
  const video = raw.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264'); assert.equal(video.width, width); assert.equal(video.height, height);
  assert.equal(raw.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
  const duration = pairs.reduce((sum, [start, end]) => sum + end - start, 0);
  // Preserve the existing frame-boundary allowance; AAC priming may add a packet.
  assert.ok(Math.abs(Number(raw.format.duration) - duration) <= Math.max(0.06, 1 / fps + 0.01));
  const input = localMediaInputArgs({ formatNames: raw.format.format_name.split(',') });
  const pixels = ffmpeg([...input, '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
  const audio = ffmpeg([...input, '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1']);
  assert.equal(pixels.length, frames.length * width * height); assert.ok(Math.abs(frames.length - duration * fps) <= 1);
  let offset = 0, checks = 0;
  for (const [start, end] of pairs) {
    for (let local = 0.25; local + 0.1 < end - start; local += 0.3) {
      const source = start + local;
      if (source % 1 > 0.8) continue;
      const frameIndex = frames.findIndex(frame => Number(frame.best_effort_timestamp_time) >= offset + local);
      assert.ok(frameIndex >= 0);
      const frameSource = start + Number(frames[frameIndex].best_effort_timestamp_time) - offset;
      const expected = Math.round((baseLuma + stepLuma * Math.floor(frameSource) - 16) * 255 / 219);
      assert.ok(Math.abs(pixels[frameIndex * width * height + width + 1] - expected) <= 10, 'retained frame belongs to this file and source section');
      const first = Math.round((offset + local) * SAMPLE_RATE), count = Math.round(0.08 * SAMPLE_RATE);
      assert.ok((first + count) * 4 <= audio.length); let crossings = 0, sum = 0;
      for (let i = first; i < first + count; i++) {
        const value = audio.readFloatLE(i * 4); sum += value * value;
        if (i > first && audio.readFloatLE((i - 1) * 4) <= 0 && value > 0) crossings++;
      }
      assert.ok(Math.sqrt(sum / count) > 0.04);
      assert.ok(Math.abs(crossings / 0.08 - (baseTone + 100 * Math.floor(source))) < 20, 'retained tone belongs to this file and source second');
      checks++;
    }
    offset += end - start;
  }
  assert.ok(checks >= pairs.length * 2);
}

test('real queued files preserve independent markers, cuts, scale, cadence and immutable submitted settings', async t => {
  const { manager, collection, files: [a, b], calls, maximumEncoders } = await setup(t);
  const aRanges = [[0, 1], [4, 6]], bRanges = [[1, 2], [3, 5]];
  const aRequest = await review(manager, a, aRanges, { videoCodec: 'h264', container: 'mp4', filenameSuffix: '_first', scale: { mode: 'fit', width: 48, height: 32 },
    rate: { mode: 'quality', crf: 24 }, audio: { codec: 'aac', bitrateKbps: 64 } });
  const bRequest = await review(manager, b, bRanges, { videoCodec: 'h264', container: 'matroska', filenameSuffix: '_second', frameRate: 5,
    rate: { mode: 'bitrate', videoKbps: 120 }, audio: { codec: 'aac', bitrateKbps: 64 } });
  const before = calls.length;
  await manager.localProcessing.enqueue(collection.id, [aRequest, bRequest]);
  await review(manager, b, [[0, 6]], { videoCodec: 'h264', container: 'mp4', rate: { mode: 'quality', crf: 40 }, audio: { codec: 'aac' } }, 1);
  await settled(manager, collection.id); assert.equal(maximumEncoders(), 1);
  const aOutput = manager.conversions.resolve(a.id, a.conversion.output.assetId).asset;
  const bOutput = manager.conversions.resolve(b.id, b.conversion.output.assetId).asset;
  assert.equal(aOutput.filename, 'first_first.mp4'); assert.equal(bOutput.filename, 'second_second.mkv');
  assert.equal(b.conversion.output.draftRevision, 0); assert.equal(b.conversion.output.processingSnapshot.settings.rate.videoKbps, 120);
  checkMarkers(aOutput.filePath, aRanges, { width: 48, height: 32, fps: 10, baseLuma: 32, stepLuma: 24, baseTone: 400 });
  checkMarkers(bOutput.filePath, bRanges, { width: 96, height: 64, fps: 5, baseLuma: 96, stepLuma: 16, baseTone: 1400 });
  const encodes = calls.slice(before).filter(call => call.command === 'ffmpeg'); assert.equal(encodes.length, 2);
  for (const [index, workspace] of [a, b].entries()) {
    assert.equal(option(encodes[index].args, '-i'), workspace.assets.get(workspace.sourceAssetId).filePath);
    assert.equal([...workspace.assets.values()].some(asset => asset.role === 'edited-output'), false);
    assert.equal(workspace.playbackAssetId, null); assert.equal(workspace.queuedProcessingJobId, null);
  }
});

test('real no-op files keep exact bytes and independent downloads when another entry is processed and removed', async t => {
  const { manager, collection, files: [a, b], calls } = await setup(t);
  const aRequest = await review(manager, a, [[0, 6]], {}, 0), bRequest = await review(manager, b, [[0, 6]], {}, 0);
  const before = calls.length; await manager.localProcessing.enqueue(collection.id, [aRequest, bRequest]); await settled(manager, collection.id);
  assert.equal(calls.slice(before).filter(call => call.command === 'ffmpeg').length, 0);
  for (const [workspace, name] of [[a, 'first.mkv'], [b, 'second.mkv']]) {
    const resolved = manager.conversions.resolve(workspace.id, workspace.conversion.output.assetId);
    assert.equal(workspace.assets.size, 1); assert.equal(workspace.conversion.output.noOp, true);
    assert.deepEqual(await fsp.readFile(resolved.asset.filePath), await fsp.readFile(path.join(root, name)));
  }
  const rerun = await review(manager, b, [[2, 4]], { videoCodec: 'h264', container: 'mp4', audio: { codec: 'aac' } }, 1);
  await manager.localProcessing.enqueue(collection.id, [rerun]); await settled(manager, collection.id);
  await manager.discard(b.id);
  const preserved = manager.conversions.resolve(a.id, a.conversion.output.assetId);
  assert.ok(preserved); assert.deepEqual(await fsp.readFile(preserved.asset.filePath), await fsp.readFile(path.join(root, 'first.mkv')));
  assert.equal(manager.localProcessing.snapshot(collection.id).workspaces.length, 1);
});
