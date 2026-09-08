'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMediaInspection } = require('../media-inspection');
const { normalizeProcessingSettings, planProcessing, publicProcessingPlan, processingOptions } = require('../processing-plan');
const { processingArgs, processingVideoFilter, validateProcessingOutput } = require('../processing-command');

function raw({ container = 'mp4', video = {}, audio = {}, extra = [], chapters = [] } = {}) {
  return {
    format: { format_name: container === 'matroska' ? 'matroska,webm' : container === 'mp3' ? 'mp3' : 'mov,mp4,m4a,3gp,3g2,mj2',
      start_time: '2', duration: container === 'matroska' ? '12' : '10', size: '1000000', tags: { major_brand: container === 'mov' ? 'qt  ' : 'isom' } }, chapters,
    streams: [video !== false && { index: 2, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 390, height: 520,
      sample_aspect_ratio: '1:1', start_time: '2', duration: '10', avg_frame_rate: '30/1', ...video },
    audio !== false && { index: 4, codec_type: 'audio', codec_name: 'aac', channels: 2, channel_layout: 'stereo', sample_rate: '48000',
      bit_rate: '64000', start_time: '2.5', duration: '9.5', ...audio }, ...extra].filter(Boolean)
  };
}
function caps() {
  return { available: true, encoders: new Set(['libx264', 'aac', 'libmp3lame']), muxers: new Set(['mp4', 'mov', 'matroska', 'mp3', 'null']),
    decoders: new Set(['h264', 'hevc', 'aac', 'opus', 'mp3', 'pcm_s16le']), decoderCodecs: new Map([
      ['h264', [{ name: 'h264', software: true }]], ['hevc', [{ name: 'hevc', software: true }]],
      ['aac', [{ name: 'aac', software: true }]], ['opus', [{ name: 'opus', software: true }]],
      ['mp3', [{ name: 'mp3float', software: true }]], ['pcm_s16le', [{ name: 'pcm_s16le', software: true }]],
      ['av1', [{ name: 'av1_cuvid', software: false }, { name: 'libdav1d', software: true }]]
    ]) };
}
const cuts = { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 3 }, { startSeconds: 7, endSeconds: 9 }] };
function plan(settings = {}, data = raw(), other = {}) {
  return planProcessing({ workspaceId: 'workspace', sourceAssetId: 'source', inputFilename: 'source.mp4',
    inspection: normalizeMediaInspection(data), capabilities: caps(), settings, ...other });
}

test('complete defaults preserve all original bytes without capability evidence or inventory loss', () => {
  const source = raw({ video: { codec_name: 'hevc', color_transfer: 'smpte2084' }, extra: [{ index: 5, codec_type: 'subtitle' }], chapters: [{}] });
  const result = plan({}, source, { capabilities: null });
  assert.equal(result.status, 'no-op'); assert.equal(result.preserveSourceInventory, true);
  assert.deepEqual(result.warnings, []); assert.equal(result.output.videoCodec, 'hevc');
  assert.equal(result.inputAssetId, result.sourceAssetId); assert.equal(result.timing.durationSeconds, 10);
  assert.throws(() => processingArgs('source', 'output', normalizeMediaInspection(source), result), /executable/);
});

test('only an omitted or null edit plan means the complete source; malformed falsy plans fail', () => {
  for (const editPlan of [false, 0, '', [], { version: 1, keepRanges: [] }]) {
    assert.throws(() => plan({}, raw(), { editPlan }), { statusCode: 400 });
  }
  assert.equal(plan({}, raw(), { editPlan: null }).key, plan().key);
  const unknown = normalizeMediaInspection(raw()); unknown.durationSeconds = null;
  assert.equal(planProcessing({ sourceAssetId: 'source', inspection: unknown }).status, 'no-op');
  for (const editPlan of [false, 0, '', cuts]) {
    assert.throws(() => planProcessing({ sourceAssetId: 'source', inspection: unknown, editPlan }), { statusCode: 400 });
  }
});

test('explicit unchanged H.264 codec and source container is a no-op only with the complete requested inventory', () => {
  assert.equal(plan({ videoCodec: 'h264' }).status, 'no-op');
  const result = plan({ videoCodec: 'h264' }, raw({ extra: [{ index: 7, codec_type: 'audio', codec_name: 'aac' }] }));
  assert.equal(result.status, 'executable'); assert.equal(result.warnings[0].required, true);
  assert.ok(result.streams.every(stream => stream.action === 'copy'));
});

