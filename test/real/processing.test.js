'use strict';

// Required production-pipeline regressions: generated local media, real tools,
// and decoded markers. A missing FFmpeg/FFprobe is a failure, never a skip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createMediaWorkspaceManager } = require('../../media-workspace');
const { localMediaInputArgs } = require('../../local-media-input');

const SAMPLE_RATE = 48000;
const WIDTH = 320, HEIGHT = 180, FPS = 20, DURATION = 5;
const CUTS = [[0, 1.5], [3, 5]];
const H264 = { videoCodec: 'h264', container: 'mp4', audio: { codec: 'aac' } };
let root;

function run(command, args) {
  return execFileSync(command, args, { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
}
function ffmpeg(args) { return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); }
function probe(file, frames = false) {
  return JSON.parse(run('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-show_format', '-show_streams',
    ...(frames ? ['-show_frames'] : []), '-of', 'json', file]));
}
function editPlan(pairs) { return { version: 1, keepRanges: pairs.map(([startSeconds, endSeconds]) => ({ startSeconds, endSeconds })) }; }
function retained(pairs) { return pairs.reduce((sum, [start, end]) => sum + end - start, 0); }
function option(args, name) { return args.includes(name) ? args[args.indexOf(name) + 1] : null; }
function assertPassPair(first, second) {
  assert.deepEqual([first, second].map(call => option(call.args, '-pass')), ['1', '2']);
  assert.equal(option(first.args, '-passlogfile'), option(second.args, '-passlogfile'));
  assert.equal(option(first.args, '-b:v'), option(second.args, '-b:v'));
  const firstGraph = option(first.args, '-filter_complex'), secondGraph = option(second.args, '-filter_complex');
  assert.ok(firstGraph, 'analysis pass runs the authoritative video transforms');
  for (const chain of firstGraph.split(';')) {
    assert.ok(secondGraph.split(';').includes(chain), 'both passes apply the exact same original-source video filter chains');
  }
}
function decodeAudio(file) {
  const inputArgs = localMediaInputArgs({ formatNames: probe(file).format.format_name.split(',') });
  return ffmpeg(['-copyts', '-start_at_zero', ...inputArgs, '-i', file, '-map', '0:a:0',
    '-af', 'aresample=async=1:first_pts=0:min_hard_comp=0.001', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1']);
}
function decodeVideo(file) {
  const inputArgs = localMediaInputArgs({ formatNames: probe(file).format.format_name.split(',') });
  return ffmpeg([...inputArgs, '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
}
function audioWindow(bytes, start, end) {
  const first = Math.round(start * SAMPLE_RATE), last = Math.round(end * SAMPLE_RATE);
  assert.ok(last * 4 <= bytes.length, `audio covers ${start.toFixed(3)}–${end.toFixed(3)} seconds`);
  let sum = 0, crossings = 0;
  for (let i = first; i < last; i++) {
    const sample = bytes.readFloatLE(i * 4);
    sum += sample * sample;
    if (i > first && bytes.readFloatLE((i - 1) * 4) <= 0 && sample > 0) crossings++;
  }
  return { rms: Math.sqrt(sum / (last - first)), frequency: crossings / (end - start) };
}

async function intake(t, name, options = {}) {
  const calls = [];
  const manager = createMediaWorkspaceManager({ tempDir: root, spawnProcess(command, args, childOptions) {
    assert.equal(childOptions.shell, false);
    assert.equal(childOptions.windowsHide, true);
    assert.ok(args.includes('-format_whitelist'));
    assert.equal(option(args, '-protocol_whitelist'), 'file');
    calls.push({ command, args: [...args] });
    const child = spawn(command, args, childOptions);
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-8192); });
    child.once('close', code => { if (code) console.log(diagnostics); });
    const timer = setTimeout(() => child.kill(), 30000);
    child.once('close', () => clearTimeout(timer));
    return child;
  }, ...options });
  t.after(() => manager.clearAll());
  const workspace = await manager.receiveLocalStream(fs.createReadStream(path.join(root, name)), { displayName: name, purpose: 'local' });
  await workspace.activePromise;
  assert.equal(workspace.status, 'ready', JSON.stringify(workspace.failure));
  assert.equal(workspace.playbackAssetId, null, 'processing does not require an editor proxy');
  return { manager, workspace, calls, revision: 0 };
}

async function planned(context, settings = {}, pairs) {
  const { manager, workspace } = context;
  const request = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision: ++context.revision,
    editPlan: editPlan(pairs || [[0, workspace.inspection.durationSeconds]]), settings };
  const plan = await manager.processing.plan(request);
  assert.ok(['executable', 'no-op'].includes(plan.status), JSON.stringify(plan));
  return { plan, request: { ...request, planKey: plan.key, acknowledgedWarnings: plan.warnings.map(warning => warning.id) } };
}

