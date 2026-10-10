'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { normalizeMediaInspection } = require('../media-inspection');
const { audioEncodingPolicy, audioPrecision, editorTimeline, LAYOUTS } = require('../audio-policy');
const { planProcessing } = require('../processing-plan');
const { processingArgs, validateProcessingOutput } = require('../processing-command');
const { createMediaWorkspaceManager } = require('../media-workspace');
const { createPeakAccumulator, waveformWindow, MAX_PAIRS } = require('../audio-waveform');

function inspection(audio = {}, video = null, kind = 'wav') {
  return normalizeMediaInspection({ format: { format_name: kind, duration: '2', start_time: '0' }, chapters: [], streams: [
    { index: 4, codec_type: 'audio', codec_name: 'pcm_s24le', sample_fmt: 's32', bits_per_raw_sample: '24', bits_per_sample: '24',
      sample_rate: '44100', channels: 2, channel_layout: 'stereo', start_time: '0', duration: '2', ...audio }, ...(video ? [video] : [])] });
}
const capabilities = { available: true, encoders: new Set(['aac', 'libmp3lame', 'libopus', 'flac', 'pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le', 'libx264']),
  decoders: new Set(['pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_f64le', 'aac', 'flac', 'opus', 'h264']), muxers: new Set(['mp4', 'ogg', 'flac', 'wav', 'matroska', 'f32le']) };
const cuts = { version: 1, keepRanges: [{ startSeconds: 0.1, endSeconds: 0.5 }, { startSeconds: 1, endSeconds: 1.5 }] };
function plan(container, source = inspection(), extras = {}) {
  return planProcessing({ sourceAssetId: 'source', inspection: source, capabilities, settings: { container }, ...extras });
}

test('inspection bounds sample metadata and precision uses evidence rather than a 16-bit fallback', () => {
  const audio = inspection().audio; assert.equal(audio.sampleFormat, 's32'); assert.equal(audio.bitsPerRawSample, 24);
  assert.deepEqual(audioPrecision(audio), { representation: 'integer', bitDepth: 24 });
  assert.deepEqual(audioPrecision({}), { representation: null, bitDepth: null });
  const invalid = inspection({ sample_fmt: 's32;filter', bits_per_raw_sample: '999', bits_per_sample: '-1' }).audio;
  assert.equal(invalid.sampleFormat, null); assert.equal(invalid.bitsPerRawSample, null); assert.equal(invalid.bitsPerSample, null);
  assert.equal(audioPrecision({ sampleFormat: 'dblp' }).bitDepth, 64);
  const unknown = inspection({ codec_name: 'flac', bits_per_sample: 0, bits_per_raw_sample: 0 }).audio;
  assert.deepEqual(audioPrecision(unknown), { representation: 'integer', bitDepth: null });
  assert.match(audioEncodingPolicy(unknown, 'flac').error, /proven integer precision.*Choose WAV/);
  assert.equal(audioEncodingPolicy(unknown, 'pcm').stream.bitDepth, 32);
  assert.match(require('../public/conversion-inspector').audioPrecisionLabel(unknown), /Meaningful precision unknown/);
});

test('lossless policies preserve rate and precision and reject FLAC reductions', () => {
  for (const [format, bits, encoder] of [['s16', 16, 'pcm_s16le'], ['s32', 24, 'pcm_s24le'], ['s32', 32, 'pcm_s32le'], ['flt', null, 'pcm_f32le'], ['dbl', null, 'pcm_f64le']]) {
    const source = inspection({ sample_fmt: format, bits_per_raw_sample: bits, bits_per_sample: bits, codec_name: bits ? `pcm_s${bits}le` : 'aac' }).audio;
    const wav = audioEncodingPolicy(source, 'pcm'); assert.equal(wav.stream.encoder, encoder); assert.equal(wav.stream.sampleRate, 44100);
    const flac = audioEncodingPolicy(source, 'flac');
    if (!bits || bits > 24) assert.match(flac.error, /Choose WAV/); else assert.equal(flac.stream.bitDepth, bits);
  }
  assert.match(audioEncodingPolicy(inspection().audio, 'flac', 64).error, /do not take/);
  assert.match(audioEncodingPolicy(inspection({ channels: 6, channel_layout: null }).audio, 'pcm').error, /layout/);
});