for (const settings of [
  { rate: { mode: 'quality' } }, { rate: { mode: 'bitrate', videoKbps: 200 } },
  { rate: { mode: 'size', maximumMB: 1 } }, { scale: { mode: 'fit', width: 854, height: 480 } }, { frameRate: 15 }
]) test(`same-codec H.264 encodes the requested override ${JSON.stringify(settings)}`, () => {
  const result = plan(settings);
  assert.equal(result.status, 'executable'); assert.equal(result.streams[0].action, 'encode');
  assert.equal(result.streams[0].encoder, 'libx264'); assert.equal(result.output.videoCodec, 'h264');
  assert.equal(result.streams[1].action, 'copy');
});

for (const container of ['mov', 'matroska']) test(`container-only ${container} remux requires only the actual muxer`, () => {
  const source = normalizeMediaInspection(raw());
  const result = plan({ container }, raw(), { capabilities: { available: true, muxers: new Set([container]) } });
  assert.equal(result.status, 'executable'); assert.ok(result.streams.every(stream => stream.action === 'copy'));
  const args = processingArgs('owned-original', 'attempt-output', source, result);
  assert.equal(args[args.indexOf('-i') + 1], 'owned-original'); assert.equal(args[args.lastIndexOf('-f') + 1], container);
  assert.ok(!args.includes('-filter_complex')); assert.ok(!args.includes('-fs'));
});

test('cuts and compression resolve one original-source plan and preserve the common presentation clock', () => {
  const source = normalizeMediaInspection(raw());
  const result = plan({ rate: { mode: 'quality', crf: 21, preset: 'slow' } }, raw(), { editPlan: cuts });
  assert.equal(result.status, 'executable'); assert.deepEqual(result.editPlan, cuts);
  assert.equal(result.timing.originSeconds, 2); assert.equal(result.timing.durationSeconds, 4);
  assert.deepEqual(result.streams.map(stream => stream.action), ['encode', 'encode']);
  const args = processingArgs('original.bin', 'final.mp4', source, result);
  assert.ok(args.includes('-copyts')); assert.ok(args.includes('-start_at_zero')); assert.ok(!args.includes('-ss'));
  assert.equal(args.filter(arg => arg === '-i').length, 1); assert.equal(args[args.indexOf('-i') + 1], 'original.bin');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /settb=AVTB/); assert.match(filter, /select='gte\(pts,1000000\)/);
  assert.match(filter, /setpts='PTS-\(1000000\+gte\(PTS,7000000\)\*4000000\)'/);
  assert.match(filter, /aresample=async=1:first_pts=0:min_hard_comp=0.001,apad=whole_dur=9/);
  assert.ok(!filter.includes('STARTPTS')); assert.ok(!args.includes('-shortest'));
});

test('unsupported source encoders need an explicit H.264 choice; copy remux preserves the actual codec', () => {
  const source = raw({ video: { codec_name: 'hevc' } });
  const blocked = plan({ rate: { mode: 'quality' } }, source);
  assert.equal(blocked.status, 'unavailable'); assert.match(blocked.message, /Choose H.264 explicitly/);
  assert.equal(plan({ videoCodec: 'h264', rate: { mode: 'quality' } }, source).status, 'executable');
  const remux = plan({ container: 'mov' }, source); assert.equal(remux.streams[0].action, 'copy'); assert.equal(remux.output.videoCodec, 'hevc');
  assert.equal(plan({ container: 'mp4' }, raw({ container: 'mov', video: { codec_name: 'prores' } })).status, 'unavailable');
  assert.ok(plan({ container: 'matroska' }, raw({ audio: { codec_name: 'mp3' } })).streams.every(stream => stream.action === 'copy'));
});

