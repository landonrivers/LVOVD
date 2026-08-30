'use strict';

process.env.YTDLP_PATH = process.execPath;

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const HISTORY_DIR = path.join(os.tmpdir(), `lvovd-job-lifecycle-history-${process.pid}-${Date.now()}`);
process.env.LVOVD_DATA_DIR = HISTORY_DIR;

const realSpawn = childProcess.spawn;
let spawnImpl = (...args) => realSpawn(...args);
let spawnCount = 0;
childProcess.spawn = (...args) => {
  spawnCount += 1;
  return spawnImpl(...args);
};

const app = require('../app-server');

test.afterEach(() => {
  spawnImpl = (...args) => realSpawn(...args);
});

test.after(async () => {
  childProcess.spawn = realSpawn;
  await fsp.rm(HISTORY_DIR, { recursive: true, force: true });
});

function createTrackedJob() {
  const job = app.createDownloadJob(false);
  app.jobs.set(job.id, job);
  return job;
}

async function forgetJob(job) {
  if (job.historyPromise) await job.historyPromise;
  app.jobs.delete(job.id);
}

function createFakeChild({ onStart = null, onKill = null, autoCloseCode = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;

  const finish = (code) => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    process.nextTick(() => child.emit('close', code));
  };

  child.kill = () => {
    if (onKill) onKill();
    finish(143);
    return true;
  };

  process.nextTick(() => {
    if (onStart) onStart();
    if (autoCloseCode != null) finish(autoCloseCode);
  });
  return child;
}

function writeTaskOutput(args, filename) {
  const outputIndex = args.indexOf('--output');
  assert.notEqual(outputIndex, -1, 'yt-dlp arguments should include an output template');
  const taskDir = path.dirname(args[outputIndex + 1]);
  fs.writeFileSync(path.join(taskDir, filename), 'synthetic media');
}

async function waitUntil(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function historyEntry(job) {
  if (job.historyPromise) await job.historyPromise;
  return (await app.historyStore.list()).find((item) => item.id === job.id) || null;
}

test('queued cancellation is terminal before queued work begins and is recorded locally', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  const before = spawnCount;

  const action = app.requestJobCancellation(job);
  assert.equal(action, 'cancelled');
  assert.equal(job.status, 'cancelled');

  await app.runDownloadJob(
    job,
    'https://example.invalid/video',
    app.normalizeOptions({}),
    app.normalizeSelection({})
  );

  assert.equal(spawnCount, before);
  assert.equal(job.tempDir, null);
  assert.equal(job.status, 'cancelled');
  assert.equal((await historyEntry(job))?.status, 'cancelled');
});

test('cancellation while workspace setup is pending cannot reach a source process', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  const before = spawnCount;

  const running = app.runDownloadJob(
    job,
    'https://example.invalid/video',
    app.normalizeOptions({}),
    app.normalizeSelection({})
  );
  assert.equal(job.workActive, true);

  const action = app.requestJobCancellation(job);
  assert.equal(action, 'cancelling');
  await running;

  assert.equal(spawnCount, before);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.tempDir, null);
  assert.deepEqual(job.outputs, []);
});

test('cancellation aborts courtesy waits and blocks late ready state', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  job.status = 'running';
  job.phase = 'waiting';
  job.workActive = true;
  let kills = 0;
  job.child = { kill() { kills += 1; } };

  const waiting = app.waitForJob(job, 60_000);
  const action = app.requestJobCancellation(job);

  assert.equal(action, 'cancelling');
  assert.equal(kills, 1);
  assert.equal(job.phase, 'cancelling');
  await assert.rejects(waiting, (error) => error?.code === 'LVOVD_JOB_CANCELLED');

  app.updateJob(job, { status: 'ready', phase: 'ready', message: 'Should not win.' });
  assert.equal(job.status, 'running');
  assert.equal(job.phase, 'cancelling');

  job.workActive = false;
  app.finalizeCancelledJob(job);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.phase, 'cancelled');
});

test('active yt-dlp cancellation kills the owned child and settles cancelled', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  const before = spawnCount;
  let kills = 0;
  spawnImpl = () => createFakeChild({ onKill: () => { kills += 1; } });

  const running = app.runDownloadJob(
    job,
    'https://example.invalid/video',
    app.normalizeOptions({ content: 'video', profile: 'maximum' }),
    app.normalizeSelection({})
  );

  await waitUntil(() => Boolean(job.child), 'active yt-dlp child');
  assert.equal(app.requestJobCancellation(job), 'cancelling');
  await running;

  assert.equal(spawnCount - before, 1);
  assert.equal(kills, 1);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.tempDir, null);
});

test('cancellation during courtesy delay prevents the next playlist item from spawning', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  const before = spawnCount;

  spawnImpl = (_command, args) => createFakeChild({
    onStart: () => writeTaskOutput(args, 'first-item.mp4'),
    autoCloseCode: 0
  });

  const running = app.runDownloadJob(
    job,
    'https://example.invalid/playlist',
    app.normalizeOptions({ content: 'video', profile: 'maximum' }),
    app.normalizeSelection({
      entryUrls: ['https://example.invalid/one', 'https://example.invalid/two']
    })
  );

  await waitUntil(() => job.phase === 'waiting', 'playlist courtesy delay');
  assert.equal(spawnCount - before, 1);
  assert.equal(app.requestJobCancellation(job), 'cancelling');
  await running;

  assert.equal(spawnCount - before, 1, 'second playlist source process must never start');
  assert.equal(job.status, 'cancelled');
  assert.deepEqual(job.outputs, []);
  assert.equal(job.tempDir, null);
});

