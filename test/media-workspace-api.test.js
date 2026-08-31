'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';
process.env.HOST = '127.0.0.1';
process.env.PORT = String(35000 + (process.pid % 10000));

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { MAX_LOCAL_MEDIA_BYTES, WORKSPACE_CANCELLED_CODE, normalizeInspection } = require('../media-workspace');
const { mediaWorkspaces } = require('../app-server');
const { server } = require('../server');

const PORT = Number(process.env.PORT);
const directInspection = Object.freeze({
  durationSeconds: 12.5,
  format: 'QuickTime / MOV',
  formatNames: ['mov', 'mp4'],
  video: { codec: 'h264', width: 640, height: 360, frameRate: 30 },
  audio: { codec: 'aac' }
});
const proxyInspection = Object.freeze({
  durationSeconds: 8,
  format: 'Matroska / WebM',
  formatNames: ['matroska', 'webm'],
  video: { codec: 'vp9', width: 320, height: 180, frameRate: 24 },
  audio: { codec: 'opus' }
});

let originalInspectAsset;
let originalCreateProxyAsset;

test.before(async () => {
  originalInspectAsset = mediaWorkspaces.inspectAsset;
  originalCreateProxyAsset = mediaWorkspaces.createProxyAsset;
  await listen();
});

test.beforeEach(async () => {
  await mediaWorkspaces.clearAll();
  mediaWorkspaces.inspectAsset = async () => directInspection;
  mediaWorkspaces.createProxyAsset = originalCreateProxyAsset;
});

test.after(async () => {
  await mediaWorkspaces.clearAll();
  mediaWorkspaces.inspectAsset = originalInspectAsset;
  mediaWorkspaces.createProxyAsset = originalCreateProxyAsset;
  await closeServer();
});

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer() {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function request(pathname, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      headers: {
        Host: `127.0.0.1:${PORT}`,
        Origin: `http://127.0.0.1:${PORT}`,
        'Sec-Fetch-Site': 'same-origin',
        Connection: 'close',
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function upload(body, name = 'local.mp4', contentType = 'video/mp4') {
  const response = await request('/api/workspace/local', {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'X-LVOVD-Filename': encodeURIComponent(name)
    },
    body
  });
  return { response, data: JSON.parse(response.body.toString('utf8')) };
}

async function waitForWorkspace(id, terminal = new Set(['ready', 'error']), timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workspace = mediaWorkspaces.get(id, { touch: false });
    if (workspace && terminal.has(workspace.status)) return workspace;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Workspace ${id} did not reach ${[...terminal].join('/')} in time.`);
}

function readOneSseEvent(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'GET',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        Origin: `http://127.0.0.1:${PORT}`,
        'Sec-Fetch-Site': 'same-origin'
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        const match = text.match(/data: ([^\n]+)\n\n/);
        if (!match) return;
        const result = { status: res.statusCode, headers: res.headers, data: JSON.parse(match[1]) };
        res.destroy();
        resolve(result);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function openSseConnection(pathname) {
  let req;
  let response;
  let firstSettled = false;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const firstEvent = new Promise((resolve, reject) => {
    req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'GET',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        Origin: `http://127.0.0.1:${PORT}`,
        'Sec-Fetch-Site': 'same-origin'
      }
    }, (res) => {
      response = res;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        const match = text.match(/data: ([^\n]+)\n\n/);
        if (!match || firstSettled) return;
        firstSettled = true;
        resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(match[1]) });
      });
      const finish = () => resolveClosed();
      res.once('end', finish);
      res.once('close', finish);
    });
    req.once('error', (error) => {
      resolveClosed();
      if (!firstSettled) reject(error);
    });
    req.end();
  });
  return {
    firstEvent,
    closed,
    close() {
      response?.destroy();
      req?.destroy();
    }
  };
}

