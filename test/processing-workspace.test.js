'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter, once } = require('node:events');
const { Readable, PassThrough } = require('node:stream');
const { createMediaWorkspaceManager } = require('../media-workspace');
const { normalizeMediaInspection } = require('../media-inspection');

const FULL = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 9 }] };
const CUT = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 6, endSeconds: 9 }] };
const SIZE = { videoCodec: 'h264', container: 'mp4', rate: { mode: 'size', maximumMB: 0.3 }, audio: { codec: 'aac', bitrateKbps: 64 } };
const QUALITY = { videoCodec: 'h264', container: 'mp4', rate: { mode: 'quality', crf: 24 } };
function facts(duration = 9, output = null) {
  const audio = output?.audioCodec || 'aac';
  return normalizeMediaInspection({ format: { format_name: 'mov,mp4,m4a', start_time: '0', duration: String(duration), tags: { major_brand: 'isom' } }, chapters: [], streams: [
    { index: 0, codec_type: 'video', codec_name: output?.videoCodec || 'h264', pix_fmt: 'yuv420p', width: output?.width || 96, height: output?.height || 64,
      sample_aspect_ratio: '1:1', avg_frame_rate: '20/1', start_time: '0', duration: String(duration) },
    { index: 1, codec_type: 'audio', codec_name: audio, sample_rate: '48000', channels: 1, channel_layout: 'mono', bit_rate: '64000', start_time: '0', duration: String(duration) }
  ] });
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'controlled asynchronous operation settles'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-processing-unit-'));
  const control = { calls: [], children: [], mode: 'success', bytes: [20000], outputs: 0, written: 0, cancelPhase: null, outputProbes: 0 };
  const capabilities = { available: true, muxers: new Set(['mp4', 'mov', 'matroska', 'mp3', 'null']),
    encoders: new Set(['libx264', 'aac', 'libmp3lame']), decoders: new Set(['h264', 'aac']) };
  const manager = createMediaWorkspaceManager({ tempDir: root, cleanupRetryDelaysMs: [1, 2], conversionTerminationGraceMs: 10,
    inspectAsset: async () => facts(), discoverCapabilities: async () => capabilities,
    spawnProcess(command, args, options) {
      assert.equal(command, 'ffmpeg'); assert.equal(options.shell, false);
      const child = new EventEmitter(); child.pid = 456; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { if (control.mode !== 'unconfirmed') setImmediate(() => { child.emit('exit', 1); child.emit('close', 1); }); return true; };
      control.children.push(child); control.calls.push(args);
      const pass = args.includes('-pass') ? Number(args[args.indexOf('-pass') + 1]) : null;
      setImmediate(async () => {
        try {
          const logIndex = args.indexOf('-passlogfile');
          if (logIndex >= 0) await fsp.writeFile(`${args[logIndex + 1]}-0.log`, 'controlled pass statistics');
          if (pass !== 1) {
            const size = control.bytes[Math.min(control.outputs++, control.bytes.length - 1)];
            await fsp.writeFile(args.at(-1), Buffer.alloc(size, 1));
            control.written++;
          }
          if (['held', 'unconfirmed'].includes(control.mode)) return;
          child.stdout.write('out_time_us=1000000\n');
          const code = control.mode === 'failed' ? 1 : 0; child.emit('exit', code); child.emit('close', code);
        } catch (error) { child.emit('error', error); child.emit('close', 1); }
      });
      return child;
    }
  });
  const emit = manager.emit.bind(manager);
  manager.emit = workspace => {
    if (control.cancelPhase === workspace.conversion.phase) { workspace.cancelRequested = true; workspace.abortController.abort(); }
    emit(workspace);
  };
  manager.defaultInspectAsset = async workspace => {
    control.outputProbes++;
    const snapshot = workspace.conversion.processingSnapshot;
    const result = facts(snapshot.retainedDurationSeconds, snapshot.output);
    if (control.mode === 'invalid') result.video.width += 2;
    return result;
  };
  const workspace = await manager.receiveLocalStream(Readable.from('synthetic original bytes'), { displayName: 'source.mp4', purpose: 'local' });
  await workspace.activePromise;
  t.after(async () => {
    control.cancelPhase = null; manager.fs = fsp;
    for (const child of control.children) { child.emit('exit', 1); child.emit('close', 1); }
    await manager.clearAll(); await fsp.rm(root, { recursive: true, force: true });
  });
  let revision = 0;
  const request = (settings = {}, editPlan = FULL) => ({ workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId,
    draftRevision: revision++, settings: structuredClone(settings), editPlan: structuredClone(editPlan) });
  const review = async body => ({ ...body, planKey: (await manager.processing.plan(body)).key });
  const process = async (settings, editPlan) => {
    const body = await review(request(settings, editPlan)); await manager.processing.start(body); await workspace.activePromise; return workspace.conversion.output;
  };
  return { manager, workspace, control, capabilities, request, review, process };
}

