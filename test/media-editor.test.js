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
  fullEditPlan,
  fullAuthoringState,
  applyOuterBoundary,
  validatePendingCut,
  removePendingSection,
  restoreRemovedSection,
  timelineRegions,
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

test('edited-output plan comparison identifies no-op and stale multi-range output deterministically', () => {
  const full = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 12.346 }] };
  const trimmed = {
    version: 1,
    keepRanges: [{ startSeconds: 1.25, endSeconds: 5 }, { startSeconds: 7, endSeconds: 11 }]
  };
  assert.equal(isFullDurationEditPlan(full, 12.3456), true);
  assert.equal(isFullDurationEditPlan(trimmed, 12.3456), false);
  assert.equal(editPlansEqual(trimmed, structuredClone(trimmed)), true);
  assert.equal(editPlansEqual(trimmed, {
    version: 1,
    keepRanges: [{ startSeconds: 1.25, endSeconds: 5 }, { startSeconds: 8, endSeconds: 11 }]
  }), false);
  assert.equal(editPlansEqual(trimmed, { version: 2, keepRanges: trimmed.keepRanges }), false);
});

test('pending middle cuts remain separate until commit and can be restored or reset', () => {
  const original = fullAuthoringState(12);
  const pending = { startSeconds: 3, endSeconds: 5 };
  assert.deepEqual(validatePendingCut(pending, 12), { valid: true, startSeconds: 3, endSeconds: 5 });
  assert.deepEqual(original.editPlan, { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 12 }] });

  const removed = removePendingSection(original, pending, 12);
  assert.equal(removed.valid, true);
  assert.deepEqual(removed.editPlan.keepRanges, [
    { startSeconds: 0, endSeconds: 3 },
    { startSeconds: 5, endSeconds: 12 }
  ]);
  assert.deepEqual(removed.authoringState.middleCutPlan, removed.editPlan);
  assert.deepEqual(original.middleCutPlan.keepRanges, [{ startSeconds: 0, endSeconds: 12 }]);
  assert.deepEqual(timelineRegions(removed.editPlan, 12).removed, [{ startSeconds: 3, endSeconds: 5 }]);

  const restored = restoreRemovedSection(
    removed.authoringState,
    { startSeconds: 3, endSeconds: 5 },
    12
  );
  assert.equal(restored.valid, true);
  assert.deepEqual(restored.editPlan, fullEditPlan(12));
  assert.deepEqual(fullAuthoringState(12), {
    middleCutPlan: fullEditPlan(12),
    outerStartSeconds: 0,
    outerEndSeconds: 12,
    editPlan: fullEditPlan(12)
  });
});

test('outer controls intersect middle-cut authoring state and canonicalize removed-gap boundaries', () => {
  const middleCutPlan = {
    version: 1,
    keepRanges: [
      { startSeconds: 0, endSeconds: 3 },
      { startSeconds: 5, endSeconds: 8 },
      { startSeconds: 10, endSeconds: 12 }
    ]
  };
  const state = {
    middleCutPlan,
    outerStartSeconds: 0,
    outerEndSeconds: 12,
    editPlan: middleCutPlan
  };
  const movedStart = applyOuterBoundary(state, 'start', 4, 12);
  assert.equal(movedStart.valid, true);
  assert.equal(movedStart.boundarySeconds, 5);
  assert.deepEqual(movedStart.editPlan.keepRanges, [
    { startSeconds: 5, endSeconds: 8 },
    { startSeconds: 10, endSeconds: 12 }
  ]);
  assert.deepEqual(movedStart.authoringState.middleCutPlan, middleCutPlan);

  const movedEnd = applyOuterBoundary(state, 'end', 9, 12);
  assert.equal(movedEnd.valid, true);
  assert.equal(movedEnd.boundarySeconds, 8);
  assert.deepEqual(movedEnd.editPlan.keepRanges, [
    { startSeconds: 0, endSeconds: 3 },
    { startSeconds: 5, endSeconds: 8 }
  ]);
  assert.deepEqual(movedEnd.authoringState.middleCutPlan, middleCutPlan);
});

