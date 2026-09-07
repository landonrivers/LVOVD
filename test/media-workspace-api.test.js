'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';
process.env.HOST = '127.0.0.1';
process.env.PORT = String(35000 + (process.pid % 10000));

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const {
  MAX_LOCAL_MEDIA_BYTES,
  WORKSPACE_CANCELLED_CODE,
  normalizeInspection,
  totalRetainedDuration
} = require('../media-workspace');
const { mediaWorkspaces, historyStore, jobs } = require('../app-server');
const { normalizeMediaInspection } = require('../media-inspection');
const { server } = require('../server');

const PORT = Number(process.env.PORT);
const directInspection = Object.freeze({
  durationSeconds: 12.5,
  format: 'QuickTime / MOV',
  formatNames: ['mov', 'mp4'],
  video: { streamIndex: 0, codec: 'h264', width: 640, height: 360, frameRate: 30 },
  audio: { streamIndex: 1, codec: 'aac' },
  trackCounts: { audio: 1, subtitle: 0 }
});
const proxyInspection = Object.freeze({
  durationSeconds: 8,
  format: 'Matroska / WebM',
  formatNames: ['matroska', 'webm'],
  video: { streamIndex: 3, codec: 'vp9', width: 320, height: 180, frameRate: 24 },
  audio: { streamIndex: 6, codec: 'opus' },
  trackCounts: { audio: 2, subtitle: 1 }
});
const editedInspection = Object.freeze({
  durationSeconds: 8.25,
  format: 'MP4',
  formatNames: ['mov', 'mp4'],
  video: { streamIndex: 0, codec: 'h264', width: 640, height: 360, frameRate: 30 },
  audio: { streamIndex: 1, codec: 'aac' },
  trackCounts: { audio: 1, subtitle: 0 }
});

let originalInspectAsset;
let originalCreateProxyAsset;
let originalInspectOutputAsset;
let originalCreateEditedAsset;
let originalDiscoverCapabilities;
let originalAssessConversion;

test.before(async () => {
  originalInspectAsset = mediaWorkspaces.inspectAsset;
  originalCreateProxyAsset = mediaWorkspaces.createProxyAsset;
  originalInspectOutputAsset = mediaWorkspaces.inspectOutputAsset;
  originalCreateEditedAsset = mediaWorkspaces.createEditedAsset;
  originalDiscoverCapabilities = mediaWorkspaces.discoverCapabilities;
  originalAssessConversion = mediaWorkspaces.assessConversion;
  await listen();
});

test.beforeEach(async () => {
  await mediaWorkspaces.clearAll();
  mediaWorkspaces.inspectAsset = async () => directInspection;
  mediaWorkspaces.createProxyAsset = originalCreateProxyAsset;
  mediaWorkspaces.discoverCapabilities = async () => ({
    available: true,
    encoders: new Set(['libx264', 'aac']),
    decoders: new Set(['h264', 'aac', 'flac']),
    muxers: new Set(['mp4'])
  });
  mediaWorkspaces.assessConversion = originalAssessConversion;
  mediaWorkspaces.inspectOutputAsset = async (workspace) => ({
    ...editedInspection,
    durationSeconds: totalRetainedDuration(workspace.render.requestedPlan)
  });
  mediaWorkspaces.createEditedAsset = async (_workspace, _source, _inspection, _plan, attempt) => {
    const bytes = Buffer.from('synthetic-edited-output');
    await fsp.writeFile(attempt.finalPath, bytes);
    return { filePath: attempt.finalPath, size: bytes.length };
  };
});

