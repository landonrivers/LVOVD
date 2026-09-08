'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, defaults, fullPlan } = require('../public/processing-profile');
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
