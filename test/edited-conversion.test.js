'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter, once } = require('node:events');
const { createMediaWorkspaceManager, totalRetainedDuration } = require('../media-workspace');
const { normalizeMediaInspection } = require('../media-inspection');

const A = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 6, endSeconds: 9 }] };
const B = { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 5 }] };
function media(duration = 9, audioOnly = false) {
  return normalizeMediaInspection({ format: { format_name: 'mov,mp4,m4a', duration: String(duration), start_time: '0', tags: { major_brand: 'isom' } }, chapters: [],
    streams: [!audioOnly && { index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 96, height: 64, avg_frame_rate: '20/1', start_time: '0', duration: String(duration) },
      { index: audioOnly ? 0 : 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1, channel_layout: 'mono', start_time: '0', duration: String(duration) }].filter(Boolean) });
}
async function eventually(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'owned retirement settles after reader close'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function setup(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-edited-input-'));
  const control = { calls: [], children: [], mode: 'success', renderMode: 'success', next: 0, inspections: 0 };
  const manager = createMediaWorkspaceManager({ tempDir: root, cleanupRetryDelaysMs: [1, 2], conversionTerminationGraceMs: 10,
    inspectAsset: async () => media(),
    discoverCapabilities: async () => ({ available: true, muxers: new Set(['mp4']) }),
    createEditedAsset: async (workspace, source, inspection, plan, attempt) => {
      assert.equal(source.id, workspace.sourceAssetId); assert.equal(inspection.durationSeconds, 9);
      if (control.renderMode === 'failed') throw new Error('controlled render failure');
      if (control.renderMode === 'cancelled') throw Object.assign(new Error('controlled cancellation'), { code: 'LVOVD_WORKSPACE_CANCELLED' });
      await fsp.writeFile(attempt.finalPath, `edited bytes ${++control.next}`);
      return { filePath: attempt.finalPath };
    },
    inspectOutputAsset: async workspace => media(totalRetainedDuration(workspace.render.requestedPlan)),
    spawnProcess(command, args, options) {
      assert.equal(options.shell, false); assert.equal(command, 'ffmpeg');
      control.calls.push(args);
      const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { setImmediate(() => { child.emit('exit', 1); child.emit('close', 1); }); return true; };
      control.children.push(child);
      fsp.writeFile(args.at(-1), 'converted fixture bytes').then(() => {
        if (control.mode === 'held') return;
        const code = control.mode === 'failed' ? 1 : 0; child.emit('exit', code); child.emit('close', code);
      });
      return child;
    }
  });
  manager.defaultInspectAsset = async workspace => {
    control.inspections++;
    const input = workspace.assets.get(workspace.conversion.activeInputAssetId);
    const facts = media(input.role === 'source' ? 9 : input.inspection.durationSeconds, true);
    if (control.mode === 'invalid') facts.audio.codec = 'opus';
    return facts;
  };
  const workspace = await manager.receiveLocalStream(Readable.from('original synthetic bytes'), { displayName: 'original.mp4', purpose: 'local' });
  await workspace.activePromise;
  manager.prepareEditor(workspace.id, workspace.sourceAssetId); await workspace.activePromise;
  t.after(async () => {
    manager.fs = fsp;
    for (const child of control.children) { child.emit('exit', 1); child.emit('close', 1); }
    await manager.clearAll();
    await fsp.rm(root, { recursive: true, force: true });
  });
  const render = async (plan = A) => {
    manager.startRender(workspace.id, plan); await workspace.activePromise;
    assert.equal(workspace.render.status, 'ready', JSON.stringify(workspace.render.failure));
    return workspace.assets.get(workspace.render.outputAssetId);
  };
  const request = async (asset, targetId = 'broad-compatibility-mp4', editPlan = asset.role === 'edited-output' ? asset.editPlan : undefined) => {
    const plan = await manager.conversions.plan(workspace.id, asset.id, targetId, editPlan);
    return { workspaceId: workspace.id, inputAssetId: asset.id, targetId, editPlan, planKey: plan.key };
  };
  const convert = async (asset, targetId) => {
    await manager.conversions.start(await request(asset, targetId)); await workspace.activePromise;
    assert.equal(workspace.conversion.status, 'ready', JSON.stringify(workspace.conversion.failure));
    return workspace.conversion.output;
  };
  return { manager, workspace, control, render, request, convert };
}

test('edited input uses stored six-second facts and original-coordinate freshness; original remains nine seconds', async t => {
  const { manager, workspace, render } = await setup(t); const edited = await render();
  const original = await manager.conversions.plan(workspace.id, workspace.sourceAssetId, 'm4a-aac');
  const plan = await manager.conversions.plan(workspace.id, edited.id, 'm4a-aac', A);
  assert.equal(plan.timing.durationSeconds, 6); assert.equal(original.timing.durationSeconds, 9);
  assert.equal(plan.inputRole, 'edited-output'); assert.equal(plan.inputFilename, edited.filename);
  assert.equal(plan.inputDurationSeconds, 6); assert.notEqual(plan.key, original.key);
  assert.notEqual(plan.inspectionKey, original.inspectionKey);
  assert.equal(plan.streams[0].index, edited.inspection.audio.streamIndex);
  assert.throws(() => manager.prepareEditor(workspace.id, edited.id), { statusCode: 409 });
  await assert.rejects(manager.conversions.plan(workspace.id, edited.id, 'm4a-aac', B), { statusCode: 409 });
  await assert.rejects(manager.conversions.plan(workspace.id, edited.id, 'm4a-aac'), { statusCode: 409 });
});

test('no-op edited download aliases exact bytes without discovery, execution, or duplicate files, including repeated no-op', async t => {
  const { manager, workspace, render, convert, control } = await setup(t); const edited = await render();
  manager.discoverCapabilities = async () => { throw new Error('no-op requires no capability check'); };
  const before = await fsp.readdir(workspace.tempDir);
  for (let i = 0; i < 3; i++) {
    const output = await convert(edited, 'broad-compatibility-mp4');
    assert.equal(output.noOp, true); assert.equal(output.assetId, edited.id);
    assert.equal(output.provenance.inputAssetId, edited.id); assert.equal(output.provenance.inputRole, 'edited-output');
    assert.equal(output.provenance.inputDurationSeconds, 6); assert.ok(output.provenance.editPlanKey);
    assert.equal(Object.isFrozen(output.provenance), true);
    assert.match(output.filename, /edited.*converted\.mp4$/i);
    assert.deepEqual(await fsp.readFile(manager.conversions.resolve(workspace.id, output.assetId).asset.filePath), await fsp.readFile(edited.filePath));
  }
  assert.equal(control.calls.length, 0); assert.equal(control.inspections, 0);
  assert.deepEqual(await fsp.readdir(workspace.tempDir), before); assert.equal(workspace.retiredOutputs.size, 0);
});

test('new planning rejects cross-workspace, proxy, converted, incomplete, retired, and arbitrary-path inputs', async t => {
  const context = await setup(t), other = await setup(t);
  const { manager, workspace, render, convert } = context;
  const old = await render(); await convert(old, 'broad-compatibility-mp4'); const latest = await render(B);
  const proxy = manager.registerAsset(workspace, { role: 'playback-proxy', filePath: path.join(workspace.tempDir, 'proxy.mp4') });
  const generated = await convert(latest, 'm4a-aac');
  for (const id of [other.workspace.sourceAssetId, proxy.id, generated.assetId, old.id, old.filePath, null, {}]) {
    await assert.rejects(manager.conversions.plan(workspace.id, id, 'm4a-aac', A), { statusCode: 409 });
  }
  latest.validated = false;
  await assert.rejects(manager.conversions.plan(workspace.id, latest.id, 'm4a-aac', B), { statusCode: 409 });
});

test('repeated rerenders retain only the edited no-op alias plus latest output, then release the alias on conversion replacement', async t => {
  const { manager, workspace, render, convert, request } = await setup(t);
  const first = await render(); const output = await convert(first, 'broad-compatibility-mp4');
  const bytes = await fsp.readFile(first.filePath);
  let latest;
  for (let i = 0; i < 4; i++) {
    latest = await render(i % 2 ? A : B);
    assert.equal(workspace.conversion.output, output);
    assert.equal(manager.resolveOutputAsset(workspace.id, first.id), null);
    assert.deepEqual(await fsp.readFile(manager.conversions.resolve(workspace.id, first.id).asset.filePath), bytes);
    assert.equal([...workspace.assets.values()].filter(asset => asset.role === 'edited-output').length, 2);
    await assert.rejects(request(first), { statusCode: 409 });
  }
  await convert(latest, 'broad-compatibility-mp4');
  assert.equal(manager.conversions.resolve(workspace.id, first.id), null);
  await assert.rejects(fsp.stat(first.filePath), { code: 'ENOENT' });
  assert.equal(workspace.retiredOutputs.size, 0);
});

test('generated output provenance survives rerender without pinning old edited input bytes', async t => {
  const { manager, workspace, render, convert, control } = await setup(t);
  const edited = await render(); const output = await convert(edited, 'm4a-aac');
  assert.equal(output.noOp, false); assert.equal(output.provenance.inputAssetId, edited.id);
  assert.equal(control.calls[0][control.calls[0].indexOf('-i') + 1], edited.filePath);
  await render(B);
  await assert.rejects(fsp.stat(edited.filePath), { code: 'ENOENT' });
  assert.ok(manager.conversions.resolve(workspace.id, output.assetId));
  assert.equal(output.provenance.inputDurationSeconds, 6); assert.equal(output.inspection.durationSeconds, 6);
});

for (const phase of ['discovery', 'stat']) {
  test(`replacement during pending ${phase} rejects the old reviewed edited input`, async t => {
    const { manager, workspace, render, request, control } = await setup(t); const edited = await render();
    const started = gate(), release = gate();
    let pending;
    if (phase === 'discovery') {
      manager.discoverCapabilities = async () => { started.resolve(); await release.promise; return { available: true, muxers: new Set(['mp4']) }; };
      pending = request(edited, 'm4a-aac');
    } else {
      const body = await request(edited, 'm4a-aac');
      manager.fs = { ...fsp, lstat: async file => { const stat = await fsp.lstat(file); started.resolve(); await release.promise; return stat; } };
      pending = manager.conversions.start(body);
    }
    const rejected = assert.rejects(pending, { statusCode: 409 });
    await started.promise; const latest = await render(B); release.resolve(); await rejected;
    assert.equal(workspace.render.outputAssetId, latest.id); assert.equal(control.calls.length, 0);
  });
}

test('Start rejects stale keys/assertions and admitted conversion prevents rerender; cancel retains edited input and previous alias', async t => {
  const { manager, workspace, render, convert, request, control } = await setup(t); const edited = await render();
  const alias = await convert(edited, 'broad-compatibility-mp4');
  const body = await request(edited, 'm4a-aac');
  await assert.rejects(manager.conversions.start({ ...body, editPlan: B }), { statusCode: 409 });
  await assert.rejects(manager.conversions.start({ ...body, planKey: 'old-key' }), { statusCode: 409 });
  control.mode = 'held'; await manager.conversions.start(body);
  assert.equal(workspace.conversion.activeInputAssetId, edited.id);
  assert.throws(() => manager.startRender(workspace.id, B), { statusCode: 409 });
  await manager.conversions.cancel(workspace.id); await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'cancelled'); assert.equal(workspace.conversion.activeInputAssetId, null);
  assert.equal(workspace.conversion.output, alias); assert.ok(await fsp.stat(edited.filePath));
  control.mode = 'success'; await convert(edited, 'm4a-aac');
});

