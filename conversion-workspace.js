'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { TARGETS, normalizeTarget, planConversion, publicConversionPlan, requestError } = require('./conversion-plan');
const { conversionArgs, validateConversionOutput } = require('./conversion-command');
const { boundedAcknowledgement } = require('./conversion-process');

// Process-wide conversion admission, independent of the remote-source queue.
let conversionOwner = null;

function conversionFilename(name, targetId) {
  const stem = String(name || 'Local media').split(/[\\/]/).at(-1).replace(/\.[^.]*$/, '')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim().slice(0, 180) || 'Local media';
  return `${stem} - converted.${TARGETS[targetId].extension}`;
}

class ConversionOperations {
  constructor(manager) { this.manager = manager; }

  source(workspaceId, sourceAssetId) {
    const workspace = this.manager.get(workspaceId);
    if (!workspace) throw requestError('Local media workspace not found or expired.', 404);
    const asset = workspace.assets.get(sourceAssetId);
    if (!asset || asset.id !== workspace.sourceAssetId || asset.role !== 'source') throw requestError('Conversion requires this workspace’s current original source asset.', 409);
    if (workspace.status !== 'ready' || !workspace.inspection || workspace.cleanupRecord) throw requestError('The original source is not ready.', 409);
    return { workspace, asset };
  }

  async plan(workspaceId, sourceAssetId, targetId) {
    normalizeTarget(targetId);
    const { workspace } = this.source(workspaceId, sourceAssetId);
    let plan = planConversion({ sourceAssetId, targetId, inspection: workspace.inspection, capabilities: null });
    // No-op/unsupported/incomplete sources need no executable capability check.
    if (plan.reason === 'capability-check') {
      const capabilities = await this.manager.discoverCapabilities();
      this.source(workspaceId, sourceAssetId);
      plan = planConversion({ sourceAssetId, targetId, inspection: workspace.inspection, capabilities });
    }
    return plan;
  }

  async start({ workspaceId, sourceAssetId, targetId, planKey, acknowledgedWarnings = [] }) {
    const plan = await this.plan(workspaceId, sourceAssetId, targetId);
    if (typeof planKey !== 'string' || plan.key !== planKey) throw requestError('The conversion plan changed. Review it again before starting.', 409);
    if (!['executable', 'no-op'].includes(plan.status)) throw requestError(plan.message, 422);
    if (!Array.isArray(acknowledgedWarnings) || acknowledgedWarnings.some(value => typeof value !== 'string')
      || plan.warnings.some(warning => warning.required && !acknowledgedWarnings.includes(warning.id))) throw requestError('Acknowledge the listed omissions before starting.', 409);
    const { workspace, asset } = this.source(workspaceId, sourceAssetId);
    if (workspace.activeOperation) throw requestError('A local workspace operation is already running.', 409);
    if (workspace.conversion.cleanupPaths.size) throw requestError('Temporary conversion cleanup needs a retry before another conversion.', 409);
    const stat = await this.manager.fs.lstat(asset.filePath);
    this.source(workspaceId, sourceAssetId);
    if (!stat.isFile() || stat.size !== asset.size) throw requestError('The owned source file changed or is missing.', 409);
    if (workspace.activeOperation || (conversionOwner && plan.status !== 'no-op')) throw requestError('Another conversion or workspace operation is busy. Try again when it finishes.', 409);
    const previous = workspace.conversion.output;
    if (plan.status === 'no-op') {
      workspace.activeOperation = 'publishing-conversion';
      workspace.conversion.output = {
        assetId: asset.id, sourceAssetId, targetId, planKey: plan.key, noOp: true,
        filename: conversionFilename(workspace.source.displayName, targetId), mime: plan.output.mime,
        size: asset.size, inspection: workspace.inspection
      };
      Object.assign(workspace.conversion, { targetId, planKey: plan.key, status: 'ready', message: 'No conversion needed. Download the existing source bytes.', failure: null, percent: 100 });
      try { if (previous && !previous.noOp) await this.retire(workspace, previous.assetId); }
      finally { workspace.activeOperation = null; }
      this.manager.emit(workspace);
      return workspace;
    }
    // No await between admission and ownership. Shared across manager instances.
    conversionOwner = workspace;
    workspace.activeOperation = 'converting';
    workspace.abortController = new AbortController();
    workspace.cancelRequested = false;
    const attempt = path.join(workspace.tempDir, `converted-${crypto.randomUUID()}.partial.${plan.output.extension}`);
    Object.assign(workspace.conversion, { status: 'running', percent: 0, message: 'Converting original source…', failure: null,
      targetId, planKey: plan.key, attemptPath: attempt, terminationPending: false });
    this.manager.emit(workspace);
    workspace.activePromise = this.perform(workspace, asset, plan, attempt);
    workspace.activePromise.catch(() => {});
    return workspace;
  }