test('complete default processing aliases the original with immutable revision/provenance and no process or duplicate file', async t => {
  const { manager, workspace, control, request, review } = await setup(t);
  const before = await fsp.readdir(workspace.tempDir), body = await review(request());
  await manager.processing.start(body); const output = workspace.conversion.output;
  assert.equal(output.noOp, true); assert.equal(output.assetId, workspace.sourceAssetId); assert.equal(output.draftRevision, 0);
  assert.equal(output.filename, 'source - processed.mp4'); assert.equal(control.calls.length, 0); assert.equal(control.outputProbes, 0);
  assert.deepEqual(await fsp.readdir(workspace.tempDir), before); assert.ok(Object.isFrozen(output.processingSnapshot.settings));
  await manager.processing.start(body); assert.equal(manager.conversions.resolve(workspace.id, output.assetId).asset.id, output.assetId);
});

test('custom suffix stays with the reviewed result and cannot rename a previous download or bypass a plan key', async t => {
  const { manager, workspace, control, process, request, review } = await setup(t);
  const original = await process({ filenameSuffix: '_first' });
  assert.equal(original.filename, 'source_first.mp4'); assert.equal(control.calls.length, 0);
  const next = await review(request({ ...QUALITY, filenameSuffix: '_second' }, CUT));
  assert.equal(manager.conversions.resolve(workspace.id, original.assetId).asset.filename, 'source_first.mp4');
  await assert.rejects(manager.processing.start({ ...next, settings: { ...next.settings, filenameSuffix: '_unreviewed' } }), { statusCode: 409 });
  await manager.processing.start(next); await workspace.activePromise;
  assert.equal(workspace.conversion.output.filename, 'source_second.mp4');
  assert.equal(workspace.conversion.output.processingSnapshot.settings.filenameSuffix, '_second');
  assert.equal(original.filename, 'source_first.mp4');
  assert.equal(manager.conversions.resolve(workspace.id, workspace.conversion.output.assetId).asset.filename, 'source_second.mp4');
  const plain = await process({ filenameSuffix: '' }); assert.equal(plain.filename, 'source.mp4');
});

test('processing uses original without editor/proxy preparation; cuts and settings remain immutable after admission', async t => {
  const { manager, workspace, control, request, review } = await setup(t); control.mode = 'held';
  const body = await review(request(QUALITY, CUT)); await manager.processing.start(body);
  await until(() => control.children.length === 1 && control.written === 1);
  body.settings.rate.crf = 40; body.editPlan.keepRanges[0].endSeconds = 1;
  assert.equal(workspace.conversion.processingSnapshot.settings.rate.crf, 24);
  assert.equal(workspace.conversion.processingSnapshot.retainedDurationSeconds, 6);
  assert.equal(workspace.editor.status, 'idle'); assert.equal(workspace.playbackAssetId, null);
  assert.ok(control.calls[0].includes(workspace.assets.get(workspace.sourceAssetId).filePath));
  assert.equal(workspace.assets.size, 1); assert.throws(() => manager.prepareEditor(workspace.id, workspace.sourceAssetId), { statusCode: 409 });
  control.children[0].emit('exit', 0); control.children[0].emit('close', 0); await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'ready'); assert.equal(workspace.conversion.output.processingSnapshot.settings.rate.crf, 24);
  assert.equal([...workspace.assets.values()].some(asset => asset.role === 'edited-output'), false);
});

