'use strict';

// Output ownership is explicit: latest results, admitted conversion, and opened
// readers. Provenance on a separately generated result does not own input bytes.
class OutputRetirement {
  constructor(manager) { this.manager = manager; }

  referenced(workspace, assetId) {
    return workspace.render.outputAssetId === assetId
      || workspace.conversion.activeInputAssetId === assetId
      || workspace.conversion.output?.assetId === assetId
      || [...workspace.readStreams.values()].some(reader => reader.assetId === assetId);
  }

  state(workspace) {
    const records = [...workspace.retiredOutputs.values()];
    const blocked = records.some(record => ['deleting', 'failed'].includes(record.status));
    return { pending: records.length > 0, blocked,
      message: blocked ? 'Temporary output cleanup needs to finish or be retried before creating another file.'
        : records.length ? 'Previous output bytes remain in use by a result or an open download.' : null };
  }

  async retire(workspace, assetId, { retry = false } = {}) {
    let record = workspace.retiredOutputs.get(assetId);
    if (!record) {
      const asset = workspace.assets.get(assetId);
      if (!asset || !['edited-output', 'converted-output'].includes(asset.role)) return;
      record = { asset, status: 'retained', promise: null };
      workspace.retiredOutputs.set(assetId, record);
    }
    if (record.promise) return record.promise;
    if (!this.manager.get(workspace.id, { touch: false }) || this.referenced(workspace, assetId)) return;
    if (record.status === 'failed' && !retry) return;
    // Revoke registry access before the asynchronous deletion. The record keeps
    // the path even on failure. No new reader/input may acquire it now.
    workspace.assets.delete(assetId);
    record.status = 'deleting';
    record.promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.manager.fs.rm(record.asset.filePath, { force: true });
          workspace.retiredOutputs.delete(assetId);
          return;
        } catch (error) {
          const delay = this.manager.cleanupRetryDelaysMs[attempt];
          if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE'].includes(error.code) || delay == null) {
            record.status = 'failed'; return;
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    })();
    try { await record.promise; }
    finally { record.promise = null; if (this.manager.get(workspace.id, { touch: false })) this.manager.emit(workspace); }
  }

  async retry(workspace) {
    for (const id of [...workspace.retiredOutputs.keys()]) await this.retire(workspace, id, { retry: true });
  }
}

module.exports = { OutputRetirement };
