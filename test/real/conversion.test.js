'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createMediaWorkspaceManager } = require('../../media-workspace');
const { localMediaInputArgs } = require('../../local-media-input');

let root;
function ffmpeg(args) { return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }); }
function probe(file, extra = []) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...localMediaInputArgs(), ...extra, '-of', 'json', file], { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
}
function hashes(file, type) { return probe(file, ['-select_streams', type, '-show_packets', '-show_data_hash', 'sha256']).packets.map(packet => packet.data_hash); }
async function intake(t, file, options = {}) {
  const calls = [];
  const manager = createMediaWorkspaceManager({ tempDir: root, spawnProcess: (command, args, opts) => { calls.push({ command, args }); return spawn(command, args, opts); }, ...options });
  t.after(() => manager.clearAll());
  const workspace = await manager.receiveLocalStream(fs.createReadStream(file), { displayName: path.basename(file), purpose: 'local' });
  await workspace.activePromise;
  assert.equal(workspace.status, 'ready', JSON.stringify(workspace.failure));
  assert.equal(workspace.playbackAssetId, null);
  return { manager, workspace, calls };
}
async function convert(context, targetId) {
  const { manager, workspace } = context;
  const plan = await manager.conversions.plan(workspace.id, workspace.sourceAssetId, targetId);
  assert.ok(['executable', 'no-op'].includes(plan.status), JSON.stringify(plan));
  await manager.conversions.start({ workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, targetId, planKey: plan.key, acknowledgedWarnings: plan.warnings.map(item => item.id) });
  await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'ready', JSON.stringify(workspace.conversion));
  const resolved = manager.conversions.resolve(workspace.id, workspace.conversion.output.assetId);
  assert.ok(resolved);
  return { plan, file: resolved.asset.filePath, inspection: workspace.conversion.output.inspection };
}

test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-conversion-real-'));
  console.log(execFileSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]);
  execFileSync('ffprobe', ['-version'], { windowsHide: true });
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=20:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(root, 'base.mp4')]);
});
test.after(async () => { if (root) await fsp.rm(root, { recursive: true, force: true }); });

test('MP4 no-op authorizes the unchanged owned bytes without FFmpeg conversion or a disk copy', async t => {
  const context = await intake(t, path.join(root, 'base.mp4'));
  const output = await convert(context, 'broad-compatibility-mp4');
  assert.equal(output.plan.status, 'no-op');
  assert.equal(context.calls.filter(call => call.command === 'ffmpeg').length, 0);
  assert.equal(output.file, context.workspace.assets.get(context.workspace.sourceAssetId).filePath);
  assert.deepEqual(await fsp.readFile(output.file), await fsp.readFile(path.join(root, 'base.mp4')));
  assert.equal(context.workspace.assets.size, 1);
});

for (const extension of ['mov', 'mkv']) {
  test(`${extension} remux creates MP4 with unchanged selected video/audio packet payloads`, async t => {
    const input = path.join(root, `remux.${extension}`);
    ffmpeg(['-i', path.join(root, 'base.mp4'), '-map', '0', '-c', 'copy', input]);
    const context = await intake(t, input);
    const output = await convert(context, 'broad-compatibility-mp4');
    assert.deepEqual(output.plan.streams.map(stream => stream.action), ['copy', 'copy']);
    assert.deepEqual(hashes(output.file, 'v'), hashes(input, 'v'));
    assert.deepEqual(hashes(output.file, 'a'), hashes(input, 'a'));
  });
}

for (const [name, videoCodec, audioCodec, actions] of [
  ['copy-video', 'libx264', 'pcm_s16le', ['copy', 'encode']],
  ['copy-audio', 'ffv1', 'aac', ['encode', 'copy']],
  ['encode-both', 'ffv1', 'pcm_s16le', ['encode', 'encode']]
]) {
  test(`${name} selects only the required encoders and preserves copied packet payloads`, async t => {
    const input = path.join(root, `${name}.mkv`);
    ffmpeg(['-i', path.join(root, 'base.mp4'), '-c:v', videoCodec, '-c:a', audioCodec, input]);
    const context = await intake(t, input);
    const output = await convert(context, 'broad-compatibility-mp4');
    assert.deepEqual(output.plan.streams.map(stream => stream.action), actions);
    if (actions[0] === 'copy') assert.deepEqual(hashes(output.file, 'v'), hashes(input, 'v'));
    if (actions[1] === 'copy') assert.deepEqual(hashes(output.file, 'a'), hashes(input, 'a'));
    assert.equal(output.inspection.video.width, 96);
    assert.equal(output.inspection.video.height, 64);
  });
}

