'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';
process.env.HOST = '127.0.0.1';
process.env.PORT = String(45000 + process.pid % 10000);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
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
function progress(id) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: `/api/processing/queue/progress?collection=${id}`,
      headers: { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, res => {
      assert.equal(res.statusCode, 200); let text = '', completed = false;
      const connection = { req, res, closed: false, stop() { req.destroy(); } };
      res.on('close', () => { connection.closed = true; });
      res.on('data', chunk => {
        text += String(chunk);
        if (!completed && text.includes('\n\n')) {
          completed = true; connection.data = JSON.parse(text.split('\n\n')[0].replace(/^data: /, '')); resolve(connection);
        }
      });
    }); req.once('error', reject);
  });
}

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
