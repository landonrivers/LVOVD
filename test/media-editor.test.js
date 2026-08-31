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
  timeToPercent
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

test('editor markup and controller keep the 6A1 visual single-range boundary explicit', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'public', 'media-editor.js'), 'utf8');

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

  assert.match(html, /one visual retained range only/i);
  assert.match(html, /does not trim, render, download/i);
  assert.match(html, /temporary local storage/i);
  assert.match(html, /Nothing is sent to cloud storage/i);
  assert.match(source, /version:\s*1[\s\S]*keepRanges:\s*\[/);
  assert.match(source, /requestAnimationFrame\(playbackFrame\)/);
  assert.match(source, /video\.currentTime/);
  assert.match(source, /xhr\.upload\.onprogress/);
  assert.match(source, /addEventListener\('drop'/);
  assert.match(source, /addEventListener\('pointerdown'/);
  assert.match(source, /setPointerCapture/);
  assert.doesNotMatch(source, /\/api\/info/);
  assert.doesNotMatch(source, /\/api\/download/);
});
