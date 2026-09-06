'use strict';

// Required real-tool regressions. No providers, binary fixtures, or tool skips.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { localMediaInputArgs } = require('../../local-media-input');
const { createMediaWorkspaceManager, normalizeInspection, totalRetainedDuration } = require('../../media-workspace');

const RATE = 48000;
const WIDTH = 160, HEIGHT = 90;
// Source video is 20 fps. Output PTS must map within 2 ms, independently of
// that 50 ms frame spacing. Duration allows one final frame plus 10 ms.
const PTS_TOLERANCE = 0.002;
const DURATION_TOLERANCE = 0.06;
// AAC uses 1024-sample (21.33 ms) frames. Ignore 30 ms around marker/cut
// boundaries; do not allow a half-second displacement to pass.
const AUDIO_EDGE_TOLERANCE = 0.03;

function run(command, args) {
  return execFileSync(command, args, { windowsHide: true, shell: false, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
}

function probe(file, frames = false) {
  return JSON.parse(run('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-show_format', '-show_streams',
    ...(frames ? ['-show_frames'] : []), '-of', 'json', file]));
}

function decode(file, audio) {
  // Decode on the FILE's presentation timeline. Explicitly fill timestamped
  // audio gaps so raw PCM byte zero does not silently mean first audio packet.
  return run('ffmpeg', ['-v', 'error', ...localMediaInputArgs(normalizeInspection(probe(file))), '-i', file,
    ...(audio ? ['-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(RATE), '-f', 'f32le']
      : ['-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo']), 'pipe:1']);
}

function rms(bytes, start, end) {
  let sum = 0;
  const first = Math.round(start * RATE), last = Math.round(end * RATE);
  assert.ok(last * 4 <= bytes.length, `audio covers ${start}–${end}`);
  for (let i = first; i < last; i++) sum += bytes.readFloatLE(i * 4) ** 2;
  return Math.sqrt(sum / (last - first));
}

function frequency(bytes, start, end) {
  let crossings = 0;
  const first = Math.round(start * RATE), last = Math.round(end * RATE);
  for (let i = first + 1; i < last; i++) {
    if (bytes.readFloatLE((i - 1) * 4) <= 0 && bytes.readFloatLE(i * 4) > 0) crossings++;
  }
  return crossings / (end - start);
}

async function fixture(t, options = {}) {
  const { audio = true, delay = 0.5, audioEnd = 5, offset = 0, extension = 'mkv', gap = false, videoGap = false, rate = '20' } = options;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-av-timing-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, `markers.${extension}`);
  const compressed = extension !== 'mkv';
  const args = ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:size=${WIDTH}x${HEIGHT}:rate=${rate}:duration=5`];
  if (audio) args.push('-f', 'lavfi', '-i', 'aevalsrc=0.125*sin(2*PI*(400+200*floor(t))*t):s=48000:d=5:n=480');
  args.push('-map', '0:v', '-vf', `geq=lum='32+32*floor(T)':cb=128:cr=128${videoGap ? ",select='lt(t,1)+gte(t,1.5)'" : ''}`,
    '-fps_mode:v', 'passthrough', '-c:v', compressed ? 'libx264' : 'ffv1');
  if (compressed) args.push('-bf', '0', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-map', '1:a', '-af', `atrim=start=${delay}:end=${audioEnd}${gap ? ",aselect='lt(t,2)+gte(t,2.5)'" : ''}`,
    '-c:a', compressed ? 'aac' : 'pcm_s16le');
  if (extension === 'ts') args.push('-mpegts_copyts', '1', '-muxdelay', '0');
  args.push('-output_ts_offset', String(offset), file);
  run('ffmpeg', args);

  // Inspect actual generated timestamps, including codec priming, before
  // deriving expected output. The lossless fixture has exact 10 ms audio blocks.
  const raw = probe(file, true);
  const origin = Number(raw.format.start_time);
  const videos = raw.frames.filter(frame => frame.media_type === 'video');
  const audios = raw.frames.filter(frame => frame.media_type === 'audio');
  const firstVideo = Number(videos[0].pts_time);
  const firstAudio = audio ? Number(audios[0].pts_time) : null;
  assert.ok(Math.abs(firstVideo - offset) < PTS_TOLERANCE);
  if (audio) assert.ok(Math.abs(firstAudio - offset - delay) < (compressed ? AUDIO_EDGE_TOLERANCE : 0.001));
  if (audio) {
    const lastAudio = audios.at(-1);
    const audioSampleRate = Number(raw.streams.find(stream => stream.codec_type === 'audio').sample_rate);
    const actualAudioEnd = Number(lastAudio.pts_time) + Number(lastAudio.nb_samples) / audioSampleRate;
    assert.ok(Math.abs(actualAudioEnd - offset - audioEnd) < AUDIO_EDGE_TOLERANCE, 'actual source audio tail');
    if (gap) assert.ok(audios.some((frame, index) => index > 0
      && Number(frame.pts_time) - Number(audios[index - 1].pts_time) > 0.49), 'source contains a timestamp gap, not encoded silence');
  }
  const [rateNumerator, rateDenominator = 1] = rate.split('/').map(Number);
  const sourceDuration = Number(videos.at(-1).pts_time) + rateDenominator / rateNumerator - origin;
  const calls = [];
  const manager = createMediaWorkspaceManager({ tempDir: root, spawnProcess(command, childArgs, childOptions) {
    assert.equal(childOptions.shell, false);
    assert.equal(childOptions.windowsHide, true);
    assert.ok(childArgs.includes('-format_whitelist'));
    assert.equal(childArgs[childArgs.indexOf('-protocol_whitelist') + 1], 'file');
    calls.push({ command, args: childArgs });
    const child = spawn(command, childArgs, childOptions);
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    child.once('close', code => { if (code !== 0) console.log(diagnostics); });
    // Kill only this test-owned child on a stall, and let production report the
    // failed operation. A hung concat must fail the test instead of hanging CI.
    const timer = setTimeout(() => child.kill(), 20000);
    child.once('close', () => clearTimeout(timer));
    return child;
  } });
  t.after(() => manager.clearAll());
  const workspace = await manager.receiveLocalStream(fs.createReadStream(file), { displayName: `markers.${extension}` });
  await workspace.activePromise;
  assert.equal(workspace.status, 'ready', JSON.stringify(workspace.failure));
  assert.ok(Math.abs(workspace.inspection.durationSeconds - sourceDuration) < DURATION_TOLERANCE, 'editor duration uses the normalized presentation');
  if (offset) assert.equal(workspace.playbackProxy, true, 'shifted origins use normalized playback');
  const pixels = decode(file, false);
  assert.equal(pixels.length, videos.length * WIDTH * HEIGHT);
  console.log(JSON.stringify({ fixture: t.name, origin, firstVideo, firstAudio, sourceDuration }));
  return { manager, workspace, calls, origin, videos, pixels, audio, delay: delay + offset - origin,
    audioEnd: audioEnd + offset - origin, gap, markerOffset: offset - origin };
}

function assertAudioWindows(bytes, ranges, source) {
  let outputOffset = 0, checked = 0;
  for (const { startSeconds: start, endSeconds: end } of ranges) {
    // Sample many interior 80 ms windows throughout every retained section.
    for (let local = 0.08; local + 0.08 < end - start; local += 0.1) {
      const sourceStart = start + local, sourceEnd = sourceStart + 0.08;
      const edges = [source.delay, source.audioEnd, ...[0, 1, 2, 3, 4, 5].map(n => n + source.markerOffset),
        ...(source.gap ? [2 + source.markerOffset, 2.5 + source.markerOffset] : [])];
      if (edges.some(edge => edge > sourceStart - AUDIO_EDGE_TOLERANCE && edge < sourceEnd + AUDIO_EDGE_TOLERANCE)) continue;
      const middle = (sourceStart + sourceEnd) / 2;
      const silent = middle < source.delay || middle >= source.audioEnd
        || (source.gap && middle >= 2 + source.markerOffset && middle < 2.5 + source.markerOffset);
      const startOut = outputOffset + local, endOut = startOut + 0.08;
      const level = rms(bytes, startOut, endOut);
      assert.ok(silent ? level < 0.001 : level > 0.05, `sound placement at output ${startOut.toFixed(3)}: RMS ${level}, expected ${silent ? 'silence' : 'tone'}`);
      if (!silent) {
        const expectedFrequency = 400 + 200 * Math.floor(middle - source.markerOffset);
        assert.ok(Math.abs(frequency(bytes, startOut, endOut) - expectedFrequency) < 20, 'chronological audio marker');
      }
      checked++;
    }
    outputOffset += end - start;
  }
  assert.ok(checked >= ranges.length * 2, 'each fixture measures multiple audible/silent windows');
}

async function renderAndVerify(t, options, pairs) {
  const source = await fixture(t, options);
  const { manager, workspace, calls } = source;
  const plan = { version: 1, keepRanges: pairs.map(([startSeconds, endSeconds]) => ({ startSeconds, endSeconds })) };
  const callStart = calls.length;
  manager.startRender(workspace.id, plan);
  await workspace.activePromise;
  assert.equal(workspace.render.status, 'ready', JSON.stringify(workspace.render.failure));
  const output = workspace.assets.get(workspace.render.outputAssetId);
  const rendered = calls.slice(callStart).find(call => call.command === 'ffmpeg');
  assert.equal(rendered.args[rendered.args.indexOf('-i') + 1], workspace.assets.get(workspace.sourceAssetId).filePath);
  assert.ok(calls.slice(callStart).some(call => call.command === 'ffprobe'), 'production output validation runs');
  const raw = probe(output.filePath, true);
  const videoStream = raw.streams.find(stream => stream.codec_type === 'video');
  assert.equal(videoStream.codec_name, 'h264');
  assert.equal(videoStream.pix_fmt, 'yuv420p');
  assert.equal(videoStream.width, WIDTH);
  assert.equal(videoStream.height, HEIGHT);
  assert.ok(raw.format.format_name.split(',').includes('mp4'));
  assert.equal(raw.streams.some(stream => stream.codec_type === 'audio'), source.audio);
  assert.ok(Math.abs(Number(raw.format.duration) - totalRetainedDuration(plan)) < DURATION_TOLERANCE);
  const audioBytes = source.audio ? decode(output.filePath, true) : null;
  if (t.name.startsWith('A:')) {
    const windows = [[0.1, 0.4], [0.6, 1.4], [1.6, 1.9], [2.1, 3.9]].map(([start, end]) => ({ start, end, rms: rms(audioBytes, start, end) }));
    let firstSoundSeconds = null;
    for (let ms = 0; ms < 1000; ms++) {
      if (rms(audioBytes, ms / 1000, (ms + 1) / 1000) > 0.02) { firstSoundSeconds = ms / 1000; break; }
    }
    console.log(JSON.stringify({ reproduction: 'rendered', duration: raw.format.duration, firstSoundSeconds, windows }));
    assert.ok(firstSoundSeconds !== null && Math.abs(firstSoundSeconds - 0.5) < AUDIO_EDGE_TOLERANCE, 'onset retains the measured half-second delay');
  }

  // Compare EVERY retained frame's timestamp and visual marker to the actual
  // original, so offsets, source order, cadence and accumulated drift are tested.
  const expected = [];
  let offset = 0;
  for (const range of plan.keepRanges) {
    source.videos.forEach((frame, index) => {
      const time = Number(frame.pts_time) - source.origin;
      if (time >= range.startSeconds - 1e-8 && time < range.endSeconds - 1e-8) {
        expected.push({ time: offset + time - range.startSeconds, pixel: source.pixels[index * WIDTH * HEIGHT] });
      }
    });
    offset += range.endSeconds - range.startSeconds;
  }
  const frames = raw.frames.filter(frame => frame.media_type === 'video');
  const pixels = decode(output.filePath, false);
  assert.equal(frames.length, expected.length, 'no imposed FPS or dropped retained frames');
  assert.equal(pixels.length, frames.length * WIDTH * HEIGHT);
  let maxPtsError = 0;
  frames.forEach((frame, index) => {
    const error = Math.abs(Number(frame.pts_time) - expected[index].time);
    maxPtsError = Math.max(maxPtsError, error);
    assert.ok(error <= PTS_TOLERANCE, `frame ${index} mapped PTS error ${error}`);
    assert.ok(Math.abs(pixels[index * WIDTH * HEIGHT] - expected[index].pixel) <= 3, `frame ${index} chronological visual marker`);
  });
  if (source.audio) {
    assert.equal(raw.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
    assertAudioWindows(audioBytes, plan.keepRanges, source);
    // Also check the player asset's audio on the same presentation timeline.
    const playback = workspace.assets.get(workspace.playbackAssetId);
    assertAudioWindows(decode(playback.filePath, true), [{ startSeconds: 0, endSeconds: Math.min(4.8, source.audioEnd) }], source);
  }
  console.log(JSON.stringify({ output: t.name, duration: raw.format.duration, frames: frames.length, maxPtsError }));
  return source;
}

const TWO = [[0, 2], [3, 5]];
for (const [name, options, ranges] of [
  ['A: original delayed-audio reproduction', {}, TWO],
  ['B: ordinary aligned audio/video', { delay: 0 }, TWO],
  ['C: single range retains its audio offset', {}, [[0.2, 2.2]]],
  ['C: single range before any audio', { delay: 2.5 }, [[0, 1]]],
  ['C: single range with missing audio tail', { audioEnd: 1 }, [[0.2, 2.2]]],
  ['D: shifted lossless Matroska origin', { offset: 7 }, TWO],
  ['D: shifted H.264/AAC MP4 origin', { offset: 7, extension: 'mp4' }, TWO],
  ['D: shifted MPEG-TS origin', { offset: 7, extension: 'ts' }, TWO],
  ['E: retained section has no audio frames', { delay: 2.5 }, [[0, 1], [2, 4]]],
  ['F: audio ends early, including an entirely silent final section', { audioEnd: 1 }, TWO],
  ['G: four ranges between frame boundaries do not accumulate drift', {}, [[0.013, 0.817], [1.123, 1.927], [2.233, 3.137], [3.343, 4.847]]],
  ['H: no audio stream remains a silent MP4', { audio: false }, TWO],
  ['H: single-frame silent interval keeps its duration', { audio: false }, [[0.5, 0.55]]],
  ['timestamped interior audio gap', { gap: true }, [[0, 2.7], [3, 5]]],
  ['timestamped interior video gap', { videoGap: true }, TWO],
  ['ordinary H.264/AAC direct playback and output', { extension: 'mp4', delay: 0 }, TWO],
  ['fractional source cadence retains every mapped frame', { extension: 'mp4', rate: '30000/1001' }, TWO]
]) {
  test(name, { timeout: 60000 }, async t => renderAndVerify(t, options, ranges));
}
