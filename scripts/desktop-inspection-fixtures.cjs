'use strict';
// Development reference only; no dependency from the native application.
const fs = require('node:fs');
const path = require('node:path');
const media = require('../media-inspection');
const caps = require('../ffmpeg-capabilities');
const fixturePath = path.join(__dirname, '..', 'test', 'fixtures', 'desktop-inspection-v1.json');
function evaluate({ operation, input }) {
  if (operation === 'inspection') return { value: media.normalizeMediaInspection(input.raw, { sourceSize: input.sourceSize }) };
  if (operation === 'frame-rate') return { value: media.parseFrameRate(input) };
  if (operation === 'capabilities') {
    try {
      const c = { available: true, version: caps.parseFfmpegVersion(input.version), encoders: caps.parseCodecCapabilities(input.encoders),
        decoders: caps.parseCodecCapabilities(input.decoders), decoderCodecs: caps.parseDecoderCapabilities(input.decoders), muxers: caps.parseMuxerCapabilities(input.muxers) };
      if (!c.version || !c.encoders.size || !c.decoders.size || !c.muxers.size) throw new Error('unparseable');
      return { value: { ...c, encoders: [...c.encoders], decoders: [...c.decoders], muxers: [...c.muxers], decoderCodecs: Object.fromEntries(c.decoderCodecs),
        software: Object.fromEntries(['h264', 'aac', 'av1', 'mp3', 'hevc', 'vp9', 'unknown'].map(codec => [codec, caps.hasSoftwareDecoder(c, codec)])), summary: caps.publicCapabilitySummary(c) } };
    } catch { return { error: { code: 'CAPABILITY_UNPARSEABLE', message: 'FFmpeg capability listings could not be recognized.' } }; }
  }
  throw new Error('Unknown fixture operation.');
}
function cases() {
  const cases = [];
  const add = (id, operation, input) => cases.push({ id, operation, input });
  const video = { index: 2, codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080, avg_frame_rate: '30000/1001', pix_fmt: 'yuv420p', start_time: '0', duration: '3' };
  const audio = { index: 4, codec_type: 'audio', codec_name: 'pcm_s24le', sample_rate: '44100', channels: 2, channel_layout: 'stereo', sample_fmt: 's32', bits_per_sample: 24, bits_per_raw_sample: '24', start_time: '0.5', duration: '2.5' };
  const base = { format: { filename: '/synthetic/private-input.mp4', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', format_long_name: 'QuickTime / MOV', duration: '99', size: '12345', tags: { major_brand: 'isom' } }, streams: [video, audio], chapters: [] };
  const inspect = (name, raw, sourceSize) => add(`inspection/${name}`, 'inspection', { raw, ...(sourceSize !== undefined ? { sourceSize } : {}) });
  inspect('base', base, 50000);
  for (const major_brand of ['qt  ', '3gp6', 'avif', 'm4a ', 'mjp2', 'xxxx', 'isom']) {
    inspect(`brand/${major_brand.trim()}`, { ...base, format: { ...base.format, tags: { major_brand, compatible_brands: 'isomiso2mp41' } } });
  }
  inspect('ambiguous-iso', { ...base, format: { ...base.format, tags: {} } });
  inspect('compatible-brand', { ...base, format: { ...base.format, tags: { compatible_brands: 'xxxx, mp42' } } });
  for (const format_name of ['matroska,webm', 'wav', 'mp3', 'flac', 'aac', 'aiff', 'ogg', 'ape', 'caf', 'unknown']) {
    inspect(`audio/${format_name}`, { format: { format_name, start_time: '1', duration: '5' }, streams: [{ ...audio, start_time: undefined, duration: undefined }] });
  }
  inspect('audio-artwork', { ...base, streams: [audio, { ...video, disposition: { attached_pic: 1 } }] });
  inspect('timed-thumbnails', { ...base, streams: [{ ...video, disposition: { timed_thumbnails: '1' } }, audio] });
  inspect('invalid-first-stream', { ...base, streams: [{ ...video, index: -1 }, { ...video, width: 0 }, video, { ...audio, index: 'NaN' }, audio] });
  inspect('extra-tracks', { ...base, streams: [video, audio, { ...audio, index: 5 }, { index: 6, codec_type: 'subtitle' }, { index: 7, codec_type: 'data' }], chapters: [{ id: 1 }] });
  inspect('missing-streams', {}); inspect('empty-streams', { streams: [] });
  inspect('untimed-video', { streams: [{ ...video, duration: undefined }] });
  inspect('incomplete-video', { streams: [{ index: 0, codec_type: 'video' }, audio] });
  inspect('missing-audio-metadata', { streams: [{ index: 0, codec_type: 'audio' }] });
  for (const value of ['N/A', '0x10', true, '', ' 1.2e2 ', '9007199254740992', '-1', '0', null]) {
    inspect(`numeric/${JSON.stringify(value)}`, { format: { format_name: 'wav', duration: value, size: value }, streams: [{ index: 0, codec_type: 'audio', sample_rate: value, channels: value, bit_rate: value, bits_per_sample: value, bits_per_raw_sample: value }] });
  }
  inspect('bounded-text', { ...base, streams: [{ ...video, codec_name: 'H264\0\n', profile: 'x'.repeat(150), sample_aspect_ratio: '4:3' }, { ...audio, sample_fmt: 's32;filter', bits_per_sample: 999, bits_per_raw_sample: 0, channel_layout: '\tstereo\n' }] });
  for (const start of [5, -2]) {
    inspect(`shift/${start}`, { ...base, format: { ...base.format, start_time: String(start) }, streams: [{ ...video, start_time: String(start), duration: '3' }, { ...audio, start_time: String(start + 0.5), duration: '3' }] });
  }
  inspect('matroska-endpoint', { format: { format_name: 'matroska,webm', start_time: '4', duration: '9' }, streams: [{ ...audio, start_time: '4.5', duration: undefined, tags: { DURATION: '00:00:09.000000000' } }] });
  inspect('invalid-duration-tag', { format: { format_name: 'matroska', duration: '9' }, streams: [{ ...audio, duration: undefined, tags: { DURATION: '999999999:00:00' } }] });
  const matrix = '00000000: 0 -65536 0\n00000001: 65536 0 0\n00000002: 0 0 1073741824';
  for (const [name, fields] of [
    ['rotation', { tags: { rotate: '-90' } }], ['nonorthogonal', { tags: { rotate: '45' } }],
    ['matrix', { side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90, displaymatrix: matrix }] }],
    ['reflection', { side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90, displaymatrix: matrix.replace('-65536', '65536') }] }],
    ['malformed-matrix', { side_data_list: [{ side_data_type: 'Display Matrix', rotation: 0, displaymatrix: 'not a matrix' }] }],
    ['hdr-transfer', { color_transfer: 'SMPTE2084' }], ['hdr-side-data', { side_data_list: [{ side_data_type: 'Mastering display metadata' }] }],
    ['alpha-format', { pix_fmt: 'gbrap10le' }], ['alpha-tag', { tags: { alpha_mode: 1 } }],
    ['side-limit', { side_data_list: [...Array.from({ length: 32 }, () => ({})), { side_data_type: 'Mastering display metadata' }] }],
  ]) inspect(name, { ...base, streams: [{ ...video, ...fields }, audio] });
  for (const value of ['30000/1001', '0/0', '24', 29.97, '0x10', '1/0', '-24', '1e2', 'N/A', null, true]) add(`frame/${JSON.stringify(value)}`, 'frame-rate', value);
  const listings = { version: 'ffmpeg version 7.1-test Copyright\n', encoders: ' V..... libx264 software\n A..... aac audio\n A..... libopus Opus\n A..... flac FLAC\n', decoders: ' V....D h264 software\n A....D aac audio\n A....D mp3float MPEG audio (codec mp3)\n V....D libdav1d AV1 software (codec av1)\n', muxers: ' E mp4 MP4\n E ogg Ogg\n DE matroska,webm Matroska\n E flac FLAC\n E wav WAV\n' };
  add('capabilities/base', 'capabilities', listings);
  add('capabilities/hardware-and-aliases', 'capabilities', { ...listings, decoders: listings.decoders + ' V....D h264_cuvid CUDA (codec h264)\n V....D av1 AV1\n V....D hevc_qsv Quick Sync (codec hevc)\n V....D vp9_vulkan hardware (codec vp9)\n V....D hevc HEVC software\n' });
  add('capabilities/hardware-only', 'capabilities', { ...listings, decoders: ' V....D av1 AV1\n V....D h264_d3d11va hardware (codec h264)\n' });
  add('capabilities/no-alias-guessing', 'capabilities', { ...listings, decoders: ' A....D mp3float MP3 without explicit alias\n' });
  add('capabilities/headers-duplicates', 'capabilities', { ...listings, encoders: 'Encoders:\n V..... = Video\n ------\n' + listings.encoders + ' A..... AAC duplicate\n', muxers: ' E = Muxing supported\n D ignored demuxer\n' + listings.muxers + ' E mp4 duplicate\n' });
  for (const field of ['version', 'encoders', 'decoders', 'muxers']) add(`capabilities/missing-${field}`, 'capabilities', { ...listings, [field]: '' });
  add('capabilities/invalid-flags', 'capabilities', { ...listings, encoders: ' AV.... bad invalid\n v..... lower invalid\n A..... ;shell invalid\n' });
  add('capabilities/long-line', 'capabilities', { ...listings, encoders: ' A..... aac ' + 'x'.repeat(4097) });
  return cases.map(item => ({ ...item, expected: evaluate(item) }));
}
if (require.main === module) {
  if (process.argv[2] !== '--write') throw new Error('Pass --write to deliberately refresh shared fixtures.');
  const data = { schemaVersion: 1, reference: { release: 'v2.7.0', commit: '7e192ad7ddee6478b517a74174cedf6dccd85a19', modules: ['media-inspection.js', 'ffmpeg-capabilities.js'] }, cases: cases() };
  fs.writeFileSync(fixturePath, JSON.stringify(data, null, 2) + '\n'); console.log(`Wrote ${data.cases.length} inspection/capability cases.`);
}
module.exports = { evaluate, fixturePath };
