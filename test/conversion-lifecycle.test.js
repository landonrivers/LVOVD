'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createMediaWorkspaceManager } = require('../media-workspace');
const { normalizeMediaInspection } = require('../media-inspection');

function metadata(kind = 'mov') {
  return { format: { format_name: 'mov,mp4,m4a', start_time: '0', duration: '5', tags: { major_brand: kind === 'mp4' ? 'isom' : 'qt  ' } }, chapters: [],
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 96, height: 64, avg_frame_rate: '20/1', start_time: '0', duration: '5' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', start_time: '0', duration: '5' }] };
}
async function setup(t, { kind = 'mov', sourceMetadata = null, ...options } = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-conversion-unit-'));
  const control = { mode: 'success', children: [], calls: [], discovery: 0 };
  const source = normalizeMediaInspection(sourceMetadata || metadata(kind));
  const manager = createMediaWorkspaceManager({ tempDir, conversionTerminationGraceMs: 10, cleanupRetryDelaysMs: [1, 2],
    inspectAsset: async () => source,
    discoverCapabilities: async () => { control.discovery++; return { available: true, muxers: new Set(['mp4']) }; },
    spawnProcess(command, args, spawnOptions) {
      const child = new EventEmitter(); child.pid = 123; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
      child.kill = signal => { child.signals.push(signal); if (control.mode !== 'held') setImmediate(() => { child.emit('exit', 1); child.emit('close', 1); }); return true; };
      control.children.push(child); control.calls.push({ command, args, options: spawnOptions });
      if (command === 'ffmpeg') {
        const file = args.at(-1);
        fs.writeFile(file, Buffer.alloc(control.mode === 'oversize' ? 256 : 32)).then(() => {
          if (control.mode === 'held') return;
          if (control.mode === 'failed') child.stderr.write('controlled processing failure');
          child.emit('exit', control.mode === 'failed' ? 1 : 0); child.emit('close', control.mode === 'failed' ? 1 : 0);
        });
      } else {
        setImmediate(() => {
          const output = metadata('mp4');
          if (control.mode === 'invalid') output.streams[0].codec_name = 'hevc';
          child.stdout.write(JSON.stringify(output)); child.emit('exit', 0); child.emit('close', 0);
        });
      }
      return child;
    }, ...options });
  const workspace = await manager.receiveLocalStream(Readable.from([Buffer.alloc(16)]), { displayName: 'fixture.mov', purpose: 'local' });
  await workspace.activePromise;
  t.after(async () => {
    for (const child of control.children) { child.emit('exit', 1); child.emit('close', 1); }
    await manager.clearAll(); await fs.rm(tempDir, { recursive: true, force: true });
  });
  const request = async () => {
    const plan = await manager.conversions.plan(workspace.id, workspace.sourceAssetId, 'broad-compatibility-mp4');
    return { workspaceId: workspace.id, inputAssetId: workspace.sourceAssetId, targetId: 'broad-compatibility-mp4', planKey: plan.key, acknowledgedWarnings: plan.warnings.map(item => item.id) };
  };
  return { manager, workspace, control, request };
}

test('neutral intake never discovers capabilities or prepares playback; Edit is explicit and reusable', async t => {
  let proxies = 0;
  const { manager, workspace, control } = await setup(t, { kind: 'mp4', createProxyAsset: async () => { proxies++; throw new Error('unexpected'); } });
  assert.equal(control.discovery, 0); assert.equal(workspace.playbackAssetId, null);
  assert.throws(() => manager.startRender(workspace.id, { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 1 }] }), { statusCode: 409 });
  manager.prepareEditor(workspace.id, workspace.sourceAssetId); await workspace.activePromise;
  assert.equal(workspace.editor.status, 'ready'); assert.equal(control.discovery, 0); assert.equal(proxies, 0);
  assert.equal(manager.prepareEditor(workspace.id, workspace.sourceAssetId), workspace);
});
test('failed lazy playback preparation retains valid source identity for conversion', async t => {
  const { manager, workspace, request } = await setup(t, { sourceMetadata: { ...metadata(), format: { format_name: 'matroska', duration: '5' } }, createProxyAsset: async () => { throw new Error('controlled proxy failure'); } });
  const id = workspace.sourceAssetId;
  manager.prepareEditor(workspace.id, id); await workspace.activePromise;
  assert.equal(workspace.status, 'ready'); assert.equal(workspace.editor.status, 'failed'); assert.equal(workspace.sourceAssetId, id);
  await manager.conversions.start(await request()); await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'ready');
});
test('server rejects stale plan, missing warning acknowledgement, wrong role and cross-workspace assets', async t => {
  const raw = metadata(); raw.chapters = [{ id: 0 }];
  const { manager, workspace, request } = await setup(t, { sourceMetadata: raw });
  const other = await setup(t);
  const body = await request();
  await assert.rejects(manager.conversions.start({ ...body, planKey: 'stale' }), { statusCode: 409 });
  await assert.rejects(manager.conversions.start({ ...body, acknowledgedWarnings: [] }), { statusCode: 409 });
  await assert.rejects(manager.conversions.plan(workspace.id, other.workspace.sourceAssetId, body.targetId), { statusCode: 409 });
  const proxy = manager.registerAsset(workspace, { filePath: path.join(workspace.tempDir, 'proxy.mp4'), role: 'playback-proxy' });
  await assert.rejects(manager.conversions.plan(workspace.id, proxy.id, body.targetId), { statusCode: 409 });
  assert.equal(manager.conversions.resolve(workspace.id, workspace.sourceAssetId), null);
});
test('source-only no-op download is explicitly authorized and does not launch discovery or copy bytes', async t => {
  const { manager, workspace, control, request } = await setup(t, { kind: 'mp4' });
  assert.equal(manager.conversions.resolve(workspace.id, workspace.sourceAssetId), null);
  const before = await fs.readdir(workspace.tempDir);
  await manager.conversions.start(await request());
  assert.ok(manager.conversions.resolve(workspace.id, workspace.sourceAssetId)); assert.equal(control.calls.length, 0); assert.equal(control.discovery, 0);
  assert.deepEqual(await fs.readdir(workspace.tempDir), before);
  const id = workspace.id, asset = workspace.sourceAssetId; await manager.discard(id);
  assert.equal(manager.conversions.resolve(id, asset), null);
});
test('conversion slot is atomic across managers; workspace work conflicts; cancellation holds it until confirmed exit', async t => {
  const first = await setup(t), second = await setup(t); first.control.mode = 'held';
  await first.manager.conversions.start(await first.request());
  await assert.rejects(second.manager.conversions.start(await second.request()), { statusCode: 409 });
  assert.throws(() => first.manager.prepareEditor(first.workspace.id, first.workspace.sourceAssetId), { statusCode: 409 });
  const start = Date.now(); await first.manager.conversions.cancel(first.workspace.id);
  assert.ok(Date.now() - start < 1000); assert.equal(first.workspace.conversion.status, 'cancelling');
  assert.equal(first.workspace.conversion.terminationPending, true);
  assert.deepEqual(first.control.children[0].signals, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(second.manager.conversions.start(await second.request()), { statusCode: 409 });
  first.control.children[0].emit('exit', 1); await first.workspace.activePromise;
  assert.equal(first.workspace.conversion.status, 'cancelled'); assert.equal(first.workspace.activeOperation, null);
  await second.manager.conversions.start(await second.request()); await second.workspace.activePromise;
  assert.equal(second.workspace.conversion.status, 'ready');
  first.control.mode = 'success'; await first.manager.conversions.start(await first.request()); await first.workspace.activePromise;
  assert.equal(first.workspace.conversion.status, 'ready');
});
test('failed, invalid, and cancelled reruns retain previous output; successful replacement retires only converted output', async t => {
  const { manager, workspace, control, request } = await setup(t);
  await manager.conversions.start(await request()); await workspace.activePromise;
  const previous = workspace.conversion.output;
  const edited = manager.registerAsset(workspace, { role: 'edited-output', filePath: path.join(workspace.tempDir, 'edited.mp4'), filename: 'edited.mp4' });
  workspace.render.outputAssetId = edited.id;
  for (const mode of ['failed', 'invalid', 'held']) {
    control.mode = mode; await manager.conversions.start(await request());
    if (mode === 'held') { const child = control.children.at(-1); await manager.conversions.cancel(workspace.id); child.emit('exit', 1); }
    await workspace.activePromise; assert.equal(workspace.conversion.output, previous); assert.ok(manager.conversions.resolve(workspace.id, previous.assetId));
  }
  control.mode = 'success'; await manager.conversions.start(await request()); await workspace.activePromise;
  assert.notEqual(workspace.conversion.output.assetId, previous.assetId); assert.equal(manager.conversions.resolve(workspace.id, previous.assetId), null);
  assert.equal(workspace.render.outputAssetId, edited.id);
});
test('Discard invalidates conversion downloads immediately and waits for owned termination before deleting', async t => {
  const { manager, workspace, control, request } = await setup(t); control.mode = 'held';
  await manager.conversions.start(await request()); const directory = workspace.tempDir;
  const discarded = manager.discard(workspace.id);
  assert.equal(manager.get(workspace.id), null); assert.equal(manager.cleanupStatus(workspace).status, 'pending');
  assert.ok((await fs.stat(directory)).isDirectory());
  control.children[0].emit('exit', 1); await discarded;
  assert.equal(manager.cleanupStatus(workspace).status, 'complete'); await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});
test('file-size guard rejects truncated output and leaves original source available', async t => {
  const { manager, workspace, control, request } = await setup(t, { maxConvertedBytes: 128 }); control.mode = 'oversize';
  await manager.conversions.start(await request()); await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'failed'); assert.equal(workspace.conversion.output, null); assert.ok(workspace.sourceAssetId);
  assert.equal(control.calls[0].args[control.calls[0].args.indexOf('-fs') + 1], '128');
});
test('retired/partial cleanup failure retains ownership, blocks accumulation, and supports bounded explicit retry', async t => {
  let deny = false;
  const injectedFs = { ...fs, rm: async (file, options) => { if (deny && path.basename(file).startsWith('converted-')) throw Object.assign(new Error('controlled'), { code: 'EACCES' }); return fs.rm(file, options); } };
  const { manager, workspace, control, request } = await setup(t, { fsPromises: injectedFs });
  control.mode = 'failed'; deny = true;
  await manager.conversions.start(await request()); await workspace.activePromise;
  assert.equal(workspace.conversion.cleanupPaths.size, 1); assert.equal(manager.publicWorkspace(workspace).conversion.cleanupPending, true);
  await assert.rejects(manager.conversions.start(await request()), { statusCode: 409 });
  deny = false; await manager.conversions.retryCleanup(workspace.id); assert.equal(workspace.conversion.cleanupPaths.size, 0);
  control.mode = 'success'; await manager.conversions.start(await request()); await workspace.activePromise; assert.equal(workspace.conversion.status, 'ready');
});