test('active FFmpeg conversion cancellation kills the conversion child and settles cancelled', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  const before = spawnCount;
  let spawnIndex = 0;
  let ffmpegKills = 0;

  spawnImpl = (_command, args) => {
    spawnIndex += 1;
    if (spawnIndex === 1) {
      return createFakeChild({
        onStart: () => writeTaskOutput(args, 'source-audio.m4a'),
        autoCloseCode: 0
      });
    }
    return createFakeChild({ onKill: () => { ffmpegKills += 1; } });
  };

  const running = app.runDownloadJob(
    job,
    'https://example.invalid/audio',
    app.normalizeOptions({ content: 'audio', audioFormat: 'mp3' }),
    app.normalizeSelection({})
  );

  await waitUntil(() => spawnIndex === 2 && Boolean(job.child), 'active FFmpeg conversion child');
  assert.equal(job.phase, 'processing');
  assert.equal(app.requestJobCancellation(job), 'cancelling');
  await running;

  assert.equal(spawnCount - before, 2);
  assert.equal(ffmpegKills, 1);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.tempDir, null);
});

test('chapter metadata probes are job-owned and cancellable before media acquisition', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  const before = spawnCount;
  let kills = 0;
  spawnImpl = () => createFakeChild({ onKill: () => { kills += 1; } });

  const running = app.runDownloadJob(
    job,
    'https://example.invalid/video',
    app.normalizeOptions({
      content: 'video',
      profile: 'maximum',
      range: { type: 'chapters', chapterIndexes: [0] }
    }),
    app.normalizeSelection({})
  );

  await waitUntil(() => Boolean(job.child), 'chapter metadata yt-dlp child');
  assert.equal(app.requestJobCancellation(job), 'cancelling');
  await running;

  assert.equal(spawnCount - before, 1);
  assert.equal(kills, 1);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.tempDir, null);
});

test('successful synthetic job reaches ready and records output metadata', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  spawnImpl = (_command, args) => createFakeChild({
    onStart: () => writeTaskOutput(args, 'ready-item.mp4'),
    autoCloseCode: 0
  });

  await app.runDownloadJob(
    job,
    'https://example.invalid/video',
    app.normalizeOptions({ content: 'video', profile: 'maximum' }),
    app.normalizeSelection({})
  );

  assert.equal(job.status, 'ready');
  const stored = await historyEntry(job);
  assert.equal(stored?.status, 'ready');
  assert.equal(stored?.outputs.length, 1);
  assert.equal(stored?.outputs[0].filename, 'ready-item.mp4');
  assert.equal('filePath' in stored.outputs[0], false);
});

test('known local FFmpeg startup failure is not presented as a source-request failure', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  spawnImpl = (command, args) => {
    if (command === process.execPath) {
      return createFakeChild({
        onStart: () => writeTaskOutput(args, 'source-audio.webm'),
        autoCloseCode: 0
      });
    }

    const child = createFakeChild();
    process.nextTick(() => {
      const error = new Error('synthetic spawn failure');
      error.code = 'ENOENT';
      child.emit('error', error);
    });
    return child;
  };

  await app.runDownloadJob(
    job,
    'https://example.invalid/audio',
    app.normalizeOptions({ content: 'audio', audioFormat: 'mp3' }),
    app.normalizeSelection({})
  );

  assert.equal(job.status, 'error');
  assert.equal(job.errorCategory, 'local_error');
  assert.equal(job.message, 'Local processing could not start');
  assert.equal(job.error, 'FFmpeg is not installed or is not on PATH.');
  assert.doesNotMatch(JSON.stringify(job.failure), /source request|media URL|update yt-dlp/i);
  const stored = await historyEntry(job);
  assert.equal(stored?.failure?.category, 'local_error');
  assert.equal(stored?.failure?.message, 'FFmpeg is not installed or is not on PATH.');
});

test('failed all-or-nothing jobs clear deleted output descriptors and record failure', async (t) => {
  const job = createTrackedJob();
  t.after(() => forgetJob(job));
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-failed-job-'));
  t.after(() => fsp.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'first-item.mp4');
  await fsp.writeFile(filePath, 'partial batch output');

  job.status = 'running';
  job.phase = 'downloading';
  job.tempDir = tempDir;
  job.outputs = [{
    id: 'first-output',
    filePath,
    filename: 'first-item.mp4',
    size: 20,
    kind: 'media',
    label: 'Playlist item 1 · Media'
  }];
  job.autoDownloadUrl = '/api/download/file?id=job&file=first-output';

  await app.settleDownloadFailure(job, new Error('simulated second item failure'));

  assert.equal(job.status, 'error');
  assert.deepEqual(job.outputs, []);
  assert.equal(job.autoDownloadUrl, null);
  assert.equal(job.tempDir, null);
  await assert.rejects(fsp.access(filePath));
  assert.equal((await historyEntry(job))?.status, 'error');
});