for (const target of ['m4a-aac', 'mp3']) {
  test(`video extracts to real ${target} audio-only output`, async t => {
    const context = await intake(t, path.join(root, 'base.mp4'));
    const output = await convert(context, target);
    assert.equal(output.plan.status, 'executable');
    assert.equal(output.inspection.video, null);
    assert.equal(output.inspection.audio.codec, target === 'mp3' ? 'mp3' : 'aac');
  });
  test(`audio-only PCM converts to ${target}, then suitable output is a no-op`, async t => {
    const input = path.join(root, `audio-${target}.wav`);
    ffmpeg(['-i', path.join(root, 'base.mp4'), '-vn', '-c:a', 'pcm_s16le', input]);
    const context = await intake(t, input);
    const output = await convert(context, target);
    const next = await intake(t, output.file);
    const noop = await convert(next, target);
    assert.equal(noop.plan.status, 'no-op');
  });
}

test('silent video conversion adds no audio stream', async t => {
  const input = path.join(root, 'silent.mkv');
  ffmpeg(['-i', path.join(root, 'base.mp4'), '-an', '-c:v', 'ffv1', input]);
  const output = await convert(await intake(t, input), 'broad-compatibility-mp4');
  assert.equal(output.inspection.audio, null);
});

function pcm(file) {
  const inspected = probe(file, ['-show_format']);
  const bytes = ffmpeg(['-copyts', '-start_at_zero', ...localMediaInputArgs({ formatNames: inspected.format.format_name.split(',') }), '-i', file, '-map', '0:a:0',
    '-af', 'aresample=async=1:first_pts=0:min_hard_comp=0.001', '-ar', '48000', '-ac', '1', '-f', 'f32le', 'pipe:1']);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function rms(samples, start, end) {
  const window = samples.subarray(Math.round(start * 48000), Math.round(end * 48000));
  assert.ok(window.length >= (end - start) * 48000 - 2, 'audio window exists');
  return Math.sqrt(window.reduce((sum, sample) => sum + sample * sample, 0) / window.length);
}
for (const [name, origin, codec, videoCodec = 'libx264'] of [['encoded', 0, 'pcm_s16le'], ['encoded-shifted', 1, 'pcm_s16le'], ['copied-shifted', 0.5, 'aac'], ['both-encoded-shifted', 1, 'pcm_s16le', 'ffv1']]) {
  test(`${name} video conversion preserves delayed audio, an internal gap, and an early audio endpoint`, async t => {
    const input = path.join(root, `timing-${name}.mkv`);
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=20:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=3',
      '-filter_complex', '[1:a]aselect=not(between(t\\,1\\,1.5)),asetpts=PTS+0.5/TB[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', videoCodec, '-c:a', codec, '-output_ts_offset', String(origin), input]);
    const context = await intake(t, input);
    const original = context.workspace.inspection;
    const raw = probe(input, ['-show_format', '-show_streams', '-show_frames']);
    const firstVideo = Number(raw.frames.find(frame => frame.media_type === 'video').best_effort_timestamp_time);
    const firstAudio = Number(raw.frames.find(frame => frame.media_type === 'audio').best_effort_timestamp_time);
    assert.ok(Math.abs(firstVideo - origin) < 0.001);
    assert.ok(Math.abs(firstAudio - origin - 0.5) < 0.03, 'actual AAC priming/sample boundary');
    assert.equal(original.durationSeconds, 5);
    const output = await convert(context, 'broad-compatibility-mp4');
    const samples = pcm(output.file);
    assert.ok(rms(samples, 0.1, 0.4) < 0.001, 'leading silence stays at the beginning');
    assert.ok(rms(samples, 0.65, 0.95) > 0.05, 'sound follows its source delay');
    assert.ok(rms(samples, 1.6, 1.9) < 0.001, 'interior timestamp gap stays in place');
    assert.ok(rms(samples, 2.15, 2.45) > 0.05, 'sound after the gap stays in place');
    assert.ok(samples.length / 48000 < 3.57, 'no unrelated video tail appended to selected audio');
    assert.ok(Math.abs(output.inspection.durationSeconds - 5) < 0.06);
    console.log(JSON.stringify({ conversionTiming: name, sourceOrigin: origin, firstVideo, firstAudio, outputDuration: output.inspection.durationSeconds, audioEnd: samples.length / 48000 }));
    const extracted = await convert(context, 'm4a-aac');
    const audioOnly = pcm(extracted.file);
    assert.ok(rms(audioOnly, 0.1, 0.4) > 0.05);
    assert.ok(rms(audioOnly, 1.1, 1.35) < 0.001);
    assert.ok(rms(audioOnly, 1.7, 2.0) > 0.05);
    assert.ok(Math.abs(audioOnly.length / 48000 - original.audio.durationSeconds) < 0.06);
  });
}