async function processFile(context, settings = {}, pairs) {
  const { manager, workspace, calls } = context;
  const admission = await planned(context, settings, pairs), firstCall = calls.length;
  await manager.processing.start(admission.request);
  await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'ready', JSON.stringify(workspace.conversion.failure));
  const result = workspace.conversion.output;
  const resolved = manager.conversions.resolve(workspace.id, result.assetId);
  assert.ok(resolved, 'final result is downloadable through the existing owned-file authority');
  assert.equal(result.provenance.inputAssetId, workspace.sourceAssetId);
  assert.equal(result.provenance.inputRole, 'source');
  assert.equal(workspace.render.outputAssetId, null, 'no edited H.264 intermediate is published');
  assert.ok(![...workspace.assets.values()].some(asset => asset.role === 'edited-output'));
  const processingCalls = calls.slice(firstCall).filter(call => call.command === 'ffmpeg');
  for (const call of processingCalls) {
    assert.equal(option(call.args, '-i'), workspace.assets.get(workspace.sourceAssetId).filePath, 'every pass reads the original');
    assert.equal(call.args.filter(value => value === '-i').length, 1, 'no hidden intermediate input');
    assert.equal(call.args.includes('-fs'), false, 'a truncated file cannot satisfy a size target');
  }
  assert.ok(!(await fsp.readdir(workspace.tempDir)).some(name => /edited-|^processing-|\.partial\.|pass.*\.log/.test(name)), 'attempt media and pass logs are cleaned');
  return { ...admission, file: resolved.asset.filePath, inspection: result.inspection, result, calls: processingCalls };
}

function assertAudioMarkers(file, pairs, { delay = 0, end = DURATION, gap = false } = {}) {
  const bytes = decodeAudio(file);
  let outputOffset = 0, checked = 0;
  for (const [start, finish] of pairs) {
    for (let local = 0.08; local + 0.1 < finish - start; local += 0.14) {
      const sourceStart = start + local, sourceEnd = sourceStart + 0.08, middle = (sourceStart + sourceEnd) / 2;
      const boundaries = [delay, end, 0, 1, 2, 3, 4, 5, ...(gap ? [2, 2.5] : [])];
      if (boundaries.some(edge => edge > sourceStart - 0.03 && edge < sourceEnd + 0.03)) continue;
      const silent = middle < delay || middle >= end || (gap && middle >= 2 && middle < 2.5);
      const actual = audioWindow(bytes, outputOffset + local, outputOffset + local + 0.08);
      assert.ok(silent ? actual.rms < 0.002 : actual.rms > 0.04, `source ${middle.toFixed(3)}s: expected ${silent ? 'silence' : 'tone'}, RMS ${actual.rms}`);
      if (!silent) assert.ok(Math.abs(actual.frequency - (400 + 200 * Math.floor(middle))) < 20, `chronological audio marker at source ${middle.toFixed(3)}s: ${actual.frequency} Hz`);
      checked++;
    }
    outputOffset += finish - start;
  }
  assert.ok(checked >= pairs.length * 2, 'multiple marker windows per retained range');
}

