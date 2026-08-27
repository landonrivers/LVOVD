'use strict';

const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const DATA_DIR = path.join(os.tmpdir(), `lvovd-history-api-${process.pid}-${Date.now()}`);
process.env.LVOVD_DATA_DIR = DATA_DIR;
process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';
process.env.HOST = '127.0.0.1';
process.env.PORT = String(35000 + (process.pid % 10000));

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { HISTORY_SCHEMA_VERSION, historyStore } = require('../download-history');
const { server } = require('../server');

const PORT = Number(process.env.PORT);

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

function request(pathname, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      headers: { Host: `127.0.0.1:${PORT}` }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, body, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function entry(id, finishedAt) {
  return {
    id,
    createdAt: finishedAt,
    finishedAt,
    status: 'ready',
    title: `History ${id}`,
    source: { name: 'Example', url: `https://example.invalid/${id}` },
    request: { options: { content: 'av' }, selection: { entryUrls: [] } },
    outputs: [{ filename: `${id}.mp4`, size: 123, kind: 'media', label: 'Media' }],
    failure: null
  };
}

test.before(async () => {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await listen();
});

test.after(async () => {
  await closeServer();
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
});

test('history API lists persisted local records newest first without source work', async () => {
  await historyStore.upsert(entry('older', '2026-08-01T00:00:00.000Z'));
  await historyStore.upsert(entry('newer', '2026-08-02T00:00:00.000Z'));

  const response = await request('/api/history');
  assert.equal(response.status, 200);
  assert.equal(response.data.version, HISTORY_SCHEMA_VERSION);
  assert.deepEqual(response.data.entries.map((item) => item.id), ['newer', 'older']);
});

test('history API deletes one record without affecting another', async () => {
  const removed = await request('/api/history?id=older', { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data, { ok: true, action: 'deleted', id: 'older' });

  const missing = await request('/api/history?id=older', { method: 'DELETE' });
  assert.equal(missing.status, 404);

  const list = await request('/api/history');
  assert.deepEqual(list.data.entries.map((item) => item.id), ['newer']);
});

test('history API Clear All is explicit and reports how many records were removed', async () => {
  await historyStore.upsert(entry('another', '2026-08-03T00:00:00.000Z'));
  const response = await request('/api/history?all=1', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(response.data.action, 'cleared');
  assert.equal(response.data.removed, 2);

  const list = await request('/api/history');
  assert.deepEqual(list.data.entries, []);
});

test('corrupt history fails only the history endpoint and LVOVD keeps serving', async (t) => {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(path.join(DATA_DIR, 'history.json'), '{not json', 'utf8');

  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = originalWarn; });

  const history = await request('/api/history');
  assert.equal(history.status, 500);
  assert.match(history.data.error, /history could not be read/i);

  const normal = await request('/not-found');
  assert.equal(normal.status, 404);
  assert.match(normal.data.error, /not found/i);
});
