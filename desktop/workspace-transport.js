'use strict';
// Presentation adapter for the released editor. Every operation is an explicit
// native command; endpoint-shaped names here never start an HTTP request.
(function(root) {
  const native = root.LVOVDNative;
  let active = null, current = null, revision = 0, connection = 0;
  const ready = native.call('desktop_handshake').then(value => {
    if (value.protocolVersion !== 1) throw new Error('The desktop interface and backend versions do not match.');
    return value;
  });
  function projection(value) {
    if (!value) return null;
    if (current?.workbenchId === value.workbenchId && (value.revision < current.revision || value.queueRevision < current.queueRevision)) value = current;
    else { current = value; revision++; }
    const jobs = value.jobs.map(job => { const failure = job.failure?.workspaceFailure || job.failure; return { ...job, workspaceId: job.sourceId, message: job.failure?.message, failure: failure && { ...failure, explanation: failure.explanation || job.failure.message } }; });
    return { id: value.workbenchId, revision, connectionEpoch: connection, limits: { maxEntries: 20 }, jobs,
      intakeFailure: value.intakeFailure, importing: value.importing, removedCleanup: value.cleanup.map(id => ({ workspaceId: id, name: 'Removed file', status: value.failedCleanup.includes(id) ? 'failed' : 'pending', message: value.failedCleanup.includes(id) ? 'Retry temporary-file cleanup.' : 'Waiting for active resources to close.' })),
      workspaces: value.sources.map(source => {
        const id = source.assetId, preview = value.previews.find(p => p.sourceAssetId === id), waveform = value.waveforms.find(p => p.sourceAssetId === id);
        const editor = value.editors.find(p => p.sourceId === id) || { eligible: false };
        const job = jobs.find(j => j.sourceId === id), result = value.results.find(r => r.sourceId === id);
        const output = result && { ...result, assetId: result.resultId, planKey: result.review.key, processingSnapshot: result.review,
          downloadUrl: native.mediaUrl(result.resultId), playbackUrl: result.mime ? native.mediaUrl(result.resultId) : null };
        const duration = job?.durationSeconds || job?.result?.review?.output?.durationSeconds || result?.review?.output?.durationSeconds || editor.durationSeconds;
        return { id, sourceAssetId: id, purpose: 'local', source: { name: source.name, size: source.size, origin: 'local' }, inspection: source.inspection.media,
          status: 'ready', activeOperation: preview?.status === 'preparing' ? 'proxying' : null,
          processingRevision: value.processingRevisions.find(([sourceId]) => sourceId === id)?.[1] ?? null,
          editor: { ...editor, operationId: preview?.operationId, status: preview?.status || 'idle', message: preview?.message }, waveform: waveform || { status: 'idle' },
          playback: preview?.status === 'ready' && preview.assetId ? { assetId: preview.assetId, role: preview.proxy ? 'playback-proxy' : 'original', proxy: preview.proxy, mime: source.inspection.media?.video ? 'video/mp4' : 'audio/mp4', url: native.mediaUrl(preview.assetId) } : null,
          conversion: { status: job?.status || (result ? 'ready' : 'idle'), percent: job?.progress?.outTimeUs != null && duration > 0 ? Math.min(99, ((Math.max(1, job.progress.pass) - 1) * 100 + job.progress.outTimeUs / (duration * 10000)) / Math.max(1, job.progress.passes)) : null,
            message: job?.message || (job?.progress?.validating ? 'Validating output…' : job?.progress?.passes === 2 ? `Pass ${job.progress.pass} of 2 · Attempt ${job.progress.attempt}` : null), failure: job?.failure, output, cleanupPending: value.failedCleanup.includes(id) },
          outputCleanup: { blocked: value.failedCleanup.includes(id) } };
      }) };
  }
  const scoped = sourceId => {
    if (!active) throw new Error('Local Media is not connected. Reopen the application.');
    return { workbenchId: active, sourceId };
  };
  async function perform(path, body, method, query) {
    await ready;
    if (path === '/api/processing/collection') {
      const result = await native.call('create_workbench'); active = result.workbenchId;
      return { collection: projection(result) };
    }
    if (path === '/api/processing/collections') {
      const entries = await native.call('list_workbenches');
      return { collections: entries.filter(e => e.discarded).map(e => ({ id: e.workbenchId, names: [], files: 0, busy: e.importing, available: true,
        cleanup: e.cleanup.map(id => ({ workspaceId: id, status: e.failedCleanup.includes(id) ? 'failed' : 'pending' })) })) };
    }
    if (path === '/api/processing/plan') {
      if (body.workspaceId !== body.sourceAssetId) throw new Error('The review belongs to another source.');
      const plan = await native.call('review_processing', { request: { ...scoped(body.sourceAssetId), draftRevision: body.draftRevision, settings: body.settings, editPlan: body.editPlan } });
      return { plan: { ...plan, workspaceId: body.workspaceId } };
    }
    if (path === '/api/processing/queue') {
      return { collection: projection(await native.call('queue_processing', { request: { workbenchId: body.collectionId,
        entries: body.entries.map(e => ({ sourceId: e.sourceAssetId, key: e.planKey, acknowledgements: e.acknowledgedWarnings || [] })) } })) };
    }
    if (path === '/api/processing/queue/cancel') {
      const job = body.workspaceId && current?.jobs.find(j => j.sourceId === body.workspaceId);
      if (body.workspaceId && !job) throw new Error('This processing job has finished or expired.');
      return { collection: projection(await native.call('cancel_processing', { request: { workbenchId: body.collectionId, jobId: job?.id || null } })) };
    }
    if (path === '/api/workspace' && method === 'DELETE') {
      const result = await native.call('remove_source', { request: scoped(query.get('workspace')) });
      projection(result);
      return { cleanup: { status: result.cleanup.includes(query.get('workspace')) ? 'pending' : 'complete' } };
    }
    if (path === '/api/processing/cleanup' || path === '/api/conversion/cleanup') {
      const result = await native.call('cleanup_workbench', { request: { workbenchId: body.collectionId || active } });
      return { collection: projection(result) };
    }
    if (path === '/api/processing/collection/remove') {
      return { collection: projection(await native.call('discard_workbench', { request: { workbenchId: body.collectionId } })) };
    }
    if (path === '/api/workspace/editor' || path === '/api/workspace/waveform') {
      const sourceId = body.sourceAssetId || query.get('sourceAssetId'), workspaceId = body.workspaceId || query.get('workspaceId');
      if (sourceId !== workspaceId) throw new Error('The request belongs to another source.');
      if (method === 'DELETE') { await native.call('cancel_waveform', { request: { ...scoped(sourceId), operationId: body.operationId } }); return {}; }
      if (method === 'GET') return native.call('waveform_window', { request: { ...scoped(sourceId), operationId: query.get('operationId'),
        startSeconds: Number(query.get('startSeconds')), endSeconds: Number(query.get('endSeconds')), points: Number(query.get('points')) } });
      const collection = projection(await native.call(path.endsWith('/editor') ? 'prepare_editor' : 'prepare_waveform', { request: scoped(sourceId) }));
      return { workspace: collection.workspaces.find(w => w.id === sourceId) };
    }
    throw new Error('This operation is not available in the desktop application yet.');
  }
  root.LVOVDWorkspaceTransport = Object.freeze({ ready,
    async request(url, options = {}) {
      const [path, rawQuery = ''] = url.split('?');
      try {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const value = await perform(path, JSON.parse(options.body || '{}'), options.method || 'GET', new URLSearchParams(rawQuery));
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return { ok: true, status: 200, json: async () => value };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        return { ok: false, status: error.code === 'ASSET_GONE' ? 404 : 400, json: async () => ({ error: error.message }) };
      }
    },
    async subscribe(id, accept, expired) {
      active = id; connection++;
      return native.subscribe(id, value => value ? accept(projection(value)) : expired());
    },
    async pick(id) { return native.call('pick_source', { request: { workbenchId: id } }); },
    async save(output) {
      return native.call('save_result', { request: { workbenchId: active, resultId: output.assetId } });
    },
    async saveAll(outputs) { return native.call('save_results', { request: { workbenchId: active, resultIds: outputs.map(o => o.assetId) } }); },
    preview(output) {
      root.document.dispatchEvent(new CustomEvent('lvovd:preview-result', { detail: { url: output.playbackUrl, name: output.filename, audio: !output.inspection?.video } }));
    },
    cancelPreview(sourceId, operationId) { return native.call('cancel_editor', { request: { ...scoped(sourceId), operationId } }).catch(() => {}); },
    owner() { return active; }
  });
})(globalThis);