test.after(async () => {
  await mediaWorkspaces.clearAll();
  mediaWorkspaces.inspectAsset = originalInspectAsset;
  mediaWorkspaces.createProxyAsset = originalCreateProxyAsset;
  mediaWorkspaces.inspectOutputAsset = originalInspectOutputAsset;
  mediaWorkspaces.createEditedAsset = originalCreateEditedAsset;
  mediaWorkspaces.discoverCapabilities = originalDiscoverCapabilities;
  mediaWorkspaces.assessConversion = originalAssessConversion;
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

async function inspectUpload(body, name = 'local-media.bin', contentType = 'application/octet-stream') {
  const response = await request('/api/conversion/local', {
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

async function waitForRender(id, terminal = new Set(['ready', 'error', 'cancelled']), timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workspace = mediaWorkspaces.get(id, { touch: false });
    if (workspace && terminal.has(workspace.render.status)) return workspace;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Workspace ${id} render did not reach ${[...terminal].join('/')} in time.`);
}

async function startRender(workspaceId, editPlan) {
  const body = Buffer.from(JSON.stringify({ workspaceId, editPlan }));
  const response = await request('/api/workspace/render', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length
    },
    body
  });
  return {
    response,
    data: JSON.parse(response.body.toString('utf8'))
  };
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

test('shared edit-plan browser module is served before the editor runtime', async () => {
  const response = await request('/edit-plan.js');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/javascript/);
  assert.match(response.body.toString('utf8'), /MAX_KEEP_RANGES/);
});

test('URL workspace route enforces the minimal editor acquisition contract', async () => {
  const post = async (payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    const response = await request('/api/workspace/url', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length
      },
      body
    });
    return { response, data: JSON.parse(response.body.toString('utf8')) };
  };

  const audio = await post({
    url: 'https://media.example/audio',
    acquisition: { content: 'audio', profile: 'compatible', maxHeight: null, sourceFormat: { mode: 'automatic' } },
    display: { title: 'Audio', sourceName: 'Example' }
  });
  assert.equal(audio.response.status, 400);
  assert.match(audio.data.error, /Video \+ Audio or Video Only/i);

  const widened = await post({
    url: 'https://media.example/video',
    acquisition: {
      content: 'video', profile: 'maximum', maxHeight: null, sourceFormat: { mode: 'automatic' },
      range: { type: 'custom', start: 1, end: 2 }
    },
    display: { title: 'Video', sourceName: 'Example' }
  });
  assert.equal(widened.response.status, 400);
  assert.match(widened.data.error, /unsupported fields/i);
  assert.equal(mediaWorkspaces.workspaces.size, 0);
});

test('URL workspace starts promptly, reports local runtime failure in-workspace, and never creates History', async () => {
  const historyBefore = await historyStore.list();
  const downloadJobsBefore = jobs.size;
  const body = Buffer.from(JSON.stringify({
    url: 'https://media.example/video',
    acquisition: {
      content: 'video',
      profile: 'maximum',
      maxHeight: 720,
      sourceFormat: { mode: 'automatic' }
    },
    display: { title: 'Remote clip', sourceName: 'Example source' }
  }));
  const response = await request('/api/workspace/url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    body
  });
  assert.equal(response.status, 202);
  const data = JSON.parse(response.body.toString('utf8'));
  assert.match(data.workspaceId, /^[0-9a-f-]{36}$/i);
  assert.equal(data.workspace.source.origin, 'url');
  assert.equal(data.workspace.source.sourceName, 'Example source');
  assert.ok(['waiting', 'acquiring'].includes(data.workspace.status));
  assert.doesNotMatch(JSON.stringify(data), /media\.example\/video|workspace-|source\.\%\(ext\)/i);

  const failed = await waitForWorkspace(data.workspaceId, new Set(['error']));
  const snapshot = mediaWorkspaces.publicWorkspace(failed);
  assert.equal(snapshot.status, 'error');
  assert.ok(snapshot.failure);
  assert.deepEqual(snapshot.assets, []);
  assert.equal(jobs.size, downloadJobsBefore);
  assert.deepEqual(await historyStore.list(), historyBefore);

  const discarded = await request(`/api/workspace?workspace=${data.workspaceId}`, { method: 'DELETE' });
  assert.equal(discarded.status, 200);
  assert.equal(mediaWorkspaces.get(data.workspaceId, { touch: false }), null);
});

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

test('Convert API accepts video and audio inspection without playback, jobs, History, or exposed paths', async () => {
  const historyBefore = await historyStore.list();
  const jobsBefore = jobs.size;
  let proxyCalls = 0;
  mediaWorkspaces.createProxyAsset = async () => {
    proxyCalls += 1;
    throw new Error('Convert inspection must not make a playback proxy.');
  };
  mediaWorkspaces.inspectAsset = async (workspace) => {
    if (workspace.source.displayName.endsWith('.flac')) {
      return {
        mediaKind: 'audio',
        durationSeconds: 4,
        sourceSize: workspace.source.size,
        format: 'FLAC',
        formatNames: ['flac'],
        video: null,
        audio: {
          streamIndex: 0, codec: 'flac', sampleRate: 44100, channels: 2,
          channelLayout: 'stereo', bitRate: null
        },
        trackCounts: { video: 0, audio: 1, subtitle: 0 }
      };
    }
    return {
      mediaKind: 'video',
      durationSeconds: 6,
      sourceSize: workspace.source.size,
      format: 'MP4',
      container: { kind: 'mp4', evidence: 'brand' },
      formatNames: ['mov', 'mp4'],
      video: {
        streamIndex: 0, codec: 'h264', profile: 'High', width: 640, height: 360,
        frameRate: 30, pixelFormat: 'yuv420p'
      },
      audio: {
        streamIndex: 1, codec: 'aac', sampleRate: 48000, channels: 2,
        channelLayout: 'stereo', bitRate: 192000
      },
      trackCounts: { video: 1, audio: 1, subtitle: 0 }
    };
  };

  const video = await inspectUpload(
    Buffer.from('synthetic conversion video'),
    '..\\private\\camera.mp4',
    'user/claimed-video'
  );
  assert.equal(video.response.status, 202);
  assert.equal(video.data.workspace.purpose, 'convert');
  const videoWorkspace = await waitForWorkspace(video.data.workspaceId);
  const videoSnapshot = mediaWorkspaces.publicWorkspace(videoWorkspace);
  assert.equal(videoSnapshot.status, 'ready');
  assert.equal(videoSnapshot.compatibility.status, 'already-compatible');
  assert.equal(videoSnapshot.playback, null);
  assert.equal(videoSnapshot.render, null);
  assert.equal(videoSnapshot.editedOutput, null);
  assert.deepEqual(videoSnapshot.assets.map((asset) => asset.role), ['source']);
  assert.doesNotMatch(JSON.stringify(videoSnapshot), /private|source\.bin|workspace-|filePath|tempDir/i);

  const event = await readOneSseEvent(`/api/workspace/progress?workspace=${videoWorkspace.id}`);
  assert.equal(event.status, 200);
  assert.equal(event.data.purpose, 'convert');
  assert.equal(event.data.status, 'ready');

  const audio = await inspectUpload(Buffer.from('synthetic audio media'), 'track.flac', 'audio/flac');
  assert.equal(audio.response.status, 202);
  const audioWorkspace = await waitForWorkspace(audio.data.workspaceId);
  const audioSnapshot = mediaWorkspaces.publicWorkspace(audioWorkspace);
  assert.equal(audioSnapshot.inspection.mediaKind, 'audio');
  assert.equal(audioSnapshot.compatibility.status, 'not-applicable');
  assert.equal(audioSnapshot.playback, null);
  assert.equal(proxyCalls, 0);
  assert.equal(jobs.size, jobsBefore);
  assert.deepEqual(await historyStore.list(), historyBefore);

  for (const workspace of [videoWorkspace, audioWorkspace]) {
    const response = await request(`/api/workspace?workspace=${workspace.id}`, { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal(mediaWorkspaces.get(workspace.id, { touch: false }), null);
    const oldProgress = await request(`/api/workspace/progress?workspace=${workspace.id}`);
    assert.equal(oldProgress.status, 404);
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

test('render API validates one changed range, uses the source asset, and securely serves one edited output', async () => {
  const proxyBytes = Buffer.from('synthetic-proxy');
  const outputBytes = Buffer.from('synthetic-final-edited-mp4');
  let renderedSource = null;
  mediaWorkspaces.inspectAsset = async () => proxyInspection;
  mediaWorkspaces.createProxyAsset = async (workspace) => {
    const filePath = path.join(workspace.tempDir, 'playback-proxy.mp4');
    await fsp.writeFile(filePath, proxyBytes);
    return { filePath, size: proxyBytes.length };
  };
  mediaWorkspaces.createEditedAsset = async (workspace, sourceAsset, inspection, editPlan, attempt) => {
    renderedSource = { workspace, sourceAsset, inspection, editPlan };
    await fsp.writeFile(attempt.finalPath, outputBytes);
    return { filePath: attempt.finalPath, size: outputBytes.length };
  };

  const { data } = await upload(Buffer.from('authoritative-original-source'), '..\\private\\trip.mkv');
  const workspace = await waitForWorkspace(data.workspaceId);
  const before = mediaWorkspaces.publicWorkspace(workspace);
  const historyBefore = await historyStore.list();
  const downloadJobCountBefore = jobs.size;
  assert.equal(before.playback.role, 'playback-proxy');

  const missingWorkspace = await startRender('missing-workspace', {
    version: 1,
    keepRanges: [{ startSeconds: 1, endSeconds: 2 }]
  });
  assert.equal(missingWorkspace.response.status, 404);

  for (const editPlan of [
    { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 8 }] },
    { version: 1, keepRanges: [{ startSeconds: -1, endSeconds: 4 }] },
    { version: 1, keepRanges: [{ startSeconds: 4, endSeconds: 4 }] },
    { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 9 }] },
    { version: 1, keepRanges: [] },
    { version: 1, keepRanges: [{ startSeconds: 4, endSeconds: 5 }, { startSeconds: 1, endSeconds: 2 }] },
    { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 4 }, { startSeconds: 3, endSeconds: 5 }] },
    {
      version: 1,
      keepRanges: Array.from({ length: 51 }, (_unused, index) => ({
        startSeconds: index * 0.15,
        endSeconds: index * 0.15 + 0.1
      }))
    }
  ]) {
    const invalid = await startRender(workspace.id, editPlan);
    assert.equal(invalid.response.status, 422);
  }

  const plan = {
    version: 1,
    keepRanges: [
      { startSeconds: 0.5, endSeconds: 3 },
      { startSeconds: 4, endSeconds: 7.25 }
    ]
  };
  const started = await startRender(workspace.id, plan);
  assert.equal(started.response.status, 202);
  assert.equal(started.data.workspace.status, 'ready');
  assert.equal(started.data.workspace.render.status, 'rendering');
  await waitForRender(workspace.id, new Set(['ready']));

  assert.equal(renderedSource.sourceAsset.id, workspace.sourceAssetId);
  assert.equal(renderedSource.sourceAsset.role, 'source');
  assert.notEqual(renderedSource.sourceAsset.id, workspace.playbackAssetId);
  assert.deepEqual(renderedSource.editPlan, plan);
  assert.equal(renderedSource.inspection.video.streamIndex, 3);

  const snapshot = mediaWorkspaces.publicWorkspace(workspace);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.render.status, 'ready');
  assert.equal(snapshot.editedOutput.role, 'edited-output');
  assert.equal(snapshot.editedOutput.filename, 'trip - edited.mp4');
  assert.deepEqual(snapshot.editedOutput.editPlan, plan);
  assert.equal(snapshot.editedOutput.inspection.video.codec, 'h264');
  assert.deepEqual(snapshot.assets.map((asset) => asset.role).sort(), ['edited-output', 'playback-proxy', 'source']);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /source\.bin|playback-proxy\.mp4|edited-[0-9a-f-]+\.mp4|lvovd-media-|private[\\/]/i
  );

  const output = await request(snapshot.editedOutput.downloadUrl);
  assert.equal(output.status, 200);
  assert.equal(output.headers['cache-control'], 'no-store');
  assert.equal(output.headers['content-type'], 'video/mp4');
  assert.match(output.headers['content-disposition'], /^attachment;/);
  assert.match(output.headers['content-disposition'], /trip - edited\.mp4/);
  assert.deepEqual(output.body, outputBytes);

  const sourceAsOutput = await request(
    `/api/workspace/output?workspace=${workspace.id}&asset=${workspace.sourceAssetId}`
  );
  assert.equal(sourceAsOutput.status, 404);
  const arbitrary = await request(`/api/workspace/output?workspace=${workspace.id}&asset=..%2Fsource.bin`);
  assert.equal(arbitrary.status, 404);

  const second = await upload(Buffer.from('second source'), 'second.mp4');
  const secondWorkspace = await waitForWorkspace(second.data.workspaceId);
  const cross = await request(
    `/api/workspace/output?workspace=${secondWorkspace.id}&asset=${snapshot.editedOutput.assetId}`
  );
  assert.equal(cross.status, 404);
  assert.equal(jobs.size, downloadJobCountBefore);
  assert.deepEqual(await historyStore.list(), historyBefore);
});

test('render cancellation preserves the ready editor, cleans partial output, and permits a fresh retry', async () => {
  const { data } = await upload(Buffer.from('ready source'), 'retry.mp4');
  const workspace = await waitForWorkspace(data.workspaceId);
  const sourceId = workspace.sourceAssetId;
  const playbackId = workspace.playbackAssetId;
  let firstAttempt;
  let renderKillCount = 0;
  mediaWorkspaces.createEditedAsset = async (ownedWorkspace, _source, _inspection, _plan, attempt) => {
    firstAttempt = attempt;
    ownedWorkspace.child = { kill() { renderKillCount += 1; } };
    await fsp.writeFile(attempt.partialPath, 'partial output');
    return new Promise((_resolve, reject) => {
      const cancel = () => {
        const error = new Error('cancelled');
        error.code = WORKSPACE_CANCELLED_CODE;
        reject(error);
      };
      if (ownedWorkspace.abortController.signal.aborted) cancel();
      else ownedWorkspace.abortController.signal.addEventListener('abort', cancel, { once: true });
    });
  };

  const plan = {
    version: 1,
    keepRanges: [{ startSeconds: 1, endSeconds: 4 }, { startSeconds: 6, endSeconds: 10 }]
  };
  assert.equal((await startRender(workspace.id, plan)).response.status, 202);
  await waitForRender(workspace.id, new Set(['rendering']));
  const cancelled = await request(`/api/workspace/render?workspace=${workspace.id}`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  const cancelledSnapshot = JSON.parse(cancelled.body.toString('utf8')).workspace;
  assert.equal(cancelledSnapshot.status, 'ready');
  assert.equal(cancelledSnapshot.render.status, 'cancelled');
  assert.equal(workspace.sourceAssetId, sourceId);
  assert.equal(workspace.playbackAssetId, playbackId);
  assert.equal(workspace.assets.size, 1);
  assert.equal(renderKillCount, 1);
  await assert.rejects(fsp.access(firstAttempt.partialPath));
  await assert.rejects(fsp.access(firstAttempt.finalPath));

  let retrySignal;
  mediaWorkspaces.createEditedAsset = async (ownedWorkspace, _source, _inspection, _plan, attempt) => {
    retrySignal = ownedWorkspace.abortController.signal;
    await fsp.writeFile(attempt.finalPath, 'successful retry');
    return { filePath: attempt.finalPath, size: 16 };
  };
  assert.equal((await startRender(workspace.id, plan)).response.status, 202);
  await waitForRender(workspace.id, new Set(['ready']));
  assert.equal(retrySignal.aborted, false);
  assert.equal(workspace.status, 'ready');
  assert.ok(mediaWorkspaces.publicWorkspace(workspace).editedOutput);
});

test('successful rerender atomically replaces output while failed or cancelled attempts preserve the last success', async () => {
  const { data } = await upload(Buffer.from('ready rerender source'), 'rerender.mp4');
  const workspace = await waitForWorkspace(data.workspaceId);
  const firstPlan = {
    version: 1,
    keepRanges: [{ startSeconds: 1, endSeconds: 4 }, { startSeconds: 6, endSeconds: 10 }]
  };
  await startRender(workspace.id, firstPlan);
  await waitForRender(workspace.id, new Set(['ready']));
  const firstAsset = workspace.assets.get(workspace.render.outputAssetId);
  assert.ok(firstAsset);

  mediaWorkspaces.createEditedAsset = async (_workspace, _source, _inspection, _plan, attempt) => {
    const bytes = Buffer.from('replacement output');
    await fsp.writeFile(attempt.finalPath, bytes);
    return { filePath: attempt.finalPath, size: bytes.length };
  };
  const secondPlan = {
    version: 1,
    keepRanges: [{ startSeconds: 2, endSeconds: 4 }, { startSeconds: 6, endSeconds: 9 }]
  };
  await startRender(workspace.id, secondPlan);
  await waitForRender(workspace.id, new Set(['ready']));
  const replacementId = workspace.render.outputAssetId;
  const replacementAsset = workspace.assets.get(replacementId);
  assert.notEqual(replacementId, firstAsset.id);
  await assert.rejects(fsp.access(firstAsset.filePath));
  assert.deepEqual(replacementAsset.editPlan, secondPlan);

  mediaWorkspaces.createEditedAsset = async () => {
    const error = new Error('synthetic FFmpeg failure with C:\\private\\input.mp4');
    error.localFailure = { operation: 'ffmpeg_processing', tool: 'ffmpeg' };
    throw error;
  };
  await startRender(workspace.id, { version: 1, keepRanges: [{ startSeconds: 3, endSeconds: 8 }] });
  await waitForRender(workspace.id, new Set(['error']));
  assert.equal(workspace.render.outputAssetId, replacementId);
  assert.equal(workspace.assets.has(replacementId), true);
  assert.doesNotMatch(JSON.stringify(mediaWorkspaces.publicWorkspace(workspace).render.failure), /C:\\private|input\.mp4/i);

  let cancelledAttempt;
  mediaWorkspaces.createEditedAsset = async (ownedWorkspace, _source, _inspection, _plan, attempt) => {
    cancelledAttempt = attempt;
    await fsp.writeFile(attempt.partialPath, 'new partial');
    return new Promise((_resolve, reject) => {
      const cancel = () => {
        const error = new Error('cancelled');
        error.code = WORKSPACE_CANCELLED_CODE;
        reject(error);
      };
      if (ownedWorkspace.abortController.signal.aborted) cancel();
      else ownedWorkspace.abortController.signal.addEventListener('abort', cancel, { once: true });
    });
  };
  await startRender(workspace.id, { version: 1, keepRanges: [{ startSeconds: 4, endSeconds: 7 }] });
  await waitForRender(workspace.id, new Set(['rendering']));
  assert.equal((await request(`/api/workspace/render?workspace=${workspace.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(workspace.render.outputAssetId, replacementId);
  assert.equal(workspace.assets.has(replacementId), true);
  await assert.rejects(fsp.access(cancelledAttempt.partialPath));

  const preserved = await request(mediaWorkspaces.publicWorkspace(workspace).editedOutput.downloadUrl);
  assert.equal(preserved.status, 200);
  assert.deepEqual(preserved.body, Buffer.from('replacement output'));
});

test('discard during rendering cancels the attempt and invalidates source, playback, and prior output URLs', async () => {
  const { data } = await upload(Buffer.from('discard render source'), 'discard.mp4');
  const workspace = await waitForWorkspace(data.workspaceId);
  const plan = {
    version: 1,
    keepRanges: [{ startSeconds: 1, endSeconds: 4 }, { startSeconds: 6, endSeconds: 10 }]
  };
  await startRender(workspace.id, plan);
  await waitForRender(workspace.id, new Set(['ready']));
  const snapshot = mediaWorkspaces.publicWorkspace(workspace);

  let partialPath;
  mediaWorkspaces.createEditedAsset = async (ownedWorkspace, _source, _inspection, _plan, attempt) => {
    partialPath = attempt.partialPath;
    await fsp.writeFile(partialPath, 'partial');
    return new Promise((_resolve, reject) => {
      const cancel = () => {
        const error = new Error('cancelled');
        error.code = WORKSPACE_CANCELLED_CODE;
        reject(error);
      };
      if (ownedWorkspace.abortController.signal.aborted) cancel();
      else ownedWorkspace.abortController.signal.addEventListener('abort', cancel, { once: true });
    });
  };
  await startRender(workspace.id, { version: 1, keepRanges: [{ startSeconds: 2, endSeconds: 9 }] });
  await waitForRender(workspace.id, new Set(['rendering']));
  const discarded = await request(`/api/workspace?workspace=${workspace.id}`, { method: 'DELETE' });
  assert.equal(discarded.status, 200);
  assert.equal(JSON.parse(discarded.body.toString('utf8')).action, 'cancelled-and-discarded');
  assert.equal(mediaWorkspaces.get(workspace.id, { touch: false }), null);
  await assert.rejects(fsp.access(partialPath));
  assert.equal((await request(snapshot.playback.url)).status, 404);
  assert.equal((await request(snapshot.editedOutput.downloadUrl)).status, 404);
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

test('DELETE acknowledges logical discard with failed cleanup, closes SSE, invalidates all URLs, and safely retries retained ownership', async t => {
  const { data } = await upload(Buffer.from('synthetic cleanup source'));
  const workspace = await waitForWorkspace(data.workspaceId);
  await startRender(workspace.id, { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 2 }] });
  await waitForRender(workspace.id);
  const snapshot = mediaWorkspaces.publicWorkspace(workspace);
  const directory = workspace.tempDir;
  const eventsUrl = `/api/workspace/progress?workspace=${workspace.id}`;
  const connection = openSseConnection(eventsUrl);
  await connection.firstEvent;
  const originalFs = mediaWorkspaces.fs;
  t.after(() => { mediaWorkspaces.fs = originalFs; });
  let calls = 0;
  mediaWorkspaces.fs = { ...fsp, rm: async () => {
    calls++;
    throw Object.assign(new Error('Synthetic permission denial'), { code: 'EACCES' });
  } };
  const response = await request(`/api/workspace?workspace=${workspace.id}`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'discarded');
  assert.equal(result.cleanup.status, 'failed');
  assert.match(result.cleanup.message, /could not be removed/);
  assert.doesNotMatch(response.body.toString(), /Synthetic|EACCES|workspace-/);
  await connection.closed;
  assert.equal(workspace.listeners.size, 0);
  assert.equal(calls, 1);
  assert.equal(mediaWorkspaces.cleanupPending.get(workspace.id).directory, directory);
  for (const url of [eventsUrl, snapshot.playback.url, snapshot.editedOutput.downloadUrl]) {
    assert.equal((await request(url)).status, 404);
  }
  assert.ok((await fsp.stat(directory)).isDirectory());
  mediaWorkspaces.fs = originalFs;
  const next = await upload(Buffer.from('new independent workspace'));
  assert.equal((await waitForWorkspace(next.data.workspaceId)).status, 'ready');
  const retry = await request(`/api/workspace?workspace=${workspace.id}`, { method: 'DELETE' });
  assert.equal(retry.status, 200);
  assert.equal(JSON.parse(retry.body).cleanup.status, 'complete');
  await assert.rejects(fsp.stat(directory), { code: 'ENOENT' });
  assert.equal((await request(snapshot.playback.url)).status, 404);
  assert.equal(mediaWorkspaces.cleanupPending.has(workspace.id), false);
});

test('Discard closes active playback and output readers before deletion and truthfully returns pending cleanup', async t => {
  const { data } = await upload(Buffer.from('synthetic streamed cleanup source'));
  const workspace = await waitForWorkspace(data.workspaceId);
  await startRender(workspace.id, { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 2 }] });
  await waitForRender(workspace.id);
  const snapshot = mediaWorkspaces.publicWorkspace(workspace);
  for (const assetId of [workspace.sourceAssetId, workspace.render.outputAssetId]) {
    // Sparse generated bytes provide deterministic backpressure without private
    // media or large in-memory fixtures. This test is about reader ownership.
    await fsp.truncate(workspace.assets.get(assetId).filePath, 32 * 1024 * 1024);
  }
  async function openPaused(url) {
    return new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: PORT, path: url }, res => {
        res.on('error', () => {});
        res.once('data', () => { res.pause(); resolve({ req, res }); });
      });
      req.on('error', reject);
    });
  }
  const playback = await openPaused(snapshot.playback.url);
  const output = await openPaused(snapshot.editedOutput.downloadUrl);
  t.after(() => { playback.req.destroy(); output.req.destroy(); });
  assert.equal(workspace.readStreams.size, 2);
  const originalFs = mediaWorkspaces.fs;
  const originalDelays = mediaWorkspaces.cleanupRetryDelaysMs;
  t.after(() => { mediaWorkspaces.fs = originalFs; mediaWorkspaces.cleanupRetryDelaysMs = originalDelays; });
  mediaWorkspaces.cleanupRetryDelaysMs = [100, 100];
  let attempts = 0;
  mediaWorkspaces.fs = { ...fsp, rm: async (...args) => {
    assert.equal(workspace.readStreams.size, 0, 'both file handles must be closed before Windows deletion');
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('Synthetic busy'), { code: 'EBUSY' });
    return fsp.rm(...args);
  } };
  const discarded = await request(`/api/workspace?workspace=${workspace.id}`, { method: 'DELETE' });
  assert.equal(discarded.status, 200);
  assert.equal(JSON.parse(discarded.body).cleanup.status, 'pending');
  assert.equal((await request(snapshot.playback.url)).status, 404);
  assert.equal((await request(snapshot.editedOutput.downloadUrl)).status, 404);
  const deadline = Date.now() + 5000;
  while (mediaWorkspaces.cleanupPending.has(workspace.id)) {
    assert.ok(Date.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(attempts, 2);
  assert.equal(mediaWorkspaces.cleanupStatus(workspace).status, 'complete');
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

test('neutral conversion API enforces reviewed identity and secure no-op GET/HEAD without Download or History work', async () => {
  mediaWorkspaces.inspectAsset = async () => normalizeMediaInspection({
    format: { format_name: 'mov,mp4,m4a', start_time: '0', duration: '5', tags: { major_brand: 'isom' } }, chapters: [],
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 96, height: 64, start_time: '0', duration: '5', avg_frame_rate: '20/1' }]
  });
  mediaWorkspaces.discoverCapabilities = async () => { throw new Error('A no-op must not discover capabilities'); };
  const bytes = Buffer.from('owned synthetic no-op bytes');
  const uploaded = await request('/api/media/local', { method: 'POST', body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'X-LVOVD-Filename': encodeURIComponent('../unsafe<>.mp4') } });
  assert.equal(uploaded.status, 202);
  const workspace = await waitForWorkspace(JSON.parse(uploaded.body).workspaceId);
  assert.equal(workspace.playbackAssetId, null);
  const body = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, targetId: 'broad-compatibility-mp4' };
  const post = (route, value) => request(route, { method: 'POST', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } });
  const url = `/api/conversion/file?workspace=${workspace.id}&asset=${workspace.sourceAssetId}`;
  assert.equal((await request(url)).status, 404);
  const jobIds = [...jobs.keys()];
  const historyBeforeConversion = await historyStore.list();
  for (const field of ['path', 'args', 'filters', 'codec', 'map']) {
    assert.equal((await post('/api/conversion/plan', { ...body, [field]: 'injected' })).status, 400);
  }
  assert.equal((await post('/api/conversion/plan', { ...body, targetId: 'mp3 -y' })).status, 400);
  assert.equal((await post('/api/workspace/editor', { workspaceId: workspace.id, sourceAssetId: 'wrong' })).status, 409);
  const planned = await post('/api/conversion/plan', body);
  assert.equal(planned.status, 200);
  const plan = JSON.parse(planned.body).plan;
  assert.equal(plan.status, 'no-op');
  assert.equal((await post('/api/conversion/start', { ...body, planKey: 'stale' })).status, 409);
  assert.equal((await post('/api/conversion/start', { ...body, planKey: plan.key })).status, 202);
  const download = await request(url);
  assert.equal(download.status, 200); assert.deepEqual(download.body, bytes);
  assert.equal(download.headers['content-type'], 'video/mp4');
  assert.equal(download.headers['cache-control'], 'no-store'); assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(download.headers['content-disposition'], /^attachment;/); assert.doesNotMatch(download.headers['content-disposition'], /unsafe<>|\.\.\//);
  const head = await request(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), bytes.length);
  assert.equal((await request(url.replace(workspace.id, 'different-workspace'))).status, 404);
  assert.deepEqual([...jobs.keys()], jobIds);
  assert.deepEqual(await historyStore.list(), historyBeforeConversion);
  assert.equal(workspace.assets.size, 1);
  await request(`/api/workspace?workspace=${workspace.id}`, { method: 'DELETE' });
  assert.equal((await request(url)).status, 404);
});