test('outer Start moves inward and outward without destroying committed middle cuts', () => {
  const cut = removePendingSection(
    fullAuthoringState(120),
    { startSeconds: 30, endSeconds: 40 },
    120
  );
  assert.equal(cut.valid, true);

  const inward = applyOuterBoundary(cut.authoringState, 'start', 50, 120);
  assert.equal(inward.valid, true);
  assert.deepEqual(inward.editPlan.keepRanges, [{ startSeconds: 50, endSeconds: 120 }]);
  assert.deepEqual(inward.authoringState.middleCutPlan.keepRanges, [
    { startSeconds: 0, endSeconds: 30 },
    { startSeconds: 40, endSeconds: 120 }
  ]);

  const outward = applyOuterBoundary(inward.authoringState, 'start', 20, 120);
  assert.equal(outward.valid, true);
  assert.deepEqual(outward.editPlan.keepRanges, [
    { startSeconds: 20, endSeconds: 30 },
    { startSeconds: 40, endSeconds: 120 }
  ]);
  assert.notDeepEqual(outward.editPlan.keepRanges, [{ startSeconds: 50, endSeconds: 120 }]);
  assert.notDeepEqual(outward.editPlan.keepRanges, [{ startSeconds: 20, endSeconds: 120 }]);
});

test('outer End moves inward and outward without destroying committed middle cuts', () => {
  const cut = removePendingSection(
    fullAuthoringState(120),
    { startSeconds: 30, endSeconds: 40 },
    120
  );
  const inward = applyOuterBoundary(cut.authoringState, 'end', 20, 120);
  assert.equal(inward.valid, true);
  assert.deepEqual(inward.editPlan.keepRanges, [{ startSeconds: 0, endSeconds: 20 }]);

  const outward = applyOuterBoundary(inward.authoringState, 'end', 100, 120);
  assert.equal(outward.valid, true);
  assert.deepEqual(outward.editPlan.keepRanges, [
    { startSeconds: 0, endSeconds: 30 },
    { startSeconds: 40, endSeconds: 100 }
  ]);
  assert.deepEqual(outward.authoringState.middleCutPlan, cut.authoringState.middleCutPlan);
});

test('outer gap snapping preserves hidden cuts for expansion and Restore', () => {
  const cut = removePendingSection(
    fullAuthoringState(120),
    { startSeconds: 30, endSeconds: 40 },
    120
  );
  const snappedStart = applyOuterBoundary(cut.authoringState, 'start', 35, 120);
  assert.equal(snappedStart.boundarySeconds, 40);
  assert.deepEqual(snappedStart.editPlan.keepRanges, [{ startSeconds: 40, endSeconds: 120 }]);

  const expandedStart = applyOuterBoundary(snappedStart.authoringState, 'start', 20, 120);
  assert.deepEqual(expandedStart.editPlan.keepRanges, [
    { startSeconds: 20, endSeconds: 30 },
    { startSeconds: 40, endSeconds: 120 }
  ]);
  assert.deepEqual(timelineRegions(expandedStart.editPlan, 120).removed, [
    { startSeconds: 0, endSeconds: 20 },
    { startSeconds: 30, endSeconds: 40 }
  ]);

  const restored = restoreRemovedSection(
    expandedStart.authoringState,
    { startSeconds: 30, endSeconds: 40 },
    120
  );
  assert.equal(restored.valid, true);
  assert.deepEqual(restored.authoringState.middleCutPlan, fullEditPlan(120));
  assert.deepEqual(restored.editPlan.keepRanges, [{ startSeconds: 20, endSeconds: 120 }]);

  const snappedEnd = applyOuterBoundary(cut.authoringState, 'end', 35, 120);
  assert.equal(snappedEnd.boundarySeconds, 30);
  const expandedEnd = applyOuterBoundary(snappedEnd.authoringState, 'end', 100, 120);
  assert.deepEqual(expandedEnd.editPlan.keepRanges, [
    { startSeconds: 0, endSeconds: 30 },
    { startSeconds: 40, endSeconds: 100 }
  ]);
});

test('middle removals are clamped to outer output and full reset clears all authoring state', () => {
  const trimmed = applyOuterBoundary(fullAuthoringState(120), 'start', 20, 120);
  const outside = removePendingSection(
    trimmed.authoringState,
    { startSeconds: 5, endSeconds: 10 },
    120
  );
  assert.equal(outside.valid, false);
  assert.match(outside.reason, /outside the current retained output/i);

  const crossing = removePendingSection(
    trimmed.authoringState,
    { startSeconds: 10, endSeconds: 25 },
    120
  );
  assert.equal(crossing.valid, true);
  assert.deepEqual(crossing.appliedCut, { startSeconds: 20, endSeconds: 25 });
  assert.deepEqual(crossing.authoringState.middleCutPlan.keepRanges, [
    { startSeconds: 0, endSeconds: 20 },
    { startSeconds: 25, endSeconds: 120 }
  ]);

  const reset = fullAuthoringState(120);
  assert.deepEqual(reset, {
    middleCutPlan: fullEditPlan(120),
    outerStartSeconds: 0,
    outerEndSeconds: 120,
    editPlan: fullEditPlan(120)
  });
});