test('invalid input identities and unstructured processing fields are rejected', async t => {
  const { manager, workspace, request } = await setup(t);
  for (const patch of [{ sourceAssetId: '/tmp/file.mp4' }, { inputAssetId: workspace.sourceAssetId }, { role: 'source' }, { args: ['-i'] }, { draftRevision: -1 }]) {
    await assert.rejects(manager.processing.plan({ ...request(), ...patch }), error => [400, 409].includes(error.statusCode));
  }
  const foreign = await manager.createWorkspace({ displayName: 'foreign.mp4', origin: 'local' });
  await assert.rejects(manager.processing.plan({ ...request(), workspaceId: foreign.id }), { statusCode: 409 });
});

test('reviewed newer drafts invalidate old plan/Start without altering a completed result', async t => {
  const { manager, workspace, request, review, process } = await setup(t); const output = await process();
  const old = await review(request(QUALITY)); const newer = request({ ...QUALITY, rate: { mode: 'quality', crf: 25 } });
  await manager.processing.plan(newer);
  await assert.rejects(manager.processing.start(old), { statusCode: 409 });
  await assert.rejects(manager.processing.plan({ ...newer, settings: QUALITY }), { statusCode: 409 });
  assert.equal(workspace.conversion.output, output);
  await assert.rejects(manager.processing.start({ ...newer, planKey: old.planKey }), { statusCode: 409 });
});

test('replacement of review during capability discovery rejects a late older plan', async t => {
  const { manager, capabilities, request } = await setup(t); const gate = deferred(); let first = true;
  manager.discoverCapabilities = () => { if (first) { first = false; return gate.promise; } return capabilities; };
  const pending = manager.processing.plan(request(QUALITY));
  await manager.processing.plan(request({ ...QUALITY, rate: { mode: 'quality', crf: 26 } }));
  gate.resolve(capabilities); await assert.rejects(pending, { statusCode: 409 });
});

test('Start revalidates revision, source evidence, and cleanup after asynchronous stat', async t => {
  const { manager, workspace, request, review } = await setup(t);
  for (const change of ['revision', 'inspection', 'cleanup']) {
    const body = await review(request(QUALITY)), gate = deferred();
    manager.fs = { ...fsp, lstat: async file => { const stat = await fsp.lstat(file); await gate.promise; return stat; } };
    const pending = manager.processing.start(body); await new Promise(resolve => setImmediate(resolve));
    if (change === 'revision') await manager.processing.plan(request());
    if (change === 'inspection') workspace.inspection.video.width += 2;
    if (change === 'cleanup') workspace.conversion.cleanupPaths.add(path.join(workspace.tempDir, 'owned-pending'));
    gate.resolve(); await assert.rejects(pending, { statusCode: 409 }); manager.fs = fsp;
    workspace.conversion.cleanupPaths.clear(); if (change === 'inspection') workspace.inspection.video.width -= 2;
  }
});

test('two-pass processing owns unique pass logs and releases all attempt files after validated publication', async t => {
  const { workspace, control, process } = await setup(t); await process(SIZE, CUT);
  assert.equal(workspace.conversion.status, 'ready'); assert.equal(control.calls.length, 2);
  assert.equal(control.calls[0][control.calls[0].indexOf('-pass') + 1], '1'); assert.equal(control.calls[1][control.calls[1].indexOf('-pass') + 1], '2');
  assert.equal(control.calls[0][control.calls[0].indexOf('-passlogfile') + 1], control.calls[1][control.calls[1].indexOf('-passlogfile') + 1]);
  assert.equal(workspace.conversion.cleanupPaths.size, 0); assert.equal(workspace.conversion.cleanupDirectories.size, 0);
  assert.equal((await fsp.readdir(workspace.tempDir)).some(name => name.startsWith('processing-')), false);
});

