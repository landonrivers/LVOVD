'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { TARGETS, normalizeTarget, planConversion, publicConversionPlan, requestError } = require('./conversion-plan');
const { conversionArgs, validateConversionOutput } = require('./conversion-command');
const { boundedAcknowledgement } = require('./conversion-process');
const { normalizeEditPlan, editPlansEqual } = require('./public/edit-plan');

// Process-wide conversion admission, independent of the remote-source queue.
let conversionOwner = null;
const conversionSlotListeners = new Set();

function conversionSlotBusy() { return Boolean(conversionOwner); }
function claimConversionSlot(workspace) {
  if (conversionOwner) throw requestError('Another local conversion is running. Try again when it finishes.', 409);
  conversionOwner = workspace;
}
function releaseConversionSlot(workspace) {
  if (conversionOwner !== workspace) return;
  conversionOwner = null;
  for (const listener of conversionSlotListeners) listener();
}
function onConversionSlotReleased(listener) { conversionSlotListeners.add(listener); return () => conversionSlotListeners.delete(listener); }

function conversionFilename(name, targetId) {
  const stem = String(name || 'Local media').split(/[\\/]/).at(-1).replace(/\.[^.]*$/, '')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 180) || 'Local media';
  return `${stem} - converted.${TARGETS[targetId].extension}`;
}

class ConversionOperations {
  constructor(manager) { this.manager = manager; }

  input(workspaceId, inputAssetId, rawEditPlan) {
    const workspace = this.manager.get(workspaceId);
    if (!workspace) throw requestError('Local media workspace not found or expired.', 404);
    const asset = workspace.assets.get(inputAssetId);
    if (asset?.role === 'source') {
      this.manager.originalSource(workspaceId, inputAssetId);
      if (rawEditPlan !== undefined) throw requestError('An original input does not take an edited-plan assertion.');
      return { workspace, asset, inspection: workspace.inspection, filename: workspace.source.displayName, editPlanKey: null };
    }
    if (!asset || asset.role !== 'edited-output' || asset.id !== workspace.render.outputAssetId
      || !asset.validated || !asset.inspection || !asset.editPlan) throw requestError('Select the latest validated edited result or the original source, then review the conversion again.', 409);
    if (workspace.status !== 'ready' || workspace.cleanupRecord || workspace.activeOperation) throw requestError('The edited input is not ready or a workspace operation is running.', 409);
    let assertion;
    try { assertion = normalizeEditPlan(rawEditPlan, workspace.inspection.durationSeconds); }
    catch { throw requestError('Submit the current canonical edit plan for this edited input.', 409); }
    if (!editPlansEqual(assertion, asset.editPlan)) throw requestError('Create an updated edited file first.', 409);
    return { workspace, asset, inspection: asset.inspection, filename: asset.filename,
      editPlanKey: crypto.createHash('sha256').update(JSON.stringify(asset.editPlan)).digest('hex') };
  }

  buildPlan(input, targetId, capabilities = null) {
    return planConversion({ workspaceId: input.workspace.id, inputAssetId: input.asset.id, inputRole: input.asset.role,
      inputFilename: input.filename, editPlanKey: input.editPlanKey, inspection: input.inspection, targetId, capabilities });
  }

  sameInput(plan, input) {
    const current = this.buildPlan(input, plan.targetId);
    if (['workspaceId', 'inputAssetId', 'inputRole', 'inputFilename', 'editPlanKey', 'inspectionKey'].some(key => current[key] !== plan[key])) {
      throw requestError('The conversion input changed. Select the input and review again.', 409);
    }
  }

  async plan(workspaceId, inputAssetId, targetId, editPlan) {
    normalizeTarget(targetId);
    const input = this.input(workspaceId, inputAssetId, editPlan);
    let plan = this.buildPlan(input, targetId);
    // No-op/unsupported/incomplete sources need no executable capability check.
    if (plan.reason === 'capability-check') {
      const capabilities = await this.manager.discoverCapabilities();
      const current = this.input(workspaceId, inputAssetId, editPlan);
      this.sameInput(plan, current);
      plan = this.buildPlan(current, targetId, capabilities);
    }
    return plan;
  }

