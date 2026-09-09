'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';
process.env.HOST = '127.0.0.1';
process.env.PORT = String(45000 + process.pid % 10000);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { mediaWorkspaces } = require('../app-server');
const { server } = require('../server');
const { normalizeMediaInspection } = require('../media-inspection');

const port = Number(process.env.PORT);
const inspection = normalizeMediaInspection({ format: { format_name: 'mov,mp4,m4a', start_time: '0', duration: '5', tags: { major_brand: 'isom' } }, streams: [
  { index: 0, codec_type: 'video', codec_name: 'h264', width: 160, height: 90, pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1', avg_frame_rate: '20/1', start_time: '0', duration: '5' },
  { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 1, channel_layout: 'mono', sample_rate: '48000', bit_rate: '64000', start_time: '0', duration: '5' }
] });
const originalInspect = mediaWorkspaces.inspectAsset, originalCapabilities = mediaWorkspaces.discoverCapabilities;

test.before(async () => {
  mediaWorkspaces.inspectAsset = async () => structuredClone(inspection);
  mediaWorkspaces.discoverCapabilities = async () => ({ available: true, encoders: new Set(['libx264', 'aac']), decoders: new Set(['h264', 'aac']), muxers: new Set(['mp4', 'null']) });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
});
test.beforeEach(() => mediaWorkspaces.clearAll());
test.after(async () => {
  await mediaWorkspaces.clearAll();
  mediaWorkspaces.inspectAsset = originalInspect; mediaWorkspaces.discoverCapabilities = originalCapabilities;
  await new Promise(resolve => server.close(resolve));
});

function request(path, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Connection: 'close', ...headers
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const bytes = Buffer.concat(chunks); let data; try { data = JSON.parse(bytes); } catch {}
        resolve({ status: res.statusCode, data, bytes, headers: res.headers });
      });
    });
    req.once('error', reject); req.end(body);
  });
}
function post(path, value, headers) { const body = Buffer.from(JSON.stringify(value)); return request(path, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers } }); }
async function collection() {
  const response = await post('/api/processing/collection', {}); assert.equal(response.status, 201); return response.data.collection;
}
async function upload(id, name, bytes = Buffer.from(name)) {
  const response = await request('/api/media/local', { method: 'POST', body: bytes,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'X-LVOVD-Filename': encodeURIComponent(name), 'X-LVOVD-Collection': id } });
  assert.equal(response.status, 202, JSON.stringify(response.data));
  const workspace = mediaWorkspaces.get(response.data.workspaceId); await workspace.activePromise;
  return workspace;
}
async function reviewed(workspace, filenameSuffix = '_copy') {
  const body = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision: 0,
    editPlan: { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 5 }] }, settings: { filenameSuffix } };
  const response = await post('/api/processing/plan', body); assert.equal(response.status, 200);
  return { ...body, planKey: response.data.plan.key, acknowledgedWarnings: response.data.plan.warnings.map(warning => warning.id) };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'owned queue settles within the test bound'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}
function progress(id) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: `/api/processing/queue/progress?collection=${id}`,
      headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, res => {
      assert.equal(res.statusCode, 200); let buffer = '';
      const waiting = new Set();
      const connection = { req, res, closed: false, snapshots: [], stop() { req.destroy(); },
        waitFor(predicate) {
          const found = this.snapshots.find(predicate); if (found) return Promise.resolve(found);
          return new Promise(done => waiting.add({ predicate, done }));
        } };
      res.on('close', () => { connection.closed = true; });
      res.on('data', chunk => {
        buffer += String(chunk); let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!event.startsWith('data: ')) continue;
          const data = JSON.parse(event.slice(6)); connection.snapshots.push(data);
          if (!connection.data) { connection.data = data; resolve(connection); }
          for (const waiter of waiting) if (waiter.predicate(data)) { waiting.delete(waiter); waiter.done(data); }
        }
      });
    }); req.once('error', reject);
  });
}

