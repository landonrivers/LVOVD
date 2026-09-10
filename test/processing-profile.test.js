'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, defaults, fullPlan, copySettings } = require('../public/processing-profile');
const source = () => ({ id: 'workspace-a', sourceAssetId: 'source-a', inspection: { durationSeconds: 10, video: { codec: 'h264' } } });

test('unknown duration retains a null unchanged plan so original bytes remain eligible', () => {
  const workspace = source(); workspace.inspection.durationSeconds = null;
  const profile = create(workspace);
  assert.equal(profile.draft().editPlan, null);
  assert.equal(profile.hasChanges(), false);
  assert.equal(profile.submit({ key: 'unchanged', draftRevision: 0 }).editPlan, null);
});

test('processing profile defaults to original full source and protects source and submitted/result provenance', () => {
  const workspace = source(), profile = create(workspace);
  workspace.inspection.durationSeconds = 1;
  assert.equal(profile.state().inspection.durationSeconds, 10);
  assert.deepEqual(profile.draft().editPlan, fullPlan(10));
  assert.deepEqual(profile.draft().settings, defaults());
  const settings = defaults(); settings.rate.mode = 'quality';
  profile.update({ settings, editPlan: { version: 1, keepRanges: [{ startSeconds: 2, endSeconds: 8 }] } });
  const submitted = profile.submit({ ...profile.draft(), key: 'review-a' });
  profile.acceptResult({ assetId: 'result-a', processingSnapshot: submitted });
  settings.rate.crf = 24; profile.update({ settings });
  submitted.editPlan.keepRanges[0].endSeconds = 99;
  assert.equal(profile.state().submitted.editPlan.keepRanges[0].endSeconds, 8);
  assert.equal(profile.state().submitted.settings.rate.crf, 18);
  assert.equal(profile.state().result.processingSnapshot.settings.rate.crf, 18);
  assert.equal(profile.state().draftRevision, 2);
});

test('Reset File restores original intent, increments revision and keeps previous result provenance', () => {
  const profile = create(source()), settings = defaults(); settings.container = 'mov';
  profile.update({ settings });
  profile.acceptResult({ assetId: 'previous', processingSnapshot: profile.draft() });
  assert.equal(profile.hasChanges(), true);
  assert.equal(profile.reset(), true);
  assert.equal(profile.hasChanges(), false);
  assert.deepEqual(profile.draft().settings, defaults());
  assert.equal(profile.state().result.processingSnapshot.settings.container, 'mov');
  assert.equal(profile.draft().draftRevision, 2);
  assert.equal(profile.reset(), false);
  assert.equal(profile.draft().draftRevision, 2);
});

test('pending UI state does not change committed revision and stale reviewed submission is rejected', () => {
  const profile = create(source());
  const reviewed = { ...profile.draft(), key: 'review-a' };
  profile.update({ editorState: { pendingCut: { startSeconds: 3, endSeconds: 4 }, playheadSeconds: 3, visibleWindow: { startSeconds: 2, endSeconds: 5 } } });
  assert.equal(profile.draft().draftRevision, 0);
  profile.state().editorState.pendingCut.startSeconds = 7;
  assert.equal(profile.state().editorState.pendingCut.startSeconds, 3);
  profile.update({ editPlan: { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 8 }] } });
  assert.throws(() => profile.submit(reviewed), /out of date/);
});

