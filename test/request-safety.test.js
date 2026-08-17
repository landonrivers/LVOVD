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
  courtesyDelayMs,
  classifyDownloadError
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

test('429 is classified as a request limit while a bare 403 is not', () => {
  const limited = classifyDownloadError(new Error('HTTP Error 429: Too Many Requests'));
  assert.equal(limited.category, 'rate_limited');
  assert.match(limited.userMessage, /stopped instead of retrying automatically/i);

  const forbidden = classifyDownloadError(new Error('ERROR: unable to download video data: HTTP Error 403: Forbidden'));
  assert.equal(forbidden.category, 'access_rejected');
  assert.doesNotMatch(forbidden.userMessage, /temporarily limiting requests/i);
  assert.match(forbidden.userMessage, /does not by itself prove rate limiting/i);
});

test('thumbnail-specific rejection is distinguished from a media 403', () => {
  const result = classifyDownloadError(new Error('ERROR: Unable to download video thumbnail 41: HTTP Error 403: Forbidden'));
  assert.equal(result.category, 'extra_rejected');
  assert.match(result.userMessage, /try again without Thumbnail/i);
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
