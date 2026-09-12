'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { requestError } = require('./conversion-plan');
const { planProcessing, publicProcessingPlan, processingFilename } = require('./processing-plan');
const { processingArgs, validateProcessingOutput } = require('./processing-command');
const { conversionSlotBusy, claimConversionSlot, releaseConversionSlot } = require('./conversion-workspace');

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function requestIntent(body, starting = false) {
  const allowed = ['workspaceId', 'sourceAssetId', 'draftRevision', 'editPlan', 'settings', ...(starting ? ['planKey', 'acknowledgedWarnings'] : [])];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))
    || typeof body.workspaceId !== 'string' || !body.workspaceId || body.workspaceId.length > 80
    || typeof body.sourceAssetId !== 'string' || !body.sourceAssetId || body.sourceAssetId.length > 80
    || !Number.isSafeInteger(body.draftRevision) || body.draftRevision < 0 || body.draftRevision > 2147483647) {
    throw requestError('Submit this workspace source, a valid draft revision, cuts, and structured output settings.');
  }
  return { workspaceId: body.workspaceId, sourceAssetId: body.sourceAssetId, draftRevision: body.draftRevision,
    editPlan: body.editPlan, settings: body.settings };
}

class ProcessingOperations {
  constructor(manager) { this.manager = manager; }

  build(input, intent, capabilities = null) {
    return planProcessing({ ...intent, inputFilename: input.workspace.source.displayName,
      inspection: input.workspace.inspection, capabilities });
  }

  checkReview(workspace, revision, intentKey) {
    const current = this.manager.get(workspace.id);
    if (current !== workspace) throw requestError('Local media workspace not found or expired.', 404);
    if (workspace.processingReview?.revision !== revision || workspace.processingReview.intentKey !== intentKey) {
      throw requestError('A newer processing draft needs review. Review the current cuts and settings before processing.', 409);
    }
  }

  async plan(body) {
    const intent = requestIntent(body);
    const input = this.manager.originalSource(intent.workspaceId, intent.sourceAssetId);
    let plan = this.build(input, intent, input.workspace.processingCapabilities);
    const intentKey = hash({ sourceAssetId: intent.sourceAssetId, inspectionKey: plan.inspectionKey,
      editPlan: plan.editPlan, settings: plan.settings, revision: intent.draftRevision });
    const old = input.workspace.processingReview;
    if (old && (old.revision > intent.draftRevision || (old.revision === intent.draftRevision && old.intentKey !== intentKey))) {
      throw requestError('This draft revision is stale or has different settings. Review a new revision.', 409);
    }
    input.workspace.processingReview = { revision: intent.draftRevision, intentKey, planKey: null };
    // Discovery also supplies truthful enabled UI choices. A failure leaves a
    // complete no-op downloadable; capability evidence is only required for
    // executing a changed operation. Successful evidence is process-cached.
    if (plan.reason === 'capability-check' || !input.workspace.processingCapabilities?.available) {
      let capabilities;
      try { capabilities = await this.manager.discoverCapabilities(); }
      catch { capabilities = { available: false }; }
      this.checkReview(input.workspace, intent.draftRevision, intentKey);
      const current = this.manager.originalSource(intent.workspaceId, intent.sourceAssetId);
      if (hash(current.workspace.inspection) !== plan.inspectionKey) throw requestError('The source inspection changed. Review again.', 409);
      input.workspace.processingCapabilities = capabilities;
      plan = this.build(current, intent, capabilities);
    }
    this.checkReview(input.workspace, intent.draftRevision, intentKey);
    input.workspace.processingReview.planKey = plan.key;
    return plan;
  }

  async start(body) {
    return this.startPrepared(await this.prepare(body));
  }