  async start({ workspaceId, inputAssetId, editPlan, targetId, planKey, acknowledgedWarnings = [] }) {
    const plan = await this.plan(workspaceId, inputAssetId, targetId, editPlan);
    if (typeof planKey !== 'string' || plan.key !== planKey) throw requestError('The conversion plan changed. Review it again before starting.', 409);
    if (!['executable', 'no-op'].includes(plan.status)) throw requestError(plan.message, 422);
    if (!Array.isArray(acknowledgedWarnings) || acknowledgedWarnings.some(value => typeof value !== 'string')
      || plan.warnings.some(warning => warning.required && !acknowledgedWarnings.includes(warning.id))) throw requestError('Acknowledge the listed omissions before starting.', 409);
    const input = this.input(workspaceId, inputAssetId, editPlan);
    this.sameInput(plan, input);
    const { workspace, asset } = input;
    if (workspace.activeOperation || workspace.queuedProcessingJobId) throw requestError('A local workspace operation is already running or queued.', 409);
    if (workspace.conversion.cleanupPaths.size || this.manager.outputRetirement.state(workspace).blocked) throw requestError('Temporary output cleanup needs a retry before another conversion.', 409);
    let stat;
    try { stat = await this.manager.fs.lstat(asset.filePath); }
    catch (error) { this.input(workspaceId, inputAssetId, editPlan); throw error; }
    this.sameInput(plan, this.input(workspaceId, inputAssetId, editPlan));
    if (!stat.isFile() || stat.size !== asset.size) throw requestError('The owned input file changed or is missing.', 409);
    if (workspace.conversion.cleanupPaths.size || this.manager.outputRetirement.state(workspace).blocked) throw requestError('Temporary output cleanup needs a retry before another conversion.', 409);
    if (workspace.activeOperation || workspace.queuedProcessingJobId || (conversionOwner && plan.status !== 'no-op')) throw requestError('Another conversion or workspace operation is busy. Try again when it finishes.', 409);
    const previous = workspace.conversion.output;
    Object.assign(workspace.conversion, { mode: 'conversion', phase: null, phasePercent: null, draftRevision: null, processingSnapshot: null });
    const provenance = Object.freeze({ inputAssetId, inputRole: asset.role, inputFilename: input.filename,
      inputDurationSeconds: input.inspection.durationSeconds, editPlanKey: input.editPlanKey });
    if (plan.status === 'no-op') {
      workspace.activeOperation = 'publishing-conversion';
      workspace.conversion.output = {
        assetId: asset.id, provenance, targetId, planKey: plan.key, noOp: true,
        filename: conversionFilename(input.filename, targetId), mime: plan.output.mime,
        size: asset.size, inspection: structuredClone(input.inspection)
      };
      Object.assign(workspace.conversion, { targetId, planKey: plan.key, status: 'ready', message: 'No conversion needed. Download the existing input bytes.', failure: null, percent: 100 });
      try { if (previous && previous.assetId !== asset.id) await this.manager.outputRetirement.retire(workspace, previous.assetId); }
      finally { workspace.activeOperation = null; }
      this.manager.emit(workspace);
      return workspace;
    }
    // No await between admission and ownership. Shared across manager instances.
    claimConversionSlot(workspace);
    workspace.activeOperation = 'converting';
    workspace.abortController = new AbortController();
    workspace.cancelRequested = false;
    const attempt = path.join(workspace.tempDir, `converted-${crypto.randomUUID()}.partial.${plan.output.extension}`);
    Object.assign(workspace.conversion, { status: 'running', percent: 0, message: asset.role === 'source' ? 'Converting original source…' : 'Converting edited result…', failure: null,
      activeInputAssetId: asset.id,
      targetId, planKey: plan.key, attemptPath: attempt, terminationPending: false });
    this.manager.emit(workspace);
    workspace.activePromise = this.perform(workspace, asset, structuredClone(input.inspection), provenance, plan, attempt);
    workspace.activePromise.catch(() => {});
    return workspace;
  }

