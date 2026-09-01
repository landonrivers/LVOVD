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
  seekBySeconds,
  fullRetainedRange,
  retainedRangeWithPlayhead,
  retainedBoundaryTime,
  editPlansEqual,
  isFullDurationEditPlan
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

test('range reset, set-boundary, and go-to-boundary actions keep range and playhead concerns separate', () => {
  const authoredRange = Object.freeze({ startSeconds: 2.5, endSeconds: 9.75 });
  const playheadSeconds = 6.125;

  assert.deepEqual(fullRetainedRange(12.3456), {
    startSeconds: 0,
    endSeconds: 12.346
  });
  assert.equal(fullRetainedRange(0), null);
  assert.deepEqual(retainedRangeWithPlayhead(authoredRange, 'start', playheadSeconds), {
    startSeconds: 6.125,
    endSeconds: 9.75
  });
  assert.deepEqual(retainedRangeWithPlayhead(authoredRange, 'end', playheadSeconds), {
    startSeconds: 2.5,
    endSeconds: 6.125
  });
  assert.deepEqual(authoredRange, { startSeconds: 2.5, endSeconds: 9.75 });
  assert.equal(retainedBoundaryTime(authoredRange, 'start', 12), 2.5);
  assert.equal(retainedBoundaryTime(authoredRange, 'end', 12), 9.75);
  assert.equal(retainedBoundaryTime({ startSeconds: -4, endSeconds: 20 }, 'start', 12), 0);
  assert.equal(retainedBoundaryTime({ startSeconds: -4, endSeconds: 20 }, 'end', 12), 12);
  assert.equal(playheadSeconds, 6.125);
});

test('edited-output plan comparison identifies no-op and stale one-range output deterministically', () => {
  const full = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 12.346 }] };
  const trimmed = { version: 1, keepRanges: [{ startSeconds: 1.25, endSeconds: 11 }] };
  assert.equal(isFullDurationEditPlan(full, 12.3456), true);
  assert.equal(isFullDurationEditPlan(trimmed, 12.3456), false);
  assert.equal(editPlansEqual(trimmed, structuredClone(trimmed)), true);
  assert.equal(editPlansEqual(trimmed, { version: 1, keepRanges: [{ startSeconds: 1.25, endSeconds: 10 }] }), false);
  assert.equal(editPlansEqual(trimmed, { version: 2, keepRanges: trimmed.keepRanges }), false);
});

test('editor markup keeps the downloader primary and makes local timeline interactions explicit', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'public', 'media-editor.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
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
    'set-start-playhead',
    'set-end-playhead',
    'go-to-start',
    'go-to-end',
    'reset-range',
    'editor-track-warning',
    'create-edited-file',
    'editor-render-noop',
    'editor-render-progress',
    'cancel-edited-render',
    'editor-render-failure',
    'editor-edited-output',
    'editor-output-stale',
    'download-edited-file',
    'timeline-zoom-in',
    'timeline-zoom-out',
    'timeline-fit'
  ]) assert.match(html, new RegExp(`id="${id}"`), id);

  assert.match(html, /Edit locally · Creates MP4/i);
  assert.match(html, /Creates a new MP4 locally/i);
  assert.match(html, /re-encodes the edited output/i);
  assert.match(html, />Create Edited File<\/button>/);
  assert.match(html, />Download Edited File<\/a>/);
  assert.match(html, /Move the start or end before creating an edited file/i);
  assert.match(html, /Range changed — create the edited file again to update it/i);
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
  assert.match(html, />Set Start Here<\/button>/);
  assert.match(html, />Go to Start<\/button>/);
  assert.match(html, />Set End Here<\/button>/);
  assert.match(html, />Go to End<\/button>/);
  assert.match(html, />Reset Range<\/button>/);
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
  assert.match(source, /root\.fetch\('\/api\/workspace\/render'/);
  assert.match(source, /method:\s*'POST'/);
  assert.match(source, /root\.fetch\(\s*`\/api\/workspace\/render\?workspace=/);
  assert.match(source, /method:\s*'DELETE'/);
  assert.match(source, /downloadEditedFile\.href = output\.downloadUrl/);
  assert.match(source, /downloadEditedFile\.download = output\.filename/);
  assert.match(source, /!editPlansEqual\(editPlan, output\.editPlan\)/);
  assert.doesNotMatch(source, /downloadEditedFile\.click\(/);
  assert.match(source, /function resetWorkspaceUi\([\s\S]{0,100}closeProgressSource\(\)/);
  assert.match(source, /function releaseWorkspaceConnectionsForDiscard\(\)[\s\S]*?closeProgressSource\(\);[\s\S]*?video\.removeAttribute\('src'\);/);
  const discardFlow = source.match(/async function discardWorkspace\(\) \{([\s\S]*?)\n    \}\n\n    function beginUpload/)?.[1];
  assert.ok(discardFlow);
  assert.ok(discardFlow.indexOf('releaseWorkspaceConnectionsForDiscard()') < discardFlow.indexOf('root.fetch('));
  assert.match(discardFlow, /restoreWorkspaceConnectionsAfterDiscardFailure\(id, connections\)/);
  assert.match(serverSource, /res\.write\(': keepalive\\n\\n'\);\s*mediaWorkspaces\.touch\(workspace\);/);
  assert.match(styles, /\.timeline-ruler-ticks::after[\s\S]*?height:\s*2px/);
  assert.match(styles, /\.timeline-ruler\.can-pan:hover[\s\S]*?\.timeline-ruler-ticks::after/);
  assert.match(styles, /\.timeline-ruler\.can-pan\s*\{\s*cursor:\s*grab/);
  assert.match(styles, /\.timeline-ruler\.panning\s*\{\s*cursor:\s*grabbing/);
  assert.doesNotMatch(source, /\/api\/info/);
  assert.doesNotMatch(source, /\/api\/download/);
});