test('failed/invalid conversion and failed/cancelled rerender preserve both latest edited result and its published alias', async t => {
  const { manager, workspace, render, convert, request, control } = await setup(t); const edited = await render();
  const alias = await convert(edited, 'broad-compatibility-mp4');
  for (const mode of ['failed', 'invalid']) {
    control.mode = mode; await manager.conversions.start(await request(edited, 'm4a-aac')); await workspace.activePromise;
    assert.equal(workspace.conversion.status, 'failed'); assert.equal(workspace.conversion.output, alias);
  }
  for (const mode of ['failed', 'cancelled']) {
    control.renderMode = mode; manager.startRender(workspace.id, B); await workspace.activePromise;
    assert.equal(workspace.render.outputAssetId, edited.id); assert.equal(workspace.conversion.output, alias);
    assert.ok(manager.conversions.resolve(workspace.id, edited.id));
  }
});

test('an opened edited download completes after replacement and last-reader close triggers retirement', async t => {
  const { manager, workspace, render } = await setup(t); const edited = await render();
  const stream = fs.createReadStream(edited.filePath, { highWaterMark: 1 });
  manager.ownReadStream(workspace, stream, { destroyed: false, destroy() {} }, edited.id);
  await once(stream, 'open');
  await render(B);
  assert.equal(manager.resolveOutputAsset(workspace.id, edited.id), null); assert.equal(stream.destroyed, false);
  assert.ok(await fsp.stat(edited.filePath));
  const expected = await fsp.readFile(edited.filePath), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), expected);
  await eventually(() => !workspace.retiredOutputs.has(edited.id));
  await assert.rejects(fsp.stat(edited.filePath), { code: 'ENOENT' });
});

