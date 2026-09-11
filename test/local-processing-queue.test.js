'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { createMediaWorkspaceManager } = require('../media-workspace');
const { normalizeMediaInspection } = require('../media-inspection');
const { conversionSlotBusy } = require('../conversion-workspace');

const FULL = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 9 }] };
const CUT = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 6, endSeconds: 9 }] };
const QUALITY = { videoCodec: 'h264', container: 'mp4', rate: { mode: 'quality', crf: 24 } };
function facts(duration = 9) {
  return normalizeMediaInspection({ format: { format_name: 'mov,mp4,m4a', start_time: '0', duration: String(duration), tags: { major_brand: 'isom' } }, chapters: [], streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 96, height: 64,
      sample_aspect_ratio: '1:1', avg_frame_rate: '20/1', start_time: '0', duration: String(duration) },
    { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1, channel_layout: 'mono', bit_rate: '64000', start_time: '0', duration: String(duration) }
  ] });
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function response() {
  const res = new EventEmitter(); res.writes = []; res.blocked = false; res.ends = 0;
  res.writeHead = code => { res.code = code; }; res.write = chunk => { res.writes.push(chunk); return !res.blocked; };
  res.end = () => { res.ends++; res.emit('close'); }; return res;
}
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'controlled queue operation settles'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function setup(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-queue-unit-'));
  const control = { calls: [], children: [], hold: false, unconfirmed: false, fail: new Set(), now: 0 };
  const capabilities = { available: true, muxers: new Set(['mp4', 'mov', 'matroska', 'mp3', 'null']),
    encoders: new Set(['libx264', 'aac', 'libmp3lame']), decoders: new Set(['h264', 'aac']) };
  const manager = createMediaWorkspaceManager({ tempDir: root, clock: () => control.now, ttlMs: 1000,
    cleanupRetryDelaysMs: [1, 2], conversionTerminationGraceMs: 10,
    inspectAsset: async () => facts(), discoverCapabilities: async () => capabilities,
    spawnProcess(command, args, spawnOptions) {
      assert.equal(command, 'ffmpeg'); assert.equal(spawnOptions.shell, false);
      const child = new EventEmitter(); child.pid = 912; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { if (!control.unconfirmed) setImmediate(() => child.finish(1)); return true; };
      child.finish = code => { child.emit('exit', code); child.emit('close', code); };
      control.calls.push(args); control.children.push(child);
      setImmediate(async () => {
        try {
          const pass = args.indexOf('-pass');
          if (pass >= 0) await fsp.writeFile(`${args[args.indexOf('-passlogfile') + 1]}-0.log`, 'owned pass statistics');
          if (pass < 0 || args[pass + 1] !== '1') await fsp.writeFile(args.at(-1), Buffer.alloc(20000, control.calls.length));
          child.written = true;
          if (!control.hold) child.finish(control.fail.has(args[args.indexOf('-i') + 1]) ? 1 : 0);
        } catch (error) { child.emit('error', error); child.finish(1); }
      });
      return child;
    }, ...options });
  manager.defaultInspectAsset = async workspace => facts(workspace.conversion.processingSnapshot.retainedDurationSeconds);
  const queue = manager.localProcessing;
  const collection = queue.createCollection();
  const add = async (name = 'source.mp4', bytes = 'synthetic source', collectionId = collection.id) => {
    const workspace = await queue.receiveLocalStream(collectionId, Readable.from(bytes), { displayName: name, declaredLength: Buffer.byteLength(bytes) });
    await workspace.activePromise; return workspace;
  };
  const review = async (workspace, settings = QUALITY, editPlan = CUT, draftRevision = 0) => {
    const body = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision,
      settings: structuredClone(settings), editPlan: structuredClone(editPlan) };
    const plan = await manager.processing.plan(body);
    return { ...body, planKey: plan.key, acknowledgedWarnings: plan.warnings.filter(item => item.required).map(item => item.id) };
  };
  const jobs = () => queue.snapshot(collection.id).jobs;
  const settled = () => until(() => jobs().every(job => ['completed', 'cancelled', 'failed'].includes(job.status)));
  t.after(async () => {
    control.unconfirmed = false; manager.fs = fsp;
    for (const child of control.children) child.finish(1);
    await manager.clearAll(); await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, manager, queue, collection, control, capabilities, add, review, jobs, settled };
}