  async removeFile(workspace, filePath) {
    workspace.conversion.cleanupPaths.add(filePath);
    for (let attempt = 0; attempt <= this.manager.cleanupRetryDelaysMs.length; attempt++) {
      try {
        await this.manager.fs.rm(filePath, { force: true, ...(workspace.conversion.cleanupDirectories.has(filePath) ? { recursive: true } : {}) });
        workspace.conversion.cleanupPaths.delete(filePath); workspace.conversion.cleanupDirectories.delete(filePath); return;
      }
      catch (error) {
        const delay = this.manager.cleanupRetryDelaysMs[attempt];
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(error.code) || delay == null) return;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async retryCleanup(workspaceId) {
    const workspace = this.manager.get(workspaceId);
    if (!workspace || workspace.activeOperation) throw requestError('Workspace is missing or busy.', 409);
    for (const file of [...workspace.conversion.cleanupPaths]) await this.removeFile(workspace, file);
    await this.manager.outputRetirement.retry(workspace);
    this.manager.emit(workspace);
    return workspace;
  }

  async perform(workspace, input, inputInspection, provenance, plan, attempt) {
    const manager = this.manager;
    let published = false, pending = '';
    const onStdout = chunk => {
      pending = (pending + String(chunk)).slice(-8192);
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line);
        if (!match) continue;
        workspace.conversion.percent = Math.min(99, Number(match[1]) / 1e6 / plan.timing.durationSeconds * 100);
        manager.emit(workspace);
      }
    };
    try {
      await manager.runOwnedProcess(workspace, 'ffmpeg', conversionArgs(input.filePath, attempt, inputInspection, plan, manager.maxConvertedBytes),
        { operation: 'ffmpeg_processing', tool: 'ffmpeg', captureStdout: false, onStdout });
      if (workspace.cancelRequested || !manager.get(workspace.id, { touch: false })) throw new Error('Conversion cancelled.');
      workspace.conversion.status = 'validating'; workspace.conversion.message = 'Validating converted file…'; manager.emit(workspace);
      const stat = await manager.fs.lstat(attempt);
      if (!stat.isFile() || stat.size <= 0 || stat.size >= manager.maxConvertedBytes || attempt === input.filePath) throw new Error('Converted output is missing, invalid, or reached the size limit.');
      const inspection = await manager.defaultInspectAsset(workspace, { filePath: attempt, size: stat.size });
      validateConversionOutput(inspection, plan);
      if (workspace.cancelRequested || !manager.get(workspace.id, { touch: false })) throw new Error('Conversion cancelled.');
      const finalPath = attempt.replace('.partial.', '.');
      await manager.fs.rename(attempt, finalPath);
      workspace.conversion.attemptPath = finalPath;
      if (workspace.cancelRequested || !manager.get(workspace.id, { touch: false })) throw new Error('Conversion cancelled.');
      const asset = manager.registerAsset(workspace, { role: 'converted-output', filePath: finalPath, size: stat.size, mime: plan.output.mime,
        filename: conversionFilename(provenance.inputFilename, plan.targetId), inspection });
      const previous = workspace.conversion.output;
      workspace.conversion.output = { assetId: asset.id, provenance, targetId: plan.targetId, planKey: plan.key, noOp: false,
        filename: asset.filename, mime: asset.mime, size: asset.size, inspection };
      published = true;
      Object.assign(workspace.conversion, { status: 'ready', percent: 100, message: 'Converted file ready.', failure: null });
      if (previous) await manager.outputRetirement.retire(workspace, previous.assetId);
    } catch (error) {
      const cancelled = workspace.cancelRequested || workspace.abortController.signal.aborted;
      Object.assign(workspace.conversion, { status: cancelled ? 'cancelled' : 'failed', percent: null,
        message: cancelled ? 'Conversion cancelled. The source and previous outputs remain available.' : 'Conversion failed. The source and previous outputs remain available.',
        failure: cancelled ? null : manager.failureFor(error) });
    } finally {
      if (!published) await this.removeFile(workspace, workspace.conversion.attemptPath || attempt);
      workspace.conversion.attemptPath = null;
      workspace.conversion.activeInputAssetId = null;
      if (workspace.retiredOutputs.has(input.id)) await manager.outputRetirement.retire(workspace, input.id);
      workspace.activeOperation = null; workspace.activePromise = null; workspace.child = null;
      releaseConversionSlot(workspace);
      manager.emit(workspace);
    }
  }

  async cancel(workspaceId) {
    const workspace = this.manager.get(workspaceId);
    if (!workspace || workspace.activeOperation !== 'converting'
      || !['running', 'validating', 'cancelling'].includes(workspace.conversion.status)) throw requestError('No conversion is running in this workspace.', 409);
    workspace.cancelRequested = true;
    Object.assign(workspace.conversion, { status: 'cancelling', percent: null, message: 'Cancelling conversion…' });
    workspace.abortController.abort();
    this.manager.emit(workspace);
    if (workspace.activePromise) await boundedAcknowledgement(workspace.activePromise, this.manager.conversionTerminationGraceMs * 2 + 100);
    return workspace;
  }

  resolve(workspaceId, assetId) {
    const workspace = this.manager.get(workspaceId);
    const output = workspace?.conversion.output;
    if (!output || output.assetId !== assetId) return null;
    const asset = workspace.assets.get(assetId);
    if (!asset || (output.noOp ? asset.id !== output.provenance.inputAssetId || asset.role !== output.provenance.inputRole
      || !['source', 'edited-output'].includes(asset.role) : asset.role !== 'converted-output')) return null;
    return { workspace, asset: { ...asset, filename: output.filename, mime: output.mime } };
  }

  publicState(workspace) {
    const state = workspace.conversion;
    const output = state.output;
    return {
      status: state.status, percent: state.percent, message: state.message, failure: state.failure,
      targetId: state.targetId, terminationPending: state.terminationPending,
      mode: state.mode || 'conversion', phase: state.phase || null, phasePercent: state.phasePercent ?? null,
      draftRevision: state.draftRevision ?? null, processingSnapshot: state.processingSnapshot || null,
      cleanupPending: state.cleanupPaths.size > 0,
      output: output ? { ...output, provenance: { ...output.provenance }, downloadUrl: `/api/conversion/file?workspace=${encodeURIComponent(workspace.id)}&asset=${encodeURIComponent(output.assetId)}` } : null
    };
  }
}

module.exports = { ConversionOperations, conversionFilename, publicConversionPlan, conversionSlotBusy, claimConversionSlot, releaseConversionSlot, onConversionSlotReleased };
