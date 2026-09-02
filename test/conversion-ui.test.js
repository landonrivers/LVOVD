'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  familiarCodecName,
  formatBytes,
  formatDuration,
  mediaKindLabel,
  inspectionFacts
} = require('../public/conversion-inspector');

const ROOT = path.join(__dirname, '..');

test('inspection UI formats familiar codec and media facts for people', () => {
  assert.equal(familiarCodecName('h264'), 'H.264');
  assert.equal(familiarCodecName('hevc'), 'H.265 / HEVC');
  assert.equal(familiarCodecName('av1'), 'AV1');
  assert.equal(familiarCodecName('vp9'), 'VP9');
  assert.equal(familiarCodecName('aac'), 'AAC');
  assert.equal(familiarCodecName('opus'), 'Opus');
  assert.equal(familiarCodecName('mp3'), 'MP3');
  assert.equal(familiarCodecName('flac'), 'FLAC');
  assert.equal(formatBytes(1_572_864), '1.50 MB');
  assert.equal(formatDuration(65.125), '00:01:05.125');
  assert.equal(mediaKindLabel('audio'), 'Audio');

  const facts = inspectionFacts({
    source: { name: 'camera.mkv', size: 1_572_864 },
    inspection: {
      mediaKind: 'video',
      format: 'Matroska / WebM',
      durationSeconds: 65.125,
      video: {
        codec: 'hevc', profile: 'Main 10', width: 1920, height: 1080,
        frameRate: 29.97, pixelFormat: 'yuv420p10le'
      },
      audio: {
        codec: 'opus', sampleRate: 48000, channels: 2,
        channelLayout: 'stereo', bitRate: 128000
      },
      trackCounts: { video: 1, audio: 2, subtitle: 3 }
    }
  });
  const displayed = Object.fromEntries(facts);

  assert.equal(displayed.Filename, 'camera.mkv');
  assert.equal(displayed['Media type'], 'Video');
  assert.equal(displayed['Video codec'], 'H.265 / HEVC');
  assert.equal(displayed.Resolution, '1920 × 1080');
  assert.equal(displayed['Audio codec'], 'Opus');
  assert.equal(displayed['Sample rate'], '48 kHz');
  assert.equal(displayed.Tracks, '1 video · 2 audio · 3 subtitle');
  assert.equal(Object.hasOwn(displayed, 'Stream ID'), false);
});

test('inspection UI preserves unknown metadata instead of inventing incompatibility', () => {
  const displayed = Object.fromEntries(inspectionFacts({
    source: { name: 'mystery.bin', size: null },
    inspection: {
      mediaKind: 'unsupported',
      format: 'Unknown container',
      durationSeconds: null,
      video: null,
      audio: null,
      trackCounts: { video: null, audio: null, subtitle: null }
    }
  }));

  assert.equal(displayed['Media type'], 'Unsupported or unknown');
  assert.equal(displayed['File size'], 'Unknown');
  assert.equal(displayed.Duration, 'Unknown');
  assert.equal(displayed.Tracks, 'Unknown video · Unknown audio · Unknown subtitle');
});

test('browser panel is a truthful inspection-only local workflow between Edit and History', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'public', 'conversion-inspector.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const panelStart = html.indexOf('<section id="conversion-inspector-panel"');
  const panelEnd = html.indexOf('<section id="history-panel"');
  const panel = html.slice(panelStart, panelEnd);

  assert.ok(panelStart > html.indexOf('<section id="media-workspace-panel"'));
  assert.ok(panelEnd > panelStart);
  assert.match(panel, /Inspect Local Media/);
  assert.match(panel, /one local video or audio file/i);
  assert.match(panel, /temporary workspace storage/i);
  assert.match(panel, /nothing is uploaded to cloud storage/i);
  assert.match(panel, /Inspection only — this release does not create a converted output/);
  assert.match(panel, /BROAD COMPATIBILITY MP4/);
  assert.match(panel, /id="conversion-file-input" type="file" hidden/);
  assert.doesNotMatch(panel, /id="conversion-file-input"[^>]*accept=/);
  assert.doesNotMatch(panel, /<button[^>]*>\s*Convert\s*<\/button>/i);
  assert.ok(html.indexOf('src="/conversion-inspector.js"')
    > html.indexOf('src="/media-editor.js"'));

  assert.match(source, /POST', '\/api\/conversion\/local'/);
  assert.match(source, /new root\.EventSource\(`\/api\/workspace\/progress/);
  assert.match(source, /method: 'DELETE'/);
  assert.match(source, /data\.purpose !== 'convert'/);
  assert.match(source, /failureDiscard\.disabled = false;\s*discardButton\.disabled = false;/);
  assert.match(styles, /\.conversion-inspector-panel/);
  assert.match(styles, /\.conversion-facts dt \{[^}]*font-size:\s*10px/s);
  assert.match(styles, /\.conversion-facts dd \{[^}]*font-size:\s*12px/s);
});
