'use strict';

// Development reference only. The desktop application never loads this module.
const fs = require('node:fs');
const path = require('node:path');
const audio = require('../audio-policy');
const edit = require('../public/edit-plan');
const fixturePath = path.join(__dirname, '..', 'test', 'fixtures', 'desktop-policy-v1.json');

function evaluate({ operation, input }) {
  try {
    switch (operation) {
      case 'precision': return { value: audio.audioPrecision(input) };
      case 'audio': return { value: audio.audioEncodingPolicy(input.audio, input.codec, input.bitrateKbps) };
      case 'timeline': return { value: audio.editorTimeline(input) };
      case 'edit': {
        const plan = edit.normalizeEditPlan(input.plan, input.durationSeconds, { rejectNoop: input.rejectNoop });
        return { value: { plan, durationSeconds: edit.totalRetainedDuration(plan), fullDuration: edit.isFullDurationEditPlan(plan, input.durationSeconds) } };
      }
      default: throw new Error('Unknown fixture operation.');
    }
  } catch (error) {
    if (!error.code) throw error;
    return { error: { code: error.code, message: error.message } };
  }
}

function cases() {
  const result = [];
  const add = (id, operation, input) => result.push({ id, operation, input });
  const base = { streamIndex: 4, codec: 'pcm_s24le', sampleRate: 44100, channels: 2, channelLayout: 'stereo', sampleFormat: 's32', bitsPerSample: 24, bitsPerRawSample: 24 };
  const precisions = [
    ['u8', { codec: 'pcm_u8', sampleFormat: 'u8', bitsPerSample: 8, bitsPerRawSample: null }],
    ['s16', { codec: 'pcm_s16le', sampleFormat: 's16', bitsPerSample: 16, bitsPerRawSample: null }],
    ['s24', {}],
    ['s32', { codec: 'pcm_s32le', bitsPerSample: 32, bitsPerRawSample: 32 }],
    ['float32', { codec: 'pcm_f32le', sampleFormat: 'flt', bitsPerSample: 32, bitsPerRawSample: null }],
    ['float64', { codec: 'pcm_f64le', sampleFormat: 'dblp', bitsPerSample: 64, bitsPerRawSample: null }],
    ['integer64', { codec: 'pcm_s64le', sampleFormat: 's64', bitsPerSample: 64, bitsPerRawSample: null }],
    ['unknown', { codec: 'flac', bitsPerSample: null, bitsPerRawSample: null }],
    ['codec-evidence', { codec: 'pcm_s24be', bitsPerSample: null, bitsPerRawSample: null }],
    ['raw-precedence', { bitsPerSample: 32, bitsPerRawSample: 20 }],
    ['inconsistent', { sampleFormat: 's16', bitsPerSample: 24, bitsPerRawSample: 24 }],
    ['missing-format', { sampleFormat: null }],
    ['invalid-format', { sampleFormat: 's32;filter' }],
    ['planar', { sampleFormat: 's32p' }],
  ];
  for (const [name, fields] of precisions) {
    const source = { ...base, ...fields };
    add(`precision/${name}`, 'precision', source);
    for (const codec of ['flac', 'pcm']) add(`audio/${name}/${codec}`, 'audio', { audio: source, codec });
  }
  for (const [layout, channels] of Object.entries(audio.LAYOUTS)) {
    for (const codec of ['aac', 'mp3', 'opus', 'flac', 'pcm']) {
      add(`layout/${layout}/${codec}`, 'audio', { audio: { ...base, channelLayout: layout, channels }, codec });
    }
  }
  for (const [name, fields] of [
    ['mono-inferred', { channels: 1, channelLayout: null }],
    ['stereo-inferred', { channelLayout: null }],
    ['surround-unknown', { channels: 6, channelLayout: null }],
    ['layout-mismatch', { channels: 6 }],
    ['layout-unsupported', { channels: 4, channelLayout: '4.0' }],
    ['missing-stream', { streamIndex: null }],
    ['missing-codec', { codec: null }],
    ['missing-rate', { sampleRate: null }],
    ['zero-rate', { sampleRate: 0 }],
    ['zero-channels', { channels: 0 }],
  ]) add(`validation/${name}`, 'audio', { audio: { ...base, ...fields }, codec: 'opus' });
  for (const [codec, rates] of [['opus', [7, 8, 8.5, 512, 513]], ['mp3', [31, 32, 64, 320, 321]], ['aac', [128]], ['flac', [64]], ['pcm', [64]], ['unknown', [null]]]) {
    for (const bitrateKbps of rates) add(`bitrate/${codec}/${bitrateKbps}`, 'audio', { audio: base, codec, bitrateKbps });
  }
  for (const channels of [1, 6, 8]) {
    const channelLayout = { 1: 'mono', 6: '5.1', 8: '7.1' }[channels];
    for (const bitrateKbps of [256 * channels, Math.min(1536, 256 * channels) + 1]) {
      add(`bitrate/opus/${channels}/${bitrateKbps}`, 'audio', { audio: { ...base, channels, channelLayout }, codec: 'opus', bitrateKbps });
    }
  }
  for (const sampleRate of [22050, 48000, 96000, 655350, 655351]) {
    for (const codec of ['aac', 'opus', 'flac', 'pcm']) add(`rate/${sampleRate}/${codec}`, 'audio', { audio: { ...base, sampleRate }, codec });
  }
  for (const [name, source] of [
    ['video-clock', { durationSeconds: 5, video: {}, audio: { startSeconds: 0.5, durationSeconds: 4 } }],
    ['audio-clock', { durationSeconds: 5, audio: { startSeconds: 0.5, durationSeconds: 4 } }],
    ['audio-endpoint', { durationSeconds: 5, audio: { startSeconds: 0.5 } }],
    ['audio-missing-clock', { durationSeconds: 5, audio: {} }],
    ['audio-negative-start', { durationSeconds: 5, audio: { startSeconds: -0.5, durationSeconds: 5.5005 } }],
    ['audio-ended', { durationSeconds: 5, audio: { startSeconds: 5 } }],
  ]) add(`timeline/${name}`, 'timeline', source);
  const plan = pairs => ({ version: 1, keepRanges: pairs.map(([startSeconds, endSeconds]) => ({ startSeconds, endSeconds })) });
  const edits = [
    ['full', plan([[0, 10]])], ['cut', plan([[1.23449, 9.87651]])],
    ['gaps', plan([[0, 2], [4, 6.125], [8, 9]])], ['adjacent', plan([[0, 2], [2, 4]])],
    ['rounded-gap', plan([[0, 2.0004], [2.00049, 4]])],
    ['raw-overlap', plan([[0, 2.00049], [2.0004, 4]])],
    ['out-of-order', plan([[4, 6], [1, 2]])], ['negative', plan([[-0.0001, 2]])],
    ['outside', plan([[0, 10.0001]])], ['empty', plan([])], ['inverted', plan([[3, 2]])],
    ['zero-length', plan([[2, 2]])], ['rounded-empty', plan([[2.0001, 2.0004]])],
    ['string-time', plan([['1', 2]])], ['null-time', plan([[null, 2]])],
    ['wrong-version', { version: 2, keepRanges: [] }], ['string-version', { version: '1', keepRanges: [] }],
    ['null', null], ['array', []], ['missing-ranges', { version: 1 }],
    ['not-an-array', { version: 1, keepRanges: {} }], ['array-range', { version: 1, keepRanges: [[0, 1]] }],
  ];
  for (const [name, value] of edits) add(`edit/${name}`, 'edit', { plan: value, durationSeconds: 10 });
  add('edit/reject-noop', 'edit', { plan: plan([[0, 10]]), durationSeconds: 10, rejectNoop: true });
  add('edit/zero-duration', 'edit', { plan: plan([[0, 1]]), durationSeconds: 0 });
  add('edit/rounding-boundary', 'edit', { plan: plan([[0.0005, 1.0015]]), durationSeconds: 2 });
  for (const count of [50, 51]) add(`edit/range-limit/${count}`, 'edit', { plan: plan(Array.from({ length: count }, (_, i) => [i * 2, i * 2 + 1])), durationSeconds: 102 });
  return result.map(item => ({ ...item, expected: evaluate(item) }));
}

if (require.main === module) {
  if (process.argv[2] !== '--write') throw new Error('Pass --write to deliberately refresh the shared reference fixtures.');
  const data = { schemaVersion: 1, reference: { release: 'v2.7.0', commit: '7e192ad7ddee6478b517a74174cedf6dccd85a19', modules: ['audio-policy.js', 'public/edit-plan.js'] }, cases: cases() };
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${data.cases.length} synthetic parity cases.`);
}
module.exports = { evaluate, fixturePath };