for (const deletionFails of [false, true]) {
  test(`DELETE owns an open HTTP upload through writer close and ${deletionFails ? 'retained failed cleanup' : 'physical cleanup'}`, { timeout: 10000 }, async t => {
    const list = await collection(), otherBytes = Buffer.from('other complete source');
    const other = await upload(list.id, 'other.mp4', otherBytes);
    await post('/api/processing/queue', { collectionId: list.id, entries: [await reviewed(other)] });
    await until(() => other.conversion.status === 'ready');
    const feed = await progress(list.id);
    const firstWrite = deferred(), destroyStarted = deferred(), closeGate = deferred(), intakeSettled = deferred();
    const originalWriter = mediaWorkspaces.createWriteStream, originalFs = mediaWorkspaces.fs;
    const originalReceive = mediaWorkspaces.receiveLocalStream, inspect = mediaWorkspaces.inspectAsset;
    let writer, incoming, uploadRequest, directory, receivedId, ownershipAtExposure, destroyCount = 0, cleanupAttempts = 0;
    const inspected = [], cleanupClosed = [];
    t.after(async () => {
      closeGate.resolve(); uploadRequest?.destroy(); feed.stop();
      mediaWorkspaces.createWriteStream = originalWriter; mediaWorkspaces.fs = originalFs;
      mediaWorkspaces.receiveLocalStream = originalReceive; mediaWorkspaces.inspectAsset = inspect;
      if (incoming) await intakeSettled.promise;
      if (receivedId) { await mediaWorkspaces.discard(receivedId); await mediaWorkspaces.retryCleanup(receivedId); }
    });
    mediaWorkspaces.inspectAsset = async (...args) => { inspected.push(args[0].id); return inspect(...args); };
    mediaWorkspaces.createWriteStream = (...args) => {
      writer = fs.createWriteStream(...args); directory = path.dirname(args[0]);
      const destroy = writer._destroy;
      for (const name of ['_write', '_writev']) {
        const write = writer[name];
        writer[name] = function (...args) {
          const callback = args.pop();
          write.call(this, ...args, error => { callback(error); firstWrite.resolve(); });
        };
      }
      writer._destroy = function (error, callback) {
        destroyCount++; destroyStarted.resolve();
        closeGate.promise.then(() => destroy.call(this, error, callback));
      };
      return writer;
    };
    mediaWorkspaces.receiveLocalStream = async function (readable, options) {
      incoming = readable;
      try { return await originalReceive.call(this, readable, { ...options, onWorkspace: workspace => {
        ownershipAtExposure = workspace.activePromise === workspace.receivingPromise && Boolean(workspace.receivingPromise);
        options.onWorkspace(workspace);
      } }); }
      finally { intakeSettled.resolve(); }
    };
    mediaWorkspaces.fs = { ...originalFs, rm: async (...args) => {
      if (args[0] === directory) {
        cleanupAttempts++; cleanupClosed.push(writer.closed);
        if (deletionFails) throw Object.assign(new Error('Synthetic permission denial'), { code: 'EACCES' });
      }
      return originalFs.rm(...args);
    } };
    uploadRequest = http.request({ hostname: '127.0.0.1', port, path: '/api/media/local', method: 'POST', headers: {
      Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin',
      'Content-Length': 32, 'X-LVOVD-Collection': list.id, 'X-LVOVD-Filename': 'partial.mp4'
    } }, res => res.resume());
    uploadRequest.on('error', () => {});
    uploadRequest.write(Buffer.alloc(8)); // Keep the client open; DELETE must stop it.
    await firstWrite.promise;
    const exposed = await feed.waitFor(data => data.workspaces.some(item => item.source.name === 'partial.mp4'));
    receivedId = exposed.workspaces.find(item => item.source.name === 'partial.mp4').id;
    const workspace = mediaWorkspaces.get(receivedId);
    assert.equal(ownershipAtExposure, true, 'receiving resource ownership exists before the entry is exposed');
    assert.equal(writer.bytesWritten, 8);
    const deleting = request(`/api/workspace?workspace=${receivedId}`, { method: 'DELETE' });
    await destroyStarted.promise;
    const repeated = request(`/api/workspace?workspace=${receivedId}`, { method: 'DELETE' });
    assert.equal(mediaWorkspaces.get(receivedId), null);
    await feed.waitFor(data => data.revision > exposed.revision && !data.workspaces.some(item => item.id === receivedId));
    assert.equal((await request(`/api/workspace?workspace=${receivedId}`)).status, 404);
    assert.equal(writer.closed, false, 'the deterministic close gate still owns the actual file handle');
    assert.equal(incoming.destroyed, true, 'server cancellation closes intake without a browser abort');
    assert.equal(mediaWorkspaces.cleanupStatus(workspace).status, 'pending');
    mediaWorkspaces.localProcessing.reap();
    assert.equal(mediaWorkspaces.localProcessing.snapshot(list.id).sourceBytesReserved, otherBytes.length + 32);
    assert.equal(cleanupAttempts, 0);
    uploadRequest.write(Buffer.alloc(8)); // Client may buffer it; the destroyed server pipeline must not consume it.
    assert.equal(writer.bytesWritten, 8, 'further client bytes cannot reach the removed writer');
    closeGate.resolve();
    const [removed, duplicate] = await Promise.all([deleting, repeated]); await intakeSettled.promise;
    assert.equal(removed.status, 200); assert.equal(duplicate.status, 200);
    assert.equal(removed.data.cleanup.status, deletionFails ? 'failed' : 'complete');
    assert.equal(writer.closed, true); assert.equal(destroyCount, 1);
    assert.equal(writer.bytesWritten, 8); assert.equal(workspace.bytesReceived, 8);
    assert.ok(cleanupClosed.length > 0 && cleanupClosed.every(Boolean));
    assert.deepEqual(inspected, []); assert.equal(workspace.sourceAssetId, null); assert.equal(workspace.inspection, null);
    await feed.waitFor(data => data.revision > exposed.revision && data.uploads === 0);
    mediaWorkspaces.localProcessing.reap();
    assert.equal(mediaWorkspaces.localProcessing.snapshot(list.id).sourceBytesReserved, otherBytes.length + (deletionFails ? 32 : 0));
    if (deletionFails) {
      assert.equal(mediaWorkspaces.cleanupPending.get(receivedId).directory, directory);
      assert.ok((await fsp.stat(directory)).isDirectory());
      mediaWorkspaces.fs = originalFs;
      assert.equal((await request(`/api/workspace?workspace=${receivedId}`, { method: 'DELETE' })).data.cleanup.status, 'complete');
      mediaWorkspaces.localProcessing.reap();
    }
    assert.equal(mediaWorkspaces.localProcessing.snapshot(list.id).sourceBytesReserved, otherBytes.length);
    await assert.rejects(fsp.stat(directory), { code: 'ENOENT' });
    const output = mediaWorkspaces.publicWorkspace(other).conversion.output;
    assert.deepEqual((await request(output.downloadUrl)).bytes, otherBytes);
    mediaWorkspaces.createWriteStream = originalWriter; mediaWorkspaces.receiveLocalStream = originalReceive;
    const next = await upload(list.id, 'next.mp4'); assert.equal(next.status, 'ready');
  });
}

