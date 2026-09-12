'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMediaInspection } = require('../media-inspection');
const { planConversion, publicConversionPlan, normalizeTarget } = require('../conversion-plan');
const { conversionArgs, validateConversionOutput } = require('../conversion-command');

function raw({ container = 'mov', video = {}, audio = {}, extra = [] } = {}) {
  return { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', start_time: '1', duration: '5', tags: { major_brand: container === 'mp4' ? 'isom' : 'qt  ' } }, chapters: [],
    streams: [video !== false && { index: 2, codec_type: 'video', codec_name: 'h264', width: 96, height: 64, pix_fmt: 'yuv420p', start_time: '1', duration: '5', avg_frame_rate: '20/1', ...video },
      audio !== false && { index: 4, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', start_time: '1.5', duration: '4.5', ...audio }, ...extra].filter(Boolean) };
}
function caps() { return { available: true, encoders: new Set(['libx264', 'aac', 'libmp3lame']), muxers: new Set(['mp4', 'mp3']),
  decoders: new Set(['h264', 'hevc', 'aac', 'opus', 'pcm_s16le', 'mp3']), decoderCodecs: new Map([
    ['h264', [{ name: 'h264', software: true }]], ['hevc', [{ name: 'hevc', software: true }]],
    ['aac', [{ name: 'aac', software: true }]], ['opus', [{ name: 'opus', software: true }]],
    ['av1', [{ name: 'av1_cuvid', software: false }, { name: 'libdav1d', software: true }]],
    ['mp3', [{ name: 'mp3float', software: true }]], ['pcm_s16le', [{ name: 'pcm_s16le', software: true }]]
  ]) }; }
function plan(data = raw(), targetId = 'broad-compatibility-mp4', capabilities = caps()) {
  return planConversion({ inputAssetId: 'owned-source', inspection: normalizeMediaInspection(data), targetId, capabilities });
}

for (const value of ['MP4', '', null, {}, ['mp3'], '__proto__', 'mp3 -y', '../mp3', 'wav']) {
  test(`conversion rejects unsupported target value ${JSON.stringify(value)}`, () => assert.throws(() => normalizeTarget(value), { statusCode: 400 }));
}
test('complete MP4 no-op needs no capabilities, but selected-role omissions require a real remux', () => {
  assert.equal(plan(raw({ container: 'mp4' }), undefined, null).status, 'no-op');
  const extra = raw({ container: 'mp4', extra: [{ index: 5, codec_type: 'audio', codec_name: 'aac' }] });
  const result = plan(extra);
  assert.equal(result.status, 'executable'); assert.equal(result.warnings[0].required, true);
  assert.deepEqual(result.streams.map(stream => stream.index), [2, 4]);
  assert.equal(plan(raw({ container: 'mp4' }), 'm4a-aac').status, 'executable');
});
test('remux requires only a muxer; codec requirements follow individual encode decisions', () => {
  const onlyMuxer = { available: true, muxers: new Set(['mp4']) };
  assert.equal(plan(raw(), undefined, onlyMuxer).status, 'executable');
  assert.equal(plan(raw(), undefined, { available: true, muxers: new Set() }).reason, 'missing-capability');
  const audio = plan(raw({ audio: { codec_name: 'opus' } }));
  assert.deepEqual(audio.streams.map(stream => stream.action), ['copy', 'encode']);
  const video = plan(raw({ video: { codec_name: 'hevc' } }));
  assert.deepEqual(video.streams.map(stream => stream.action), ['encode', 'copy']);
  assert.deepEqual(plan(raw({ video: { codec_name: 'hevc' }, audio: { codec_name: 'opus' } })).streams.map(stream => stream.action), ['encode', 'encode']);
});
test('software decoder alias is executed explicitly, never the advertised hardware default', () => {
  const source = normalizeMediaInspection(raw({ video: { codec_name: 'av1' } }));
  const result = planConversion({ inputAssetId: 'owned', inspection: source, targetId: 'broad-compatibility-mp4', capabilities: caps() });
  assert.equal(result.streams[0].decoder, 'libdav1d');
  const args = conversionArgs('original.bin', 'output.mp4', source, result, 1000000);
  assert.equal(args[args.indexOf('-c:2') + 1], 'libdav1d'); assert.ok(args.indexOf('-c:2') < args.indexOf('-i'));
  assert.ok(args.includes('-enable_drefs')); assert.ok(args.includes('-format_whitelist')); assert.ok(args.includes('-copyts')); assert.ok(args.includes('-start_at_zero'));
  assert.equal(args[args.indexOf('-i') + 1], 'original.bin');
  assert.ok(!args.includes('-shortest')); assert.ok(!args.includes('-r')); assert.ok(!args.includes('-acodec'));
  assert.deepEqual(publicConversionPlan(result).streams[0], { role: 'video', index: 2, action: 'encode' });
});
for (const [layout, channels, bitrate] of [['mono', 1, 128000], ['stereo', 2, 256000], ['5.1', 6, 512000], ['5.1(side)', 6, 512000]]) {
  test(`AAC encoding preserves ${layout} and uses its specified bitrate`, () => {
    const result = plan(raw({ audio: { codec_name: 'opus', channel_layout: layout, channels, sample_rate: '44100' } }));
    assert.equal(result.status, 'executable'); const stream = result.streams[1];
    assert.equal(stream.channels, channels); assert.equal(stream.channelLayout, layout); assert.equal(stream.bitRate, bitrate); assert.equal(stream.sampleRate, 44100);
  });
}
test('copy preserves low-bitrate AAC and nonstandard parameters; encoding discloses resampling', () => {
  const source = raw({ audio: { sample_rate: '32000', bit_rate: '32000', channels: 8, channel_layout: '7.1' } });
  const result = plan(source); assert.equal(result.streams[1].action, 'copy'); assert.equal(result.output.channels, 8); assert.equal(result.output.sampleRate, 32000);
  assert.equal(plan(source, 'mp3').reason, 'unsupported');
  const encoded = plan(raw({ audio: { codec_name: 'opus', sample_rate: '32000' } }));
  assert.equal(encoded.output.sampleRate, 48000); assert.match(encoded.changes.join(' '), /Resample.*32000.*48000/);
});
for (const audio of [{ sample_rate: null }, { channels: null }, { index: null }, { sample_rate: '' }, { channels: 0 }]) {
  test(`missing necessary audio facts stay incomplete: ${JSON.stringify(audio)}`, () => assert.equal(plan(raw({ audio })).status, 'unknown'));
}
test('unknown six-channel layout and unsupported known layouts do not silently downmix', () => {
  assert.equal(plan(raw({ audio: { codec_name: 'opus', channels: 6, channel_layout: null } })).reason, 'incomplete');
  assert.equal(plan(raw({ audio: { codec_name: 'opus', channels: 8, channel_layout: '7.1' } })).reason, 'unsupported');
});
for (const video of [{ color_transfer: 'smpte2084' }, { color_transfer: 'arib-std-b67' }, { pix_fmt: 'yuva420p' }, { tags: { alpha_mode: '1' } }, { tags: { rotate: '45' } }]) {
  test(`known unsupported video fidelity remains available for audio extraction: ${JSON.stringify(video)}`, () => {
    assert.equal(plan(raw({ video })).reason, 'unsupported');
    assert.equal(plan(raw({ video }), 'm4a-aac').status, 'executable');
  });
}
test('unknown transfer/alpha remain unknown; odd encoded geometry pads, never crops', () => {
  const source = raw({ video: { codec_name: 'hevc', width: 95, height: 63, tags: { rotate: '90' } } });
  const facts = normalizeMediaInspection(source); assert.equal(facts.video.hdr, null); assert.equal(facts.video.alpha, null);
  const result = plan(source); assert.equal(result.output.width, 64); assert.equal(result.output.height, 96); assert.equal(result.output.rotationDegrees, 0);
  assert.match(result.changes.join(' '), /Pad.*64 × 96/);
});
test('shared selected endpoint and audio-only timing stay distinct at shifted origins', () => {
  const video = plan(); assert.equal(video.timing.durationSeconds, 5); assert.equal(video.timing.audioStartSeconds, 0.5);
  const audio = plan(raw(), 'm4a-aac'); assert.equal(audio.timing.durationSeconds, 4.5); assert.equal(audio.timing.audioStartSeconds, 0); assert.equal(audio.timing.sourceAudioStartSeconds, 0.5);
  assert.match(audio.changes.join(' '), /video-only tail/);
});
test('plan key includes source identity, effective settings, selected roles, and warning evidence', () => {
  const result = plan(); assert.equal(result.key, plan().key);
  assert.notEqual(result.key, plan(raw({ audio: { codec_name: 'opus' } })).key);
  const chapters = raw(); chapters.chapters = [{ id: 0, start_time: '0', end_time: '5' }];
  assert.notEqual(result.key, plan(chapters).key); assert.ok(plan(chapters).warnings.length);
  assert.notEqual(result.key, planConversion({ inputAssetId: 'different', inspection: normalizeMediaInspection(raw()), targetId: result.targetId, capabilities: caps() }).key);
});
test('failed discovery stays unknown while known missing requirements stay unavailable', () => {
  assert.equal(plan(raw(), undefined, { available: false }).reason, 'capability-check');
  assert.deepEqual(plan(raw(), undefined, { available: false }).missing, []);
  const missing = caps(); missing.encoders.clear(); assert.equal(plan(raw({ video: { codec_name: 'hevc' } }), undefined, missing).reason, 'missing-capability');
});
test('output validation rejects unexpected streams, duration truncation, orientation, and audio changes', () => {
  const result = plan(raw({ container: 'mp4' }));
  const good = normalizeMediaInspection(raw({ container: 'mp4' }));
  assert.equal(validateConversionOutput(good, result), good);
  for (const change of [facts => facts.extraStreams.total++, facts => facts.durationSeconds -= 0.5,
    facts => facts.video.rotationDegrees = 90, facts => facts.audio.channels = 1, facts => facts.audio.sampleRate = 32000]) {
    const bad = structuredClone(good); change(bad); assert.throws(() => validateConversionOutput(bad, result));
  }
});

test('display matrices reject reflection, skew, or missing rotation evidence without changing audio applicability', () => {
  const ordinary = '\n00000000: 65536 0 0\n00000001: 0 65536 0\n00000002: 0 0 1073741824\n';
  for (const [matrix, rotation, expected] of [[ordinary, 0, true], [ordinary.replace('65536', '-65536'), 0, false], [ordinary.replace('65536 0 0', '65536 100 0'), 0, false], [ordinary, undefined, false]]) {
    const source = raw({ video: { side_data_list: [{ side_data_type: 'Display Matrix', displaymatrix: matrix, rotation }] } });
    assert.equal(normalizeMediaInspection(source).video.orientationSupported, expected);
    assert.equal(plan(source).status, expected ? 'executable' : 'unavailable');
    assert.equal(plan(source, 'm4a-aac').status, 'executable');
  }
});

test('output validation catches a lost early audio endpoint and an unnamed six-channel layout', () => {
  const source = raw({ container: 'mp4', audio: { duration: '3', channels: 6, channel_layout: '5.1(side)' } });
  const result = plan(source), good = normalizeMediaInspection(source);
  assert.equal(validateConversionOutput(good, result), good);
  const shiftedEnd = structuredClone(good); shiftedEnd.audio.durationSeconds -= 0.5;
  assert.throws(() => validateConversionOutput(shiftedEnd, result), /audio endpoint/);
  const unnamed = structuredClone(good); unnamed.audio.channelLayout = null;
  assert.throws(() => validateConversionOutput(unnamed, result), /audio channel layout/);
});
