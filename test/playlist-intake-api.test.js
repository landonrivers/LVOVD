'use strict';
process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';
process.env.HOST = '127.0.0.1'; process.env.PORT = String(45000 + process.pid % 10000);
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const app = require('../app-server');
const { server } = require('../server');
const port = Number(process.env.PORT);
function call(route, body, headers = {}, method = 'POST') {
  const bytes = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
      'Sec-Fetch-Site': 'same-origin', Connection: 'close', ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { body = Buffer.concat(chunks).toString(); } resolve({ status: res.statusCode, body }); });
    }); req.once('error', reject); req.end(bytes);
  });
}
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
test.before(async () => { await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); });
test.after(async () => { await app.mediaWorkspaces.clearAll(); await new Promise(resolve => server.close(resolve)); });
test.beforeEach(() => app.mediaWorkspaces.clearAll());

async function setup() {
  const collection = (await call('/api/processing/collection', {})).body.collection;
  const preview = app.playlistIntake.remember({ kind: 'playlist', entries: [0, 1].map(index => ({ title: `Synthetic item ${index}`, url: `https://fixture.example/item-${index}`, intakeEligible: true })) });
  return { collection, body: { collectionId: collection.id, requestId: crypto.randomUUID(), previewId: preview.playlistImportId,
    entryUrls: preview.entries.map(item => item.url), acquisition: { content: 'av', profile: 'maximum', maxHeight: null, sourceFormat: { mode: 'automatic' } } } };
}