function assertVideoMarkers(file, pairs, { width = WIDTH, height = HEIGHT, fps = FPS } = {}) {
  const raw = probe(file, true), stream = raw.streams.find(item => item.codec_type === 'video');
  assert.equal(stream.codec_name, 'h264');
  assert.equal(stream.width, width); assert.equal(stream.height, height);
  const frames = raw.frames.filter(frame => frame.media_type === 'video'), pixels = decodeVideo(file);
  assert.equal(pixels.length, frames.length * width * height);
  const duration = retained(pairs), tolerance = Math.max(0.06, 1 / fps + 0.01);
  assert.ok(Math.abs(Number(raw.format.duration) - duration) <= tolerance, `complete retained duration: ${raw.format.duration} vs ${duration}`);
  assert.ok(Math.abs(frames.length - duration * fps) <= 1, 'cadence reduction preserves playback duration');
  let checked = 0;
  for (let index = 0; index < frames.length; index++) {
    const pts = Number(frames[index].best_effort_timestamp_time);
    assert.ok(Math.abs(pts - index / fps) <= 0.002, `frame ${index} stays on the output clock`);
    let offset = 0, sourceTime = null;
    for (const [start, end] of pairs) {
      if (pts < offset + end - start - 1e-7) { sourceTime = start + pts - offset; break; }
      offset += end - start;
    }
    if (sourceTime === null || Math.abs(sourceTime - Math.round(sourceTime)) < 0.06) continue;
    // The source's neutral corner uses limited-range luma 32+32*floor(T).
    // Gray decoding expands it to full range; sample well inside the scaled box.
    const expected = Math.round((32 + 32 * Math.floor(sourceTime) - 16) * 255 / 219);
    const pixel = pixels[index * width * height + 4 * width + 4];
    assert.ok(Math.abs(pixel - expected) <= 10, `frame ${index} shows retained source section ${Math.floor(sourceTime)}: ${pixel} vs ${expected}`);
    checked++;
  }
  assert.ok(checked > pairs.length * 2);
  return raw;
}