test('a client-disconnected HTTP upload closes its writer before releasing cleanup and reservations', { timeout: 10000 }, async t => {
  const list = await collection(), feed = await progress(list.id), written = deferred(), settled = deferred();
  const originalWriter = mediaWorkspaces.createWriteStream, originalFs = mediaWorkspaces.fs;
  const originalReceive = mediaWorkspaces.receiveLocalStream, originalInspect = mediaWorkspaces.inspectAsset;
  let writer, directory, client, inspections = 0;
  const closedAtCleanup = [];
  t.after(async () => {
    client?.destroy(); feed.stop();
    if (writer) await settled.promise;
    mediaWorkspaces.createWriteStream = originalWriter; mediaWorkspaces.fs = originalFs;
    mediaWorkspaces.receiveLocalStream = originalReceive; mediaWorkspaces.inspectAsset = originalInspect;
  });
  mediaWorkspaces.inspectAsset = async (...args) => { inspections++; return originalInspect(...args); };
  mediaWorkspaces.createWriteStream = (...args) => {
    writer = fs.createWriteStream(...args); directory = path.dirname(args[0]);
    for (const name of ['_write', '_writev']) {
      const write = writer[name]; writer[name] = function (...args) {
        const callback = args.pop(); write.call(this, ...args, error => { callback(error); written.resolve(); });
      };
    }
    return writer;
  };
  mediaWorkspaces.receiveLocalStream = async function (...args) {
    try { return await originalReceive.apply(this, args); } finally { settled.resolve(); }
  };
  mediaWorkspaces.fs = { ...originalFs, rm: async (...args) => {
    if (args[0] === directory) closedAtCleanup.push(writer.closed);
    return originalFs.rm(...args);
  } };
  client = http.request({ hostname: '127.0.0.1', port, path: '/api/media/local', method: 'POST', headers: {
    Origin: `http://127.0.0.1:${port}`, 'Content-Length': 32, 'X-LVOVD-Collection': list.id, 'X-LVOVD-Filename': 'disconnect.mp4'
  } }, res => res.resume());
  client.on('error', () => {}); client.write(Buffer.alloc(8)); await written.promise;
  const exposed = await feed.waitFor(data => data.workspaces.length === 1), id = exposed.workspaces[0].id;
  client.destroy(); await settled.promise;
  await feed.waitFor(data => data.revision > exposed.revision && data.uploads === 0);
  assert.equal(mediaWorkspaces.get(id), null); assert.equal(writer.closed, true); assert.equal(writer.bytesWritten, 8);
  assert.deepEqual(closedAtCleanup, [true]); assert.equal(inspections, 0);
  assert.equal(mediaWorkspaces.localProcessing.snapshot(list.id).sourceBytesReserved, 0);
  await assert.rejects(fsp.stat(directory), { code: 'ENOENT' });
});

