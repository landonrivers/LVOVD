'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMediaInspection,
  isPrimaryVideoCandidate
} = require('../media-inspection');

test('generic timed video normalization retains bounded product media facts', () => {
  const inspection = normalizeMediaInspection({
    format: {
      filename: 'C:\\private\\never-expose.mp4',
      duration: '12.34567',
      size: '9999',
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      format_long_name: 'QuickTime / MOV',
      tags: { major_brand: 'isom' }
    },
    streams: [
      {
        index: 2,
        codec_type: 'video',
        codec_name: 'h264',
        profile: 'High',
        width: 1920,
        height: 1080,
        avg_frame_rate: '30000/1001',
        pix_fmt: 'yuv420p'
      },
      {
        index: 4,
        codec_type: 'audio',
        codec_name: 'aac',
        sample_rate: '48000',
        channels: 2,
        channel_layout: 'stereo',
        bit_rate: '256000'
      },
      { index: 6, codec_type: 'subtitle', codec_name: 'mov_text' }
    ]
  }, { sourceSize: 12_345 });

  assert.deepEqual(inspection, {
    mediaKind: 'video',
    durationSeconds: 12.346,
    sourceSize: 12_345,
    format: 'MP4',
    formatNames: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
    video: {
      streamIndex: 2,
      codec: 'h264',
      profile: 'High',
      width: 1920,
      height: 1080,
      frameRate: 29.97,
      pixelFormat: 'yuv420p'
    },
    audio: {
      streamIndex: 4,
      codec: 'aac',
      sampleRate: 48000,
      channels: 2,
      channelLayout: 'stereo',
      bitRate: 256000
    },
    trackCounts: { video: 1, audio: 1, subtitle: 1 }
  });
  assert.doesNotMatch(JSON.stringify(inspection), /private|never-expose/i);
});

test('generic audio-only inspection succeeds while attached artwork is not primary video', () => {
  const inspection = normalizeMediaInspection({
    format: { duration: '180', format_name: 'mp3', format_long_name: 'MP2/3' },
    streams: [
      {
        index: 0,
        codec_type: 'audio',
        codec_name: 'mp3',
        sample_rate: '44100',
        channels: 2,
        channel_layout: 'stereo',
        bit_rate: '192000'
      },
      {
        index: 1,
        codec_type: 'video',
        codec_name: 'mjpeg',
        width: 1200,
        height: 1200,
        disposition: { attached_pic: 1 }
      }
    ]
  });

  assert.equal(inspection.mediaKind, 'audio');
  assert.equal(inspection.video, null);
  assert.equal(inspection.audio.codec, 'mp3');
  assert.deepEqual(inspection.trackCounts, { video: 0, audio: 1, subtitle: 0 });
  assert.equal(isPrimaryVideoCandidate({
    index: 1,
    codec_type: 'video',
    width: 100,
    height: 100,
    disposition: { timed_thumbnails: 1 }
  }), false);
});

test('untimed visual and non-media inspection remain conservative unsupported results', () => {
  const still = normalizeMediaInspection({
    format: { format_name: 'image2' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'png', width: 800, height: 600 }
    ]
  });
  const nonMedia = normalizeMediaInspection({ format: {}, streams: [] });

  assert.equal(still.mediaKind, 'unsupported');
  assert.equal(still.durationSeconds, null);
  assert.equal(still.video.codec, 'png');
  assert.equal(nonMedia.mediaKind, 'unsupported');
  assert.equal(nonMedia.video, null);
  assert.equal(nonMedia.audio, null);
  assert.deepEqual(nonMedia.trackCounts, { video: 0, audio: 0, subtitle: 0 });
});

test('missing generic metadata remains null or unknown rather than invented absence', () => {
  const inspection = normalizeMediaInspection({
    format: { duration: 'N/A' },
    streams: [{ index: 0, codec_type: 'audio' }]
  });
  const unreportedStreams = normalizeMediaInspection({ format: {} });
  const incompleteVideo = normalizeMediaInspection({
    format: {},
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }]
  });

  assert.equal(inspection.mediaKind, 'audio');
  assert.equal(inspection.durationSeconds, null);
  assert.equal(inspection.audio.codec, null);
  assert.equal(inspection.audio.sampleRate, null);
  assert.equal(inspection.format, 'Unknown container');
  assert.deepEqual(unreportedStreams.trackCounts, { video: null, audio: null, subtitle: null });
  assert.equal(incompleteVideo.video, null);
  assert.equal(incompleteVideo.trackCounts.video, 1);
});