  // Queue admission reviews the same production plan, but does not claim the
  // encoder. Its owned snapshot survives later, independently reviewed drafts.
  async prepare(body, { queued = false } = {}) {
    const intent = requestIntent(body, true);
    const plan = await this.plan(intent);
    if (typeof body.planKey !== 'string' || body.planKey !== plan.key) throw requestError('The processing plan changed. Review the current draft first.', 409);
    if (!['executable', 'no-op'].includes(plan.status)) throw requestError(plan.message, 422);
    const acknowledgements = body.acknowledgedWarnings ?? [];
    if (!Array.isArray(acknowledgements) || acknowledgements.some(item => typeof item !== 'string')
      || plan.warnings.some(warning => warning.required && !acknowledgements.includes(warning.id))) {
      throw requestError('Acknowledge the reviewed omissions before processing.', 409);
    }
    const { workspace, asset } = this.manager.originalSource(intent.workspaceId, intent.sourceAssetId);
    const reviewKey = workspace.processingReview.intentKey;
    this.checkAdmission(workspace, plan, { ignoreSlot: queued });
    let stat;
    try { stat = await this.manager.fs.lstat(asset.filePath); }
    catch { throw requestError('The owned source file is missing. Remove the entry and choose the file again.', 409); }
    this.checkReview(workspace, intent.draftRevision, reviewKey);
    const current = this.manager.originalSource(intent.workspaceId, intent.sourceAssetId);
    if (current.asset !== asset || !stat.isFile() || stat.size !== asset.size || hash(workspace.inspection) !== plan.inspectionKey) {
      throw requestError('The owned source identity or inspection changed. Review again.', 409);
    }
    this.checkAdmission(workspace, plan, { ignoreSlot: queued });
    return { workspace, asset, plan: freeze(structuredClone(plan)), intent: freeze(structuredClone(intent)), reviewKey };
  }

  async startPrepared(prepared, { queueJobId = null, isCancelled = () => false } = {}) {
    const { workspace, asset, plan, intent, reviewKey } = prepared;
    const assertCurrent = () => {
      if (isCancelled()) throw requestError('Queued processing was cancelled.', 409);
      const current = this.manager.originalSource(intent.workspaceId, intent.sourceAssetId);
      if (current.workspace !== workspace || current.asset !== asset || hash(workspace.inspection) !== plan.inspectionKey) {
        throw requestError('The queued source identity or inspection changed. Review again.', 409);
      }
      if (queueJobId ? workspace.queuedProcessingJobId !== queueJobId : workspace.queuedProcessingJobId) {
        throw requestError('This file has a different queued processing operation.', 409);
      }
      if (!queueJobId) this.checkReview(workspace, intent.draftRevision, reviewKey);
      this.checkAdmission(workspace, plan, { queueJobId });
    };
    assertCurrent();
    // A queued source can wait while another file runs. Recheck its owned bytes
    // immediately before admission, without consulting a newer browser draft.
    if (queueJobId) {
      let stat;
      try { stat = await this.manager.fs.lstat(asset.filePath); }
      catch { throw requestError('The owned source file is missing. Remove the entry and choose the file again.', 409); }
      assertCurrent();
      if (!stat.isFile() || stat.size !== asset.size) throw requestError('The queued source file changed or is missing.', 409);
    }
    const frozenPlan = freeze(structuredClone(plan));
    const snapshot = freeze({ draftRevision: intent.draftRevision, planKey: plan.key,
      editPlan: structuredClone(plan.editPlan), settings: structuredClone(plan.settings),
      streams: plan.streams.map(({ role, index, action }) => ({ role, index, action })),
      sourceDurationSeconds: workspace.inspection.durationSeconds, retainedDurationSeconds: plan.timing.durationSeconds,
      output: structuredClone(plan.output), rateBudget: structuredClone(plan.rateBudget || null) });
    const provenance = freeze({ inputAssetId: asset.id, inputRole: 'source', inputFilename: workspace.source.displayName,
      inputDurationSeconds: workspace.inspection.durationSeconds, editPlanKey: hash(plan.editPlan), planKey: plan.key,
      draftRevision: intent.draftRevision });
    Object.assign(workspace.conversion, { mode: 'processing', targetId: null, planKey: plan.key,
      draftRevision: intent.draftRevision, processingSnapshot: snapshot, failure: null, phasePercent: null });
    if (plan.status === 'no-op') {
      workspace.activeOperation = 'publishing-conversion';
      const previous = workspace.conversion.output;
      workspace.conversion.output = { assetId: asset.id, noOp: true, targetId: null, planKey: plan.key,
        provenance, draftRevision: intent.draftRevision, processingSnapshot: snapshot,
        filename: plan.downloadFilename || workspace.source.displayName, mime: asset.mime, size: asset.size, inspection: structuredClone(workspace.inspection) };
      Object.assign(workspace.conversion, { status: 'ready', phase: 'ready', percent: 100, message: 'No processing needed. The complete existing file is ready to download.' });
      try { if (previous && previous.assetId !== asset.id) await this.manager.outputRetirement.retire(workspace, previous.assetId); }
      finally { workspace.activeOperation = null; this.manager.emit(workspace); }
      return workspace;
    }
    // This is the same process-wide slot as the existing converter. No await
    // between final revalidation and ownership of every pass and correction.
    claimConversionSlot(workspace);
    workspace.activeOperation = 'converting';
    workspace.abortController = new AbortController(); workspace.cancelRequested = false;
    Object.assign(workspace.conversion, { status: 'running', phase: 'preparing', percent: null,
      message: 'Preparing the reviewed processing plan…', activeInputAssetId: asset.id, terminationPending: false });
    this.manager.emit(workspace);
    workspace.activePromise = this.perform(workspace, freeze({ ...asset }), freeze(structuredClone(workspace.inspection)), frozenPlan, snapshot, provenance);
    workspace.activePromise.catch(() => {});
    return workspace;
  }

