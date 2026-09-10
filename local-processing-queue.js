'use strict';

const crypto = require('node:crypto');
const { requestError } = require('./conversion-plan');
const { conversionSlotBusy, onConversionSlotReleased } = require('./conversion-workspace');

const DEFAULT_LIMITS = Object.freeze({ maxCollections: 2, maxEntries: 20, maxQueued: 20,
  maxUploadsPerCollection: 1, maxSourceBytes: 100 * 1024 ** 3 });
const LIVE = new Set(['queued', 'starting', 'running', 'cancelling']);

// A bounded local workbench owns existing workspaces. Jobs only retain a reviewed
// processing snapshot and its original source; output ownership stays in the
// workspace/retirement machinery, not in a second asset registry.
class LocalProcessingQueue {
  constructor(manager, limits = {}) {
    this.manager = manager;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...limits });
    this.collections = new Map();
    this.owners = new Map();
    this.reservations = new Map();
    this.order = [];
    this.draining = false;
    this.scheduled = false;
    this.unsubscribeSlot = null;
  }

  listen() {
    if (!this.unsubscribeSlot) this.unsubscribeSlot = onConversionSlotReleased(() => this.kick());
  }

  get(id, { touch = true } = {}) {
    const collection = this.collections.get(id);
    if (!collection) throw requestError('Local file collection not found or expired.', 404);
    if (touch) collection.lastAccessAt = this.manager.now();
    return collection;
  }

  createCollection() {
    this.reap();
    for (const collection of this.collections.values()) {
      if (this.dropEmptyDisconnected(collection)) continue;
      if (!collection.members.size && !collection.uploads && !collection.listener
        && this.manager.now() - collection.lastAccessAt >= this.manager.ttlMs) this.collections.delete(collection.id);
    }
    if (this.collections.size >= this.limits.maxCollections) throw requestError('The local workbench limit is reached. Remove an unused collection first.', 409);
    const collection = { id: crypto.randomUUID(), members: new Set(), jobs: new Map(), uploads: 0,
      listener: null, disconnected: false, lastAccessAt: this.manager.now(), admitting: false, admissionEpoch: 0, revision: 0 };
    this.collections.set(collection.id, collection); this.listen();
    return this.snapshot(collection.id);
  }

  snapshot(id, { touch = true } = {}) {
    const collection = this.get(id, { touch });
    return { id: collection.id, revision: ++collection.revision, limits: this.limits,
      sourceBytesReserved: [...this.reservations.values()].reduce((sum, item) => sum + item.bytes, 0),
      uploads: collection.uploads,
      workspaces: [...collection.members].map(workspaceId => this.manager.get(workspaceId, { touch: false }))
        .filter(Boolean).map(workspace => this.manager.publicWorkspace(workspace)),
      jobs: [...collection.jobs.values()].map(job => ({ id: job.id, workspaceId: job.workspaceId,
        sourceAssetId: job.sourceAssetId, draftRevision: job.draftRevision, planKey: job.planKey,
        status: job.status, message: job.message, failure: job.failure || null })) };
  }

  emit(collection) {
    if (!this.collections.has(collection.id) || !collection.listener) return;
    if (collection.waitingForDrain) return;
    try {
      const response = collection.listener;
      if (response.write(`data: ${JSON.stringify(this.snapshot(collection.id, { touch: false }))}\n\n`) === false) {
        // Coalesce progress to one fresh snapshot while the reader is slow.
        // Never append every FFmpeg progress event to an unbounded HTTP buffer.
        collection.waitingForDrain = true;
        response.once('drain', () => {
          if (collection.listener !== response) return;
          collection.waitingForDrain = false; this.emit(collection);
        });
      }
    }
    catch { this.closeListener(collection); }
  }

  subscribe(id, response) {
    const collection = this.get(id);
    this.closeListener(collection);
    collection.listener = response; collection.disconnected = false;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const heartbeat = setInterval(() => {
      if (collection.listener !== response) { clearInterval(heartbeat); return; }
      collection.lastAccessAt = this.manager.now();
      for (const workspaceId of collection.members) this.manager.get(workspaceId);
      if (!collection.waitingForDrain) { try { response.write(': local collection keepalive\n\n'); } catch { this.closeListener(collection); } }
    }, 15000);
    heartbeat.unref?.();
    collection.heartbeat = heartbeat;
    response.on('close', () => {
      clearInterval(heartbeat);
      if (collection.listener === response) {
        collection.listener = null; collection.disconnected = true;
        this.dropEmptyDisconnected(collection);
      }
    });
    this.emit(collection);
    return collection;
  }

  closeListener(collection) {
    collection.waitingForDrain = false;
    clearInterval(collection.heartbeat); collection.heartbeat = null;
    const response = collection.listener; collection.listener = null;
    if (response) collection.disconnected = true;
    if (response) { try { response.end(); } catch {} }
    // A replacement subscriber is installed synchronously after closing the
    // old one. Defer empty-collection reclamation until that handoff finishes.
    queueMicrotask(() => this.dropEmptyDisconnected(collection));
  }

  dropEmptyDisconnected(collection) {
    if (collection.disconnected && !collection.listener && !collection.members.size
      && !collection.uploads && !collection.admitting
      && !this.order.some(job => job.collectionId === collection.id && LIVE.has(job.status))) {
      this.collections.delete(collection.id);
      return true;
    }
    return false;
  }

  reap() {
    for (const [key, reservation] of this.reservations) {
      if (reservation.workspaceId && !this.manager.workspaces.has(reservation.workspaceId)
        && !this.manager.discards.has(reservation.workspaceId) && !this.manager.cleanupPending.has(reservation.workspaceId)) {
        this.reservations.delete(key);
      }
    }
  }

  reserve(collection, bytes) {
    this.reap();
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw requestError('Collection uploads require a finite positive Content-Length.', 400);
    if (collection.members.size + collection.uploads >= this.limits.maxEntries) throw requestError(`A local workbench accepts at most ${this.limits.maxEntries} files.`, 409);
    const used = [...this.reservations.values()].reduce((sum, item) => sum + item.bytes, 0);
    if (bytes > this.manager.maxBytes || used + bytes > this.limits.maxSourceBytes) throw requestError('The local original-source storage budget is full. Remove files or retry pending cleanup first.', 413);
    // Failed cleanup still consumes bounded intake slots as well as its byte
    // reservation. Repeated tiny failed files cannot bypass the byte bound.
    if (this.reservations.size >= this.limits.maxCollections * this.limits.maxEntries) throw requestError('Temporary file cleanup must finish before adding more files.', 409);
    const key = crypto.randomUUID();
    this.reservations.set(key, { bytes, workspaceId: null, collectionId: collection.id });
    return key;
  }

  attach(collection, workspace, reservationKey) {
    if (this.collections.get(collection.id) !== collection) throw requestError('The local collection was removed.', 409);
    if (this.owners.has(workspace.id)) throw requestError('This workspace already belongs to a local collection.', 409);
    collection.members.add(workspace.id); this.owners.set(workspace.id, collection.id);
    this.reservations.get(reservationKey).workspaceId = workspace.id;
    this.emit(collection);
  }

  async receiveLocalStream(id, readable, options) {
    const collection = this.get(id);
    if (collection.uploads >= this.limits.maxUploadsPerCollection) throw requestError('Another file is uploading to this collection. Wait before uploading the next file.', 409);
    const key = this.reserve(collection, options.declaredLength);
    collection.uploads++;
    let workspace;
    try {
      return await this.manager.receiveLocalStream(readable, { ...options, purpose: 'local',
        maximumReceivedBytes: options.declaredLength,
        onWorkspace: current => { workspace = current; this.attach(collection, current, key); } });
    } catch (error) {
      if (workspace) this.workspaceRemoved(workspace);
      else this.reservations.delete(key);
      throw error;
    } finally { collection.uploads--; this.reap(); this.emit(collection); }
  }

  attachWorkspace(id, workspaceId) {
    const collection = this.get(id), workspace = this.manager.get(workspaceId);
    if (!workspace || workspace.source.origin !== 'url') throw requestError('Only an existing URL editor workspace can be attached here.', 409);
    if (this.owners.get(workspace.id) === id) return this.snapshot(id);
    if (this.owners.has(workspace.id)) throw requestError('This source belongs to another local collection.', 409);
    // URL acquisition has its own size cap. Reserve that cap while its actual
    // source length is unknown, never an invented zero-byte allowance.
    const key = this.reserve(collection, workspace.source.size || this.manager.maxBytes);
    this.attach(collection, workspace, key);
    return this.snapshot(id);
  }

  member(collection, workspaceId) {
    if (!collection.members.has(workspaceId) || this.owners.get(workspaceId) !== collection.id) throw requestError('This file does not belong to the selected local collection.', 409);
    const workspace = this.manager.get(workspaceId);
    if (!workspace) throw requestError('This file was removed or expired.', 409);
    return workspace;
  }

  async enqueue(id, entries) {
    const collection = this.get(id);
    if (!Array.isArray(entries) || !entries.length || entries.length > this.limits.maxQueued) throw requestError('Submit a bounded list of reviewed processing entries.', 400);
    if (collection.admitting) throw requestError('A submission is already being reviewed for this collection.', 409);
    if (new Set(entries.map(entry => entry?.workspaceId)).size !== entries.length) throw requestError('Submit each file only once.', 409);
    collection.admitting = true;
    const admissionEpoch = collection.admissionEpoch;
    try {
      const prepared = [];
      for (const body of entries) {
        this.member(collection, body?.workspaceId);
        prepared.push(await this.manager.processing.prepare(structuredClone(body), { queued: true }));
      }
      if (this.collections.get(id) !== collection) throw requestError('The local collection was removed.', 409);
      if (collection.admissionEpoch !== admissionEpoch) throw requestError('The pending queue submission was cancelled. Review and submit again.', 409);
      if (this.order.filter(job => LIVE.has(job.status)).length + prepared.length > this.limits.maxQueued) throw requestError('The local processing queue is full.', 409);
      for (const item of prepared) {
        const workspace = this.member(collection, item.workspace.id);
        this.manager.processing.checkReview(workspace, item.intent.draftRevision, item.reviewKey);
        this.manager.processing.checkAdmission(workspace, item.plan, { ignoreSlot: true });
        if (workspace !== item.workspace || workspace.assets.get(item.asset.id) !== item.asset
          || crypto.createHash('sha256').update(JSON.stringify(workspace.inspection)).digest('hex') !== item.plan.inspectionKey) {
          throw requestError('A reviewed source changed before queue admission.', 409);
        }
      }
      // No asynchronous boundary between final validation, pinning original
      // sources, and publishing all jobs. Process All is an atomic admission.
      for (const item of prepared) {
        const job = { id: crypto.randomUUID(), collectionId: id, workspaceId: item.workspace.id,
          sourceAssetId: item.asset.id, draftRevision: item.intent.draftRevision, planKey: item.plan.key,
          status: 'queued', message: 'Queued for local processing.', prepared: item,
          queuedAt: this.manager.now(), cancelled: false };
        item.workspace.queuedProcessingJobId = job.id;
        collection.jobs.set(job.workspaceId, job); this.order.push(job);
      }
      this.emit(collection); this.kick();
      return this.snapshot(id);
    } finally { collection.admitting = false; }
  }

  kick() {
    if (this.scheduled || this.draining) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.drain().catch(() => {}); });
  }

  finish(job, status, message, error = null) {
    job.status = status; job.message = message;
    if (error) job.failure = this.manager.failureFor(error);
    const workspace = job.prepared?.workspace;
    if (workspace?.queuedProcessingJobId === job.id) {
      workspace.queuedProcessingJobId = null;
      this.manager.touch(workspace);
    }
    job.prepared = null;
    this.order = this.order.filter(item => item !== job);
    const collection = this.collections.get(job.collectionId);
    if (collection) { this.emit(collection); this.dropEmptyDisconnected(collection); }
  }

  async drain() {
    if (this.draining || conversionSlotBusy()) return;
    this.draining = true;
    try {
      while (!conversionSlotBusy()) {
        const job = this.order.find(item => item.status === 'queued');
        if (!job) break;
        const collection = this.collections.get(job.collectionId);
        if (!collection || job.cancelled) { this.finish(job, 'cancelled', 'Queued processing cancelled.'); continue; }
        job.status = 'starting'; job.message = 'Checking the queued source before processing.'; this.emit(collection);
        try {
          const workspace = await this.manager.processing.startPrepared(job.prepared,
            { queueJobId: job.id, isCancelled: () => job.cancelled || !collection.members.has(job.workspaceId) });
          job.status = job.cancelled ? 'cancelling' : 'running'; job.message = job.cancelled ? 'Cancelling local processing…' : 'Processing this file.';
          this.emit(collection);
          if (workspace.activePromise) await workspace.activePromise;
          const status = job.cancelled || workspace.conversion.status === 'cancelled' ? 'cancelled'
            : workspace.conversion.status === 'ready' ? 'completed' : 'failed';
          job.failure = workspace.conversion.failure;
          this.finish(job, status, status === 'completed' ? 'File ready to download.' : workspace.conversion.message);
        } catch (error) {
          if (!job.cancelled && error.code === 'LVOVD_CONVERSION_BUSY') {
            job.status = 'queued'; job.message = 'Waiting for the current local operation to finish.'; this.emit(collection);
            break;
          }
          this.finish(job, job.cancelled ? 'cancelled' : 'failed', job.cancelled ? 'Queued processing cancelled.' : error.message, job.cancelled ? null : error);
        }
      }
    } finally {
      this.draining = false;
      if (!conversionSlotBusy() && this.order.some(job => job.status === 'queued')) this.kick();
    }
  }

  async cancel(id, workspaceId = null) {
    const collection = this.get(id);
    if (workspaceId !== null) this.member(collection, workspaceId);
    collection.admissionEpoch++;
    const jobs = [...collection.jobs.values()].filter(job => LIVE.has(job.status) && (workspaceId === null || job.workspaceId === workspaceId));
    // Mark every selected job before awaiting termination, so Cancel All cannot
    // admit a following job in the gap between two cancellation calls.
    for (const job of jobs) {
      const workspace = job.prepared?.workspace;
      // Publication wins a late cancellation while safe retirement/attempt
      // cleanup is still finishing. Do not relabel an existing result as lost.
      if (workspace?.conversion.status === 'ready' && workspace.conversion.output?.planKey === job.planKey
        && workspace.activeOperation) continue;
      job.cancelled = true;
      if (job.status === 'queued') this.finish(job, 'cancelled', 'Queued processing cancelled.');
      else { job.status = 'cancelling'; job.message = 'Cancelling local processing…'; }
    }
    this.emit(collection);
    for (const job of jobs) {
      if (!job.cancelled) continue;
      const workspace = this.manager.get(job.workspaceId, { touch: false });
      if (workspace?.activeOperation === 'converting' && ['running', 'validating', 'cancelling'].includes(workspace.conversion.status)) {
        await this.manager.conversions.cancel(workspace.id);
      }
    }
    this.kick();
    return this.snapshot(id);
  }

  workspaceChanged(workspace) {
    if (workspace.source.size > 0) {
      for (const reservation of this.reservations.values()) {
        if (reservation.workspaceId === workspace.id) reservation.bytes = Math.min(reservation.bytes, workspace.source.size);
      }
    }
    const collection = this.collections.get(this.owners.get(workspace.id));
    if (collection) this.emit(collection);
  }

  workspaceRemoved(workspace) {
    const collection = this.collections.get(this.owners.get(workspace.id));
    if (!collection) return;
    collection.members.delete(workspace.id); this.owners.delete(workspace.id);
    const job = collection.jobs.get(workspace.id);
    if (job && LIVE.has(job.status)) {
      job.cancelled = true;
      if (job.status === 'queued') this.finish(job, 'cancelled', 'The queued file was removed.');
    }
    collection.jobs.delete(workspace.id);
    this.emit(collection); this.dropEmptyDisconnected(collection);
  }

  async discardCollection(id) {
    const collection = this.get(id);
    if (collection.uploads || collection.admitting) throw requestError('Wait for the current intake or admission before removing the collection.', 409);
    collection.admissionEpoch++;
    for (const job of collection.jobs.values()) {
      job.cancelled = true;
      if (job.status === 'queued') this.finish(job, 'cancelled', 'The local collection was removed.');
    }
    this.closeListener(collection);
    this.collections.delete(id);
    const discarded = [];
    for (const workspaceId of collection.members) {
      this.owners.delete(workspaceId);
      discarded.push(this.manager.discard(workspaceId));
    }
    // Invalidate every member before awaiting any child's termination/cleanup.
    await Promise.all(discarded);
    this.reap();
    return { id, removed: true, cleanupPending: [...this.reservations.values()].some(item => item.collectionId === id) };
  }

  sweep(now = this.manager.now()) {
    for (const job of [...this.order]) {
      if (job.status === 'queued' && now - job.queuedAt >= this.manager.ttlMs) {
        job.cancelled = true; this.finish(job, 'cancelled', 'Queued processing expired before it could start. Review and submit again.');
      }
    }
    this.reap();
    for (const collection of [...this.collections.values()]) {
      if (!collection.members.size && !collection.uploads && !collection.admitting && now - collection.lastAccessAt >= this.manager.ttlMs) {
        this.closeListener(collection); this.collections.delete(collection.id);
      }
    }
  }

  clear() {
    for (const collection of this.collections.values()) {
      for (const job of collection.jobs.values()) {
        job.cancelled = true;
        if (job.status === 'queued') this.finish(job, 'cancelled', 'Local processing was cleared.');
      }
      this.closeListener(collection);
    }
    if (this.unsubscribeSlot) this.unsubscribeSlot(); this.unsubscribeSlot = null;
    this.collections.clear(); this.owners.clear(); this.order = []; this.reap();
  }
}

module.exports = { LocalProcessingQueue, DEFAULT_LIMITS };