for (const settings of [
  { videoCodec: 'hevc' }, { container: 'webm' }, { videoCodec: null }, { container: ['mp4'] }, { audio: null },
  { filter: 'crop=1:1' }, { scale: { mode: 'fit', width: 0, height: 480 } }, { scale: { mode: 'fit', width: 640.5, height: 480 } },
  { scale: { mode: 'fit', width: 640, height: 20000 } }, { scale: { mode: 'fit', width: 640, height: 480, crop: true } },
  { rate: { mode: 'bitrate', videoKbps: '200' } }, { rate: { mode: 'bitrate', videoKbps: Infinity } },
  { rate: { mode: 'bitrate', videoKbps: 0 } }, { rate: { mode: 'size', maximumMB: -1 } }, { rate: { mode: 'size', maximumMB: NaN } },
  { rate: { mode: 'quality', crf: 52 } }, { rate: { mode: 'quality', preset: 'custom -fs 1' } },
  { rate: { mode: 'bitrate', videoKbps: 300, twoPass: 'true' } }, { audio: { codec: 'aac', bitrateKbps: 0 } },
  { audio: { codec: 'mp3', bitrateKbps: 512 } }, { audio: { codec: 'mp3', bitrateKbps: 9 } }, { frameRate: 0 }, { frameRate: '15' }
]) test(`invalid processing controls fail before command admission ${JSON.stringify(settings)}`, () => {
  assert.throws(() => normalizeProcessingSettings(settings), { statusCode: 400 });
});

test('inactive controls normalize consistently and do not perturb keys or acquire hidden transforms', () => {
  const inactive = { rate: { mode: 'automatic', crf: 35, preset: 'slow', videoKbps: 500, maximumMB: 5, twoPass: true },
    scale: { mode: 'unchanged', width: 640, height: 480, allowUpscale: true } };
  assert.deepEqual(normalizeProcessingSettings(inactive), normalizeProcessingSettings({}));
  assert.equal(plan(inactive).key, plan().key);
});

test('plan keys bind draft revision, original identity, source facts, and committed cuts', () => {
  const result = plan({ rate: { mode: 'quality' } });
  assert.notEqual(result.key, plan(result.settings, raw(), { draftRevision: 1 }).key);
  assert.notEqual(result.key, plan(result.settings, raw(), { sourceAssetId: 'another-source' }).key);
  assert.notEqual(result.key, plan(result.settings, raw(), { workspaceId: 'another-workspace' }).key);
  assert.notEqual(result.key, plan(result.settings, raw({ audio: { bit_rate: '96000' } })).key);
  assert.notEqual(result.key, plan(result.settings, raw(), { editPlan: cuts }).key);
  assert.throws(() => plan({}, raw(), { draftRevision: -1 }), { statusCode: 400 });
  assert.throws(() => plan({}, raw(), { editPlan: { ...cuts, filter: 'anything' } }), { statusCode: 400 });
  assert.throws(() => plan({}, raw(), { editPlan: { version: 1, keepRanges: [{ startSeconds: 9, endSeconds: 11 }] } }), { statusCode: 400 });
  assert.deepEqual(publicProcessingPlan(result).streams[0], { role: 'video', index: 2, action: 'encode' });
});

test('size budgets use retained seconds, decimal MB, selected audio, and an explicit overhead reserve', () => {
  const settings = { rate: { mode: 'size', maximumMB: 1 }, audio: { codec: 'aac', bitrateKbps: 96 } };
  const full = plan(settings), cut = plan(settings, raw(), { editPlan: cuts });
  assert.equal(cut.rateBudget.maximumBytes, 1000000); assert.equal(cut.passes, 2);
  assert.equal(cut.rateBudget.audioBitsPerSecond, 96000); assert.equal(cut.rateBudget.audioBytes, 48000);
  assert.ok(cut.rateBudget.overheadBytes > 16384); assert.ok(cut.rateBudget.videoBitrate > full.rateBudget.videoBitrate);
  assert.ok(cut.rateBudget.estimatedBytes <= cut.rateBudget.maximumBytes);
  assert.equal(plan({ rate: { mode: 'size', maximumMB: 0.01 } }).status, 'unavailable');
  const unknownAudio = plan({ rate: { mode: 'size', maximumMB: 1 } }, raw({ audio: { bit_rate: null } }));
  assert.equal(unknownAudio.status, 'unavailable'); assert.match(unknownAudio.message, /AAC.*explicit audio bitrate/);
  const silent = plan({ rate: { mode: 'size', maximumMB: 1 } }, raw({ audio: false }));
  assert.equal(silent.rateBudget.audioBytes, 0); assert.equal(silent.status, 'executable');
});

