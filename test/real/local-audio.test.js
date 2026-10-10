'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMediaWorkspaceManager } = require('../../media-workspace');

let root;
const rate = 44100, channels = 2, duration = 2;
const cuts = { version: 1, keepRanges: [{ startSeconds: 0.1, endSeconds: 0.5 }, { startSeconds: 1, endSeconds: 1.5 }] };
const cases = [[8, 'u8', 'pcm_u8'], [16, 's16le', 'pcm_s16le'], [24, 's24le', 'pcm_s24le'], [32, 's32le', 'pcm_s32le'], [32, 'f32le', 'pcm_f32le'], [64, 'f64le', 'pcm_f64le']];
function run(command, args) { return execFileSync(command, args, { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }); }
function ffmpeg(args) { return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]); }
function decode(file, format, codec) { return ffmpeg(['-i', file, '-map', '0:a:0', '-c:a', codec, '-f', format, 'pipe:1']); }
function selected(bytes, width) {
  return Buffer.concat(cuts.keepRanges.map(range => bytes.subarray(Math.ceil(range.startSeconds * rate) * channels * width, Math.ceil(range.endSeconds * rate) * channels * width)));
}
test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-real-audio-'));
  for (const [bits, format, codec] of cases) {
    const width = bits / 8, bytes = Buffer.alloc(rate * duration * channels * width);
    for (let i = 0; i < bytes.length / width; i++) {
      const x = Math.sin(i * 0.07) * 0.2;
      if (format === 'f64le') bytes.writeDoubleLE(x + (i % 7) * 1e-15, i * width);
      else if (format === 'f32le') bytes.writeFloatLE(x, i * width);
      else if (bits === 8) bytes.writeUInt8(Math.round(x * 127 + 128), i);
      else bytes.writeIntLE(Math.round(x * (2 ** (bits - 1) - 1)) + i % 3, i * width, width);
    }
    const raw = path.join(root, `${format}.raw`); await fsp.writeFile(raw, bytes);
    ffmpeg(['-f', format, '-ar', String(rate), '-ac', String(channels), '-i', raw, '-c:a', codec, path.join(root, `${format}.wav`)]);
  }
});
test.after(async () => { await fsp.rm(root, { recursive: true, force: true }); });
async function intake(t, name) {
  const manager = createMediaWorkspaceManager({ tempDir: root }); t.after(() => manager.clearAll());
  const workspace = await manager.receiveLocalStream(fs.createReadStream(path.join(root, name)), { purpose: 'local', displayName: name });
  await workspace.activePromise; assert.equal(workspace.status, 'ready', JSON.stringify(workspace.failure));
  return { manager, workspace };
}
async function processFile(manager, workspace, settings, editPlan = cuts, revision = 0) {
  const intent = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision: revision, settings, editPlan };
  const reviewed = await manager.processing.plan(intent); assert.equal(reviewed.status, 'executable', reviewed.message);
  await manager.processing.start({ ...intent, planKey: reviewed.key, acknowledgedWarnings: reviewed.warnings.map(w => w.id) });
  await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'ready', JSON.stringify(workspace.conversion.failure));
  const result = workspace.conversion.output;
  assert.equal(result.provenance.inputAssetId, workspace.sourceAssetId);
  return { reviewed, result, file: workspace.assets.get(result.assetId).filePath };
}

for (const [bits, format, codec] of cases) test(`WAV ${format} trimmed processing preserves every retained decoded sample`, async t => {
  const { manager, workspace } = await intake(t, `${format}.wav`);
  const source = decode(workspace.assets.get(workspace.sourceAssetId).filePath, format, codec);
  const output = await processFile(manager, workspace, { container: 'wav' });
  assert.deepEqual(decode(output.file, format, codec), selected(source, bits / 8));
  assert.equal(output.result.inspection.audio.sampleRate, rate);
  assert.equal(output.result.inspection.audio.channels, channels);
});