test('Opus accepts canonical layouts and channel-bound bitrates without speaker remapping', () => {
  for (const [layout, channels] of Object.entries(LAYOUTS)) {
    const policy = audioEncodingPolicy(inspection({ channels, channel_layout: layout }).audio, 'opus');
    if (layout === '5.1(side)') assert.match(policy.error, /not be remapped/);
    else { assert.equal(policy.stream.channels, channels); assert.equal(policy.stream.sampleRate, 48000); assert.equal(policy.stream.bitRate, channels * 64000); }
  }
  assert.match(audioEncodingPolicy(inspection({ channels: 1, channel_layout: 'mono' }).audio, 'opus', 257).error, /256/);
  assert.match(audioEncodingPolicy(inspection().audio, 'opus', 7).error, /between 8/);
});

test('standalone audio cuts use the first selected sample; output commands are codec specific', () => {
  const source = inspection({ start_time: '0.5' });
  assert.deepEqual(editorTimeline(source), { durationSeconds: 2, offsetSeconds: 0.5 });
  for (const container of ['opus', 'flac', 'wav']) {
    const reviewed = plan(container, source, { editPlan: cuts }); assert.equal(reviewed.status, 'executable', reviewed.message);
    const args = processingArgs('original.wav', 'output', source, reviewed);
    assert.equal(args[args.indexOf('-itsoffset') + 1], '-0.5'); assert.ok(!args.includes('undefined')); assert.ok(!args.includes('-q:a'));
    assert.equal(reviewed.timing.durationSeconds, 0.9); assert.equal(reviewed.output.channels, 2);
    if (container === 'opus') assert.equal(args[args.lastIndexOf('-f') + 1], 'ogg');
    if (container === 'wav') assert.equal(args[args.indexOf('-rf64') + 1], 'auto');
  }
});

test('new format plans bind capabilities and preserve original no-ops regardless of precision', () => {
  const source = inspection({ codec_name: 'flac', sample_fmt: 's32', bits_per_raw_sample: 32, bits_per_sample: 0 }, null, 'flac');
  assert.equal(plan('source', source, { capabilities: null }).status, 'no-op');
  assert.equal(plan('flac', source).status, 'no-op');
  assert.match(plan('flac', source, { editPlan: cuts }).message, /Choose WAV/);
  assert.equal(plan('opus', inspection(), { capabilities: { ...capabilities, encoders: new Set() } }).reason, 'missing-capability');
  assert.equal(plan('wav', inspection(), { editPlan: cuts, capabilities: { ...capabilities, muxers: new Set() } }).reason, 'missing-capability');
  assert.equal(plan('wav', inspection(), { settings: { container: 'wav', audio: { codec: 'opus' } } }).status, 'unavailable');
});

test('MKV uses the shared Opus/FLAC policy and refuses an unbudgetable FLAC maximum size', () => {
  const video = { index: 1, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 64, height: 64, start_time: '0', duration: '2', avg_frame_rate: '20/1' };
  const source = inspection({}, video, 'matroska');
  for (const codec of ['opus', 'flac']) {
    const result = plan('matroska', source, { settings: { container: 'matroska', audio: { codec } }, editPlan: cuts });
    assert.equal(result.status, 'executable', result.message); assert.equal(result.output.audioCodec, codec);
  }
  const sized = plan('matroska', source, { settings: { container: 'matroska', audio: { codec: 'flac' }, rate: { mode: 'size', maximumMB: 1 } } });
  assert.equal(sized.status, 'unavailable'); assert.match(sized.message, /budget/);
  const surround = plan('matroska', inspection({ codec_name: 'pcm_f32le', sample_fmt: 'flt', channels: 5, channel_layout: '5.0' }, video, 'matroska'),
    { settings: { container: 'matroska', audio: { codec: 'opus' } } });
  assert.equal(surround.status, 'executable'); assert.ok(surround.options.containers.some(option => option.value === 'matroska'));
});

test('actual lossless output validation rejects a reduced bit depth', () => {
  const reviewed = plan('flac'); const output = inspection({ codec_name: 'flac', sample_fmt: 's32', bits_per_sample: 0 }, null, 'flac');
  assert.doesNotThrow(() => validateProcessingOutput(output, reviewed));
  output.audio.bitsPerRawSample = 16;
  assert.throws(() => validateProcessingOutput(output, reviewed), /precision/);
});