test('two-pass commands use the same original, geometry, rate, preset, cuts, and cadence', () => {
  const settings = { rate: { mode: 'size', maximumMB: 1 }, scale: { mode: 'fit', width: 854, height: 480 }, frameRate: 15 };
  const source = normalizeMediaInspection(raw()), result = plan(settings, raw(), { editPlan: cuts });
  const first = processingArgs('original.bin', 'result.mp4', source, result, { pass: 1, passLogPrefix: 'owned-attempt/pass' });
  const second = processingArgs('original.bin', 'result.mp4', source, result, { pass: 2, passLogPrefix: 'owned-attempt/pass' });
  const commonVideo = processingVideoFilter(source, result);
  assert.equal(first[first.indexOf('-filter_complex') + 1], commonVideo);
  assert.ok(second[second.indexOf('-filter_complex') + 1].startsWith(commonVideo));
  for (const flag of ['-i', '-b:v', '-preset', '-enc_time_base:v', '-x264-params', '-passlogfile']) assert.equal(first[first.indexOf(flag) + 1], second[second.indexOf(flag) + 1]);
  assert.equal(first[first.lastIndexOf('-f') + 1], 'null'); assert.equal(first.at(-1), '-');
  assert.ok(first.includes('-an')); assert.ok(!first.includes('-fs')); assert.ok(!second.includes('-fs'));
  assert.throws(() => processingArgs('original.bin', 'result.mp4', source, result), /pass log/);
  const corrected = processingArgs('original.bin', 'retry.mp4', source, result, { pass: 2, passLogPrefix: 'new-attempt/pass', videoBitrate: 20000 });
  assert.equal(corrected[corrected.indexOf('-b:v') + 1], '20000');
  const noNull = caps(); noNull.muxers.delete('null');
  assert.equal(plan(settings, raw(), { editPlan: cuts, capabilities: noNull }).reason, 'missing-capability');
});

test('portrait fit, no-upscale, rotation, anamorphic aspect, and even padding resolve without cropping', () => {
  const fit = plan({ scale: { mode: 'fit', width: 854, height: 480 } });
  assert.deepEqual([fit.output.width, fit.output.height], [360, 480]); assert.equal(fit.output.sampleAspectRatio, '1:1');
  const small = plan({ scale: { mode: 'fit', width: 854, height: 480 } }, raw({ video: { width: 96, height: 64 } }));
  assert.deepEqual([small.output.width, small.output.height], [96, 64]);
  const odd = plan({ rate: { mode: 'quality' } }, raw({ video: { width: 95, height: 63, tags: { rotate: '90' } } }));
  assert.deepEqual([odd.output.width, odd.output.height, odd.output.rotationDegrees], [64, 96, 0]);
  assert.match(processingVideoFilter(normalizeMediaInspection(raw()), odd), /pad=ceil/);
  const anamorphic = plan({ scale: { mode: 'fit', width: 640, height: 480 } }, raw({ video: { width: 720, height: 576, sample_aspect_ratio: '16:15' } }));
  assert.deepEqual([anamorphic.output.width, anamorphic.output.height], [640, 480]); assert.equal(anamorphic.output.sampleAspectRatio, '1:1');
  assert.equal(plan({ frameRate: 60 }).status, 'unavailable');
});

test('audio-only outputs retain accepted copy/MP3-quality semantics and support authored video cuts directly', () => {
  const aac = plan({ container: 'm4a' }); assert.equal(aac.streams[0].action, 'copy'); assert.equal(aac.timing.durationSeconds, 9.5);
  const mp3 = plan({ container: 'mp3' }); assert.equal(mp3.streams[0].encoder, 'libmp3lame'); assert.equal(mp3.streams[0].quality, 0);
  const changed = plan({ container: 'm4a', audio: { codec: 'aac', bitrateKbps: 96 } });
  assert.equal(changed.status, 'executable'); assert.equal(changed.streams[0].action, 'encode'); assert.equal(changed.streams[0].bitRate, 96000);
  assert.equal(plan({ container: 'mp3', audio: { bitrateKbps: 9 } }).status, 'unavailable');
  assert.equal(plan({ container: 'mp3', audio: { bitrateKbps: 96 } }).streams[0].bitRate, 96000);
  assert.equal(plan({ audio: { codec: 'mp3' } }, raw({ video: false })).status, 'unavailable');
  for (const container of ['m4a', 'mp3']) {
    const result = plan({ container }, raw(), { editPlan: cuts }); assert.equal(result.status, 'executable');
    assert.equal(result.timing.durationSeconds, 4); assert.equal(result.streams.length, 1); assert.equal(result.streams[0].action, 'encode');
    const args = processingArgs('original-video', 'cut-audio', normalizeMediaInspection(raw()), result);
    assert.ok(args.includes('-vn')); assert.ok(!args.includes('-itsoffset')); assert.ok(!args.includes('libx264'));
    assert.match(args[args.indexOf('-filter_complex') + 1], /apad=whole_dur=9/);
  }
});