test('real server gate rejects hostile origins, foreign identities and unsupported import fields before source work', async () => {
  const { body } = await setup(), before = app.remoteSourceRequests.size;
  for (const headers of [{ Origin: 'https://hostile.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'hostile.example' }]) {
    assert.equal((await call('/api/processing/import', body, headers)).status, 403);
  }
  for (const patch of [{ collectionId: crypto.randomUUID() }, { previewId: crypto.randomUUID() }, { paths: ['source.mp4'] }, { ffmpeg: '-y' },
    { acquisition: { ...body.acquisition, range: { start: 1 } } }, { entryUrls: ['https://fixture.example/foreign'] }]) {
    assert.ok((await call('/api/processing/import', { ...body, ...patch })).status >= 400);
  }
  assert.equal(app.remoteSourceRequests.size, before); assert.equal(app.mediaWorkspaces.workspaces.size, 0);
});

test('accepted HTTP admission, duplicate response and pending Remove use authoritative collection ownership', async () => {
  const { collection, body } = await setup(), hold = gate();
  const blocking = app.remoteSourceRequests.preview('held synthetic Preview', () => hold.promise);
  try {
    const response = await call('/api/processing/import', body); assert.equal(response.status, 202);
    assert.equal(response.body.collection.workspaces.length, 0); assert.equal(response.body.collection.intake.items.length, 2);
    assert.equal(app.mediaWorkspaces.workspaces.size, 0);
    const duplicate = await call('/api/processing/import', body); assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.collection.intake.id, body.requestId);
    const other = (await call('/api/processing/collection', {})).body.collection;
    assert.equal((await call('/api/processing/import/cancel', { collectionId: other.id, requestId: body.requestId })).status, 409);
    const item = response.body.collection.intake.items[1];
    assert.equal((await call(`/api/workspace?workspace=${item.id}`, null, {}, 'DELETE')).status, 200);
    assert.equal(app.mediaWorkspaces.localProcessing.snapshot(collection.id).intake.status, 'cancelled');
  } finally { hold.resolve(); await blocking; await app.mediaWorkspaces.localProcessing.get(collection.id).intake.promise; }
  assert.equal(app.mediaWorkspaces.workspaces.size, 0);
});

for (const kind of ['unknown total', 'separate streams and merge intermediates', 'active partial download']) {
  test(`actual acquisition guard bounds ${kind} before source adoption`, async () => {
    const workspace = await app.mediaWorkspaces.createUrlWorkspace({ displayName: 'Guard fixture', purpose: 'local' });
    let kills = 0; const observed = [], options = { content: 'av', profile: 'maximum', maxHeight: null, sourceFormat: { mode: 'automatic' } };
    const spawnProcess = (command, args, config) => {
      observed.push({ args, config }); const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { kills++; child.emit('close', 1); };
      setImmediate(async () => {
        const template = args[args.indexOf('--output') + 1];
        await fs.writeFile(template.replace('%(ext)s', 'mp4'), Buffer.alloc(kind === 'separate streams and merge intermediates' ? 150 : 301));
        if (kind === 'separate streams and merge intermediates') {
          await fs.mkdir(path.join(workspace.tempDir, 'fragments'));
          await fs.writeFile(path.join(workspace.tempDir, 'fragments', 'stream.part'), Buffer.alloc(100));
          await fs.writeFile(path.join(workspace.tempDir, 'source.f137.mp4'), Buffer.alloc(100));
        }
        child.stdout.write('__LVOVD_WORKSPACE_PROGRESS__NA|NA|NA|NA|NA|NA\n'); if (kind !== 'active partial download') child.emit('close', 0);
      }); return child;
    };
    await assert.rejects(app.runWorkspaceAcquisition(workspace, 'https://fixture.example/item', options, { title: 'Guard fixture', sourceName: 'Synthetic' }, { maximumBytes: 300, spawnProcess }));
    assert.equal(kills, kind === 'active partial download' ? 1 : 0);
    assert.equal(workspace.sourceAssetId, null); assert.equal(workspace.assets.size, 0);
    assert.equal(observed[0].config.shell, false); assert.equal(observed[0].args[observed[0].args.indexOf('--max-filesize') + 1], '300');
    assert.equal(observed[0].args[observed[0].args.indexOf('--extractor-retries') + 1], '0');
  });
}

test('removed-file cleanup endpoint enforces origin and collection ownership and never acquires media', async () => {
  const { collection } = await setup(), queue = app.mediaWorkspaces.localProcessing, manager = app.mediaWorkspaces;
  const owner = queue.get(collection.id), key = queue.reserve(owner, 100), workspace = await manager.createUrlWorkspace({ displayName: 'Removed fixture', purpose: 'local' });
  queue.attach(owner, workspace, key); workspace.activeOperation = null;
  const directory = workspace.tempDir; await fs.writeFile(path.join(directory, 'owned.part'), 'small fixture');
  const originalFs = manager.fs; let block = true, attempts = 0;
  manager.fs = { ...originalFs, rm: async (file, options) => {
    if (file === directory) { attempts++; if (block) throw Object.assign(new Error('Synthetic EACCES'), { code: 'EACCES' }); }
    return fs.rm(file, options);
  } };
  try {
    await manager.discard(workspace.id); const initialAttempts = attempts, sourceRequests = app.remoteSourceRequests.size;
    const other = (await call('/api/processing/collection', {})).body.collection;
    const body = { collectionId: collection.id, workspaceId: workspace.id };
    for (const headers of [{ Origin: 'https://hostile.example' }, { Host: 'hostile.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.equal((await call('/api/processing/cleanup', body, headers)).status, 403);
    }
    assert.equal((await call('/api/processing/cleanup', { ...body, collectionId: other.id })).status, 409);
    assert.equal((await call('/api/processing/cleanup', { ...body, workspaceId: crypto.randomUUID() })).status, 409);
    assert.equal((await call('/api/processing/cleanup', { ...body, path: directory })).status, 400);
    assert.equal((await call('/api/processing/cleanup', { ...body, ffmpeg: '-y' })).status, 400);
    assert.equal(attempts, initialAttempts);
    let response = await call('/api/processing/cleanup', body);
    assert.equal(response.status, 200); assert.equal(response.body.collection.removedCleanup[0].status, 'failed');
    assert.equal(response.body.collection.sourceBytesReserved, 100); assert.equal(attempts, initialAttempts + 1);
    assert.equal(JSON.stringify(response.body).includes(directory), false); assert.equal(JSON.stringify(response.body).includes('Synthetic EACCES'), false);
    block = false; response = await call('/api/processing/cleanup', body);
    assert.equal(response.status, 200); assert.deepEqual(response.body.collection.removedCleanup, []);
    assert.equal(response.body.collection.sourceBytesReserved, 0); assert.equal(queue.entryCount(owner), 0);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); assert.equal(app.remoteSourceRequests.size, sourceRequests);
  } finally { block = false; await manager.retryCleanup(workspace.id); manager.fs = originalFs; }
});