test('processing profile retains reversible outer bounds and hidden middle cuts through read-only copies', () => {
  const profile = create(source());
  const authoring = { outerStartSeconds: 4, outerEndSeconds: 8,
    middleCutPlan: { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 2 }, { startSeconds: 3, endSeconds: 10 }] },
    editPlan: { version: 1, keepRanges: [{ startSeconds: 4, endSeconds: 8 }] } };
  profile.update({ editPlan: authoring.editPlan, editorState: { authoring } });
  authoring.middleCutPlan.keepRanges[0].endSeconds = 99;
  const exposed = profile.state();
  assert.equal(exposed.editorState.authoring.middleCutPlan.keepRanges[0].endSeconds, 2);
  exposed.editorState.authoring.outerStartSeconds = 0;
  exposed.editorState.authoring.middleCutPlan.keepRanges.length = 0;
  assert.equal(profile.state().editorState.authoring.outerStartSeconds, 4);
  assert.equal(profile.state().editorState.authoring.middleCutPlan.keepRanges.length, 2);
  assert.equal(profile.state().draftRevision, 1);
});

test('independent files preserve original-coordinate cuts, reversible view and immutable queued work when all output settings are copied', () => {
  const a = create(source());
  const other = source(); other.id = 'workspace-b'; other.sourceAssetId = 'source-b'; other.inspection.durationSeconds = 20;
  const b = create(other), settings = defaults();
  settings.videoCodec = 'h264'; settings.container = 'mov'; settings.rate = { ...settings.rate, mode: 'bitrate', videoKbps: 2000 };
  settings.scale = { ...settings.scale, mode: 'fit', width: 854, height: 480 }; settings.filenameSuffix = ' - chosen';
  settings.frameRate = 15; settings.audio = { codec: 'aac', bitrateKbps: 128 };
  a.update({ settings, editPlan: { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 4 }] } });
  b.update({ editPlan: { version: 1, keepRanges: [{ startSeconds: 12, endSeconds: 18 }] },
    editorState: { workspaceId: 'workspace-b', pendingCut: { startSeconds: 13, endSeconds: 14 }, playheadSeconds: 15, visibleWindow: { startSeconds: 10, endSeconds: 20 } } });
  const admitted = b.submit({ ...b.draft(), key: 'queued-b' }); b.acceptResult({ assetId: 'prior-b', processingSnapshot: admitted });
  const before = b.state();
  b.update({ settings: copySettings(a.state().settings) });
  const after = b.state();
  assert.deepEqual(after.editPlan, before.editPlan); assert.deepEqual(after.editorState, before.editorState);
  assert.equal(after.settings.container, 'mov'); assert.equal(after.settings.rate.videoKbps, 2000); assert.equal(after.settings.filenameSuffix, ' - chosen');
  assert.deepEqual(after.settings, a.state().settings);
  assert.deepEqual(after.submitted, admitted); assert.deepEqual(after.result, before.result); assert.equal(after.inspection.durationSeconds, 20);
  assert.equal(after.draftRevision, before.draftRevision + 1);
  a.update({ settings: defaults() }); assert.equal(b.state().settings.rate.videoKbps, 2000);
  b.reset(); assert.deepEqual(a.draft().editPlan.keepRanges, [{ startSeconds: 1, endSeconds: 4 }]);
});

test('copying every output setting retains incompatible intent and never aliases another profile', () => {
  const selected = defaults(), audio = create({ ...source(), inspection: { durationSeconds: 3, video: null } });
  selected.videoCodec = 'h264'; selected.container = 'mp4'; selected.rate.mode = 'quality';
  const copied = copySettings(selected); audio.update({ settings: copied });
  assert.deepEqual(audio.state().settings, selected);
  copied.rate.crf = 30; selected.scale.percent = 50;
  assert.equal(audio.state().settings.rate.crf, 18); assert.equal(audio.state().settings.scale.percent, null);
  assert.equal(selected.rate.crf, 18); assert.equal(audio.state().inspection.video, null);
});

test('a reviewed plan from another file cannot become the selected file submitted snapshot', () => {
  const profile = create(source());
  assert.throws(() => profile.submit({ ...profile.draft(), sourceAssetId: 'source-b', key: 'foreign' }), /another file/);
  assert.throws(() => profile.submit({ ...profile.draft(), workspaceId: 'workspace-b', key: 'foreign' }), /another file/);
  assert.equal(profile.state().submitted, null);
});