for (const [layout, channels, targetId] of [['mono', 1, 'm4a-aac'], ['stereo', 2, 'm4a-aac'], ['5.1', 6, 'm4a-aac'], ['5.1(side)', 6, 'm4a-aac']]) {
  test(`real AAC ${layout} preserves the layout or rejects an unverifiable encoder result`, async t => {
    const input = path.join(root, `layout-${layout.replace(/[^a-z0-9]/gi, '')}.mkv`);
    ffmpeg(['-f', 'lavfi', '-i', `aevalsrc=0.1*sin(2*PI*440*t):s=44100:d=1:c=${layout}`, '-c:a', 'flac', input]);
    const context = await intake(t, input);
    assert.equal(context.workspace.inspection.audio.channels, channels);
    const { manager, workspace } = context;
    const inspect = manager.defaultInspectAsset.bind(manager);
    let actual;
    manager.defaultInspectAsset = async (...args) => { actual = await inspect(...args); return actual; };
    const plan = await manager.conversions.plan(workspace.id, workspace.sourceAssetId, targetId);
    assert.equal(plan.status, 'executable');
    assert.equal(plan.output.channelLayout, layout);
    await manager.conversions.start({ workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, targetId, planKey: plan.key });
    await workspace.activePromise;
    assert.equal(actual.audio.channels, channels); assert.equal(actual.audio.sampleRate, 44100);
    if (layout === '5.1(side)' && actual.audio.channelLayout !== layout) {
      // Some native AAC builds emit an unnamed PCE layout. Six channels alone
      // cannot establish side/back/LFE positions: this is a tested failure, not a skip.
      assert.equal(workspace.conversion.status, 'failed'); assert.equal(workspace.conversion.output, null);
      assert.equal(workspace.conversion.failure.category, 'local_conversion_validation');
      assert.match(workspace.conversion.failure.explanation, /channel layout/);
      console.log(JSON.stringify({ aacLayoutRuntimeLimitation: layout, actualLayout: actual.audio.channelLayout, channels, published: false }));
    } else {
      assert.equal(workspace.conversion.status, 'ready', JSON.stringify(workspace.conversion.failure));
      assert.equal(actual.audio.channelLayout, layout);
    }
    if (channels > 2) {
      const refused = await context.manager.conversions.plan(context.workspace.id, context.workspace.sourceAssetId, 'mp3');
      assert.equal(refused.reason, 'unsupported'); assert.match(refused.message, /downmixed/);
    }
  });
}

for (const [rotation, pixelFormat] of [[90, 'yuv420p'], [90, 'yuv444p'], [180, 'yuv444p'], [270, 'yuv444p']]) {
  test(`standard ${rotation} degree ${pixelFormat === 'yuv420p' ? 'copied' : 'encoded'} orientation is applied exactly once`, async t => {
    const base = path.join(root, `orientation-${rotation}-${pixelFormat}.mp4`), input = base.replace('.mp4', '.mov');
    ffmpeg(['-f', 'lavfi', '-i', 'color=black:size=96x64:rate=10:duration=1,drawbox=x=0:y=0:w=30:h=20:color=red:t=fill,drawbox=x=70:y=40:w=20:h=20:color=blue:t=fill',
      '-c:v', 'libx264', '-pix_fmt', pixelFormat, base]);
    ffmpeg(['-display_rotation', String(rotation), '-i', base, '-c', 'copy', input]);
    const context = await intake(t, input);
    assert.equal(context.workspace.inspection.video.rotationDegrees, rotation);
    const output = await convert(context, 'broad-compatibility-mp4');
    const frame = file => ffmpeg([...localMediaInputArgs(), '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    const originalFrame = frame(input), outputFrame = frame(output.file);
    assert.equal(originalFrame.length, outputFrame.length);
    const error = originalFrame.reduce((sum, value, index) => sum + Math.abs(value - outputFrame[index]), 0) / originalFrame.length;
    assert.ok(error < 5, `asymmetric displayed frame differs by ${error}`);
    assert.equal(output.inspection.video.rotationDegrees || 0, pixelFormat === 'yuv420p' ? rotation : 0);
  });
}

test('odd source dimensions are minimally padded without losing source pixels', async t => {
  const input = path.join(root, 'odd.mkv');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=95x63:rate=10:duration=1', '-c:v', 'ffv1', '-pix_fmt', 'bgr0', input]);
  const output = await convert(await intake(t, input), 'broad-compatibility-mp4');
  assert.equal(output.inspection.video.width, 96); assert.equal(output.inspection.video.height, 64);
  assert.match(output.plan.changes.join(' '), /no source pixels are cropped/);
});

test('MP3 extraction preserves a timestamp gap in the selected source audio', async t => {
  const input = path.join(root, 'mp3-gap.mkv');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=3',
    '-af', 'aselect=not(between(t\\,1\\,1.5))', '-c:a', 'libmp3lame', '-q:a', '0', input]);
  const output = await convert(await intake(t, input), 'mp3');
  const samples = pcm(output.file);
  assert.ok(rms(samples, 0.1, 0.4) > 0.05);
  assert.ok(rms(samples, 1.15, 1.4) < 0.001);
  assert.ok(rms(samples, 1.7, 2.0) > 0.05);
});

