'use strict';

(function attachProcessingProfile(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) root.LVOVDProcessingProfile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProcessingProfileApi() {
  function defaults() {
    return { videoCodec: 'unchanged', container: 'source', filenameSuffix: ' - processed', scale: { mode: 'unchanged', width: null, height: null, percent: null, allowUpscale: false },
      frameRate: null, rate: { mode: 'automatic', crf: 18, preset: 'medium', videoKbps: null, maximumMB: null, twoPass: false },
      audio: { codec: 'unchanged', bitrateKbps: null } };
  }
  function clone(value) { return value == null ? value : structuredClone(value); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function fullPlan(duration) {
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: Math.round(duration * 1000) / 1000 }] };
  }
  function copySettings(selected) { return clone(selected); }
  function create(workspace) {
    const identity = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId };
    const inspection = clone(workspace.inspection), initialPlan = fullPlan(inspection.durationSeconds);
    let editPlan = clone(initialPlan), settings = defaults(), editorState = null, draftRevision = 0, submitted = null, result = null;
    return {
      update(next) {
        const nextPlan = next.editPlan || editPlan, nextSettings = next.settings || settings;
        const changed = !same(nextPlan, editPlan) || !same(nextSettings, settings);
        if (changed) { editPlan = clone(nextPlan); settings = clone(nextSettings); draftRevision++; }
        if (next.editorState) editorState = clone(next.editorState);
        return changed;
      },
      reset() {
        const changed = !same(editPlan, initialPlan) || !same(settings, defaults());
        editPlan = clone(initialPlan); settings = defaults();
        if (changed) draftRevision++;
        return changed;
      },
      draft() { return { ...identity, draftRevision, editPlan: clone(editPlan), settings: clone(settings) }; },
      submit(plan) {
        if ((plan.workspaceId && plan.workspaceId !== identity.workspaceId) || (plan.sourceAssetId && plan.sourceAssetId !== identity.sourceAssetId)) throw new Error('The processing review belongs to another file.');
        if (plan.draftRevision !== draftRevision) throw new Error('The processing review is out of date. Review the current settings again.');
        submitted = { ...identity, draftRevision, editPlan: clone(plan.editPlan || editPlan), settings: clone(plan.settings || settings), planKey: plan.key };
        return clone(submitted);
      },
      acceptResult(output) { result = clone(output); },
      hasChanges() { return !same(editPlan, initialPlan) || !same(settings, defaults()); },
      state() { return { ...identity, inspection: clone(inspection), editPlan: clone(editPlan), editorState: clone(editorState), settings: clone(settings), draftRevision,
        submitted: clone(submitted), result: clone(result) }; }
    };
  }
  return { defaults, fullPlan, copySettings, create };
});