test('collection API submits two exact reviewed originals and serves independent byte-identical downloads', async () => {
  const list = await collection(), aBytes = Buffer.from('first source'), bBytes = Buffer.from('second source');
  const a = await upload(list.id, 'a.mp4', aBytes), b = await upload(list.id, 'b.mp4', bBytes);
  const response = await post('/api/processing/queue', { collectionId: list.id, entries: [await reviewed(a, '_a'), await reviewed(b, '_b')] });
  assert.equal(response.status, 202, JSON.stringify(response.data));
  await until(() => a.conversion.status === 'ready' && b.conversion.status === 'ready');
  for (const [workspace, bytes, filename] of [[a, aBytes, 'a_a.mp4'], [b, bBytes, 'b_b.mp4']]) {
    const output = workspace.conversion.output;
    assert.equal(output.noOp, true); assert.equal(output.filename, filename); assert.equal(output.provenance.inputAssetId, workspace.sourceAssetId);
    const result = await request(`/api/conversion/file?workspace=${workspace.id}&asset=${output.assetId}`);
    assert.equal(result.status, 200); assert.deepEqual(result.bytes, bytes); assert.equal(workspace.assets.size, 1);
  }
  assert.equal((await request(`/api/conversion/file?workspace=${a.id}&asset=${b.sourceAssetId}`)).status, 404);
});

test('collection requests reject foreign membership, arbitrary fields, malformed identity, and hostile origins', async () => {
  const list = await collection(), other = await collection();
  const a = await upload(list.id, 'a.mp4'), b = await upload(other.id, 'b.mp4');
  const foreign = await post('/api/processing/queue', { collectionId: list.id, entries: [await reviewed(b)] });
  assert.ok([404, 409].includes(foreign.status)); assert.equal(b.conversion.output, null);
  for (const value of [{}, { collectionId: list.id, entries: [] }, { collectionId: list.id, entries: [await reviewed(a)], args: ['-i', '/tmp/file'] },
    { collectionId: list.id, entries: [{ ...await reviewed(a), sourceAssetId: '/tmp/file.mp4' }] }]) {
    const result = await post('/api/processing/queue', value); assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result.data));
  }
  assert.equal((await post('/api/processing/collection', {}, { Origin: 'https://hostile.example' })).status, 403);
  assert.equal((await request('/api/processing/queue/progress?collection=missing')).status, 404);
  assert.ok((await post('/api/processing/collection/attach', { collectionId: list.id, workspaceId: b.id })).status >= 400);
});

test('collection intake rejects missing size and capacity overflow before retaining new sources', async () => {
  const first = await collection(); await collection();
  assert.equal((await post('/api/processing/collection', {})).status, 409);
  const noSize = await request('/api/media/local', { method: 'POST', body: Buffer.from('unbounded'), headers: { 'Transfer-Encoding': 'chunked', 'X-LVOVD-Collection': first.id } });
  assert.ok(noSize.status >= 400); assert.equal(mediaWorkspaces.workspaces.size, 0);
  const badCollection = await request('/api/media/local', { method: 'POST', body: Buffer.from('x'), headers: { 'Content-Length': 1, 'X-LVOVD-Collection': '/tmp/foreign' } });
  assert.ok(badCollection.status >= 400); assert.equal(mediaWorkspaces.workspaces.size, 0);
});

test('one collection progress stream contains both files; replacing it and removing one file preserve the other', async t => {
  const list = await collection(), a = await upload(list.id, 'a.mp4'), b = await upload(list.id, 'b.mp4');
  const first = await progress(list.id); t.after(() => first.stop());
  assert.deepEqual(first.data.workspaces.map(item => item.id), [a.id, b.id]);
  const second = await progress(list.id); t.after(() => second.stop());
  await until(() => first.closed);
  assert.equal((await request(`/api/workspace?workspace=${a.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(mediaWorkspaces.get(a.id), null); assert.ok(mediaWorkspaces.get(b.id));
  assert.equal((await post('/api/processing/queue', { collectionId: list.id, entries: [await reviewed(b)] })).status, 202);
  await until(() => b.conversion.status === 'ready');
  assert.equal((await request(`/api/conversion/file?workspace=${b.id}&asset=${b.sourceAssetId}`)).status, 200);
  assert.equal((await request(`/api/workspace/media?workspace=${a.id}&asset=${a.sourceAssetId}`)).status, 404);
});