test('real conversion cancellation stops the owned process, removes partial output, and permits retry', async t => {
  const input = path.join(root, 'cancellation.mkv');
  ffmpeg(['-i', path.join(root, 'base.mp4'), '-c:v', 'ffv1', '-c:a', 'pcm_s16le', input]);
  let slow = true, observed;
  const spawned = new Promise(resolve => { observed = resolve; });
  const context = await intake(t, input, { spawnProcess(command, args, options) {
    // Pace this tiny source only in the test so cancellation cannot lose a race
    // against a completed encode. All mapping/filters/output remain production.
    const paced = args.slice();
    if (command === 'ffmpeg' && slow) paced.splice(paced.indexOf('-i'), 0, '-re');
    const child = spawn(command, paced, options);
    if (command === 'ffmpeg' && slow) child.stdout.once('data', () => observed(child));
    return child;
  } });
  const { manager, workspace } = context;
  const plan = await manager.conversions.plan(workspace.id, workspace.sourceAssetId, 'broad-compatibility-mp4');
  await manager.conversions.start({ workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, targetId: plan.targetId, planKey: plan.key });
  const child = await spawned;
  await manager.conversions.cancel(workspace.id); await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'cancelled'); assert.ok(child.exitCode != null || child.signalCode != null);
  assert.equal(workspace.activeOperation, null); assert.equal(workspace.conversion.output, null);
  assert.ok(!(await fsp.readdir(workspace.tempDir)).some(name => name.startsWith('converted-')));
  slow = false; await convert(context, plan.targetId);
  assert.equal(workspace.conversion.status, 'ready');
});

test('real file-size-limited partial conversion cannot replace a previous successful result', async t => {
  const input = path.join(root, 'size-limit.mkv');
  ffmpeg(['-i', path.join(root, 'base.mp4'), '-c:v', 'ffv1', '-c:a', 'pcm_s16le', input]);
  const context = await intake(t, input);
  await convert(context, 'broad-compatibility-mp4');
  const { manager, workspace } = context, previous = workspace.conversion.output;
  manager.maxConvertedBytes = 1024;
  const plan = await manager.conversions.plan(workspace.id, workspace.sourceAssetId, previous.targetId);
  await manager.conversions.start({ workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, targetId: plan.targetId, planKey: plan.key });
  await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'failed'); assert.equal(workspace.conversion.output, previous);
  assert.ok(manager.conversions.resolve(workspace.id, previous.assetId));
  assert.ok(!(await fsp.readdir(workspace.tempDir)).some(name => name.includes('.partial.')));
});

test('conversion retains audio beyond the selected video endpoint without shortest truncation', async t => {
  const input = path.join(root, 'longer-audio.mkv');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=20:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=3', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', input]);
  const result = await convert(await intake(t, input), 'broad-compatibility-mp4');
  assert.ok(Math.abs(result.inspection.durationSeconds - 3) < 0.06);
  assert.ok(Math.abs(result.inspection.video.durationSeconds - 2) < 0.06);
  assert.ok(rms(pcm(result.file), 2.5, 2.8) > 0.05);
});
