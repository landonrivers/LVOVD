'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  HISTORY_SCHEMA_VERSION,
  defaultHistoryDataDir,
  createHistoryStore
} = require('../history-store');
const {
  createHistoryContext,
  createHistoryEntry,
  recordTerminalJob
} = require('../download-history');

async function makeDir(t, prefix = 'lvovd-history-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function entry(id, finishedAt) {
  return {
    id,
    createdAt: finishedAt,
    finishedAt,
    status: 'ready',
    title: id,
    source: { name: 'Example', url: 'https://example.invalid/video' },
    request: { options: { content: 'av' }, selection: { entryUrls: [] } },
    outputs: [],
    failure: null
  };
}

test('history data directory follows per-user platform conventions and honors an override', () => {
  assert.equal(
    defaultHistoryDataDir({ env: { LVOVD_DATA_DIR: './custom-history' }, platform: 'linux', home: '/home/tester' }),
    path.resolve('./custom-history')
  );
  assert.equal(
    defaultHistoryDataDir({ env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, platform: 'win32', home: 'C:\\Users\\Test' }),
    path.join('C:\\Users\\Test\\AppData\\Local', 'LVOVD')
  );
  assert.equal(
    defaultHistoryDataDir({ env: {}, platform: 'darwin', home: '/Users/tester' }),
    path.join('/Users/tester', 'Library', 'Application Support', 'LVOVD')
  );
  assert.equal(
    defaultHistoryDataDir({ env: {}, platform: 'linux', home: '/home/tester' }),
    path.join('/home/tester', '.local', 'share', 'LVOVD')
  );
});

test('history persists across store instances and upsert does not duplicate an id', async (t) => {
  const dataDir = await makeDir(t);
  const firstStore = createHistoryStore({ dataDir });
  await firstStore.upsert(entry('older', '2026-08-01T00:00:00.000Z'));
  await firstStore.upsert(entry('newer', '2026-08-02T00:00:00.000Z'));
  await firstStore.upsert({ ...entry('older', '2026-08-03T00:00:00.000Z'), title: 'Updated' });

  const secondStore = createHistoryStore({ dataDir });
  const entries = await secondStore.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, 'older');
  assert.equal(entries[0].title, 'Updated');
  assert.equal(entries[1].id, 'newer');

  const raw = JSON.parse(await fsp.readFile(path.join(dataDir, 'history.json'), 'utf8'));
  assert.equal(raw.version, HISTORY_SCHEMA_VERSION);
});

test('history delete and clear mutate only the intended local records', async (t) => {
  const dataDir = await makeDir(t);
  const store = createHistoryStore({ dataDir });
  await store.upsert(entry('one', '2026-08-01T00:00:00.000Z'));
  await store.upsert(entry('two', '2026-08-02T00:00:00.000Z'));

  assert.equal(await store.remove('one'), true);
  assert.equal(await store.remove('missing'), false);
  assert.deepEqual((await store.list()).map((item) => item.id), ['two']);
  assert.equal(await store.clear(), 1);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.clear(), 0);
});

test('failed atomic replacement preserves the previous valid history file', async (t) => {
  const dataDir = await makeDir(t);
  const normal = createHistoryStore({ dataDir });
  await normal.upsert(entry('kept', '2026-08-01T00:00:00.000Z'));

  const failingFs = Object.create(fsp);
  failingFs.rename = async () => {
    const error = new Error('simulated rename failure');
    error.code = 'EACCES';
    throw error;
  };
  const failing = createHistoryStore({ dataDir, fsPromises: failingFs });
  await assert.rejects(
    failing.upsert(entry('lost', '2026-08-02T00:00:00.000Z')),
    (error) => error?.code === 'LVOVD_HISTORY_WRITE'
  );

  const entries = await normal.list();
  assert.deepEqual(entries.map((item) => item.id), ['kept']);
});

test('corrupt history is isolated to the history feature', async (t) => {
  const dataDir = await makeDir(t);
  await fsp.writeFile(path.join(dataDir, 'history.json'), '{not json', 'utf8');
  const store = createHistoryStore({ dataDir });
  await assert.rejects(store.list(), (error) => error?.code === 'LVOVD_HISTORY_CORRUPT');
});

test('history entries store terminal metadata without temporary paths or runtime URLs', () => {
  const job = {
    id: 'job-ready',
    createdAt: Date.parse('2026-08-01T00:00:00.000Z'),
    status: 'ready',
    historyContext: createHistoryContext(
      'https://example.invalid/watch?id=123',
      { content: 'av', profile: 'compatible', extras: { thumbnail: false } },
      { entryUrls: [] },
      { title: 'Example title', sourceName: 'Example Source' }
    ),
    outputs: [{
      id: 'runtime-output-id',
      filePath: '/tmp/lvovd-run-secret/job/file.mp4',
      filename: 'file.mp4',
      size: 42,
      kind: 'media',
      label: 'Media'
    }],
    autoDownloadUrl: '/api/download/file?id=job-ready&file=runtime-output-id',
    error: null,
    errorCategory: null
  };

  const stored = createHistoryEntry(job, new Date('2026-08-01T01:00:00.000Z'));
  assert.equal(stored.title, 'Example title');
  assert.equal(stored.source.url, 'https://example.invalid/watch?id=123');
  assert.deepEqual(stored.outputs, [{ filename: 'file.mp4', size: 42, kind: 'media', label: 'Media' }]);
  const serialized = JSON.stringify(stored);
  assert.doesNotMatch(serialized, /filePath|runtime-output-id|autoDownloadUrl|lvovd-run-secret/);
});

test('history persistence failure cannot change a successful terminal job', async () => {
  const job = {
    id: 'job-success',
    createdAt: Date.now(),
    status: 'ready',
    historyContext: createHistoryContext(
      'https://example.invalid/video',
      { content: 'video' },
      { entryUrls: [] },
      { title: 'Still successful', sourceName: 'Example' }
    ),
    outputs: [],
    error: null,
    errorCategory: null
  };
  const warnings = [];
  const saved = await recordTerminalJob(job, {
    store: { upsert: async () => { throw new Error('simulated disk failure'); } },
    logger: { warn: (message) => warnings.push(message) }
  });

  assert.equal(saved, false);
  assert.equal(job.status, 'ready');
  assert.equal(job.historyRecorded, undefined);
  assert.match(job.historyRecordError, /simulated disk failure/);
  assert.equal(warnings.length, 1);
});

test('terminal history recording is idempotent for one job', async () => {
  const writes = [];
  const job = {
    id: 'job-once',
    createdAt: Date.now(),
    status: 'cancelled',
    historyContext: createHistoryContext(
      'https://example.invalid/video',
      { content: 'audio' },
      { entryUrls: [] },
      { title: 'Cancelled media', sourceName: 'Example' }
    ),
    outputs: [],
    error: null,
    errorCategory: null
  };
  const store = { upsert: async (value) => { writes.push(value); } };

  assert.equal(await recordTerminalJob(job, { store, logger: { warn() {} } }), true);
  assert.equal(await recordTerminalJob(job, { store, logger: { warn() {} } }), false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'cancelled');
});