test('combined peaks preserve extrema across channels and bound memory, windows, malformed bytes and duration', () => {
  const accumulator = createPeakAccumulator({ durationSeconds: 0.02, sampleRate: 1000, channels: 2 });
  const pcm = Buffer.alloc(20 * 2 * 4); pcm.writeFloatLE(-0.7, 0); pcm.writeFloatLE(0.9, 4);
  accumulator.push(pcm.subarray(0, 3)); accumulator.push(pcm.subarray(3));
  const data = accumulator.finish();
  const peaks = waveformWindow(data, accumulator.binSeconds, 0.02, 0, 0.02, 2);
  assert.deepEqual(peaks, [[-0.7, 0.9], [0, 0]]);
  assert.throws(() => waveformWindow(data, 0.01, 0.02, 0, 1, 1));
  assert.throws(() => waveformWindow(data, 0.01, 0.02, 0, 0.02, 4097));
  assert.ok(createPeakAccumulator({ durationSeconds: 86400, sampleRate: 48000, channels: 8 }).pairs <= MAX_PAIRS);
  const invalid = createPeakAccumulator({ durationSeconds: 0.01, sampleRate: 1000, channels: 1 });
  const nan = Buffer.alloc(4); nan.writeFloatLE(NaN); assert.throws(() => invalid.push(nan), /non-finite/);
  assert.throws(() => invalid.push(Buffer.alloc(5000)), /byte bound/);
  const positive = createPeakAccumulator({ durationSeconds: 0.01, sampleRate: 1000, channels: 1 });
  const dc = Buffer.alloc(40); for (let offset = 0; offset < dc.length; offset += 4) dc.writeFloatLE(0.5, offset);
  positive.push(dc); assert.deepEqual(waveformWindow(positive.finish(), 0.01, 0.01, 0, 0.01, 1), [[0.5, 0.5]]);
});

async function waveFixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-waveform-test-'));
  const children = [];
  const manager = createMediaWorkspaceManager({ tempDir: dir, inspectAsset: async () => inspection({ sample_rate: '1000', duration: '0.02' }),
    discoverCapabilities: async () => capabilities, conversionTerminationGraceMs: 10, waveformOptions: { deadlineMs: options.deadlineMs || 2000 },
    spawnProcess(command, args) {
      const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.args = args;
      child.signals = [];
      child.kill = signal => { child.signals.push(signal); child.killed = signal; if (!options.holdExit) setImmediate(() => child.emit('close', 1)); return true; };
      children.push(child); return child;
    } });
  t.after(async () => { for (const child of children) child.emit('close', 1); await manager.clearAll(); await fs.rm(dir, { recursive: true, force: true }); });
  const workspace = await manager.receiveLocalStream(Readable.from('original'), { purpose: 'local', displayName: 'audio.wav' });
  manager.waveforms.start(workspace.id, workspace.sourceAssetId);
  for (let i = 0; !children.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(children.length, 1);
  return { manager, workspace, child: children[0], children };
}

test('waveform completion is owned, cached and contains no peak data in progress descriptors', async t => {
  const { manager, workspace, child } = await waveFixture(t);
  child.stdout.write(Buffer.alloc(20 * 2 * 4)); child.emit('close', 0);
  await manager.waveforms.tasks.get(workspace.id).promise;
  const state = manager.publicWorkspace(workspace).waveform;
  assert.equal(state.status, 'ready'); assert.equal(state.peaks, undefined);
  const result = await manager.waveforms.window(workspace.id, workspace.sourceAssetId, 0, 0.02, 2);
  assert.equal(result.peaks.length, 2); assert.equal(result.sourceAssetId, workspace.sourceAssetId);
  const asset = [...workspace.assets.values()].find(a => a.role === 'waveform'); assert.equal(asset.playable, false);
  await manager.discard(workspace.id);
  await assert.rejects(manager.waveforms.window(workspace.id, workspace.sourceAssetId, 0, 0.02, 2), /not found|expired/);
});

test('foreground processing waits for confirmed waveform child exit', async t => {
  const { manager, workspace, child } = await waveFixture(t, { holdExit: true });
  const intent = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision: 0 };
  const reviewed = await manager.processing.plan(intent);
  let admitted = false;
  const waiting = manager.processing.start({ ...intent, planKey: reviewed.key,
    acknowledgedWarnings: reviewed.warnings.map(warning => warning.id) }).then(() => { admitted = true; });
  const deadline = Date.now() + 2000;
  while (!child.signals.includes('SIGKILL')) { assert.equal(admitted, false); assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(admitted, false); assert.equal(child.killed, 'SIGKILL');
  child.emit('exit', 1); await waiting;
  assert.equal(admitted, true); assert.ok(['waiting', 'preparing'].includes(manager.waveforms.state(workspace).status));
  assert.equal(workspace.conversion.output.noOp, true);
});

