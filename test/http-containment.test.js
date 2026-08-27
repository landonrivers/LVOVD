'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';
process.env.HOST = '127.0.0.1';
process.env.PORT = String(32000 + (process.pid % 10000));

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT);
const app = require('../app-server');
const { server } = require('../server');

test.before(async () => { await listen(); });
test.after(async () => { await closeServer(); });

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

function request(pathname, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'GET',
      headers: {
        Host: `127.0.0.1:${PORT}`,
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawRequest(text) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PORT, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(text));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

test('app-server cannot be started as an alternate unsecured listener', () => {
  const result = spawnSync(process.execPath, ['app-server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0' },
    encoding: 'utf8',
    timeout: 2000,
    windowsHide: true
  });

  assert.equal(result.status, 1, result.stderr || result.error?.message || 'unexpected direct app-server result');
  assert.match(result.stderr, /internal LVOVD module/i);
  assert.equal(result.error?.code, undefined);
});

test('the authoritative wrapper contains malformed request URL failures and keeps serving', async () => {
  const response = await rawRequest(
    `GET http://[bad HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`
  );
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.match(response, /Invalid request URL/);

  const next = await request('/not-found');
  assert.equal(next.status, 404);

  const crossSite = await request('/not-found', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
});

test('unexpected application-handler failures are contained by the authoritative wrapper', async (t) => {
  const originalHandleRequest = app.handleRequest;
  app.handleRequest = async () => {
    throw new Error('simulated unexpected application failure');
  };
  t.after(() => { app.handleRequest = originalHandleRequest; });

  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalConsoleError; });

  const failed = await request('/not-found');
  console.error = originalConsoleError;
  assert.equal(failed.status, 500);
  assert.match(failed.body, /could not complete that local request/i);

  app.handleRequest = originalHandleRequest;
  const next = await request('/not-found');
  assert.equal(next.status, 404);
});

test('prepared-file open failures are handled without terminating the server', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-file-race-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'prepared.mp4');
  await fsp.writeFile(filePath, 'prepared media', 'utf8');

  const jobId = 'file-race-job';
  const outputId = 'file-race-output';
  app.jobs.set(jobId, {
    id: jobId,
    status: 'ready',
    outputs: [{
      id: outputId,
      filePath,
      filename: 'prepared.mp4',
      size: 14,
      kind: 'media',
      label: 'Media'
    }]
  });
  t.after(() => app.jobs.delete(jobId));

  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = (candidate, ...args) => {
    if (candidate !== filePath) return originalCreateReadStream(candidate, ...args);
    const stream = new PassThrough();
    process.nextTick(() => {
      const error = new Error('simulated file disappearance');
      error.code = 'ENOENT';
      stream.emit('error', error);
    });
    return stream;
  };
  t.after(() => { fs.createReadStream = originalCreateReadStream; });

  const failed = await request(`/api/download/file?id=${encodeURIComponent(jobId)}&file=${encodeURIComponent(outputId)}`);
  assert.equal(failed.status, 404);
  assert.match(failed.body, /prepared file has expired/i);

  const next = await request('/not-found');
  assert.equal(next.status, 404);
});
