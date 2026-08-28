'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourceFormatSummary } = require('../source-formats');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('source format explorer normalizes useful media evidence without exposing transport URLs', () => {
  const summary = sourceFormatSummary({
    formats: [
      {
        format_id: '137',
        format_note: '1080p',
        url: 'https://cdn.example/video-1080.mp4?token=secret',
        http_headers: { Authorization: 'secret' },
        ext: 'mp4',
        width: 1920,
        height: 1080,
        fps: 30,
        vcodec: 'avc1.640028',
        acodec: 'none',
        tbr: 4500,
        filesize: 50 * 1024 * 1024
      },
      {
        format_id: '140',
        url: 'https://cdn.example/audio.m4a?token=secret',
        ext: 'm4a',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        abr: 129,
        audio_channels: 2,
        asr: 48000,
        filesize_approx: 4 * 1024 * 1024
      },
      {
        format_id: 'direct',
        url: 'https://cdn.example/direct.mp4?token=secret',
        ext: 'mp4',
        height: 720,
        fps: 30
      },
      {
        format_id: 'storyboard',
        url: 'https://cdn.example/storyboard.mhtml',
        protocol: 'mhtml',
        ext: 'mhtml',
        vcodec: 'images',
        acodec: 'none',
        width: 160,
        height: 90
      }
    ]
  });

  assert.equal(summary.total, 3);
  assert.equal(summary.shown, 3);
  assert.equal(summary.limited, false);

  const video = summary.formats.find((format) => format.id === '137');
  assert.equal(video.type, 'Video only');
  assert.equal(video.video, true);
  assert.equal(video.audio, false);
  assert.equal(video.videoCodec, 'avc1.640028');
  assert.equal(video.audioCodec, null);
  assert.equal(video.sizeBytes, 50 * 1024 * 1024);
  assert.equal(video.sizeApproximate, false);

  const audio = summary.formats.find((format) => format.id === '140');
  assert.equal(audio.type, 'Audio only');
  assert.equal(audio.video, false);
  assert.equal(audio.audio, true);
  assert.equal(audio.audioCodec, 'mp4a.40.2');
  assert.equal(audio.sizeBytes, 4 * 1024 * 1024);
  assert.equal(audio.sizeApproximate, true);
  assert.equal(audio.audioChannels, 2);
  assert.equal(audio.sampleRate, 48000);

  const direct = summary.formats.find((format) => format.id === 'direct');
  assert.equal(direct.video, true);
  assert.equal(direct.audio, null);
  assert.equal(direct.type, 'Video · audio unknown');
  assert.equal(direct.videoCodec, null);

  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('cdn.example'), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(serialized.includes('token=secret'), false);
});

test('source format explorer keeps missing metadata unknown instead of inventing absence', () => {
  const summary = sourceFormatSummary({
    url: 'https://media.example/direct.mp4',
    format_id: 'direct-one',
    height: 1080,
    fps: 60,
    vcodec: 'avc1.64002a'
  });

  assert.equal(summary.total, 1);
  assert.equal(summary.formats[0].video, true);
  assert.equal(summary.formats[0].audio, null);
  assert.equal(summary.formats[0].audioCodec, null);
});

test('source format explorer bounds the Preview payload and scrubs URL-like display metadata', () => {
  const formats = Array.from({ length: 125 }, (_, index) => ({
    format_id: index === 0 ? 'https://cdn.example/not-a-safe-id' : `v${index}`,
    format_note: index === 1 ? 'mirror https://cdn.example/internal' : `${720 + index}p`,
    url: `https://cdn.example/video-${index}.mp4?token=secret`,
    ext: 'mp4',
    height: 720 + index,
    vcodec: 'avc1.4d401f',
    acodec: 'none'
  }));
  const summary = sourceFormatSummary({ formats });

  assert.equal(summary.total, 125);
  assert.equal(summary.shown, 100);
  assert.equal(summary.limited, true);
  assert.equal(summary.formats.length, 100);
  assert.equal(JSON.stringify(summary).includes('cdn.example'), false);
});

test('format explorer UI is read-only and uses the normal Preview response', () => {
  const app = read('public/app.js');
  const server = read('app-server.js');
  assert.match(server, /sourceFormats: sourceFormatSummary\(info\)/);
  assert.match(app, /function renderSourceFormats\(info\)/);
  assert.match(app, /Read-only details from this Preview/);
  assert.match(app, /manual source-format selection is not enabled yet/i);
  assert.match(app, /renderSourceFormats\(info\)/);
  assert.doesNotMatch(app, /sourceFormatId|manualFormat|\/api\/formats/);
});
