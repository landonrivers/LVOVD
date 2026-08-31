'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseTimecode,
  formatTimecode,
  validateSelection,
  clampVisibleWindow,
  zoomVisibleWindow,
  panVisibleWindow,
  timeToPercent,
  formatTimelineTick,
  timelineTickStep,
  buildTimelineTicks,
  playbackShortcutForKey,
  seekBySeconds
} = require('../public/media-editor');

const ROOT = path.join(__dirname, '..');

test('exact time parsing accepts documented seconds, MM:SS, and HH:MM:SS forms', () => {
  assert.equal(parseTimecode('83.5'), 83.5);
  assert.equal(parseTimecode('01:23.500'), 83.5);
  assert.equal(parseTimecode('00:01:23.500'), 83.5);
  assert.equal(parseTimecode('12:34:56.789'), 45_296.789);
  assert.equal(parseTimecode(' 0.001 '), 0.001);

  for (const invalid of ['', '-1', '1:60', '00:60:00', '1::2', '1:2:3:4', 'abc', '1.2345']) {
    assert.equal(parseTimecode(invalid), null, invalid);
  }
});

test('canonical time formatting is millisecond precise and carries rounding', () => {
  assert.equal(formatTimecode(0), '00:00:00.000');
  assert.equal(formatTimecode(83.5), '00:01:23.500');
  assert.equal(formatTimecode(3_599.9996), '01:00:00.000');
  assert.equal(formatTimecode(-2), '00:00:00.000');
});

test('selection validation preserves one bounded positive retained range', () => {
  assert.deepEqual(validateSelection(1.2344, 9.8766, 10), {
    valid: true,
    startSeconds: 1.234,
    endSeconds: 9.877
  });
  assert.equal(validateSelection(-0.001, 5, 10).valid, false);
  assert.equal(validateSelection(0, 10.001, 10).valid, false);
  assert.equal(validateSelection(5, 5, 10).valid, false);
  assert.equal(validateSelection(6, 5, 10).valid, false);
  assert.equal(validateSelection(0, 1, Number.NaN).valid, false);
});

test('zoom and pan math stays clamped to the finite media duration', () => {
  assert.deepEqual(clampVisibleWindow({ startSeconds: -50, endSeconds: 25 }, 100), {
    startSeconds: 0,
    endSeconds: 75
  });
  assert.deepEqual(clampVisibleWindow({ startSeconds: 90, endSeconds: 120 }, 100), {
    startSeconds: 70,
    endSeconds: 100
  });

  const zoomed = zoomVisibleWindow({ startSeconds: 0, endSeconds: 100 }, 100, 0.5, 25);
  assert.deepEqual(zoomed, { startSeconds: 12.5, endSeconds: 62.5 });
  assert.deepEqual(panVisibleWindow(zoomed, 100, 100), { startSeconds: 50, endSeconds: 100 });
  assert.deepEqual(panVisibleWindow(zoomed, 100, -100), { startSeconds: 0, endSeconds: 50 });
  assert.equal(timeToPercent(37.5, zoomed), 50);
  assert.equal(timeToPercent(-1, zoomed), 0);
  assert.equal(timeToPercent(200, zoomed), 100);
});

test('timeline ticks use readable adaptive precision and a bounded label count', () => {
  assert.equal(formatTimelineTick(0, 5), '0:00');
  assert.equal(formatTimelineTick(5, 5), '0:05');
  assert.equal(formatTimelineTick(12.5, 0.5), '00:12.5');
  assert.equal(formatTimelineTick(13, 0.05), '00:13.000');
  assert.equal(formatTimelineTick(3_723, 5), '1:02:03');
  assert.equal(timelineTickStep(30, 600), 5);

  const whole = buildTimelineTicks({ startSeconds: 0, endSeconds: 30 }, 600);
  assert.deepEqual(whole.ticks.map((tick) => tick.label), [
    '0:00', '0:05', '0:10', '0:15', '0:20', '0:25', '0:30'
  ]);
  assert.ok(whole.ticks.length < 9);

  const close = buildTimelineTicks({ startSeconds: 12.5, endSeconds: 12.75 }, 600);
  assert.equal(close.stepSeconds, 0.05);
  assert.equal(close.ticks[0].label, '00:12.500');
  assert.equal(close.ticks.at(-1).label, '00:12.750');
});