for (const action of ['removal', 'expiry']) test(`waveform ${action} invalidates ownership before waiting for the decoder and deleting files`, async t => {
  const { manager, workspace, child } = await waveFixture(t, { holdExit: true });
  const directory = workspace.tempDir;
  const pending = action === 'removal' ? manager.discard(workspace.id) : manager.cleanupExpired(workspace.lastAccessAt + manager.ttlMs + 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.get(workspace.id), null); assert.ok(child.signals.includes('SIGTERM'));
  assert.ok((await fs.stat(directory)).isDirectory());
  child.stdout.write(Buffer.alloc(160)); child.emit('close', 0); await pending;
  assert.equal(manager.waveforms.tasks.has(workspace.id), false);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('failed waveform cleanup retains the cache and source reservation until explicit retry succeeds', async t => {
  const { manager, workspace, child } = await waveFixture(t);
  child.stdout.write(Buffer.alloc(160)); child.emit('close', 0); await manager.waveforms.tasks.get(workspace.id).promise;
  const queue = manager.localProcessing, collection = queue.get(queue.createCollection().id);
  queue.attach(collection, workspace, queue.reserve(collection, workspace.source.size));
  const bytes = queue.snapshot(collection.id).sourceBytesReserved;
  manager.fs = { ...fs, rm: async () => { throw Object.assign(new Error('Synthetic locked waveform'), { code: 'EACCES' }); } };
  await manager.discard(workspace.id);
  assert.equal(manager.cleanupStatus(workspace).status, 'failed');
  assert.ok([...manager.cleanupPending.get(workspace.id).assets.values()].some(asset => asset.role === 'waveform'));
  assert.equal(queue.snapshot(collection.id).sourceBytesReserved, bytes);
  assert.equal(queue.snapshot(collection.id).removedCleanup.length, 1);
  manager.fs = fs; await manager.retryCleanup(workspace.id);
  assert.equal(queue.snapshot(collection.id).sourceBytesReserved, 0); assert.equal(queue.snapshot(collection.id).removedCleanup.length, 0);
});

test('an obsolete selection cancellation cannot cancel a newer waveform operation', async t => {
  const { manager, workspace, children } = await waveFixture(t);
  const first = manager.waveforms.state(workspace).operationId;
  await manager.waveforms.cancel(workspace.id, first); manager.waveforms.start(workspace.id, workspace.sourceAssetId);
  for (let i = 0; children.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const current = manager.waveforms.tasks.get(workspace.id); assert.notEqual(current.id, first);
  await manager.waveforms.cancel(workspace.id, first); assert.equal(current.controller.signal.aborted, false);
  children[1].stdout.write(Buffer.alloc(160)); children[1].emit('close', 0); await current.promise;
  assert.equal(current.status, 'ready');
});

for (const malformed of ['non-finite', 'oversized', 'truncated']) test(`waveform ${malformed} output fails without taking away trimming or processing`, async t => {
  const { manager, workspace, child } = await waveFixture(t);
  const bytes = Buffer.alloc(malformed === 'oversized' ? 10000 : malformed === 'truncated' ? 2 : 160);
  if (malformed === 'non-finite') bytes.writeFloatLE(NaN);
  child.stdout.write(bytes); child.stderr.write('private/source/path.wav');
  if (malformed === 'truncated') child.emit('close', 0);
  await manager.waveforms.tasks.get(workspace.id).promise;
  const state = manager.publicWorkspace(workspace); assert.equal(state.waveform.status, 'failed');
  assert.doesNotMatch(state.waveform.message, /private|path.wav/); assert.equal(state.editor.eligible, true);
  assert.equal((await manager.processing.plan({ workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision: 0 })).status, 'no-op');
});

test('waveform deadlines fail independently while retaining the source and editor eligibility', async t => {
  const { manager, workspace } = await waveFixture(t, { deadlineMs: 15 });
  await manager.waveforms.tasks.get(workspace.id).promise;
  assert.equal(manager.waveforms.state(workspace).status, 'failed'); assert.match(manager.waveforms.state(workspace).message, /timed out/);
  assert.equal(manager.publicWorkspace(workspace).editor.eligible, true); assert.ok(workspace.assets.has(workspace.sourceAssetId));
});