for (const [bits, format, codec] of cases.slice(0, 3)) test(`FLAC from ${format} preserves all retained samples and integer precision`, async t => {
  const { manager, workspace } = await intake(t, `${format}.wav`);
  const source = decode(workspace.assets.get(workspace.sourceAssetId).filePath, format, codec);
  const output = await processFile(manager, workspace, { container: 'flac' });
  assert.deepEqual(decode(output.file, format, codec), selected(source, bits / 8));
  assert.equal(output.result.inspection.audio.bitsPerRawSample, bits <= 16 ? 16 : 24);
});

test('32-bit integer and floating-point sources are refused by FLAC without losing source ownership', async t => {
  for (const name of ['s32le', 'f32le', 'f64le']) {
    const { manager, workspace } = await intake(t, `${name}.wav`);
    const reviewed = await manager.processing.plan({ workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision: 0, settings: { container: 'flac' }, editPlan: cuts });
    assert.equal(reviewed.status, 'unavailable'); assert.match(reviewed.message, /WAV/);
    assert.ok(workspace.assets.has(workspace.sourceAssetId));
  }
});

test('Opus trim output is 48 kHz with the correct decoded duration and audible retained signal', async t => {
  const { manager, workspace } = await intake(t, 's24le.wav');
  const output = await processFile(manager, workspace, { container: 'opus' });
  assert.equal(output.result.inspection.container.kind, 'ogg'); assert.equal(output.result.inspection.audio.codec, 'opus');
  assert.equal(output.result.inspection.audio.sampleRate, 48000);
  const decoded = decode(output.file, 'f32le', 'pcm_f32le');
  assert.ok(Math.abs(decoded.length / 4 / channels / 48000 - 0.9) < 0.002);
  let energy = 0; for (let i = 0; i < decoded.length; i += 4) energy += decoded.readFloatLE(i) ** 2;
  assert.ok(energy / (decoded.length / 4) > 0.005);
});

test('real audio preview and waveform use the original timeline without altering processing input', async t => {
  const { manager, workspace } = await intake(t, 's24le.wav');
  manager.prepareEditor(workspace.id, workspace.sourceAssetId); await workspace.activePromise;
  assert.equal(workspace.editor.status, 'ready', JSON.stringify(workspace.editor.failure));
  const playback = manager.publicWorkspace(workspace).playback;
  assert.equal(playback.mime, 'audio/mp4'); assert.equal(playback.proxy, true);
  manager.waveforms.start(workspace.id, workspace.sourceAssetId);
  for (let i = 0; !manager.waveforms.tasks.get(workspace.id).promise && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await manager.waveforms.tasks.get(workspace.id).promise;
  assert.equal(manager.waveforms.state(workspace).status, 'ready', manager.waveforms.state(workspace).message);
  const window = await manager.waveforms.window(workspace.id, workspace.sourceAssetId, 0, 2, 100);
  assert.equal(window.peaks.length, 100); assert.ok(window.peaks.some(([min, max]) => min < -0.1 && max > 0.1));
  const output = await processFile(manager, workspace, { container: 'flac' });
  assert.equal(output.result.provenance.inputAssetId, workspace.sourceAssetId);
});

test('MKV Opus and FLAC encodes preserve video and the selected audio layout', async t => {
  const name = 'video.mkv';
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=20:d=2', '-i', path.join(root, 's24le.wav'), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s24le', path.join(root, name)]);
  for (const codec of ['opus', 'flac']) {
    const { manager, workspace } = await intake(t, name);
    const output = await processFile(manager, workspace, { container: 'matroska', audio: { codec } }, null);
    assert.equal(output.result.inspection.audio.codec, codec); assert.equal(output.result.inspection.video.codec, 'h264');
    assert.equal(output.reviewed.streams.find(s => s.role === 'video').action, 'copy');
    assert.equal(output.result.inspection.audio.channelLayout, 'stereo');
  }
});