for (const phase of ['pass-2', 'retrying']) {
  test(`cancellation at ${phase} prevents subsequent owned phases and preserves prior result`, async t => {
    const { workspace, control, process } = await setup(t); const old = await process();
    control.bytes = [350000]; control.cancelPhase = phase; await process(SIZE, CUT);
    assert.equal(workspace.conversion.status, 'cancelled'); assert.equal(workspace.conversion.output, old);
    assert.equal(control.calls.length, phase === 'pass-2' ? 1 : 2);
    assert.equal(workspace.conversion.cleanupPaths.size, 0); assert.equal(workspace.activeOperation, null);
  });
}

test('one bounded size correction publishes complete under-limit bytes and records effective bitrate', async t => {
  const { workspace, control, process } = await setup(t); control.bytes = [350000, 250000];
  const output = await process(SIZE, CUT);
  assert.equal(workspace.conversion.status, 'ready'); assert.equal(control.calls.length, 4); assert.equal(output.attempts, 2);
  assert.equal(output.size, 250000); assert.ok(output.effectiveVideoBitrate < output.processingSnapshot.rateBudget.videoBitrate);
  assert.equal(control.calls.some(args => args.includes('-fs')), false);
});

test('persistent overshoot and failed validation preserve previous result without more than one correction', async t => {
  const { workspace, control, process } = await setup(t); const old = await process();
  control.bytes = [350000]; await process(SIZE, CUT);
  assert.equal(workspace.conversion.status, 'failed'); assert.equal(workspace.conversion.failure.category, 'local_processing_size');
  assert.equal(control.calls.length, 4); assert.equal(workspace.conversion.output, old);
  control.mode = 'invalid'; control.bytes = [20000]; await process(QUALITY);
  assert.equal(workspace.conversion.status, 'failed'); assert.equal(workspace.conversion.output, old);
});

test('cancellation holds shared conversion admission until child termination, then allows retry', async t => {
  const first = await setup(t), second = await setup(t); first.control.mode = 'unconfirmed';
  const body = await first.review(first.request(QUALITY)); await first.manager.processing.start(body);
  await until(() => first.control.children.length === 1);
  await first.manager.conversions.cancel(first.workspace.id);
  assert.equal(first.workspace.activeOperation, 'converting'); assert.equal(first.workspace.conversion.status, 'cancelling');
  const other = await second.review(second.request(QUALITY)); await assert.rejects(second.manager.processing.start(other), { statusCode: 409 });
  const oldPlan = await second.manager.conversions.plan(second.workspace.id, second.workspace.sourceAssetId, 'mp3');
  await assert.rejects(second.manager.conversions.start({ workspaceId: second.workspace.id, inputAssetId: second.workspace.sourceAssetId, targetId: 'mp3', planKey: oldPlan.key }), { statusCode: 409 });
  first.control.children[0].emit('exit', 1); first.control.children[0].emit('close', 1); await first.workspace.activePromise;
  await second.manager.processing.start(other); await second.workspace.activePromise; assert.equal(second.workspace.conversion.status, 'ready');
});

test('failed pass-directory cleanup remains owned and blocks processing until bounded explicit retry', async t => {
  const { manager, workspace, request, review, process } = await setup(t); let attempts = 0;
  manager.fs = { ...fsp, rm: async (file, options) => {
    if (path.basename(file).startsWith('processing-')) { attempts++; throw Object.assign(new Error('controlled lock'), { code: 'EBUSY' }); }
    return fsp.rm(file, options);
  } };
  await process(SIZE); assert.equal(workspace.conversion.status, 'ready'); assert.equal(attempts, 3);
  assert.equal(workspace.conversion.cleanupPaths.size, 1); assert.equal(workspace.conversion.cleanupDirectories.size, 1);
  await assert.rejects(manager.processing.start(await review(request(QUALITY))), { statusCode: 409 });
  manager.fs = fsp; await manager.conversions.retryCleanup(workspace.id);
  assert.equal(workspace.conversion.cleanupPaths.size, 0); assert.equal(workspace.conversion.cleanupDirectories.size, 0);
});

