'use strict';

const LAYOUTS = Object.freeze({ mono: 1, stereo: 2, '3.0': 3, quad: 4, '5.0': 5, '5.1': 6, '5.1(side)': 6, '6.1': 7, '7.1': 8 });
const MP3_BITRATES = Object.freeze([32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]);
const AUDIO_CONTAINERS = Object.freeze(['m4a', 'mp3', 'opus', 'flac', 'wav']);

function audioPrecision(audio = {}) {
  const format = /^(u8|s16|s32|s64|flt|dbl)p?$/.exec(audio.sampleFormat || '')?.[1];
  const storageBits = { u8: 8, s16: 16, s32: 32, s64: 64, flt: 32, dbl: 64 }[format];
  if (!storageBits) return { representation: null, bitDepth: null };
  if (['flt', 'dbl'].includes(format)) return { representation: 'float', bitDepth: storageBits };
  const codecBits = /^pcm_[su](8|16|24|32|64)(?:le|be)?$/.exec(audio.codec || '')?.[1];
  const bitDepth = audio.bitsPerRawSample || audio.bitsPerSample || Number(codecBits) || null;
  if (bitDepth == null) return { representation: 'integer', bitDepth: null };
  return bitDepth > 0 && bitDepth <= storageBits
    ? { representation: 'integer', bitDepth } : { representation: null, bitDepth: null };
}

function editorTimeline(source = {}) {
  source ||= {};
  if (source.video) return { durationSeconds: source.durationSeconds, offsetSeconds: 0 };
  const offsetSeconds = source.audio?.startSeconds;
  const durationSeconds = source.audio?.durationSeconds ?? (Number.isFinite(offsetSeconds) ? source.durationSeconds - offsetSeconds : null);
  return { durationSeconds: durationSeconds > 0 ? Math.round(durationSeconds * 1000) / 1000 : null,
    offsetSeconds: Number.isFinite(offsetSeconds) ? offsetSeconds : null };
}

function audioEncodingPolicy(audio, codec, bitrateKbps = null) {
  const unavailable = (error, reason = 'unsupported') => ({ error, reason });
  if (!audio?.codec || !Number.isSafeInteger(audio.streamIndex) || !(audio.sampleRate > 0) || !(audio.channels > 0)) {
    return unavailable('Audio codec, stream identity, channels, or sample rate is incomplete.', 'incomplete');
  }
  const channelLayout = audio.channelLayout || ({ 1: 'mono', 2: 'stereo' }[audio.channels]);
  if (!channelLayout) return unavailable('An audio channel layout is required before encoding.', 'incomplete');
  if (LAYOUTS[channelLayout] !== audio.channels) return unavailable('This audio layout cannot be encoded without a channel change. No downmix is performed.');
  const base = { role: 'audio', index: audio.streamIndex, codec: audio.codec, action: 'encode',
    sampleRate: audio.sampleRate, channels: audio.channels, channelLayout };
  if (codec === 'aac' || codec === 'mp3') {
    if (!['mono', 'stereo', '5.1', '5.1(side)'].includes(channelLayout) || (codec === 'mp3' && audio.channels > 2)) {
      return unavailable('This audio layout cannot be encoded here without a channel change. No downmix is performed.');
    }
    if (codec === 'mp3' && bitrateKbps != null && !MP3_BITRATES.includes(bitrateKbps)) return unavailable(`Choose a supported MP3 bitrate: ${MP3_BITRATES.join(', ')} kbps.`);
    return { stream: { ...base, encoder: codec === 'aac' ? 'aac' : 'libmp3lame', sampleRate: [44100, 48000].includes(audio.sampleRate) ? audio.sampleRate : 48000,
      ...(bitrateKbps != null ? { bitRate: bitrateKbps * 1000 } : codec === 'aac' ? { bitRate: { 1: 128000, 2: 256000, 6: 512000 }[audio.channels] } : { quality: 0 }) }, outputCodec: codec };
  }
  if (codec === 'opus') {
    if (channelLayout === '5.1(side)') return unavailable('Opus cannot preserve the 5.1(side) layout here. Choose FLAC or WAV; speakers will not be remapped.');
    if (bitrateKbps != null && (!Number.isFinite(bitrateKbps) || bitrateKbps < 8 || bitrateKbps > Math.min(1536, 256 * audio.channels))) return unavailable(`Opus bitrate must be between 8 and ${Math.min(1536, 256 * audio.channels)} kbps for this channel count.`);
    return { stream: { ...base, encoder: 'libopus', sampleRate: 48000, bitRate: (bitrateKbps ?? 64 * audio.channels) * 1000 }, outputCodec: 'opus' };
  }
  if (!['flac', 'pcm'].includes(codec)) return unavailable('Choose a supported audio encoder explicitly.');
  if (bitrateKbps != null) return unavailable('FLAC and WAV preserve precision automatically and do not take an audio bitrate.');
  const precision = audioPrecision(audio);
  if (!precision.representation || codec === 'flac' && precision.bitDepth == null) return unavailable(codec === 'flac' ? 'FLAC requires proven integer precision. Choose WAV when the source sample format can be inspected; meaningful precision will not be guessed.' : 'Audio precision is unknown. Choose another source with usable sample-format metadata.');
  if (codec === 'flac') {
    if (precision.representation !== 'integer' || precision.bitDepth > 24) return unavailable('FLAC requires proven integer precision of at most 24 bits here. Choose WAV to preserve this source without reducing precision.');
    if (audio.sampleRate > 655350) return unavailable('FLAC cannot preserve this sample rate. Choose WAV.');
    const bitDepth = precision.bitDepth <= 16 ? 16 : 24;
    return { stream: { ...base, encoder: 'flac', sampleFormat: bitDepth === 16 ? 's16' : 's32', bitDepth, representation: 'integer', compressionLevel: 5 }, outputCodec: 'flac' };
  }
  // An integer decoder format bounds its stored samples even when meaningful
  // precision is unknown. WAV can preserve that storage width without claiming
  // a measured source bit depth; FLAC deliberately requires stronger evidence.
  const preservedBits = precision.bitDepth ?? ({ u8: 8, s16: 16, s32: 32, s64: 64 })[audio.sampleFormat.replace(/p$/, '')];
  const bitDepth = precision.representation === 'float' ? precision.bitDepth : [8, 16, 24, 32].find(bits => bits >= preservedBits);
  if (!bitDepth) return unavailable('WAV cannot preserve this integer precision with the supported encoders.');
  const encoder = precision.representation === 'float' ? `pcm_f${bitDepth}le` : bitDepth === 8 ? 'pcm_u8' : `pcm_s${bitDepth}le`;
  return { stream: { ...base, encoder, bitDepth, representation: precision.representation,
    sampleFormat: precision.representation === 'float' ? bitDepth === 64 ? 'dbl' : 'flt' : bitDepth === 8 ? 'u8' : bitDepth <= 16 ? 's16' : 's32',
    bitRate: audio.sampleRate * audio.channels * bitDepth }, outputCodec: encoder };
}

module.exports = { LAYOUTS, AUDIO_CONTAINERS, MP3_BITRATES, audioPrecision, audioEncodingPolicy, editorTimeline };