  async removeFile(workspace, filePath) {
    workspace.conversion.cleanupPaths.add(filePath);
    for (let attempt = 0; attempt <= this.manager.cleanupRetryDelaysMs.length; attempt++) {
      try { await this.manager.fs.rm(filePath, { force: true }); workspace.conversion.cleanupPaths.delete(filePath); return; }
      catch (error) {
        const delay = this.manager.cleanupRetryDelaysMs[attempt];
        if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(error.code) || delay == null) return;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async retire(workspace, assetId) {
    const asset = workspace.assets.get(assetId);
    if (asset?.role !== 'converted-output') return;
    workspace.assets.delete(assetId);
    await this.removeFile(workspace, asset.filePath);
  }

  async retryCleanup(workspaceId) {
    const workspace = this.manager.get(workspaceId);
    if (!workspace || workspace.activeOperation) throw requestError('Workspace is missing or busy.', 409);
    for (const file of [...workspace.conversion.cleanupPaths]) await this.removeFile(workspace, file);
    this.manager.emit(workspace);
    return workspace;
  }

  async perform(workspace, source, plan, attempt) {
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
      await manager.runOwnedProcess(workspace, 'ffmpeg', conversionArgs(source.filePath, attempt, workspace.inspection, plan, manager.maxConvertedBytes),
        { operation: 'ffmpeg_processing', tool: 'ffmpeg', captureStdout: false, onStdout });
      if (workspace.cancelRequested || !manager.get(workspace.id, { touch: false })) throw new Error('Conversion cancelled.');
      workspace.conversion.status = 'validating'; workspace.conversion.message = 'Validating converted file…'; manager.emit(workspace);
      const stat = await manager.fs.lstat(attempt);
      if (!stat.isFile() || stat.size <= 0 || stat.size >= manager.maxConvertedBytes || attempt === source.filePath) throw new Error('Converted output is missing, invalid, or reached the size limit.');
      const inspection = await manager.defaultInspectAsset(workspace, { filePath: attempt, size: stat.size });
      validateConversionOutput(inspection, plan);
      if (workspace.cancelRequested || !manager.get(workspace.id, { touch: false })) throw new Error('Conversion cancelled.');
      const finalPath = attempt.replace('.partial.', '.');
      await manager.fs.rename(attempt, finalPath);
      workspace.conversion.attemptPath = finalPath;
      if (workspace.cancelRequested || !manager.get(workspace.id, { touch: false })) throw new Error('Conversion cancelled.');
      const asset = manager.registerAsset(workspace, { role: 'converted-output', filePath: finalPath, size: stat.size, mime: plan.output.mime,
        filename: conversionFilename(workspace.source.displayName, plan.targetId), inspection });
      const previous = workspace.conversion.output;
      workspace.conversion.output = { assetId: asset.id, sourceAssetId: source.id, targetId: plan.targetId, planKey: plan.key, noOp: false,
        filename: asset.filename, mime: asset.mime, size: asset.size, inspection };
      published = true;
      Object.assign(workspace.conversion, { status: 'ready', percent: 100, message: 'Converted file ready.', failure: null });
      if (previous && !previous.noOp) await this.retire(workspace, previous.assetId);
    } catch (error) {
      const cancelled = workspace.cancelRequested || workspace.abortController.signal.aborted;
      Object.assign(workspace.conversion, { status: cancelled ? 'cancelled' : 'failed', percent: null,
        message: cancelled ? 'Conversion cancelled. The source and previous outputs remain available.' : 'Conversion failed. The source and previous outputs remain available.',
        failure: cancelled ? null : manager.failureFor(error) });
    } finally {
      if (!published) await this.removeFile(workspace, workspace.conversion.attemptPath || attempt);
      workspace.conversion.attemptPath = null;
      workspace.activeOperation = null; workspace.activePromise = null; workspace.child = null;
      if (conversionOwner === workspace) conversionOwner = null;
      manager.emit(workspace);
    }
  }

  async cancel(workspaceId) {
    const workspace = this.manager.get(workspaceId);
    if (!workspace || workspace.activeOperation !== 'converting') throw requestError('No conversion is running in this workspace.', 409);
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
    if (!asset || (output.noOp ? asset.role !== 'source' || asset.id !== workspace.sourceAssetId : asset.role !== 'converted-output')) return null;
    return { workspace, asset: { ...asset, filename: output.filename, mime: output.mime } };
  }

  publicState(workspace) {
    const state = workspace.conversion;
    const output = state.output;
    return {
      status: state.status, percent: state.percent, message: state.message, failure: state.failure,
      targetId: state.targetId, terminationPending: state.terminationPending,
      cleanupPending: state.cleanupPaths.size > 0,
      output: output ? { ...output, downloadUrl: `/api/conversion/file?workspace=${encodeURIComponent(workspace.id)}&asset=${encodeURIComponent(output.assetId)}` } : null
    };
  }
}

module.exports = { ConversionOperations, conversionFilename, publicConversionPlan };
