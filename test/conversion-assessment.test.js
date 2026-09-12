'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMediaInspection } = require('../media-inspection');
const { parseFrameRate } = require('../media-inspection');
const { normalizeInspection } = require('../media-workspace');
const { assessBroadCompatibilityMp4: assess } = require('../conversion-compatibility');
const { parseDecoderCapabilities } = require('../ffmpeg-capabilities');
const { formatBytes } = require('../public/conversion-inspector');

const FAMILY = 'mov,mp4,m4a,3gp,3g2,mj2';
const VIDEO = { index: 0, codec_type: 'video', codec_name: 'h264', width: 160, height: 90, pix_fmt: 'yuv420p' };
const AUDIO = { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 };
const COPY = { available: true, encoders: new Set(), decoders: new Set(), muxers: new Set(['mp4']) };
function source(format = {}, streams = [VIDEO, AUDIO]) {
  return { format: { format_name: FAMILY, duration: '5', tags: { major_brand: 'isom' }, ...format }, streams };
}

for (const [name, format, kind, status] of [
  ['MP4 isom', {}, 'mp4', 'already-compatible'],
  ['QuickTime wins over shared aliases and compatible isom', { tags: { major_brand: 'qt  ', compatible_brands: 'qt  isom' } }, 'mov', 'remux'],
  ['ISO aliases without brands', { tags: {} }, 'unknown', 'unknown'],
  ['misleading filename and label', { filename: 'clip.mp4', format_long_name: 'MP4', tags: {} }, 'unknown', 'unknown'],
  ['unknown demuxer', { format_name: 'unrecognized', tags: {} }, 'unknown', 'unknown'],
  ['Matroska', { format_name: 'matroska,webm', tags: {} }, 'matroska', 'remux'],
  ['AVI', { format_name: 'avi', tags: {} }, 'avi', 'remux'],
  ['3GP is not MP4', { tags: { major_brand: '3gp6', compatible_brands: 'isom' } }, '3gp', 'remux'],
  ['AVIF is not MP4', { tags: { major_brand: 'avif', compatible_brands: 'mif1isom' } }, 'other-iso', 'remux'],
  ['HEIC is not MP4', { tags: { major_brand: 'heic', compatible_brands: 'isom' } }, 'other-iso', 'remux'],
  ['malformed brand is not truncated into isom', { tags: { major_brand: 'isom-invalid' } }, 'unknown', 'unknown']
]) {
  test(`container evidence: ${name}`, () => {
    for (const streams of [[VIDEO, AUDIO], [VIDEO]]) {
      const inspection = normalizeMediaInspection(source(format, streams));
      assert.equal(inspection.container.kind, kind);
      const result = assess(inspection, COPY);
      assert.equal(result.status, status);
      if (status === 'remux') {
        assert.equal(result.actions.video, 'copy');
        assert.deepEqual(result.missing, []);
        assert.equal(assess(inspection, { ...COPY, muxers: new Set() }).status, 'unavailable');
      }
    }
  });
}

for (const value of [undefined, null, '', '  ', NaN, Infinity, 'Infinity', '12oops', true, [], {}, '0x10', -1, 1.5]) {
  test(`missing integer metadata: ${String(value)}`, () => {
    const raw = source({}, [{ ...AUDIO, index: value }]);
    assert.equal(normalizeMediaInspection(raw).audio, null, 'never invent an index');
    const inspection = normalizeMediaInspection(source({}, [{ ...AUDIO, sample_rate: value, channels: value, bit_rate: value }]));
    assert.equal(inspection.audio.sampleRate, null);
    assert.equal(inspection.audio.channels, null);
    assert.equal(inspection.audio.bitRate, null);
  });
}

test('real zero survives only in fields permitting zero, and source stat size takes precedence', () => {
  const raw = source({ size: '9999' }, [{ ...AUDIO, index: 0, sample_rate: 0, channels: '0', bit_rate: 0 }]);
  const inspection = normalizeMediaInspection(raw);
  assert.equal(inspection.audio.streamIndex, 0);
  assert.equal(inspection.audio.sampleRate, null);
  assert.equal(inspection.audio.channels, null);
  assert.equal(inspection.audio.bitRate, 0);
  assert.equal(inspection.sourceSize, 9999);
  for (const sourceSize of [null, undefined, '', ' ', NaN, Infinity, 'bad', -1]) {
    assert.equal(normalizeMediaInspection(raw, { sourceSize }).sourceSize, 9999);
  }
  assert.equal(normalizeMediaInspection(raw, { sourceSize: 123 }).sourceSize, 123);
  assert.equal(normalizeMediaInspection(raw, { sourceSize: 0 }).sourceSize, 0);
  for (const value of [null, undefined, '', ' ']) assert.equal(formatBytes(value), 'Unknown');
  assert.equal(formatBytes(0), '0 B');
});

test('frame-rate parsing rejects malformed numeric objects and preserves valid rational cadence', () => {
  for (const value of [null, undefined, '', ' ', [], [30], {}, true, Infinity, 'NaN', '0/0', '30/0', '0x10']) {
    assert.equal(parseFrameRate(value), null);
  }
  assert.equal(parseFrameRate('30000/1001'), 29.97);
});