  checkAdmission(workspace, plan, { ignoreSlot = false, queueJobId = null } = {}) {
    if (workspace.activeOperation || (workspace.queuedProcessingJobId && workspace.queuedProcessingJobId !== queueJobId)) {
      throw requestError('A local operation is running or queued. Wait for it to finish or cancel it.', 409);
    }
    if (!ignoreSlot && plan.status !== 'no-op' && conversionSlotBusy()) {
      throw Object.assign(requestError('A local operation is running. Wait for it to finish or cancel it.', 409), { code: 'LVOVD_CONVERSION_BUSY' });
    }
    if (workspace.conversion.cleanupPaths.size || this.manager.outputRetirement.state(workspace).blocked) throw requestError('Retry temporary cleanup before processing another file.', 409);
  }

  checkActive(workspace) {
    if (workspace.cancelRequested || workspace.abortController.signal.aborted || this.manager.get(workspace.id, { touch: false }) !== workspace) {
      throw Object.assign(new Error('Processing cancelled.'), { code: 'LVOVD_WORKSPACE_CANCELLED' });
    }
  }

  phase(workspace, phase, message, percent = null) {
    Object.assign(workspace.conversion, { phase, message, percent, phasePercent: null });
    this.manager.emit(workspace);
  }

  async perform(workspace, source, inspection, plan, snapshot, provenance) {
    const manager = this.manager, owned = new Set();
    let published = false, finalPath = null, videoBitrate = plan.rateBudget?.videoBitrate ?? null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        this.checkActive(workspace);
        const id = crypto.randomUUID(), directory = path.join(workspace.tempDir, `processing-${id}`);
        owned.add(directory); workspace.conversion.cleanupDirectories.add(directory); workspace.conversion.cleanupPaths.add(directory);
        await manager.fs.mkdir(directory);
        this.checkActive(workspace);
        const outputPath = path.join(directory, `result.partial.${plan.output.extension}`);
        workspace.conversion.attemptPath = outputPath;
        const passes = plan.passes || 1;
        for (let pass = 1; pass <= passes; pass++) {
          this.checkActive(workspace);
          const phase = passes === 2 ? `pass-${pass}` : 'encoding';
          this.phase(workspace, phase, `${attempt ? 'Size correction: ' : ''}${passes === 2 ? `Pass ${pass} of 2` : 'Processing file'}…`, attempt ? null : (pass - 1) / passes * 90);
          let pending = '';
          const onStdout = chunk => {
            pending = (pending + String(chunk)).slice(-8192);
            const lines = pending.split(/\r?\n/); pending = lines.pop();
            for (const line of lines) {
              const match = /^out_time_us=(\d+)$/.exec(line); if (!match) continue;
              const percent = Math.max(0, Math.min(99, Number(match[1]) / 1e6 / plan.timing.durationSeconds * 100));
              workspace.conversion.phasePercent = percent;
              // A corrective attempt changes the amount of work; keep overall
              // progress indeterminate then instead of moving a false ETA back.
              workspace.conversion.percent = attempt ? null : ((pass - 1) + percent / 100) / passes * 90;
              manager.emit(workspace);
            }
          };
          await manager.runOwnedProcess(workspace, 'ffmpeg', processingArgs(source.filePath, outputPath, inspection, plan,
            { pass: passes === 2 ? pass : null, passLogPrefix: path.join(directory, 'pass'), videoBitrate }),
          { operation: 'ffmpeg_processing', tool: 'ffmpeg', captureStdout: false, onStdout });
          this.checkActive(workspace);
        }
        workspace.conversion.status = 'validating';
        this.phase(workspace, 'validating', 'Validating the complete processed file…', 95);
        const stat = await manager.fs.lstat(outputPath);
        this.checkActive(workspace);
        if (!stat.isFile() || stat.size <= 0 || stat.size >= manager.maxConvertedBytes) throw new Error('Processed output is missing, empty, or reached the workspace safety size limit.');
        const outputInspection = await manager.defaultInspectAsset(workspace, { filePath: outputPath, size: stat.size });
        this.checkActive(workspace);
        validateProcessingOutput(outputInspection, plan);
        const maximumBytes = plan.rateBudget?.maximumBytes;
        if (maximumBytes && stat.size > maximumBytes) {
          if (attempt === 1) throw this.sizeFailure();
          const fixed = (plan.rateBudget.audioBytes || 0) + (plan.rateBudget.overheadBytes || 0);
          const next = Math.floor(Math.min(videoBitrate * 0.9, videoBitrate * (maximumBytes - fixed) / Math.max(1, stat.size - fixed) * 0.9));
          if (!Number.isFinite(next) || next < plan.rateBudget.minimumVideoBitrate || next <= 0) throw this.sizeFailure();
          this.phase(workspace, 'retrying', 'The complete file exceeded the maximum. Making one correction to the video bitrate…');
          await manager.conversions.removeFile(workspace, directory);
          // removeFile retains failed ownership for explicit retry. Do not
          // replenish its exhausted retry budget again from this finally block.
          owned.delete(directory);
          this.checkActive(workspace);
          if (workspace.conversion.cleanupPaths.has(directory)) throw new Error('Temporary processing cleanup needs a retry before correcting the size.');
          videoBitrate = next; workspace.conversion.status = 'running';
          continue;
        }
        finalPath = path.join(workspace.tempDir, `processed-${id}.${plan.output.extension}`);
        await manager.fs.rename(outputPath, finalPath);
        this.checkActive(workspace);
        const asset = manager.registerAsset(workspace, { role: 'converted-output', filePath: finalPath, size: stat.size,
          mime: plan.output.mime, filename: plan.downloadFilename, inspection: outputInspection });
        const previous = workspace.conversion.output;
        workspace.conversion.output = { assetId: asset.id, noOp: false, targetId: null, planKey: plan.key,
          filename: asset.filename, mime: asset.mime, size: asset.size, inspection: outputInspection, provenance,
          draftRevision: snapshot.draftRevision, processingSnapshot: snapshot, attempts: attempt + 1, effectiveVideoBitrate: videoBitrate };
        published = true;
        Object.assign(workspace.conversion, { status: 'ready', phase: 'ready', percent: 100, phasePercent: 100, message: 'Processed file ready.', failure: null });
        if (previous) await manager.outputRetirement.retire(workspace, previous.assetId);
        break;
      }
    } catch (error) {
      const cancelled = workspace.cancelRequested || workspace.abortController.signal.aborted || error.code === 'LVOVD_WORKSPACE_CANCELLED';
      Object.assign(workspace.conversion, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed', percent: null, phasePercent: null,
        message: cancelled ? 'Processing cancelled. Your source, edits, and previous result remain available.' : 'Processing failed. Your source, edits, and previous result remain available.',
        failure: cancelled ? null : manager.failureFor(error) });
    } finally {
      if (!published && finalPath) await manager.conversions.removeFile(workspace, finalPath);
      for (const directory of owned) await manager.conversions.removeFile(workspace, directory);
      workspace.conversion.attemptPath = null; workspace.conversion.activeInputAssetId = null;
      workspace.child = null; workspace.activeOperation = null; workspace.activePromise = null;
      releaseConversionSlot(workspace); manager.emit(workspace);
    }
  }

  sizeFailure() {
    return Object.assign(new Error('The chosen settings could not produce a complete file within the maximum size.'), { workspaceFailure: {
      category: 'local_processing_size', title: 'The complete output could not meet the maximum size',
      explanation: 'The completed file exceeded the requested maximum after the bounded size attempt. No oversized result was published; your previous result remains available.',
      help: 'Increase the maximum size or explicitly choose a smaller picture or audio bitrate, then review and process again.'
    } });
  }
}

module.exports = { ProcessingOperations, processingFilename, requestIntent, publicProcessingPlan };