function generateMarkers(name, { compressed = false, audio = true, delay = 0, audioEnd = DURATION, gap = false, videoGap = false, offset = 0 } = {}) {
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}`];
  if (audio) args.push('-f', 'lavfi', '-i', `aevalsrc=0.125*sin(2*PI*(400+200*floor(t))*t):s=${SAMPLE_RATE}:d=${DURATION}:n=480`);
  args.push('-map', '0:v', '-vf', "geq=lum='if(lt(X,32)*lt(Y,24),32+32*floor(T),lum(X,Y))':cb='if(lt(X,16)*lt(Y,12),128,cb(X,Y))':cr='if(lt(X,16)*lt(Y,12),128,cr(X,Y))'"
    + (videoGap ? ",select='lt(t,1)+gte(t,1.5)'" : ''), '-fps_mode', 'passthrough',
    '-c:v', compressed ? 'libx264' : 'ffv1', '-pix_fmt', 'yuv420p');
  if (compressed) args.push('-crf', '0', '-preset', 'ultrafast');
  if (audio) args.push('-map', '1:a', '-af', `atrim=start=${delay}:end=${audioEnd}${gap ? ",aselect='lt(t,2)+gte(t,2.5)'" : ''}`,
    '-c:a', compressed ? 'aac' : 'pcm_s16le');
  args.push('-output_ts_offset', String(offset), path.join(root, name));
  ffmpeg(args);
}

test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-processing-real-'));
  console.log(run('ffmpeg', ['-version']).toString().split(/\r?\n/)[0]); run('ffprobe', ['-version']);
  generateMarkers('sections.mkv');
  generateMarkers('compressed.mp4', { compressed: true });
  generateMarkers('silent.mkv', { audio: false });
  generateMarkers('timing.mkv', { delay: 0.5, audioEnd: 4, gap: true, offset: 1 });
  generateMarkers('video-gap.mkv', { videoGap: true });
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=390x520:rate=20:duration=1', '-c:v', 'ffv1', path.join(root, 'portrait.mkv')]);
  ffmpeg(['-i', path.join(root, 'sections.mkv'), '-vn', '-c:a', 'pcm_s16le', path.join(root, 'audio.wav')]);
});
test.after(async () => { if (root) await fsp.rm(root, { recursive: true, force: true }); });

test('complete processing defaults authorize identical source bytes with no encoding or disk copy', async t => {
  const context = await intake(t, 'compressed.mp4'), before = await fsp.readdir(context.workspace.tempDir);
  const output = await processFile(context);
  assert.equal(output.plan.status, 'no-op'); assert.equal(output.calls.length, 0);
  assert.equal(output.file, context.workspace.assets.get(context.workspace.sourceAssetId).filePath);
  assert.deepEqual(await fsp.readFile(output.file), await fsp.readFile(path.join(root, 'compressed.mp4')));
  assert.deepEqual(await fsp.readdir(context.workspace.tempDir), before);
  assert.equal(context.workspace.assets.size, 1);
});

for (const container of ['mov', 'matroska']) {
  test(`compatible ${container} container change remuxes original packet payloads without an encoder`, async t => {
    const context = await intake(t, 'compressed.mp4');
    const output = await processFile(context, { container });
    assert.deepEqual(output.plan.streams.map(stream => stream.action), ['copy', 'copy']);
    assert.equal(output.calls.length, 1);
    const hashes = (file, role) => JSON.parse(run('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-select_streams', role,
      '-show_packets', '-show_data_hash', 'sha256', '-of', 'json', file])).packets.map(packet => packet.data_hash);
    for (const role of ['v', 'a']) assert.deepEqual(hashes(output.file, role), hashes(path.join(root, 'compressed.mp4'), role));
    assert.ok(Math.abs(output.inspection.durationSeconds - DURATION) <= 0.06);
  });
}

test('original sections are cut, scaled and encoded directly into one H.264 result', async t => {
  const context = await intake(t, 'sections.mkv');
  const output = await processFile(context, { ...H264, scale: { mode: 'fit', width: 160, height: 90 },
    rate: { mode: 'bitrate', videoKbps: 90 } }, CUTS);
  assert.equal(output.calls.length, 1);
  assert.equal(output.plan.timing.durationSeconds, 3.5);
  assertVideoMarkers(output.file, CUTS, { width: 160, height: 90 });
  assertAudioMarkers(output.file, CUTS);
});

test('unchanged H.264 codec with requested quality produces smaller re-encoded H.264', async t => {
  const context = await intake(t, 'compressed.mp4');
  const output = await processFile(context, { rate: { mode: 'quality', crf: 30, preset: 'medium' } });
  assert.equal(output.calls.length, 1); assert.equal(output.inspection.video.codec, 'h264');
  assert.equal(option(output.calls[0].args, '-c:v'), 'libx264');
  assert.ok(output.result.size < context.workspace.assets.get(context.workspace.sourceAssetId).size * 0.7, 'requested compression materially reduces bytes');
  assertVideoMarkers(output.file, [[0, DURATION]]);
  assertAudioMarkers(output.file, [[0, DURATION]]);
});

test('portrait fit preserves aspect ratio with even dimensions and no default upscaling', async t => {
  const context = await intake(t, 'portrait.mkv');
  const fit = await processFile(context, { ...H264, audio: { codec: 'unchanged' }, scale: { mode: 'fit', width: 854, height: 480 } });
  assert.equal(fit.inspection.video.width, 360); assert.equal(fit.inspection.video.height, 480);
  const noUpscale = await processFile(context, { ...H264, audio: { codec: 'unchanged' }, scale: { mode: 'fit', width: 1920, height: 1080 } });
  assert.equal(noUpscale.inspection.video.width, 390); assert.equal(noUpscale.inspection.video.height, 520);
  assert.ok(Math.abs(noUpscale.inspection.durationSeconds - 1) <= 0.06);
});

test('explicit frame-rate reduction keeps the cut duration and chronological markers', async t => {
  const output = await processFile(await intake(t, 'sections.mkv'), { ...H264, frameRate: 10 }, CUTS);
  const raw = assertVideoMarkers(output.file, CUTS, { fps: 10 });
  assert.equal(raw.streams.find(stream => stream.codec_type === 'video').avg_frame_rate, '10/1');
  assertAudioMarkers(output.file, CUTS);
});

test('average bitrate uses real two-pass encoding and preserves complete media', async t => {
  const context = await intake(t, 'compressed.mp4');
  const output = await processFile(context, { rate: { mode: 'bitrate', videoKbps: 90, twoPass: true } });
  assert.deepEqual(output.calls.map(call => option(call.args, '-pass')), ['1', '2']);
  assertPassPair(...output.calls);
  const packets = JSON.parse(run('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-select_streams', 'v', '-show_packets', '-of', 'json', output.file])).packets;
  const kbps = packets.reduce((sum, packet) => sum + Number(packet.size), 0) * 8 / DURATION / 1000;
  assert.ok(kbps >= 90 * 0.65 && kbps <= 90 * 1.3, `measured average video bitrate ${kbps.toFixed(1)} kbps`);
  assertVideoMarkers(output.file, [[0, DURATION]]); assertAudioMarkers(output.file, [[0, DURATION]]);
  console.log(JSON.stringify({ processingAverageVideoKbps: kbps, requestedKbps: 90, bytes: output.result.size }));
});

test('maximum file size budgets the retained duration and publishes a complete fitting result', async t => {
  const context = await intake(t, 'compressed.mp4');
  const output = await processFile(context, { audio: { codec: 'aac', bitrateKbps: 64 }, rate: { mode: 'size', maximumMB: 0.1 } }, CUTS);
  assert.equal(output.plan.timing.durationSeconds, 3.5);
  assert.equal(output.plan.passes, 2);
  assert.ok(output.calls.length === 2 || output.calls.length === 4, 'at most one corrective two-pass retry');
  assert.ok(output.result.size <= output.plan.rateBudget.maximumBytes);
  assert.equal((await fsp.stat(output.file)).size, output.result.size, 'actual bytes are checked');
  assertVideoMarkers(output.file, CUTS); assertAudioMarkers(output.file, CUTS);
  for (let i = 0; i < output.calls.length; i += 2) {
    assertPassPair(output.calls[i], output.calls[i + 1]);
  }
  console.log(JSON.stringify({ processingMaximumBytes: output.plan.rateBudget.maximumBytes, actualBytes: output.result.size,
    retainedDuration: output.inspection.durationSeconds, sourceDuration: context.workspace.inspection.durationSeconds, passes: output.calls.length }));
});

test('actual oversized valid files get one corrective retry then fail while preserving the previous result', async t => {
  const context = await intake(t, 'compressed.mp4'), { manager, workspace, calls } = context;
  const previous = await processFile(context, { rate: { mode: 'quality', crf: 24 } }, CUTS);
  const runOwnedProcess = manager.runOwnedProcess.bind(manager), padded = [];
  let markerFailure;
  manager.runOwnedProcess = async (...args) => {
    const result = await runOwnedProcess(...args);
    const commandArgs = args[2];
    if (args[1] === 'ffmpeg' && option(commandArgs, '-pass') === '2') {
      // MP4 permits trailing bytes. Pad the actual completed file, without
      // falsifying stat/probe evidence or substituting a fake encoder result.
      const outputPath = commandArgs.at(-1);
      const encodedSize = (await fsp.stat(outputPath)).size;
      await fsp.appendFile(outputPath, Buffer.alloc(Math.max(1, 120000 - encodedSize)));
      try { assertVideoMarkers(outputPath, CUTS); assertAudioMarkers(outputPath, CUTS); }
      catch (error) { markerFailure = error; throw error; }
      padded.push(outputPath);
    }
    return result;
  };
  const admission = await planned(context, { audio: { codec: 'aac', bitrateKbps: 64 }, rate: { mode: 'size', maximumMB: 0.1 } }, CUTS), firstCall = calls.length;
  await manager.processing.start(admission.request); await workspace.activePromise;
  if (markerFailure) throw markerFailure;
  assert.equal(workspace.conversion.status, 'failed');
  assert.match(JSON.stringify(workspace.conversion.failure), /size|limit|maximum|fit/i);
  assert.equal(workspace.conversion.output, previous.result, 'failed retry cannot replace a successful result');
  assert.ok(manager.conversions.resolve(workspace.id, previous.result.assetId));
  const attempts = calls.slice(firstCall).filter(call => call.command === 'ffmpeg');
  assert.deepEqual(attempts.map(call => option(call.args, '-pass')), ['1', '2', '1', '2']);
  assertPassPair(attempts[0], attempts[1]); assertPassPair(attempts[2], attempts[3]);
  assert.equal(padded.length, 2, 'only one bounded retry');
  for (const call of attempts) {
    assert.equal(option(call.args, '-i'), workspace.assets.get(workspace.sourceAssetId).filePath);
    assert.equal(call.args.includes('-fs'), false);
  }
  assert.ok(Number(option(attempts[2].args, '-b:v')) < Number(option(attempts[0].args, '-b:v')), 'corrective retry lowers only the requested video budget');
  assert.equal(workspace.conversion.cleanupPaths.size, 0);
  assert.ok(!(await fsp.readdir(workspace.tempDir)).some(name => /^processing-|\.partial\.|pass.*\.log/.test(name)));
  for (const file of padded) await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
  assertVideoMarkers(previous.file, CUTS); assertAudioMarkers(previous.file, CUTS);
});

test('cancelling after the real first pass prevents pass two and cleans its logs before a successful retry', async t => {
  const context = await intake(t, 'compressed.mp4'), { manager, workspace, calls } = context;
  const runOwnedProcess = manager.runOwnedProcess.bind(manager);
  let cancellation;
  manager.runOwnedProcess = async (...args) => {
    const result = await runOwnedProcess(...args);
    if (args[1] === 'ffmpeg' && option(args[2], '-pass') === '1') {
      // The real process has exited. Cancel at the owned boundary before the
      // production loop can admit pass two; do not await our own activePromise.
      cancellation = manager.conversions.cancel(workspace.id);
    }
    return result;
  };
  const settings = { rate: { mode: 'bitrate', videoKbps: 90, twoPass: true } };
  const admission = await planned(context, settings, CUTS), firstCall = calls.length;
  await manager.processing.start(admission.request); await workspace.activePromise; await cancellation;
  assert.equal(workspace.conversion.status, 'cancelled');
  assert.deepEqual(calls.slice(firstCall).filter(call => call.command === 'ffmpeg').map(call => option(call.args, '-pass')), ['1']);
  assert.equal(workspace.conversion.output, null); assert.equal(workspace.activeOperation, null);
  assert.equal(workspace.conversion.cleanupPaths.size, 0);
  assert.ok(!(await fsp.readdir(workspace.tempDir)).some(name => /^processing-|\.partial\.|pass.*\.log/.test(name)));
  manager.runOwnedProcess = runOwnedProcess;
  const retried = await processFile(context, settings, CUTS);
  assertVideoMarkers(retried.file, CUTS); assertAudioMarkers(retried.file, CUTS);
});

test('cuts and compression preserve shifted source origin, delayed audio, gaps and a silent tail', async t => {
  const context = await intake(t, 'timing.mkv'), original = probe(path.join(root, 'timing.mkv'), true);
  const audioFrames = original.frames.filter(frame => frame.media_type === 'audio');
  assert.ok(Math.abs(Number(original.frames.find(frame => frame.media_type === 'video').pts_time) - 1) <= 0.002);
  assert.ok(Math.abs(Number(audioFrames[0].pts_time) - 1.5) <= 0.002);
  assert.ok(audioFrames.some((frame, index) => index > 0 && Number(frame.pts_time) - Number(audioFrames[index - 1].pts_time) > 0.49), 'fixture contains a timestamp gap');
  const pairs = [[0, 2.7], [3, 5]];
  const output = await processFile(context, { ...H264, rate: { mode: 'quality', crf: 23 } }, pairs);
  assertVideoMarkers(output.file, pairs);
  assertAudioMarkers(output.file, pairs, { delay: 0.5, end: 4, gap: true });
});

test('silent video cuts and compression never invent an audio stream', async t => {
  const output = await processFile(await intake(t, 'silent.mkv'), { ...H264, audio: { codec: 'unchanged' }, rate: { mode: 'quality', crf: 23 } }, CUTS);
  assert.equal(output.inspection.audio, null); assertVideoMarkers(output.file, CUTS);
});

test('unchanged cadence preserves every retained video frame and its internal timestamp gap', async t => {
  const input = path.join(root, 'video-gap.mkv'), original = probe(input, true);
  const sourceFrames = original.frames.filter(frame => frame.media_type === 'video'), sourcePixels = decodeVideo(input);
  assert.ok(sourceFrames.some((frame, index) => index > 0
    && Number(frame.pts_time) - Number(sourceFrames[index - 1].pts_time) > 0.5), 'the source contains an actual video timestamp gap');
  const output = await processFile(await intake(t, 'video-gap.mkv'), H264, CUTS);
  const actual = probe(output.file, true), frames = actual.frames.filter(frame => frame.media_type === 'video'), pixels = decodeVideo(output.file);
  const expected = [];
  let offset = 0;
  for (const [start, end] of CUTS) {
    sourceFrames.forEach((frame, index) => {
      const time = Number(frame.pts_time);
      if (time >= start && time < end) expected.push({ time: offset + time - start, index });
    });
    offset += end - start;
  }
  assert.equal(frames.length, expected.length, 'no retained frames dropped or invented to fill the gap');
  assert.equal(pixels.length, frames.length * WIDTH * HEIGHT);
  frames.forEach((frame, index) => {
    assert.ok(Math.abs(Number(frame.pts_time) - expected[index].time) <= 0.002, `retained frame ${index} stays on the source clock`);
    const actualPixel = pixels[index * WIDTH * HEIGHT + 4 * WIDTH + 4];
    const sourcePixel = sourcePixels[expected[index].index * WIDTH * HEIGHT + 4 * WIDTH + 4];
    assert.ok(Math.abs(actualPixel - sourcePixel) <= 10, `retained frame ${index} has the corresponding source marker`);
  });
  assert.ok(Math.abs(output.inspection.durationSeconds - retained(CUTS)) <= 0.06);
  assertAudioMarkers(output.file, CUTS);
});

for (const [container, format] of [['mp4', 'mp4'], ['mov', 'mov'], ['matroska', 'matroska']]) {
  test(`direct cut and H.264 encoding creates supported ${container} output`, async t => {
    const output = await processFile(await intake(t, 'sections.mkv'), { ...H264, container }, CUTS);
    const raw = assertVideoMarkers(output.file, CUTS);
    assert.ok(raw.format.format_name.split(',').includes(format)); assertAudioMarkers(output.file, CUTS);
  });
}

for (const [container, codec] of [['m4a', 'aac'], ['mp3', 'mp3']]) {
  test(`audio-only input still converts through unified processing to ${container}`, async t => {
    const output = await processFile(await intake(t, 'audio.wav'), { container, audio: { codec } });
    assert.equal(output.inspection.video, null); assert.equal(output.inspection.audio.codec, codec);
    assert.ok(Math.abs(output.inspection.durationSeconds - DURATION) <= 0.06);
    assertAudioMarkers(output.file, [[0, DURATION]]);
  });
  test(`video cuts convert directly from the original source into ${container} with retained audio markers`, async t => {
    const output = await processFile(await intake(t, 'sections.mkv'), { container, audio: { codec } }, CUTS);
    assert.equal(output.inspection.video, null); assert.equal(output.inspection.audio.codec, codec);
    assert.ok(Math.abs(output.inspection.durationSeconds - retained(CUTS)) <= 0.06);
    assert.equal(output.calls.length, 1);
    assertAudioMarkers(output.file, CUTS);
  });
}