test('bounded playback shortcuts toggle or seek five seconds with duration clamping', () => {
  assert.equal(playbackShortcutForKey(' '), 'toggle');
  assert.equal(playbackShortcutForKey('ArrowLeft'), -5);
  assert.equal(playbackShortcutForKey('ArrowRight'), 5);
  assert.equal(playbackShortcutForKey('Enter'), null);
  assert.equal(seekBySeconds(2, -5, 20), 0);
  assert.equal(seekBySeconds(18, 5, 20), 20);
  assert.equal(seekBySeconds(10.125, 5, 20), 15.125);
});

test('editor markup keeps the downloader primary and makes local timeline interactions explicit', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'public', 'media-editor.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(ROOT, 'app-server.js'), 'utf8');

  for (const id of [
    'media-drop-zone',
    'workspace-failure-discard',
    'editor-video',
    'timeline-ruler',
    'timeline-track',
    'timeline-removed-before',
    'timeline-retained',
    'timeline-removed-after',
    'timeline-playhead',
    'timeline-start-handle',
    'timeline-end-handle',
    'editor-start-time',
    'editor-end-time',
    'timeline-zoom-in',
    'timeline-zoom-out',
    'timeline-fit'
  ]) assert.match(html, new RegExp(`id="${id}"`), id);

  assert.match(html, /one retained range for preview/i);
  assert.match(html, /does not create, download, or save an edited file/i);
  assert.match(html, /Edit preview · No output yet/i);
  assert.match(html, /temporary local storage/i);
  assert.match(html, /Nothing is sent to cloud storage/i);
  assert.doesNotMatch(html, /\b(?:Roadmap|6A1)\b/i);
  assert.doesNotMatch(html, /id="media-file-input"[^>]*\baccept=/i);
  assert.doesNotMatch(source, /Roadmap 6A1/i);
  assert.ok(html.indexOf('id="lookup-form"') < html.indexOf('id="media-workspace-panel"'));
  assert.ok(html.indexOf('id="preview"') < html.indexOf('id="media-workspace-panel"'));
  assert.ok(html.indexOf('id="media-workspace-panel"') < html.indexOf('id="history-panel"'));
  assert.match(html, /<label for="video-url">Media URL<\/label>/);
  assert.doesNotMatch(html, />Video URL<\/label>/);
  assert.doesNotMatch(html, /VISUAL RETAINED RANGE/i);
  assert.match(html, />Full Timeline<\/button>/);
  assert.match(html, /Click or drag the timeline to seek · Drag the time ruler to pan when zoomed/i);
  assert.match(html, /id="timeline-track"[^>]*tabindex="0"/);
  assert.match(source, /version:\s*1[\s\S]*keepRanges:\s*\[/);
  assert.match(source, /requestAnimationFrame\(playbackFrame\)/);
  assert.match(source, /video\.currentTime/);
  assert.match(source, /xhr\.upload\.onprogress/);
  assert.match(source, /addEventListener\('drop'/);
  assert.match(source, /addEventListener\('pointerdown'/);
  assert.match(source, /setPointerCapture/);
  assert.match(source, /dropZone\.hidden = true/);
  assert.match(source, /dropZone\.hidden = false/);
  assert.match(source, /playhead\.addEventListener\('pointerdown', beginPlayheadDrag\)/);
  assert.match(source, /playheadSeekFrame = root\.requestAnimationFrame/);
  assert.match(source, /track\.addEventListener\('keydown', handlePlaybackKey\)/);
  assert.match(source, /video\.addEventListener\('keydown', handlePlaybackKey\)/);
  const readyBranch = source.match(/else if \(data\.status === 'ready'\) \{([\s\S]*?)\n      \}/)?.[1];
  assert.ok(readyBranch);
  assert.doesNotMatch(readyBranch, /closeProgressSource/);
  assert.match(source, /if \(data\.workspace\?\.status !== 'error'\) startProgress\(activeWorkspaceId\)/);
  assert.match(source, /function resetWorkspaceUi\([\s\S]{0,100}closeProgressSource\(\)/);
  assert.match(serverSource, /res\.write\(': keepalive\\n\\n'\);\s*mediaWorkspaces\.touch\(workspace\);/);
  assert.doesNotMatch(source, /\/api\/info/);
  assert.doesNotMatch(source, /\/api\/download/);
});