test('unreported streams cannot prove that the video target is inapplicable', () => {
  const inspection = normalizeMediaInspection({ format: {} });
  assert.equal(inspection.trackCounts.video, null);
  assert.equal(assess(inspection, COPY).status, 'unknown');
});

test('reported incomplete video is not audio-only, and Edit remains strict', () => {
  for (const missing of [{ index: null }, { index: undefined }, { width: null }, { height: '' }, { width: 0.5 }]) {
    const raw = source({}, [{ ...VIDEO, ...missing }, AUDIO]);
    const inspection = normalizeMediaInspection(raw);
    assert.equal(inspection.video, null);
    assert.equal(inspection.trackCounts.video, 1);
    assert.equal(inspection.mediaKind, 'unknown');
    assert.equal(assess(inspection, COPY).status, 'unknown');
    assert.throws(() => normalizeInspection(raw), /usable video stream/);
  }
  for (const disposition of [{ attached_pic: 1 }, { timed_thumbnails: 1 }]) {
    const raw = source({}, [{ ...VIDEO, disposition }, AUDIO]);
    const inspection = normalizeMediaInspection(raw);
    assert.equal(inspection.mediaKind, 'audio');
    assert.equal(assess(inspection, COPY).status, 'not-applicable');
    assert.throws(() => normalizeInspection(raw));
  }
});

test('decoder listing relationships distinguish software from advertised hardware', () => {
  const decoderCodecs = parseDecoderCapabilities(`
 V..... libdav1d dav1d AV1 decoder by VideoLAN (codec av1)
 V....D av1 Alliance for Open Media AV1
 V..... av1_cuvid Nvidia CUVID AV1 decoder (codec av1)
 V....D av1_qsv AV1 video (Intel Quick Sync Video acceleration) (codec av1)
 A....D mp3float MP3 (MPEG audio layer 3) (codec mp3)
 V....D h264 H.264 / AVC / MPEG-4 AVC
 A....D aac AAC
`);
  assert.deepEqual(decoderCodecs.get('av1'), [
    { name: 'libdav1d', software: true }, { name: 'av1', software: false },
    { name: 'av1_cuvid', software: false }, { name: 'av1_qsv', software: false }
  ]);
  assert.deepEqual(decoderCodecs.get('mp3'), [{ name: 'mp3float', software: true }]);
  assert.deepEqual(decoderCodecs.get('h264'), [{ name: 'h264', software: true }]);
  const caps = { ...COPY, encoders: new Set(['libx264', 'aac']), decoderCodecs };
  const av1 = normalizeMediaInspection(source({}, [{ ...VIDEO, codec_name: 'av1' }, AUDIO]));
  assert.equal(assess(av1, caps).status, 'reencode-video');
  const mp3 = normalizeMediaInspection(source({}, [VIDEO, { ...AUDIO, codec_name: 'mp3' }]));
  assert.equal(assess(mp3, caps).status, 'reencode-audio');
  const hardware = parseDecoderCapabilities(' V....D av1 Alliance for Open Media AV1\n V..... av1_cuvid Nvidia CUVID AV1 decoder (codec av1)\n');
  assert.deepEqual(assess(av1, { ...caps, decoderCodecs: hardware }).missing, ['source video decoder']);
});

test('assessment requires only capabilities for the proposed operation', () => {
  const audio = normalizeMediaInspection(source({}, [VIDEO, { ...AUDIO, codec_name: 'mp3' }]));
  const audioCaps = { ...COPY, encoders: new Set(['aac']), decoderCodecs: parseDecoderCapabilities(' A....D mp3float MP3 (codec mp3)\n') };
  assert.equal(assess(audio, audioCaps).status, 'reencode-audio', 'copied video needs no decoder or encoder');
  const video = normalizeMediaInspection(source({}, [{ ...VIDEO, codec_name: 'hevc' }, AUDIO]));
  const videoCaps = { ...COPY, encoders: new Set(['libx264']), decoderCodecs: parseDecoderCapabilities(' V....D hevc H.265 / HEVC\n') };
  assert.equal(assess(video, videoCaps).status, 'reencode-video', 'copied audio needs no decoder or encoder');
  assert.deepEqual(assess(video, { ...videoCaps, muxers: new Set() }).missing, ['MP4 muxer']);
});

test('discovery failure is unknown capability evidence, while a known no-op needs no discovery', () => {
  const mov = normalizeMediaInspection(source({ tags: { major_brand: 'qt' } }));
  const failure = assess(mov, { available: false });
  assert.equal(failure.status, 'unknown');
  assert.equal(failure.actions.container, 'remux', 'operation requirements remain known');
  assert.deepEqual(failure.missing, []);
  assert.match(failure.title, /could not check/i);
  const missing = assess(mov, { ...COPY, muxers: new Set() });
  assert.equal(missing.status, 'unavailable');
  assert.deepEqual(missing.missing, ['MP4 muxer']);
  assert.equal(assess(normalizeMediaInspection(source()), { available: false }).status, 'already-compatible');
});