test('successful processing replacement preserves open old-result readers until close and retires bytes afterward', async t => {
  const { manager, workspace, process } = await setup(t); const old = await process(QUALITY), asset = workspace.assets.get(old.assetId);
  const reader = fs.createReadStream(asset.filePath, { highWaterMark: 1 }); manager.ownReadStream(workspace, reader, { destroy() {} }, asset.id); await once(reader, 'open');
  await process(); assert.equal(manager.conversions.resolve(workspace.id, asset.id), null); assert.equal(reader.destroyed, false);
  const chunks = []; for await (const chunk of reader) chunks.push(chunk); assert.equal(Buffer.concat(chunks).length, old.size);
  await until(() => !workspace.retiredOutputs.has(asset.id)); await assert.rejects(fsp.stat(asset.filePath), { code: 'ENOENT' });
});

test('Discard during a pass invalidates input/results immediately and waits for termination before directory release', async t => {
  const { manager, workspace, control, request, review, process } = await setup(t); const old = await process(); control.mode = 'unconfirmed';
  await manager.processing.start(await review(request(SIZE))); await until(() => control.children.length === 1);
  const directory = workspace.tempDir, discarded = manager.discard(workspace.id);
  assert.equal(manager.get(workspace.id), null); assert.equal(manager.conversions.resolve(workspace.id, old.assetId), null); assert.ok(await fsp.stat(directory));
  control.children[0].emit('exit', 1); control.children[0].emit('close', 1); await discarded;
  await assert.rejects(fsp.stat(directory), { code: 'ENOENT' }); assert.equal(control.calls.length, 1);
});

test('failed overshoot cleanup retains its exhausted three-attempt budget without restarting it in finally', async t => {
  const { manager, workspace, control, process } = await setup(t);
  control.bytes = [350000];
  let attempts = 0;
  manager.fs = { ...fsp, rm: async (file, options) => {
    if (path.basename(file).startsWith('processing-')) {
      attempts++;
      throw Object.assign(new Error('controlled locked size-attempt directory'), { code: 'EBUSY' });
    }
    return fsp.rm(file, options);
  } };
  await process(SIZE, CUT);
  assert.equal(workspace.conversion.status, 'failed');
  assert.equal(control.calls.length, 2, 'a size correction cannot begin before prior attempt cleanup succeeds');
  assert.equal(attempts, 3, 'initial deletion and two retries are the complete automatic budget');
  assert.equal(workspace.conversion.cleanupPaths.size, 1);
  assert.equal(workspace.conversion.cleanupDirectories.size, 1, 'failed directory remains owned for explicit cleanup');
  manager.fs = fsp;
  await manager.conversions.retryCleanup(workspace.id);
  assert.equal(workspace.conversion.cleanupPaths.size, 0);
  assert.equal(workspace.conversion.cleanupDirectories.size, 0);
});

test('late cancellation cannot replace ready with cancelling while published-result directory cleanup completes', async t => {
  const { manager, workspace, request, review } = await setup(t);
  const entered = deferred(), release = deferred();
  manager.fs = { ...fsp, rm: async (file, options) => {
    if (path.basename(file).startsWith('processing-')) { entered.resolve(); await release.promise; }
    return fsp.rm(file, options);
  } };
  await manager.processing.start(await review(request(QUALITY)));
  const completed = workspace.activePromise;
  await entered.promise;
  const output = workspace.conversion.output;
  try {
    assert.equal(workspace.conversion.status, 'ready');
    assert.equal(workspace.activeOperation, 'converting', 'cleanup still owns admission');
    assert.ok(manager.conversions.resolve(workspace.id, output.assetId));
    await assert.rejects(manager.conversions.cancel(workspace.id), { statusCode: 409 });
  } finally { release.resolve(); await completed; }
  assert.equal(workspace.conversion.status, 'ready');
  assert.equal(workspace.conversion.output, output);
  assert.equal(workspace.activeOperation, null);
  assert.equal(workspace.conversion.cleanupPaths.size, 0);
});