test('collection queue preserves independent sources, cuts, names, results, and sequential production processing', async t => {
  const { manager, queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add('alpha.mp4'), b = await add('beta.mp4');
  const first = await review(a, { ...QUALITY, filenameSuffix: '_a' });
  const second = await review(b, { ...QUALITY, filenameSuffix: '_b' }, FULL);
  const accepted = await queue.enqueue(collection.id, [first, second]);
  assert.deepEqual(accepted.jobs.map(job => job.status), ['queued', 'queued']);
  await settled();
  assert.deepEqual(jobs().map(job => job.status), ['completed', 'completed']);
  assert.deepEqual(control.calls.map(args => args[args.indexOf('-i') + 1]), [a.assets.get(a.sourceAssetId).filePath, b.assets.get(b.sourceAssetId).filePath]);
  assert.equal(a.conversion.output.filename, 'alpha_a.mp4'); assert.equal(b.conversion.output.filename, 'beta_b.mp4');
  assert.equal(a.conversion.output.processingSnapshot.retainedDurationSeconds, 6); assert.equal(b.conversion.output.processingSnapshot.retainedDurationSeconds, 9);
  assert.notEqual(a.conversion.output.assetId, b.conversion.output.assetId);
  assert.equal(a.editor.status, 'idle'); assert.equal(b.editor.status, 'idle');
  assert.equal(manager.conversions.resolve(a.id, b.conversion.output.assetId), null);
  assert.equal(conversionSlotBusy(), false);
});

test('reviewed no-op queue downloads original bytes without spawning or accumulating job history', async t => {
  const { queue, collection, control, add, review, jobs, settled } = await setup(t);
  const workspace = await add(), request = await review(workspace, {}, FULL);
  const before = await fsp.readdir(workspace.tempDir);
  await queue.enqueue(collection.id, [request]); await settled();
  assert.equal(workspace.conversion.output.assetId, workspace.sourceAssetId); assert.equal(workspace.conversion.output.noOp, true);
  await queue.enqueue(collection.id, [request]); await settled();
  assert.equal(jobs().length, 1); assert.equal(control.calls.length, 0);
  assert.deepEqual(await fsp.readdir(workspace.tempDir), before);
});

test('cross-collection and cross-source identities cannot submit another file or arbitrary path', async t => {
  const { queue, collection, add, review } = await setup(t);
  const a = await add(), other = queue.createCollection(), b = await add('foreign.mp4', 'foreign', other.id);
  await assert.rejects(queue.enqueue(collection.id, [await review(b)]), { statusCode: 409 });
  const own = await review(a);
  for (const sourceAssetId of [b.sourceAssetId, a.tempDir, '/arbitrary/file']) {
    await assert.rejects(queue.enqueue(collection.id, [{ ...own, sourceAssetId }]), error => [400, 409].includes(error.statusCode));
  }
  await assert.rejects(queue.enqueue(collection.id, [{ ...own, args: ['-i', '/arbitrary/file'] }]), { statusCode: 400 });
  assert.equal(queue.snapshot(collection.id).jobs.length, 0);
});

test('Process All rejects duplicate or invalid entries atomically without pinning valid entries', async t => {
  const { queue, collection, add, review } = await setup(t);
  const a = await add(), b = await add(), first = await review(a), second = await review(b);
  await assert.rejects(queue.enqueue(collection.id, [first, first]), { statusCode: 409 });
  await assert.rejects(queue.enqueue(collection.id, [first, { ...second, planKey: 'unreviewed' }]), { statusCode: 409 });
  assert.equal(a.queuedProcessingJobId, null); assert.equal(b.queuedProcessingJobId, null);
  assert.equal(queue.snapshot(collection.id).jobs.length, 0);
});

test('required omission acknowledgements are checked for every queued plan', async t => {
  const { queue, collection, add, review } = await setup(t);
  const workspace = await add(); workspace.inspection.extraStreams.chapters = 1;
  const request = await review(workspace);
  assert.deepEqual(request.acknowledgedWarnings, ['omitted-content']);
  await assert.rejects(queue.enqueue(collection.id, [{ ...request, acknowledgedWarnings: [] }]), { statusCode: 409 });
  assert.equal(workspace.queuedProcessingJobId, null);
});

test('queued snapshots retain reviewed cuts/settings after later drafts and reject duplicate/direct admission', async t => {
  const { manager, queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add('first.mp4'), b = await add('second.mp4'); control.hold = true;
  const first = await review(a), second = await review(b);
  await queue.enqueue(collection.id, [first, second]); await until(() => control.children[0]?.written);
  second.settings.rate.crf = 40; second.editPlan.keepRanges[0].endSeconds = 1;
  await review(b, { ...QUALITY, rate: { mode: 'quality', crf: 30 } }, FULL, 1);
  await assert.rejects(queue.enqueue(collection.id, [await review(b, QUALITY, FULL, 2)]), { statusCode: 409 });
  await assert.rejects(manager.processing.start(await review(b, QUALITY, FULL, 3)), { statusCode: 409 });
  assert.throws(() => manager.prepareEditor(b.id, b.sourceAssetId), { statusCode: 409 });
  assert.equal(jobs()[1].status, 'queued');
  control.hold = false; control.children[0].finish(0); await settled();
  assert.equal(b.conversion.output.processingSnapshot.settings.rate.crf, 24);
  assert.equal(b.conversion.output.processingSnapshot.retainedDurationSeconds, 6);
  assert.equal(b.conversion.output.draftRevision, 0);
});

for (const action of ['cancel-all', 'cancel-file', 'remove']) {
  test(`${action} during pending pre-admission source stat prevents late queue publication`, async t => {
    const { manager, queue, collection, add, review } = await setup(t);
    const workspace = await add(), request = await review(workspace), gate = deferred(), entered = deferred();
    manager.fs = { ...fsp, lstat: async filename => { const stat = await fsp.lstat(filename); entered.resolve(); await gate.promise; return stat; } };
    const pending = queue.enqueue(collection.id, [request]); await entered.promise;
    if (action === 'remove') await manager.discard(workspace.id);
    else await queue.cancel(collection.id, action === 'cancel-file' ? workspace.id : null);
    gate.resolve(); await assert.rejects(pending, { statusCode: action === 'remove' ? 404 : 409 });
    assert.equal(queue.snapshot(collection.id).jobs.length, 0); assert.equal(workspace.queuedProcessingJobId, null);
  });
}

test('late newer draft or capability discovery cancellation rejects the whole pending review', async t => {
  const { manager, queue, collection, capabilities, add, review } = await setup(t);
  const workspace = await add(), body = await review(workspace), gate = deferred();
  workspace.processingCapabilities = null; manager.discoverCapabilities = () => gate.promise;
  const pending = queue.enqueue(collection.id, [body]);
  await queue.cancel(collection.id); gate.resolve(capabilities);
  await assert.rejects(pending, { statusCode: 409 });
  assert.equal(workspace.queuedProcessingJobId, null);
});

test('removal during pre-start stat cannot resurrect an entry or begin encoding', async t => {
  const { manager, queue, collection, control, add, review } = await setup(t);
  const workspace = await add(), request = await review(workspace), gate = deferred(), entered = deferred(); let stats = 0;
  manager.fs = { ...fsp, lstat: async filename => { const stat = await fsp.lstat(filename); if (++stats === 2) { entered.resolve(); await gate.promise; } return stat; } };
  await queue.enqueue(collection.id, [request]); await entered.promise;
  await manager.discard(workspace.id); gate.resolve();
  await until(() => !queue.draining);
  assert.equal(control.calls.length, 0); assert.equal(queue.snapshot(collection.id).workspaces.length, 0);
  assert.equal(queue.snapshot(collection.id).jobs.length, 0);
});

test('changed queued source inspection fails only that file before encoding', async t => {
  const { queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add(), b = await add(), c = await add(); control.hold = true;
  await queue.enqueue(collection.id, [await review(a), await review(b), await review(c)]);
  await until(() => control.children[0]?.written); b.inspection.video.width += 2;
  control.hold = false; control.children[0].finish(0); await settled();
  assert.deepEqual(jobs().map(job => job.status), ['completed', 'failed', 'completed']);
  assert.equal(control.calls.length, 2); assert.match(jobs()[1].message, /inspection changed/);
});

test('a missing queued source fails with a friendly diagnostic and lets other files finish', async t => {
  const { queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add(), b = await add(), c = await add(); control.hold = true;
  await queue.enqueue(collection.id, [await review(a), await review(b), await review(c)]);
  await until(() => control.children[0]?.written);
  const sourcePath = b.assets.get(b.sourceAssetId).filePath;
  await fsp.rm(sourcePath);
  control.hold = false; control.children[0].finish(0); await settled();
  assert.deepEqual(jobs().map(job => job.status), ['completed', 'failed', 'completed']);
  assert.equal(jobs()[1].message, 'The owned source file is missing. Remove the entry and choose the file again.');
  assert.equal(JSON.stringify(jobs()[1]).includes(sourcePath), false);
  assert.equal(control.calls.length, 2); assert.equal(b.queuedProcessingJobId, null);
});

test('a process-wide slot race during queued pre-start stat waits instead of failing or overlapping', async t => {
  const { manager, queue, collection, control, add, review, settled, jobs } = await setup(t);
  const a = await add(), b = await add(), request = await review(a), gate = deferred(), entered = deferred(); let stats = 0;
  const sourcePath = a.assets.get(a.sourceAssetId).filePath;
  manager.fs = { ...fsp, lstat: async filename => { const stat = await fsp.lstat(filename); if (filename === sourcePath && ++stats === 2) { entered.resolve(); await gate.promise; } return stat; } };
  await queue.enqueue(collection.id, [request]); await entered.promise;
  control.hold = true; await manager.processing.start(await review(b)); await until(() => control.children[0]?.written);
  gate.resolve(); await until(() => jobs()[0].status === 'queued'); assert.equal(control.calls.length, 1);
  control.hold = false; control.children[0].finish(0); await settled();
  assert.equal(jobs()[0].status, 'completed'); assert.equal(control.calls.length, 2);
});

test('ordinary encoding failure preserves previous successful result and continues later files once', async t => {
  const { queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add(), b = await add(); await queue.enqueue(collection.id, [await review(a, {}, FULL)]); await settled();
  const previous = a.conversion.output; control.fail.add(a.assets.get(a.sourceAssetId).filePath);
  await queue.enqueue(collection.id, [await review(a, QUALITY, CUT, 1), await review(b)]); await settled();
  assert.deepEqual(jobs().map(job => job.status), ['failed', 'completed']); assert.equal(a.conversion.output, previous);
  assert.equal(control.calls.length, 2); assert.equal(a.conversion.cleanupPaths.size, 0);
});

test('Cancel All marks following jobs before confirmed active termination and preserves owned sources/results', async t => {
  const { queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add(), b = await add(); await queue.enqueue(collection.id, [await review(a, {}, FULL)]); await settled();
  const previous = a.conversion.output; control.hold = true; control.unconfirmed = true;
  await queue.enqueue(collection.id, [await review(a, QUALITY, CUT, 1), await review(b)]);
  await until(() => control.children[0]?.written);
  const result = await queue.cancel(collection.id);
  assert.deepEqual(result.jobs.map(job => job.status), ['cancelling', 'cancelled']); assert.equal(conversionSlotBusy(), true);
  assert.equal(control.calls.length, 1); assert.ok(a.queuedProcessingJobId); assert.equal(b.queuedProcessingJobId, null);
  control.children[0].finish(1); await settled();
  assert.equal(conversionSlotBusy(), false); assert.equal(a.conversion.output, previous);
  assert.deepEqual(jobs().map(job => job.status), ['cancelled', 'cancelled']);
  assert.ok((await fsp.stat(b.assets.get(b.sourceAssetId).filePath)).isFile());
});

test('cancelling one queued entry leaves other entries and the active operation intact', async t => {
  const { queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add(), b = await add(), c = await add(); control.hold = true;
  await queue.enqueue(collection.id, [await review(a), await review(b), await review(c)]);
  await until(() => control.children[0]?.written); await queue.cancel(collection.id, b.id);
  assert.equal(jobs()[1].status, 'cancelled'); assert.equal(a.cancelRequested, false);
  control.hold = false; control.children[0].finish(0); await settled();
  assert.deepEqual(jobs().map(job => job.status), ['completed', 'cancelled', 'completed']); assert.equal(control.calls.length, 2);
});

test('Cancel All between owned passes prevents pass two and every following file', async t => {
  const { manager, queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add(), b = await add();
  const settings = { videoCodec: 'h264', container: 'mp4', rate: { mode: 'size', maximumMB: 0.3 }, audio: { codec: 'aac', bitrateKbps: 64 } };
  const emit = manager.emit.bind(manager); let cancellation;
  manager.emit = workspace => {
    if (workspace === a && workspace.conversion.phase === 'pass-2' && !cancellation) {
      cancellation = true; cancellation = queue.cancel(collection.id);
    }
    emit(workspace);
  };
  await queue.enqueue(collection.id, [await review(a, settings), await review(b)]); await settled(); await cancellation;
  assert.deepEqual(jobs().map(job => job.status), ['cancelled', 'cancelled']); assert.equal(control.calls.length, 1);
  assert.equal(a.conversion.cleanupPaths.size, 0); assert.equal(a.conversion.cleanupDirectories.size, 0);
  assert.equal((await fsp.readdir(a.tempDir)).some(filename => filename.startsWith('processing-')), false);
});

test('late Cancel All preserves already published result while cancelling following queued files', async t => {
  const { manager, queue, collection, add, review, jobs, settled } = await setup(t);
  const a = await add(), b = await add(), gate = deferred(), entered = deferred();
  manager.fs = { ...fsp, rm: async (filename, options) => {
    if (filename.startsWith(a.tempDir) && path.basename(filename).startsWith('processing-')) { entered.resolve(); await gate.promise; }
    return fsp.rm(filename, options);
  } };
  await queue.enqueue(collection.id, [await review(a), await review(b)]); await entered.promise;
  assert.equal(a.conversion.status, 'ready'); const output = a.conversion.output;
  await queue.cancel(collection.id); gate.resolve(); await settled();
  assert.deepEqual(jobs().map(job => job.status), ['completed', 'cancelled']); assert.equal(a.conversion.output, output);
});

test('queued sources stay owned before expiry, and expired waiting jobs release their pins', async t => {
  const { manager, queue, collection, control, add, review, settled, jobs } = await setup(t);
  const a = await add(), b = await add(); control.hold = true;
  await queue.enqueue(collection.id, [await review(a), await review(b)]); await until(() => control.children[0]?.written);
  control.now = 999; await manager.cleanupExpired(); assert.equal(manager.get(b.id, { touch: false }), b);
  control.now = 1001; await manager.cleanupExpired(); assert.equal(jobs()[1].status, 'cancelled'); assert.equal(b.queuedProcessingJobId, null);
  control.now = 2002; await manager.cleanupExpired(); assert.equal(manager.get(b.id), null);
  control.hold = false; control.children[0].finish(0); await settled();
});

test('entry count, collection count, queue count and reserved source bytes are enforced before intake/admission', async t => {
  const { queue, collection, control, add, review } = await setup(t, { localProcessingLimits: { maxCollections: 1, maxEntries: 2, maxQueued: 1, maxSourceBytes: 12 } });
  assert.throws(() => queue.createCollection(), { statusCode: 409 });
  const a = await add('a.mp4', '123456');
  await assert.rejects(add('too-big.mp4', '1234567'), { statusCode: 413 });
  const b = await add('b.mp4', '123456');
  await assert.rejects(add('too-many.mp4', '1'), { statusCode: 409 });
  await assert.rejects(queue.enqueue(collection.id, [await review(a), await review(b)]), { statusCode: 400 });
  control.hold = true; await queue.enqueue(collection.id, [await review(a)]);
  await assert.rejects(queue.enqueue(collection.id, [await review(b)]), { statusCode: 409 });
});

test('only one upload per collection and exact received-byte ceiling prevent bypassing reservations', async t => {
  const { manager, queue, collection } = await setup(t);
  const createWriter = manager.createWriteStream;
  let writer;
  const closedAtCleanup = [];
  manager.createWriteStream = (...args) => { writer = createWriter(...args); return writer; };
  manager.fs = { ...fsp, rm: async (...args) => { closedAtCleanup.push(writer.closed); return fsp.rm(...args); } };
  await assert.rejects(queue.receiveLocalStream(collection.id, Readable.from('x'), { displayName: 'x.mp4' }), { statusCode: 400 });
  const stream = new PassThrough(), pending = queue.receiveLocalStream(collection.id, stream, { displayName: 'a.mp4', declaredLength: 3 });
  await assert.rejects(queue.receiveLocalStream(collection.id, Readable.from('x'), { displayName: 'b.mp4', declaredLength: 1 }), { statusCode: 409 });
  stream.end('1234'); await assert.rejects(pending);
  assert.equal(writer.closed, true); assert.deepEqual(closedAtCleanup, [true]);
  assert.equal(queue.snapshot(collection.id).workspaces.length, 0); assert.equal(queue.snapshot(collection.id).sourceBytesReserved, 0);
});

test('legacy URL workspace reserves its bounded unknown source, then uses authoritative acquired bytes', async t => {
  const { manager, queue, collection, add } = await setup(t, { maxBytes: 20, localProcessingLimits: { maxSourceBytes: 20 } });
  const workspace = await manager.createUrlWorkspace({ displayName: 'existing.mp4' });
  queue.attachWorkspace(collection.id, workspace.id);
  assert.equal(queue.snapshot(collection.id).sourceBytesReserved, 20);
  await assert.rejects(add('local.mp4', '123'), { statusCode: 413 });
  const file = path.join(workspace.tempDir, 'acquired.mp4'); await fsp.writeFile(file, '12345');
  await manager.adoptAcquiredFile(workspace.id, file);
  assert.equal(queue.snapshot(collection.id).sourceBytesReserved, 5);
  await add('local.mp4', '123'); assert.equal(queue.snapshot(collection.id).sourceBytesReserved, 8);
  assert.equal(queue.snapshot(collection.id).workspaces.length, 2);
});

test('failed removal retains source reservation and bounded intake backpressure until explicit cleanup succeeds', async t => {
  const { manager, queue, collection, add } = await setup(t, { localProcessingLimits: { maxCollections: 1, maxEntries: 1, maxSourceBytes: 10 } });
  const workspace = await add('a.mp4', '1234567890'), directory = workspace.tempDir; let calls = 0;
  manager.fs = { ...fsp, rm: async (filename, options) => { if (filename === directory) { calls++; throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } return fsp.rm(filename, options); } };
  await manager.discard(workspace.id); await until(() => manager.cleanupPending.get(workspace.id)?.status === 'failed');
  assert.equal(calls, 3); assert.equal(queue.snapshot(collection.id).workspaces.length, 0);
  assert.equal(queue.snapshot(collection.id).sourceBytesReserved, 10);
  await assert.rejects(add('b.mp4', '1'), { statusCode: 413 });
  manager.fs = fsp; await manager.retryCleanup(workspace.id);
  await add('b.mp4', '1'); assert.equal(queue.snapshot(collection.id).sourceBytesReserved, 1);
});

test('one collection progress reader replaces its predecessor and coalesces slow-reader updates', async t => {
  const { manager, queue, collection, add } = await setup(t);
  const workspace = await add();
  const first = response(), second = response(); queue.subscribe(collection.id, first); queue.subscribe(collection.id, second);
  assert.equal(first.ends, 1); assert.equal(second.code, 200); assert.equal(workspace.listeners.size, 0);
  second.blocked = true; manager.emit(workspace); const writes = second.writes.length;
  for (let i = 0; i < 50; i++) { workspace.conversion.percent = i; manager.emit(workspace); }
  assert.equal(second.writes.length, writes);
  second.blocked = false; second.emit('drain'); assert.equal(second.writes.length, writes + 1);
  assert.match(second.writes.at(-1), /"percent":49/);
  const old = JSON.parse(second.writes.at(-1).slice(6)), newer = queue.snapshot(collection.id);
  assert.ok(newer.revision > old.revision, 'HTTP and SSE projections can be ordered despite network response races');
  await queue.discardCollection(collection.id); assert.equal(second.ends, 1); assert.throws(() => queue.snapshot(collection.id), { statusCode: 404 });
});

test('empty disconnected workbenches release collection slots without pruning an active subscriber handoff', async t => {
  const { queue, collection } = await setup(t, { localProcessingLimits: { maxCollections: 1 } });
  let id = collection.id;
  for (let i = 0; i < 5; i++) {
    const first = response(), second = response();
    queue.subscribe(id, first); queue.subscribe(id, second); await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.snapshot(id).id, id); assert.equal(first.ends, 1);
    second.end(); assert.throws(() => queue.snapshot(id), { statusCode: 404 });
    id = queue.createCollection().id;
  }
  assert.equal(queue.collections.size, 1);
});

test('collection Discard invalidates all result URLs before waiting for active process termination', async t => {
  const { manager, queue, collection, control, add, review, settled } = await setup(t);
  const a = await add(), b = await add();
  await queue.enqueue(collection.id, [await review(a, {}, FULL), await review(b, {}, FULL)]); await settled();
  const aId = a.conversion.output.assetId, bId = b.conversion.output.assetId;
  control.hold = true; control.unconfirmed = true;
  await queue.enqueue(collection.id, [await review(a, QUALITY, CUT, 1), await review(b, QUALITY, CUT, 1)]);
  await until(() => control.children[0]?.written);
  const discarded = queue.discardCollection(collection.id);
  assert.equal(manager.conversions.resolve(a.id, aId), null); assert.equal(manager.conversions.resolve(b.id, bId), null);
  assert.equal(conversionSlotBusy(), true); assert.equal(queue.snapshot(collection.id).workspaces.length, 0);
  assert.deepEqual(queue.snapshot(collection.id).removedCleanup.map(item => item.workspaceId).sort(), [a.id, b.id].sort(), 'both owners remain reachable until physical cleanup settles');
  control.children[0].finish(1); await discarded; assert.equal(conversionSlotBusy(), false);
  assert.equal(control.calls.length, 1);
});

test('removing a collection invalidates downloads and preserves deletion failure ownership', async t => {
  const { manager, queue, collection, add, review, settled } = await setup(t);
  const workspace = await add(); await queue.enqueue(collection.id, [await review(workspace, {}, FULL)]); await settled();
  const assetId = workspace.conversion.output.assetId, directory = workspace.tempDir;
  manager.fs = { ...fsp, rm: async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } };
  const result = await queue.discardCollection(collection.id); assert.equal(result.cleanupPending, true);
  assert.equal(manager.conversions.resolve(workspace.id, assetId), null);
  await until(() => manager.cleanupPending.get(workspace.id)?.status === 'failed');
  assert.equal(manager.cleanupPending.get(workspace.id).directory, directory);
});

test('reopening a disconnected workbench preserves admitted processing and a lost reopen acknowledgement expires', async t => {
  const { manager, queue, collection, control, add, review, jobs, settled } = await setup(t);
  const a = await add('first.mp4'), b = await add('second.mp4'); control.hold = true;
  await queue.enqueue(collection.id, [await review(a), await review(b)]); await until(() => control.children[0]?.written);
  const before = jobs(), bytes = queue.snapshot(collection.id).sourceBytesReserved;
  const previous = response(); queue.subscribe(collection.id, previous); previous.end();
  assert.deepEqual(queue.reopen(collection.id).jobs, before);
  assert.throws(() => queue.reopen(collection.id), { statusCode: 409 });
  const elapsed = manager.now() + 10001; manager.now = () => elapsed;
  const reopened = queue.reopen(collection.id); assert.deepEqual(reopened.jobs, before);
  assert.equal(a.lastAccessAt, elapsed); assert.equal(b.lastAccessAt, elapsed);
  assert.throws(() => queue.subscribe(collection.id, response(), reopened.connectionEpoch - 1), { statusCode: 409 });
  const resumed = response(); queue.subscribe(collection.id, resumed, reopened.connectionEpoch);
  assert.equal(queue.snapshot(collection.id).sourceBytesReserved, bytes);
  control.hold = false; control.children[0].finish(0); await settled();
  assert.equal(control.calls.length, 2); assert.deepEqual(jobs().map(job => job.status), ['completed', 'completed']);
  assert.equal(a.conversion.output.processingSnapshot.retainedDurationSeconds, 6); assert.equal(b.conversion.output.processingSnapshot.retainedDurationSeconds, 6);
});
