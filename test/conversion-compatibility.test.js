'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BROAD_MP4_TARGET,
  assessBroadCompatibilityMp4
} = require('../conversion-compatibility');

const FULL_CAPABILITIES = Object.freeze({
  available: true,
  encoders: new Set(['libx264', 'aac', 'libopus', 'libmp3lame', 'flac']),
  decoders: new Set(['h264', 'hevc', 'vp9', 'aac', 'opus', 'mp3', 'flac']),
  muxers: new Set(['mp4', 'matroska', 'webm', 'mp3', 'flac', 'wav'])
});

function videoInspection({
  formatNames = ['mov', 'mp4'],
  videoCodec = 'h264',
  pixelFormat = 'yuv420p',
  audioCodec = 'aac',
  audioTracks = audioCodec == null ? 0 : 1
} = {}) {
  return {
    mediaKind: 'video',
    formatNames,
    video: { codec: videoCodec, pixelFormat },
    audio: audioCodec == null ? null : { codec: audioCodec },
    trackCounts: { video: 1, audio: audioTracks, subtitle: 0 }
  };
}

test('Broad Compatibility MP4 recognizes proven already-compatible video', () => {
  const assessment = assessBroadCompatibilityMp4(videoInspection(), FULL_CAPABILITIES);

  assert.equal(assessment.target, BROAD_MP4_TARGET);
  assert.equal(assessment.status, 'already-compatible');
  assert.deepEqual(assessment.actions, { container: 'keep', video: 'copy', audio: 'copy' });
  assert.match(assessment.explanation, /no conversion/i);
});

test('Broad Compatibility MP4 distinguishes remux from re-encoding', () => {
  const assessment = assessBroadCompatibilityMp4(
    videoInspection({ formatNames: ['matroska', 'webm'] }),
    FULL_CAPABILITIES
  );

  assert.equal(assessment.status, 'remux');
  assert.deepEqual(assessment.actions, { container: 'remux', video: 'copy', audio: 'copy' });
  assert.match(assessment.explanation, /remain unchanged|remux/i);
  assert.doesNotMatch(assessment.explanation, /re-encod/i);
});

test('Broad Compatibility MP4 separates audio-only and video-only re-encoding needs', () => {
  const audioOnlyChange = assessBroadCompatibilityMp4(
    videoInspection({ audioCodec: 'opus' }),
    FULL_CAPABILITIES
  );
  const videoOnlyChange = assessBroadCompatibilityMp4(
    videoInspection({ videoCodec: 'hevc', pixelFormat: 'yuv420p', audioCodec: null }),
    FULL_CAPABILITIES
  );

  assert.equal(audioOnlyChange.status, 'reencode-audio');
  assert.deepEqual(audioOnlyChange.actions, { container: 'mp4', video: 'copy', audio: 'reencode' });
  assert.equal(videoOnlyChange.status, 'reencode-video');
  assert.deepEqual(videoOnlyChange.actions, { container: 'mp4', video: 'reencode', audio: 'none' });
});

test('Broad Compatibility MP4 identifies combined video and audio re-encoding', () => {
  const assessment = assessBroadCompatibilityMp4(
    videoInspection({ videoCodec: 'vp9', pixelFormat: 'yuv444p', audioCodec: 'opus' }),
    FULL_CAPABILITIES
  );

  assert.equal(assessment.status, 'reencode-video-and-audio');
  assert.deepEqual(assessment.actions, {
    container: 'mp4', video: 'reencode', audio: 'reencode'
  });
});

test('missing metadata remains unknown and audio media is not applicable to the video target', () => {
  const unknown = assessBroadCompatibilityMp4(
    videoInspection({ videoCodec: 'h264', pixelFormat: null }),
    FULL_CAPABILITIES
  );
  const audio = assessBroadCompatibilityMp4({
    mediaKind: 'audio',
    video: null,
    audio: { codec: 'flac' },
    trackCounts: { video: 0, audio: 1, subtitle: 0 }
  }, FULL_CAPABILITIES);

  assert.equal(unknown.status, 'unknown');
  assert.match(unknown.explanation, /not have enough reported metadata/i);
  assert.equal(audio.status, 'not-applicable');
  assert.match(audio.explanation, /audio-only/i);
});

test('missing installed software capability makes otherwise-known work unavailable', () => {
  const assessment = assessBroadCompatibilityMp4(
    videoInspection({ videoCodec: 'hevc', audioCodec: 'opus' }),
    {
      available: true,
      encoders: new Set(['aac']),
      decoders: new Set(['opus']),
      muxers: new Set()
    }
  );

  assert.equal(assessment.status, 'unavailable');
  assert.deepEqual(assessment.actions, {
    container: 'mp4', video: 'reencode', audio: 'reencode'
  });
  assert.deepEqual(assessment.missing, [
    'MP4 muxer',
    'source video decoder',
    'H.264 software encoder'
  ]);
  assert.match(assessment.explanation, /required local decoders, encoders, or the MP4 muxer/i);
});

test('hardware encoders do not substitute for the reliable software target', () => {
  const assessment = assessBroadCompatibilityMp4(
    videoInspection({ videoCodec: 'hevc', audioCodec: null }),
    {
      available: true,
      encoders: new Set(['h264_nvenc']),
      decoders: new Set(['hevc']),
      muxers: new Set(['mp4'])
    }
  );

  assert.equal(assessment.status, 'unavailable');
  assert.ok(assessment.missing.includes('H.264 software encoder'));
});