test('an FFmpeg spawn failure releases admission and retains the owned source for retry', async t => {
  const context = await setup(t);
  const { manager, workspace, request } = context, original = manager.spawnProcess;
  manager.spawnProcess = () => { throw Object.assign(new Error('controlled missing executable'), { code: 'ENOENT' }); };
  await manager.conversions.start(await request()); await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'failed'); assert.equal(workspace.activeOperation, null);
  assert.ok(workspace.sourceAssetId); assert.equal(workspace.conversion.output, null);
  manager.spawnProcess = original;
  await manager.conversions.start(await request()); await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'ready');
});

test('ENOSPC stays a local storage failure and preserves a prior validated conversion', async t => {
  let full = false;
  const context = await setup(t, { fsPromises: { ...fs, rename: async (...args) => {
    if (full) throw Object.assign(new Error('controlled disk full'), { code: 'ENOSPC' });
    return fs.rename(...args);
  } } });
  const { manager, workspace, request } = context;
  await manager.conversions.start(await request()); await workspace.activePromise;
  const previous = workspace.conversion.output;
  full = true; await manager.conversions.start(await request()); await workspace.activePromise;
  assert.equal(workspace.conversion.status, 'failed'); assert.equal(workspace.conversion.output, previous);
  assert.match(JSON.stringify(workspace.conversion.failure), /space|storage/i);
});