test('conversion alias replacement preserves its already-open reader until close', async t => {
  const { manager, workspace, render, convert } = await setup(t); const edited = await render();
  await convert(edited, 'broad-compatibility-mp4'); const latest = await render(B);
  const stream = fs.createReadStream(edited.filePath); manager.ownReadStream(workspace, stream, { destroy() {} }, edited.id); await once(stream, 'open');
  await convert(latest, 'broad-compatibility-mp4');
  assert.equal(manager.conversions.resolve(workspace.id, edited.id), null); assert.equal(stream.destroyed, false);
  assert.ok(await fsp.stat(edited.filePath)); stream.destroy(); await once(stream, 'close');
  await eventually(() => !workspace.retiredOutputs.has(edited.id)); await assert.rejects(fsp.stat(edited.filePath), { code: 'ENOENT' });
});

for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
  test(`${code} retirement retains failed-file ownership, bounds retries and admission, then explicit cleanup recovers`, async t => {
    const { manager, workspace, render } = await setup(t); const edited = await render(); let calls = 0;
    manager.fs = { ...fsp, rm: async (file, options) => { if (file === edited.filePath) { calls++; throw Object.assign(new Error('controlled retirement denial'), { code }); } return fsp.rm(file, options); } };
    await render(B);
    assert.equal(calls, code === 'EACCES' ? 1 : 3); assert.equal(manager.publicWorkspace(workspace).outputCleanup.blocked, true);
    assert.equal(workspace.retiredOutputs.get(edited.id).asset.filePath, edited.filePath);
    assert.throws(() => manager.startRender(workspace.id, A), { statusCode: 409 });
    await manager.outputRetirement.retire(workspace, edited.id); assert.equal(calls, code === 'EACCES' ? 1 : 3);
    manager.fs = fsp; await manager.conversions.retryCleanup(workspace.id);
    assert.equal(workspace.retiredOutputs.size, 0); await render(A);
  });
}