test('editor markup keeps the downloader primary and makes local timeline interactions explicit', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'public', 'media-editor.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const serverSource = fs.readFileSync(path.join(ROOT, 'app-server.js'), 'utf8');

  for (const id of [
    'media-drop-zone',
    'open-editor-button',
    'open-editor-note',
    'workspace-failure-discard',
    'editor-video',
    'timeline-ruler',
    'timeline-track',
    'timeline-regions',
    'timeline-pending-cut',
    'timeline-playhead',
    'timeline-start-handle',
    'timeline-end-handle',
    'timeline-cut-start-handle',
    'timeline-cut-end-handle',
    'editor-start-time',
    'editor-end-time',
    'set-start-playhead',
    'set-end-playhead',
    'go-to-start',
    'go-to-end',
    'reset-range',
    'cut-start-time',
    'cut-end-time',
    'set-cut-start',
    'set-cut-end',
    'remove-section',
    'clear-pending-cut',
    'removed-sections',
    'removed-sections-list',
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

  assert.doesNotMatch(html, /Edit locally · Creates MP4/i);
  assert.match(html, /Creates a new MP4 locally/i);
  assert.match(html, /re-encodes the edited output/i);
  assert.match(html, /id="create-edited-file" class="button secondary mini"[^>]*>Create Edited File<\/button>/);
  assert.match(html, />DOWNLOAD EDITED FILE<\/p>/);
  assert.match(html, /id="download-edited-file" class="button secondary mini"[^>]*>Download<\/a>/);
  assert.match(html, /Change the retained range or remove a section before creating an edited file/i);
  assert.match(html, /Range changed — create the edited file again to update it/i);
  assert.doesNotMatch(html, /Choose or drop one local video\. It stays on this computer/i);
  assert.match(html, /Nothing is sent to cloud storage/i);
  assert.doesNotMatch(html, /LOCAL EDIT WORKSPACE/i);
  assert.doesNotMatch(html, /\b(?:Roadmap|6A1)\b/i);
  assert.doesNotMatch(html, /id="media-file-input"[^>]*\baccept=/i);
  assert.doesNotMatch(source, /Roadmap 6A1/i);
  assert.ok(html.indexOf('src="/edit-plan.js"') < html.indexOf('src="/media-editor.js"'));
  assert.ok(html.indexOf('id="lookup-form"') < html.indexOf('id="media-workspace-panel"'));
  assert.ok(html.indexOf('id="preview"') < html.indexOf('id="media-workspace-panel"'));
  assert.ok(html.indexOf('id="media-workspace-panel"') < html.indexOf('id="history-panel"'));
  assert.match(html, /<label class="workflow-heading" for="video-url">Download From Media URL<\/label>/);
  assert.match(html, /<h2 id="media-workspace-title" class="workflow-heading">Edit Local Media File<\/h2>/);
  assert.match(html, /id="workspace-storage-note" class="workspace-storage-note" hidden/);
  assert.match(html, /id="preview-button" class="button secondary lookup-submit"[^>]*>Preview<\/button>/);
  assert.match(html, /id="download-button" class="button primary big"/);
  assert.match(html, /id="open-editor-button" class="button secondary editor-action big"[^>]*>Edit Source Video<\/button>/);
  assert.ok(html.indexOf('id="download-button"') < html.indexOf('id="open-editor-button"'));
  assert.doesNotMatch(html, />Video URL<\/label>/);
  assert.doesNotMatch(html, /VISUAL RETAINED RANGE/i);
  assert.match(html, />Full Timeline<\/button>/);
  assert.match(html, />Set Start<\/button>/);
  assert.match(html, />Go to Start<\/button>/);
  assert.match(html, />Set End<\/button>/);
  assert.match(html, />Go to End<\/button>/);
  assert.match(html, />Reset Range<\/button>/);
  assert.match(html, /id="crop-video-title" class="editor-section-title">Crop Video Length<\/h4>/);
  assert.match(html, /id="middle-cut-title" class="editor-section-title">Remove Section<\/h4>/);
  assert.doesNotMatch(html, /Move the playhead to each boundary/i);
  assert.match(html, />Set Cut Start<\/button>/);
  assert.match(html, />Set Cut End<\/button>/);
  assert.match(html, />Remove Section<\/button>/);
  assert.match(html, />Clear Cut<\/button>/);
  assert.match(html, />Removed Sections</);
  assert.ok(html.indexOf('id="reset-range"') < html.indexOf('class="editor-render-panel"'));
  assert.ok(html.indexOf('id="crop-video-title"') < html.indexOf('class="editor-exact-grid"'));
  assert.ok(html.indexOf('class="editor-exact-grid"') < html.indexOf('id="middle-cut-title"'));
  assert.ok(html.indexOf('id="create-edited-file"') < html.indexOf('Creates a new MP4 locally'));
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
  assert.match(source, /storageNote\.hidden = true/);
  assert.match(source, /if \(!file\.size\)[\s\S]*?return;[\s\S]*?showStorageNote\('local'\)/);
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
  assert.match(source, /timelineRegionsLayer\.replaceChildren\(\)/);
  assert.match(source, /deriveInternalRemovedGaps\(editPlan\)/);
  assert.match(source, /pendingCut\[`\$\{handleDrag\.which\}Seconds`\]/);
  assert.match(source, /removePendingSection\(authoringState, pendingCut, durationSeconds\)/);
  assert.match(source, /restoreRemovedSection\(authoringState, gap, durationSeconds\)/);
  assert.match(source, /authoringState = fullAuthoringState\(durationSeconds\)/);
  assert.match(source, /const state = fullAuthoringState\(durationSeconds\);[\s\S]*?commitAuthoringState\(state, \{ clearPending: true \}\)/);
  assert.doesNotMatch(source, /downloadEditedFile\.click\(/);
  assert.match(source, /function resetWorkspaceUi\([\s\S]{0,100}closeProgressSource\(\)/);
  assert.match(source, /lvovd:workspace-acquire-url/);
  assert.match(source, /lvovd:workspace-state/);
  assert.match(source, /root\.fetch\('\/api\/workspace\/url'/);
  assert.match(source, /workspaceTitle\.textContent = data\.source\?\.origin === 'url' \? 'Edit Media' : 'Edit Local Media File'/);
  assert.match(source, /The selected media is downloaded into temporary local storage for editing/i);
  assert.match(source, /Editing after acquisition is local/i);
  assert.match(source, /The source service still sees the acquisition requests/i);
  assert.match(source, /A browser playback proxy may use additional temporary space/i);
  assert.match(source, /Nothing is uploaded to cloud storage by LVOVD/i);
  assert.match(source, /function releaseWorkspaceConnectionsForDiscard\(\)[\s\S]*?closeProgressSource\(\);[\s\S]*?video\.removeAttribute\('src'\);/);
  const discardStart = source.indexOf('async function discardWorkspace()');
  const discardEnd = source.indexOf('async function startEditedRender()', discardStart);
  const discardFlow = source.slice(discardStart, discardEnd);
  assert.ok(discardStart >= 0 && discardEnd > discardStart);
  assert.ok(discardFlow.indexOf('releaseWorkspaceConnectionsForDiscard()') < discardFlow.indexOf('root.fetch('));
  assert.match(discardFlow, /restoreWorkspaceConnectionsAfterDiscardFailure\(id, connections\)/);
  assert.match(serverSource, /res\.write\(': keepalive\\n\\n'\);\s*mediaWorkspaces\.touch\(workspace\);/);
  assert.match(serverSource, /'\/edit-plan\.js': \['edit-plan\.js', 'text\/javascript; charset=utf-8'\]/);
  assert.match(styles, /\.timeline-ruler-ticks::after[\s\S]*?height:\s*2px/);
  assert.match(styles, /\.timeline-ruler\.can-pan:hover[\s\S]*?\.timeline-ruler-ticks::after/);
  assert.match(styles, /\.timeline-ruler\.can-pan\s*\{\s*cursor:\s*grab/);
  assert.match(styles, /\.timeline-ruler\.panning\s*\{\s*cursor:\s*grabbing/);
  assert.match(styles, /\.timeline-region\.pending-cut/);
  assert.match(styles, /\.timeline-handle\.cut/);
  assert.match(styles, /\.lookup-form\s*\{[^}]*border:[^;}]*rgba\(169,148,255,\.22\)[^}]*background:\s*linear-gradient/);
  assert.doesNotMatch(styles, /\.lookup-form\s*\{[^}]*box-shadow:/);
  assert.match(styles, /\.lookup-form:focus-within\s*\{[^}]*border-color:[^;}]*rgba\(184,159,255,\.42\)/);
  assert.match(styles, /\.lookup-form \.lookup-submit\s*\{[^}]*background:\s*linear-gradient/);
  assert.match(styles, /\.workflow-heading\s*\{[^}]*display:\s*block[^}]*font-size:\s*clamp\(15px,\s*2vw,\s*17px\)/);
  assert.doesNotMatch(styles, /\.lookup-form label[^}]*font-size:/);
  assert.match(styles, /\.media-workspace-panel\s*\{[^}]*padding:\s*clamp\(14px,\s*2vw,\s*18px\)/);
  assert.match(styles, /#workspace-status:empty\s*\{\s*min-height:\s*0;\s*margin-top:\s*0/);
  assert.match(styles, /grid-template-columns:\s*repeat\(2,\s*minmax\(180px,200px\)\)\s*max-content/);
  assert.match(styles, /grid-template-areas:\s*"start-field end-field \."\s*"start-actions end-actions reset"/);
  assert.match(styles, /\.timeline-range-actions\s*\{\s*grid-area:\s*reset/);
  assert.match(styles, /\.editor-boundary-actions \.button,\s*\.timeline-range-actions \.button\s*\{\s*white-space:\s*nowrap/);
  assert.match(styles, /\.editor-section-title\s*\{[^}]*font-size:\s*16px/);
  assert.match(styles, /\.middle-cut-panel\s*\{[^}]*padding:\s*0[^}]*border:\s*0[^}]*background:\s*none/);
  assert.doesNotMatch(styles, /\.middle-cut-panel\s*\{[^}]*rgba\(255,197,72/);
  assert.match(styles, /grid-template-areas:\s*"start-field"\s*"start-actions"[\s\S]*?"reset"/);
  assert.doesNotMatch(source, /\/api\/info/);
  assert.doesNotMatch(source, /\/api\/download/);
});

test('Preview editor action stays secondary, explains eligible or ineligible state, and sends only acquisition settings', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'app-server.js'), 'utf8');

  assert.match(html, /class="preview-actions"[\s\S]*id="download-button" class="button primary big"[\s\S]*id="open-editor-button" class="button secondary editor-action big"[^>]*>Edit Source Video<\/button>/);
  assert.match(styles, /\.button\.secondary\.editor-action\s*\{[^}]*color:\s*#effff6;[^}]*linear-gradient\(135deg, #245f47, #2d7757\)/);
  assert.match(styles, /\.button\.secondary\.editor-action:hover\s*\{[^}]*linear-gradient\(135deg, #2a6d51, #358b65\)/);
  assert.match(app, /currentInfo\.kind !== 'media'[\s\S]*Collections and playlists cannot be opened/);
  assert.match(app, /currentInfo\.capabilities\?\.live\?\.isLive[\s\S]*Live media cannot be opened/);
  assert.match(app, /!\['av', 'video'\]\.includes\(content\)/);
  assert.match(app, /editorWorkspaceState\.active[\s\S]*Discard the current editor workspace/);
  assert.match(app, /Edit Source Video opens the full media using the selected video source, profile, and resolution\. Time Range, Extras, and SponsorBlock apply only to Download\./);
  assert.match(app, /openEditorNote\.textContent = state\.eligible \? EDITOR_ELIGIBLE_NOTE : state\.reason/);
  assert.match(app, /openEditorNote\.hidden = !openEditorNote\.textContent/);
  assert.match(app, /function buildEditorAcquisition\(\)[\s\S]*content,[\s\S]*profile:[\s\S]*maxHeight:[\s\S]*sourceFormat:/);
  const dispatchStart = app.indexOf("new CustomEvent('lvovd:workspace-acquire-url'");
  const dispatchEnd = app.indexOf('}));', dispatchStart);
  const payload = app.slice(dispatchStart, dispatchEnd);
  assert.doesNotMatch(payload, /range|chapter|extras|subtitle|sponsor/i);
  assert.match(server, /requestUrl\.pathname === '\/api\/workspace\/url'/);
  assert.match(server, /assertOnlyKeys\(body, new Set\(\['url', 'acquisition', 'display'\]\)/);
});