test('missing tools, unknown capability evidence, fidelity refusal, and layout policy stay distinct', () => {
  assert.equal(plan({ rate: { mode: 'quality' } }, raw(), { capabilities: { available: false } }).reason, 'capability-check');
  const missing = caps(); missing.encoders.delete('libx264');
  assert.equal(plan({ rate: { mode: 'quality' } }, raw(), { capabilities: missing }).reason, 'missing-capability');
  for (const video of [{ color_transfer: 'smpte2084' }, { pix_fmt: 'yuva420p' }, { tags: { rotate: '45' } }]) {
    assert.equal(plan({ rate: { mode: 'quality' } }, raw({ video })).status, 'unavailable');
    assert.equal(plan({ container: 'm4a' }, raw({ video })).status, 'executable');
  }
  const unknownLayout = raw({ audio: { channels: 6, channel_layout: null } });
  assert.equal(plan({}, unknownLayout, { editPlan: cuts }).reason, 'incomplete');
  const surround = raw({ audio: { channels: 8, channel_layout: '7.1' } });
  assert.equal(plan({}, surround, { editPlan: cuts }).status, 'unavailable');
  assert.equal(plan({ container: 'mov' }, surround).streams[1].action, 'copy');
  const side = plan({}, raw({ audio: { channels: 6, channel_layout: '5.1(side)' } }), { editPlan: cuts });
  assert.equal(side.output.channelLayout, '5.1(side)'); assert.equal(side.streams[1].channels, 6);
});

test('available UI choices reflect muxers, software decoder evidence, and applicable audio layout', () => {
  const source = normalizeMediaInspection(raw());
  const unknown = processingOptions(source, { available: false });
  assert.deepEqual(unknown.containers.map(item => item.value), ['source']);
  const available = processingOptions(source, caps());
  assert.deepEqual(available.containers.map(item => item.value), ['source', 'mp4', 'mov', 'matroska', 'm4a', 'mp3']);
  assert.ok(available.frameRates.every(value => value < 30));
  const noEncoder = caps(); noEncoder.encoders.delete('libx264');
  assert.deepEqual(processingOptions(source, noEncoder).videoCodecs.map(item => item.value), ['unchanged']);
  const surround = normalizeMediaInspection(raw({ audio: { channels: 6, channel_layout: '5.1' } }));
  assert.ok(!processingOptions(surround, caps()).audioCodecs.some(item => item.value === 'mp3'));
});

test('validation checks actual requested codecs, endpoints, geometry, inventory, and layouts before publication', () => {
  const source = raw({ container: 'mov' });
  const result = plan({ container: 'mp4' }, source);
  const good = normalizeMediaInspection(raw()); assert.equal(validateProcessingOutput(good, result), good);
  for (const mutate of [output => output.container.kind = 'mov', output => output.durationSeconds = 8,
    output => output.extraStreams.total++, output => output.extraStreams.chapters++, output => output.video.width--,
    output => output.video.codec = 'hevc', output => output.video.startSeconds += 0.5, output => output.video.durationSeconds -= 0.5,
    output => output.audio.channels = 1, output => output.audio.channelLayout = null, output => output.audio.durationSeconds -= 0.5]) {
    const invalid = structuredClone(good); mutate(invalid); assert.throws(() => validateProcessingOutput(invalid, result), /validation failed/);
  }
  const hevcSource = raw({ container: 'mov', video: { codec_name: 'hevc' } });
  const hevc = plan({ container: 'mp4' }, hevcSource);
  assert.doesNotThrow(() => validateProcessingOutput(normalizeMediaInspection(raw({ video: { codec_name: 'hevc' } })), hevc));
});