test('transient retirement failure retries within the existing budget and removes the old file', async t => {
  const { manager, workspace, render } = await setup(t); const edited = await render(); let calls = 0;
  manager.fs = { ...fsp, rm: async (file, options) => { if (file === edited.filePath && ++calls === 1) throw Object.assign(new Error('temporary lock'), { code: 'EBUSY' }); return fsp.rm(file, options); } };
  await render(B); assert.equal(calls, 2); assert.equal(workspace.retiredOutputs.size, 0);
});

for (const expired of [false, true]) {
  test(`${expired ? 'expiry' : 'Discard'} invalidates alias/current outputs, closes readers, and retains failed directory cleanup`, async t => {
    const { manager, workspace, render, convert } = await setup(t); const edited = await render(); await convert(edited, 'broad-compatibility-mp4'); await render(B);
    const directory = workspace.tempDir, stream = fs.createReadStream(edited.filePath);
    manager.ownReadStream(workspace, stream, { destroyed: false, destroy() {} }, edited.id); await once(stream, 'open');
    manager.fs = { ...fsp, rm: async (file, options) => { if (file === directory) throw Object.assign(new Error('directory locked'), { code: 'EACCES' }); return fsp.rm(file, options); } };
    const discarded = expired ? manager.cleanupExpired(Date.now() + 7200000) : manager.discard(workspace.id);
    assert.equal(manager.get(workspace.id), null); assert.equal(manager.conversions.resolve(workspace.id, edited.id), null);
    await discarded; assert.equal(stream.closed, true); assert.equal(manager.cleanupStatus(workspace).status, 'failed');
    assert.equal(manager.cleanupPending.get(workspace.id).directory, directory);
    manager.fs = fsp; await manager.retryCleanup(workspace.id); await assert.rejects(fsp.stat(directory), { code: 'ENOENT' });
  });
}