test('lossless outputs preserve channel order and samples across supported layouts and sample rates', async t => {
  const layouts = ['mono', 'stereo', '3.0', 'quad', '5.0', '5.1', '5.1(side)', '6.1', '7.1'];
  const counts = [1, 2, 3, 4, 5, 6, 6, 7, 8];
  const keep = { version: 1, keepRanges: [{ startSeconds: 0.05, endSeconds: 0.15 }, { startSeconds: 0.2, endSeconds: 0.3 }] };
  for (let i = 0; i < layouts.length; i++) {
    const layout = layouts[i], count = counts[i], sourceRate = [22050, 44100, 96000][i % 3];
    const frequency = channel => count >= 6 && channel === 3 ? 60 : 200 * (channel + 1);
    const expressions = Array.from({ length: count }, (_, channel) => `0.2*sin(2*PI*${frequency(channel)}*t)`).join('|');
    const name = `layout-${i}.wav`;
    ffmpeg(['-f', 'lavfi', '-i', `aevalsrc=${expressions}:s=${sourceRate}:d=0.4:c=${layout}`, '-c:a', 'pcm_s24le', path.join(root, name)]);
    const { manager, workspace } = await intake(t, name);
    const original = decode(workspace.assets.get(workspace.sourceAssetId).filePath, 's24le', 'pcm_s24le');
    const expected = Buffer.concat(keep.keepRanges.map(range => original.subarray(Math.ceil(range.startSeconds * sourceRate) * count * 3, Math.ceil(range.endSeconds * sourceRate) * count * 3)));
    let revision = 0;
    for (const container of ['flac', 'wav']) {
      const output = await processFile(manager, workspace, { container }, keep, revision++);
      assert.equal(output.result.inspection.audio.channelLayout, layout);
      assert.equal(output.result.inspection.audio.sampleRate, sourceRate);
      assert.deepEqual(decode(output.file, 's24le', 'pcm_s24le'), expected);
    }
    if (layout !== '5.1(side)') {
      const output = await processFile(manager, workspace, { container: 'opus' }, keep, revision++);
      assert.equal(output.result.inspection.audio.channelLayout, layout);
      const audio = decode(output.file, 'f32le', 'pcm_f32le');
      for (let channel = 0; channel < count; channel++) {
        let crossings = 0;
        for (let frame = 961; frame < 3840; frame++) {
          if (audio.readFloatLE(((frame - 1) * count + channel) * 4) <= 0 && audio.readFloatLE((frame * count + channel) * 4) > 0) crossings++;
        }
        assert.ok(Math.abs(crossings / 0.06 - frequency(channel)) < 35, `Opus ${layout} retains channel ${channel}: ${crossings / 0.06} Hz`);
      }
    }
  }
});

test('audio-only shifted starts exclude unrelated tracks and preserve cuts on the selected sample clock', async t => {
  const name = 'shifted-audio.mkv';
  ffmpeg(['-itsoffset', '0.5', '-i', path.join(root, 's24le.wav'), '-i', path.join(root, 's16le.wav'),
    '-map', '0:a:0', '-map', '1:a:0', '-c:a', 'pcm_s24le', '-copyts', path.join(root, name)]);
  const { manager, workspace } = await intake(t, name);
  assert.equal(manager.publicWorkspace(workspace).editor.durationSeconds, 2);
  assert.equal(manager.publicWorkspace(workspace).editor.offsetSeconds, 0.5);
  const original = decode(path.join(root, 's24le.wav'), 's24le', 'pcm_s24le');
  const output = await processFile(manager, workspace, { container: 'flac' });
  assert.deepEqual(decode(output.file, 's24le', 'pcm_s24le'), selected(original, 3));
  assert.equal(output.result.inspection.trackCounts.audio, 1);
});

test('timestamp gaps remain silent in lossless audio trimming', async t => {
  const name = 'gapped-audio.mkv';
  ffmpeg(['-i', path.join(root, 's24le.wav'), '-af', "aselect='not(between(t,0.4,0.7))'", '-c:a', 'pcm_s24le', path.join(root, name)]);
  const { manager, workspace } = await intake(t, name);
  const source = ffmpeg(['-i', path.join(root, name), '-af', 'aresample=async=1:first_pts=0:min_hard_comp=0.001,apad=whole_dur=2,atrim=end=2', '-c:a', 'pcm_s24le', '-f', 's24le', 'pipe:1']);
  const output = await processFile(manager, workspace, { container: 'flac' });
  assert.deepEqual(decode(output.file, 's24le', 'pcm_s24le'), selected(source, 3));
});