function within(promise, label, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

test('raw local intake returns an opaque workspace and direct media supports GET, HEAD, and byte ranges', async () => {
  const bytes = Buffer.from('synthetic-direct-video-bytes');
  const { response, data } = await upload(bytes, '..\\private\\camera.mp4', 'user/claimed-type');
  assert.equal(response.status, 202);
  assert.match(data.workspaceId, /^[0-9a-f-]{36}$/i);
  assert.equal(data.workspace.source.name, 'camera.mp4');
  assert.doesNotMatch(JSON.stringify(data), /user\/claimed-type/i);
  assert.doesNotMatch(JSON.stringify(data), /source\.bin|workspace-|private[\\/]/i);

  const workspace = await waitForWorkspace(data.workspaceId);
  const publicWorkspace = mediaWorkspaces.publicWorkspace(workspace);
  assert.equal(publicWorkspace.status, 'ready');
  assert.equal(publicWorkspace.playback.proxy, false);
  assert.equal(publicWorkspace.source.size, bytes.length);
  assert.equal(publicWorkspace.assets.length, 1);

  const event = await readOneSseEvent(`/api/workspace/progress?workspace=${workspace.id}`);
  assert.equal(event.status, 200);
  assert.match(event.headers['content-type'], /^text\/event-stream/);
  assert.equal(event.data.id, workspace.id);
  assert.equal(event.data.status, 'ready');

  const mediaPath = publicWorkspace.playback.url;
  const full = await request(mediaPath);
  assert.equal(full.status, 200);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['cache-control'], 'no-store');
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.deepEqual(full.body, bytes);

  const head = await request(mediaPath, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), bytes.length);
  assert.equal(head.body.length, 0);

  const partial = await request(mediaPath, { headers: { Range: 'bytes=2-7' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers['content-range'], `bytes 2-7/${bytes.length}`);
  assert.deepEqual(partial.body, bytes.subarray(2, 8));

  const suffix = await request(mediaPath, { headers: { Range: 'bytes=-5' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(suffix.body, bytes.subarray(-5));

  for (const range of ['bytes=999-', 'bytes=5-2', 'bytes=0-1,4-5', 'items=0-1']) {
    const invalid = await request(mediaPath, { headers: { Range: range } });
    assert.equal(invalid.status, 416, range);
    assert.equal(invalid.headers['content-range'], `bytes */${bytes.length}`);
    assert.equal(invalid.body.length, 0);
  }
});

test('proxy preparation retains separate source and playback assets without exposing paths', async () => {
  const proxyBytes = Buffer.from('synthetic-browser-playback-proxy');
  mediaWorkspaces.inspectAsset = async () => proxyInspection;
  mediaWorkspaces.createProxyAsset = async (workspace) => {
    const filePath = path.join(workspace.tempDir, 'playback-proxy.mp4');
    await fsp.writeFile(filePath, proxyBytes);
    return { filePath, size: proxyBytes.length };
  };

  const { data } = await upload(Buffer.from('synthetic-incompatible-source'), 'clip.mkv', 'video/mp4');
  const workspace = await waitForWorkspace(data.workspaceId);
  const snapshot = mediaWorkspaces.publicWorkspace(workspace);
  assert.equal(snapshot.playback.proxy, true);
  assert.equal(snapshot.playback.role, 'playback-proxy');
  assert.deepEqual(snapshot.assets.map((asset) => asset.role).sort(), ['playback-proxy', 'source']);
  assert.doesNotMatch(JSON.stringify(snapshot), /source\.bin|playback-proxy\.mp4|workspace-/i);

  const media = await request(snapshot.playback.url);
  assert.equal(media.status, 200);
  assert.deepEqual(media.body, proxyBytes);
});

test('unknown and cross-workspace assets cannot be served', async () => {
  const first = await upload(Buffer.from('first synthetic video'), 'first.mp4');
  const firstWorkspace = await waitForWorkspace(first.data.workspaceId);
  const firstSnapshot = mediaWorkspaces.publicWorkspace(firstWorkspace);
  const second = await upload(Buffer.from('second synthetic video'), 'second.mp4');
  const secondWorkspace = await waitForWorkspace(second.data.workspaceId);
  const secondSnapshot = mediaWorkspaces.publicWorkspace(secondWorkspace);

  const cross = await request(`/api/workspace/media?workspace=${firstWorkspace.id}&asset=${secondSnapshot.playback.assetId}`);
  assert.equal(cross.status, 404);
  const unknownWorkspace = await request(`/api/workspace/media?workspace=missing&asset=${firstSnapshot.playback.assetId}`);
  assert.equal(unknownWorkspace.status, 404);
  const unknownAsset = await request(`/api/workspace/media?workspace=${firstWorkspace.id}&asset=missing`);
  assert.equal(unknownAsset.status, 404);
  const unknownProgress = await request('/api/workspace/progress?workspace=missing');
  assert.equal(unknownProgress.status, 404);
});

test('non-video inspection remains a normalized local error and removes staged assets', async () => {
  mediaWorkspaces.inspectAsset = async () => normalizeInspection({
    format: { duration: '2', format_name: 'wav' },
    streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le' }]
  });
  const { data } = await upload(Buffer.from('synthetic-audio-only'), 'audio.wav', 'audio/wav');
  const workspace = await waitForWorkspace(data.workspaceId);
  const snapshot = mediaWorkspaces.publicWorkspace(workspace);
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.failure.category, 'local_media_invalid');
  assert.match(snapshot.failure.explanation, /video stream/i);
  assert.deepEqual(snapshot.assets, []);
  assert.equal(snapshot.playback, null);
  assert.doesNotMatch(JSON.stringify(snapshot.failure), /audio\.wav|source\.bin|workspace-/i);

  const discarded = await request(`/api/workspace?workspace=${workspace.id}`, { method: 'DELETE' });
  assert.equal(discarded.status, 200);
  assert.equal(JSON.parse(discarded.body.toString('utf8')).action, 'discarded');
  assert.equal(mediaWorkspaces.get(workspace.id, { touch: false }), null);
});

test('DELETE succeeds with an open workspace SSE lease and completes authoritative cleanup', async (t) => {
  const bytes = Buffer.from('synthetic-ready-video-with-live-lease');
  const { data } = await upload(bytes, 'leased.mp4');
  const workspace = await waitForWorkspace(data.workspaceId);
  const snapshot = mediaWorkspaces.publicWorkspace(workspace);
  const lease = openSseConnection(`/api/workspace/progress?workspace=${workspace.id}`);
  t.after(() => lease.close());

  const event = await within(lease.firstEvent, 'initial workspace lease event');
  assert.equal(event.status, 200);
  assert.equal(event.data.status, 'ready');
  assert.equal(workspace.listeners.size, 1);

  const response = await request(`/api/workspace?workspace=${workspace.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body.toString('utf8')).action, 'discarded');
  await within(lease.closed, 'workspace lease closure');
  assert.equal(workspace.listeners.size, 0);
  assert.equal(mediaWorkspaces.get(workspace.id, { touch: false }), null);

  const oldMedia = await request(snapshot.playback.url);
  assert.equal(oldMedia.status, 404);
  const oldProgress = await request(`/api/workspace/progress?workspace=${workspace.id}`);
  assert.equal(oldProgress.status, 404);
});

test('declared over-limit intake is rejected before workspace creation', async () => {
  const response = await request('/api/workspace/local', {
    method: 'POST',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(MAX_LOCAL_MEDIA_BYTES + 1),
      'X-LVOVD-Filename': 'huge.mp4'
    }
  });
  assert.equal(response.status, 413);
  const data = JSON.parse(response.body.toString('utf8'));
  assert.equal(data.details.category, 'local_media_too_large');
  assert.equal(mediaWorkspaces.workspaces.size, 0);
});

test('DELETE cancels active preparation, discards assets, and invalidates media URLs', async () => {
  mediaWorkspaces.inspectAsset = (workspace) => new Promise((_resolve, reject) => {
    const cancel = () => {
      const error = new Error('cancelled');
      error.code = WORKSPACE_CANCELLED_CODE;
      reject(error);
    };
    workspace.abortController.signal.addEventListener('abort', cancel, { once: true });
  });

  const { data } = await upload(Buffer.from('synthetic-slow-video'), 'slow.mp4');
  const response = await request(`/api/workspace?workspace=${data.workspaceId}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body.toString('utf8')).action, 'cancelled-and-discarded');
  assert.equal(mediaWorkspaces.get(data.workspaceId, { touch: false }), null);

  const media = await request(`/api/workspace/media?workspace=${data.workspaceId}&asset=anything`);
  assert.equal(media.status, 404);
  const secondDelete = await request(`/api/workspace?workspace=${data.workspaceId}`, { method: 'DELETE' });
  assert.equal(secondDelete.status, 404);
});