test('plan keys bind workspace, input identity, role, edited plan, and inspection evidence even when effective codec decisions match', async t => {
  const { manager, workspace, render } = await setup(t);
  const first = await render();
  const firstPlan = await manager.conversions.plan(workspace.id, first.id, 'broad-compatibility-mp4', A);
  const latest = await render();
  const latestPlan = await manager.conversions.plan(workspace.id, latest.id, 'broad-compatibility-mp4', A);
  assert.notEqual(firstPlan.key, latestPlan.key); assert.equal(firstPlan.inspectionKey, latestPlan.inspectionKey);
  const { planConversion } = require('../conversion-plan');
  const args = { workspaceId: workspace.id, inputAssetId: latest.id, inputRole: 'edited-output', inputFilename: latest.filename,
    editPlanKey: latestPlan.editPlanKey, inspection: latest.inspection, targetId: latestPlan.targetId };
  const original = planConversion(args);
  for (const change of [{ workspaceId: 'other' }, { inputAssetId: 'other' }, { inputRole: 'source' }, { editPlanKey: 'different' },
    { inspection: { ...latest.inspection, bitRate: 12345 } }]) assert.notEqual(planConversion({ ...args, ...change }).key, original.key);
});

test('edited inspection controls codec/index/origin selection even when original source facts differ', async t => {
  const { manager, workspace, render } = await setup(t); const edited = await render();
  workspace.inspection.video = { ...workspace.inspection.video, streamIndex: 7, codec: 'hevc', width: 1920, height: 1080, hdr: true };
  workspace.inspection.audio = { ...workspace.inspection.audio, streamIndex: 9, codec: 'opus' };
  workspace.inspection.timeOriginSeconds = 5;
  const plan = await manager.conversions.plan(workspace.id, edited.id, 'broad-compatibility-mp4', A);
  assert.equal(plan.status, 'no-op'); assert.equal(plan.timing.originSeconds, 0);
  assert.equal(plan.output.width, 96); assert.deepEqual(plan.streams.map(stream => [stream.index, stream.action]), [[0, 'copy'], [1, 'copy']]);
});

test('changed immutable inspection evidence during pre-start stat is rejected rather than executing an old key', async t => {
  const { manager, workspace, render, request, control } = await setup(t); const edited = await render(); const body = await request(edited, 'm4a-aac');
  manager.fs = { ...fsp, lstat: async file => { const stat = await fsp.lstat(file); edited.inspection.audio.sampleRate = 44100; return stat; } };
  await assert.rejects(manager.conversions.start(body), { statusCode: 409 }); assert.equal(control.calls.length, 0);
});

test('a retirement failure arising during original-input stat is rechecked before conversion admission', async t => {
  const { manager, workspace, render, request, control } = await setup(t); const edited = await render();
  const body = await request(workspace.assets.get(workspace.sourceAssetId), 'm4a-aac');
  const started = gate(), release = gate();
  manager.fs = { ...fsp,
    lstat: async file => { const stat = await fsp.lstat(file); started.resolve(); await release.promise; return stat; },
    rm: async (file, options) => { if (file === edited.filePath) throw Object.assign(new Error('controlled failure'), { code: 'EACCES' }); return fsp.rm(file, options); }
  };
  const pending = manager.conversions.start(body), rejected = assert.rejects(pending, { statusCode: 409 });
  await started.promise; await render(B); release.resolve(); await rejected;
  assert.equal(control.calls.length, 0); assert.equal(manager.publicWorkspace(workspace).outputCleanup.blocked, true);
});
