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
const { mediaWorkspaces, historyStore, jobs } = require('../app-server');
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

test.before(async () => {
  originalInspectAsset = mediaWorkspaces.inspectAsset;
  originalCreateProxyAsset = mediaWorkspaces.createProxyAsset;
  originalInspectOutputAsset = mediaWorkspaces.inspectOutputAsset;
  originalCreateEditedAsset = mediaWorkspaces.createEditedAsset;
  await listen();
});

test.beforeEach(async () => {
  await mediaWorkspaces.clearAll();
  mediaWorkspaces.inspectAsset = async () => directInspection;
  mediaWorkspaces.createProxyAsset = originalCreateProxyAsset;
  mediaWorkspaces.inspectOutputAsset = async () => editedInspection;
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
    { version: 1, keepRanges: [] }
  ]) {
    const invalid = await startRender(workspace.id, editPlan);
    assert.equal(invalid.response.status, 422);
  }

  const plan = { version: 1, keepRanges: [{ startSeconds: 0.5, endSeconds: 7.25 }] };
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

  const plan = { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 10 }] };
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
  const firstPlan = { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 10 }] };
  await startRender(workspace.id, firstPlan);
  await waitForRender(workspace.id, new Set(['ready']));
  const firstAsset = workspace.assets.get(workspace.render.outputAssetId);
  assert.ok(firstAsset);

  mediaWorkspaces.createEditedAsset = async (_workspace, _source, _inspection, _plan, attempt) => {
    const bytes = Buffer.from('replacement output');
    await fsp.writeFile(attempt.finalPath, bytes);
    return { filePath: attempt.finalPath, size: bytes.length };
  };
  const secondPlan = { version: 1, keepRanges: [{ startSeconds: 2, endSeconds: 9 }] };
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
  const plan = { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 10 }] };
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
