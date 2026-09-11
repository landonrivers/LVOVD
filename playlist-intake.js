'use strict';

const crypto = require('node:crypto');
const { requestError } = require('./conversion-plan');
const { courtesyDelayMs } = require('./request-safety');

function cancelled() { return Object.assign(new Error('Playlist import cancelled.'), { code: 'LVOVD_WORKSPACE_CANCELLED' }); }
function pause(signal, milliseconds) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function only(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw requestError('Invalid playlist import request.', 400);
}

// Intake owns bounded descriptors and source reservations, not another media
// registry or processing scheduler. Its one coordinator task calls acquisition
// directly; it must never await a nested coordinator acquisition.
class PlaylistIntake {
  constructor(queue, { coordinator, acquire, normalizeAcquisition, classifyFailure, wait = pause, delay = courtesyDelayMs }) {
    this.queue = queue; this.manager = queue.manager;
    Object.assign(this, { coordinator, acquire, normalizeAcquisition, classifyFailure, wait, delay });
    this.previews = new Map(); queue.intake = this;
  }
  remember(info) {
    if (info.kind !== 'playlist') return info;
    const now = this.manager.now();
    for (const [id, value] of this.previews) if (now - value.createdAt >= 10 * 60 * 1000) this.previews.delete(id);
    while (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value);
    const previewId = crypto.randomUUID();
    this.previews.set(previewId, { createdAt: now, entries: info.entries.slice(0, 100).map(entry => ({
      url: typeof entry.url === 'string' && entry.url.length <= 4096 ? entry.url : null,
      title: String(entry.title || 'Playlist video').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180), intakeEligible: entry.intakeEligible
    })),
      sourceName: String(info.source?.name || info.source?.hostname || 'media source').slice(0, 120) });
    return { ...info, playlistImportId: previewId };
  }
  snapshot(collection) {
    const batch = collection.intake;
    if (!batch) return null;
    return { id: batch.id, active: batch.active, status: batch.status, message: batch.message,
      items: batch.items.map(item => ({ id: item.id, workspaceId: item.workspaceId, title: item.title,
        status: item.status, message: item.message, removed: item.removed, failure: item.failure || null })) };
  }
  admit(body) {
    only(body, ['collectionId', 'previewId', 'entryUrls', 'acquisition', 'requestId']);
    const collection = this.queue.get(body.collectionId);
    if (typeof body.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.requestId)) throw requestError('A valid import request identity is required.', 400);
    const acquisition = this.normalizeAcquisition(body.acquisition);
    if (acquisition.sourceFormat?.mode === 'manual') throw requestError('Manual source formats cannot be applied to a playlist.', 400);
    const preview = this.previews.get(body.previewId);
    if (!preview || this.manager.now() - preview.createdAt >= 10 * 60 * 1000) throw requestError('Preview this playlist again before importing.', 409);
    if (!Array.isArray(body.entryUrls) || !body.entryUrls.length || body.entryUrls.length > 100
      || body.entryUrls.some(url => typeof url !== 'string' || url.length > 4096)) throw requestError('Choose a bounded list of playlist item URLs.', 400);
    const selected = new Set(body.entryUrls), ordered = [], found = new Set();
    for (const entry of preview.entries) {
      if (!entry.url || !selected.has(entry.url) || found.has(entry.url)) continue;
      if (entry.intakeEligible === false) throw requestError('The selection contains an unavailable, live or protected item.', 400);
      found.add(entry.url); ordered.push({ url: entry.url, title: String(entry.title || 'Playlist video').slice(0, 180) });
    }
    if (found.size !== selected.size) throw requestError('Every selected item must have a resolved page URL in this Preview.', 400);
    const key = crypto.createHash('sha256').update(JSON.stringify({ previewId: body.previewId, ordered, acquisition })).digest('hex');
    for (const other of this.queue.collections.values()) if (other !== collection && other.intake?.id === body.requestId) throw requestError('This import belongs to another collection.', 409);
    if (collection.intake?.id === body.requestId) {
      if (collection.intake.key !== key) throw requestError('This import request identity already has different choices.', 409);
      return this.queue.snapshot(collection.id);
    }
    if (collection.intake?.active) throw requestError('This collection already has an import. Cancel it or wait for settlement.', 409);
    this.queue.reap();
    if (this.queue.entryCount(collection) + ordered.length > this.queue.limits.maxEntries
      || this.queue.reservedFileCount() + ordered.length > this.queue.limits.maxCollections * this.queue.limits.maxEntries) {
      throw requestError(`The entire selection must fit within the ${this.queue.limits.maxEntries}-file collection and pending-cleanup limits.`, 409);
    }
    const batch = { id: body.requestId, key, active: true, status: 'waiting', message: 'Waiting for source access…',
      createdAt: this.manager.now(), controller: new AbortController(), acquisition: Object.freeze({ ...acquisition, sourceFormat: Object.freeze({ ...acquisition.sourceFormat }) }),
      sourceName: preview.sourceName, items: Object.freeze(ordered.map(item => {
        const descriptor = { workspaceId: null, status: 'waiting', message: 'Not started', removed: false };
        for (const [key, value] of Object.entries({ ...item, id: crypto.randomUUID() })) Object.defineProperty(descriptor, key, { value, enumerable: true });
        return descriptor;
      })) };
    collection.intake = batch;
    for (const item of batch.items) collection.intakeSlots.add(item.id);
    this.queue.emit(collection);
    batch.promise = this.coordinator.acquire(() => this.run(collection, batch)).finally(() => {
      batch.active = false;
      for (const item of batch.items) collection.intakeSlots.delete(item.id);
      this.queue.reap(); this.queue.emit(collection); this.queue.dropEmptyDisconnected(collection);
    });
    batch.promise.catch(() => {});
    return this.queue.snapshot(collection.id);
  }
  current(collection, batch) {
    return this.queue.collections.get(collection.id) === collection && collection.intake === batch && !batch.controller.signal.aborted;
  }
  changed(workspace) {
    const collection = this.queue.collections.get(this.queue.owners.get(workspace.id));
    const item = collection?.intake?.items.find(item => item.id === workspace.id);
    if (item && !item.removed && ['waiting', 'acquiring', 'inspecting'].includes(item.status) && ['acquiring', 'inspecting'].includes(workspace.status)) {
      item.status = workspace.status; item.message = workspace.message;
    }
  }
  stop(collection, message = 'Import cancelled; remaining items were not started.') {
    const batch = collection.intake;
    if (!batch?.active) return;
    batch.controller.abort(); batch.status = 'cancelled'; batch.message = message;
    for (const item of batch.items) if (['waiting', 'acquiring', 'inspecting'].includes(item.status)) {
      item.status = 'cancelled'; item.message = item.workspaceId ? 'Import cancelled' : 'Cancelled — not started';
      if (!item.workspaceId) collection.intakeSlots.delete(item.id);
    }
    const active = batch.current;
    if (active && this.manager.workspaces.has(active.id)) this.manager.discard(active.id).catch(() => {});
    this.queue.emit(collection);
  }
  cancel(body) {
    only(body, ['collectionId', 'requestId']);
    const collection = this.queue.get(body.collectionId);
    if (collection.intake?.id !== body.requestId) throw requestError('That import does not belong to this collection.', 409);
    this.stop(collection); return this.queue.snapshot(collection.id);
  }
  removed(workspaceId) {
    for (const collection of this.queue.collections.values()) {
      const item = collection.intake?.items.find(item => item.id === workspaceId);
      if (!item) continue;
      item.removed = true; collection.intakeSlots.delete(item.id);
      if (['waiting', 'acquiring', 'inspecting'].includes(item.status)) this.stop(collection, 'An importing file was removed; remaining items were not started.');
      this.queue.emit(collection); return true;
    }
    return false;
  }
  async run(collection, batch) {
    try {
      for (let index = 0; index < batch.items.length; index++) {
        if (!this.current(collection, batch)) throw cancelled();
        const item = batch.items[index];
        if (index) {
          batch.status = 'waiting'; batch.message = 'Giving the source a short break…'; this.queue.emit(collection);
          await this.wait(batch.controller.signal, this.delay());
          if (!this.current(collection, batch)) throw cancelled();
        }
        let reservationKey, workspace;
        try {
          this.queue.reap();
          const used = [...this.queue.reservations.values()].reduce((sum, item) => sum + item.bytes, 0);
          const maximumBytes = Math.min(this.manager.maxBytes, this.queue.limits.maxSourceBytes - used);
          if (maximumBytes <= 0) throw requestError('The original-source storage budget is full. Remove files or retry cleanup before importing.', 413);
          reservationKey = this.queue.reserve(collection, maximumBytes, item.id);
          const reservation = this.queue.reservations.get(reservationKey);
          reservation.workspaceId = item.id; reservation.displayName = item.title; reservation.fixed = true; reservation.preparing = true;
          workspace = await this.manager.createUrlWorkspace({ id: item.id, purpose: 'local', displayName: item.title, sourceName: batch.sourceName, waiting: true });
          reservation.preparing = false;
          if (!this.current(collection, batch) || item.removed) throw cancelled();
          batch.current = workspace; item.workspaceId = workspace.id;
          this.queue.attach(collection, workspace, reservationKey); collection.intakeSlots.delete(item.id);
          item.status = 'acquiring'; batch.status = 'acquiring'; batch.message = `Importing item ${index + 1} of ${batch.items.length}`;
          this.queue.emit(collection);
          // The collection and cancellation owner already exist before acquire can
          // spawn. This per-item promise lets Discard await only owned resources.
          const operation = Promise.resolve().then(() => {
            if (!this.current(collection, batch) || item.removed || workspace.cancelRequested) throw cancelled();
            return this.acquire(workspace, item.url, structuredClone(batch.acquisition), { title: item.title, sourceName: batch.sourceName }, { maximumBytes });
          });
          workspace.activePromise = operation;
          await operation;
          if (!this.current(collection, batch) || item.removed || !this.manager.workspaces.has(workspace.id)) throw cancelled();
          if (workspace.status !== 'ready' || !workspace.inspection?.video || !workspace.sourceAssetId) {
            throw Object.assign(new Error('Acquisition did not produce an inspected video source.'), { intakeFailure: workspace.failure });
          }
          reservation.bytes = workspace.source.size; reservation.fixed = false;
          item.status = 'ready'; item.message = 'Ready in Local Media'; batch.current = null;
          this.queue.emit(collection);
        } catch (error) {
          const isCancelled = !this.current(collection, batch) || item.removed || workspace?.cancelRequested;
          item.status = isCancelled ? 'cancelled' : 'failed';
          item.failure = isCancelled ? null : error.intakeFailure || (error.statusCode === 413 ? {
            category: 'local_source_budget', title: 'Local source storage budget is full', explanation: error.message,
            help: 'Remove files or finish pending cleanup before importing again.'
          } : this.classifyFailure(error));
          item.message = isCancelled ? 'Import cancelled' : item.failure.title;
          if (workspace) {
            if (isCancelled) await this.manager.discard(workspace.id);
            else if (!workspace.cleanupRecord) await this.manager.failAcquisition(workspace, item.failure);
            const reservation = this.queue.reservations.get(reservationKey);
            if (reservation && this.manager.cleanupStatus(workspace).status === 'complete') reservation.bytes = 0;
          } else if (reservationKey) this.queue.reservations.delete(reservationKey);
          batch.status = item.status; batch.message = isCancelled ? 'Import cancelled.' : `Import stopped: ${item.title}. Remaining items were not started.`;
          for (const remaining of batch.items.slice(index + 1)) { remaining.status = 'cancelled'; remaining.message = 'Not started'; }
          this.queue.emit(collection); return;
        }
      }
      batch.status = 'ready'; batch.message = 'Import complete. Review files before processing.';
    } catch (error) {
      batch.status = 'cancelled'; batch.message = 'Import cancelled; remaining items were not started.';
      for (const item of batch.items) if (item.status === 'waiting') { item.status = 'cancelled'; item.message = 'Cancelled — not started'; }
    }
  }
}

module.exports = { PlaylistIntake, pause };
