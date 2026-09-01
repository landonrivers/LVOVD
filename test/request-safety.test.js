'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOptions,
  buildYtdlpArgs
} = require('../server');
const {
  BATCH_DELAY_MIN_MS,
  BATCH_DELAY_MAX_MS,
  createSerialTaskQueue,
  createSourceRequestCoordinator,
  courtesyDelayMs
} = require('../request-safety');

test('playlist courtesy delay stays between five and ten seconds', () => {
  assert.equal(courtesyDelayMs(() => 0), BATCH_DELAY_MIN_MS);
  assert.equal(courtesyDelayMs(() => 0.999999999), BATCH_DELAY_MAX_MS);
});

test('serial task queue never overlaps work and continues after a failed task', async () => {
  const queue = createSerialTaskQueue();
  let active = 0;
  let maxActive = 0;
  const order = [];

  const work = (name, shouldFail = false) => queue.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    order.push(`end:${name}`);
    if (shouldFail) throw new Error(`failed:${name}`);
    return name;
  });

  const first = work('one');
  const second = work('two', true);
  const third = work('three');

  assert.equal(await first, 'one');
  await assert.rejects(second, /failed:two/);
  assert.equal(await third, 'three');
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start:one', 'end:one',
    'start:two', 'end:two',
    'start:three', 'end:three'
  ]);
  assert.equal(queue.size, 0);
});

test('source request coordinator serializes previews, downloads, and editor acquisitions', async () => {
  const coordinator = createSourceRequestCoordinator();
  let active = 0;
  let maxActive = 0;
  let duplicateRuns = 0;
  const order = [];

  const work = (name) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(`start:${name}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`end:${name}`);
    active -= 1;
    return name;
  };

  const firstPreview = coordinator.preview('https://video.example/watch/one', work('preview-one'));
  const duplicatePreview = coordinator.preview('https://video.example/watch/one', async () => {
    duplicateRuns += 1;
    return 'duplicate';
  });
  const download = coordinator.download(work('download'));
  const acquisition = coordinator.acquire(work('editor-acquisition'));
  const secondPreview = coordinator.preview('https://video.example/watch/two', work('preview-two'));

  assert.strictEqual(firstPreview, duplicatePreview);
  assert.equal(coordinator.size, 4);
  assert.equal(await firstPreview, 'preview-one');
  assert.equal(await duplicatePreview, 'preview-one');
  assert.equal(await download, 'download');
  assert.equal(await acquisition, 'editor-acquisition');
  assert.equal(await secondPreview, 'preview-two');
  assert.equal(duplicateRuns, 0);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [
    'start:preview-one', 'end:preview-one',
    'start:download', 'end:download',
    'start:editor-acquisition', 'end:editor-acquisition',
    'start:preview-two', 'end:preview-two'
  ]);
  assert.equal(coordinator.size, 0);

  assert.equal(
    await coordinator.preview('https://video.example/watch/one', async () => 'preview-one-again'),
    'preview-one-again'
  );
});

test('checking Thumbnail does not change audio source acquisition', () => {
  const withoutThumbnail = normalizeOptions({ content: 'audio', audioFormat: 'mp3' });
  const withThumbnail = normalizeOptions({
    content: 'audio',
    audioFormat: 'mp3',
    extras: { thumbnail: true }
  });

  const task = { url: 'https://video.example/watch/ABCDEFGHIJK' };
  const plainArgs = buildYtdlpArgs(task, withoutThumbnail, '/tmp/plain.%(ext)s', 'download:test');
  const thumbnailArgs = buildYtdlpArgs(task, withThumbnail, '/tmp/thumb.%(ext)s', 'download:test');

  const plainFormat = plainArgs[plainArgs.indexOf('--format') + 1];
  const thumbnailFormat = thumbnailArgs[thumbnailArgs.indexOf('--format') + 1];
  assert.equal(plainFormat, 'bestaudio');
  assert.equal(thumbnailFormat, 'bestaudio');
  assert.equal(plainArgs.includes('--write-thumbnail'), false);
  assert.equal(thumbnailArgs.includes('--write-thumbnail'), true);
  assert.equal(thumbnailArgs.includes('--convert-thumbnails'), true);
});
