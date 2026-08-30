'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../server');
const { classifyFailure, classifySourceFailure } = require('../failure-classification');
const { createHistoryContext, createHistoryEntry } = require('../download-history');

function assertNormalizedFailure(value, category) {
  assert.deepEqual(Object.keys(value), ['category', 'title', 'explanation', 'help']);
  assert.equal(value.category, category);
  assert.ok(value.title);
  assert.ok(value.explanation);
  assert.ok(value.help);
}

test('strong HTTP 429 evidence is rate limiting while a bare HTTP 403 remains ambiguous rejection', () => {
  const limited = classifySourceFailure(new Error('HTTP Error 429: Too Many Requests'));
  assertNormalizedFailure(limited, 'rate_limited');
  assert.match(limited.explanation, /stopped without retrying automatically/i);

  const forbidden = classifySourceFailure(new Error('ERROR: unable to download video data: HTTP Error 403: Forbidden'));
  assertNormalizedFailure(forbidden, 'access_rejected');
  assert.match(forbidden.explanation, /does not by itself prove rate limiting/i);
  assert.doesNotMatch(forbidden.explanation, /source is limiting requests/i);
});

test('authentication-required evidence is distinct from private or unavailable content', () => {
  for (const message of [
    'Sign in required. Use browser cookies to continue.',
    'Sign in to confirm your age.',
    'HTTP Error 401: Unauthorized'
  ]) {
    assertNormalizedFailure(classifySourceFailure(new Error(message)), 'authentication');
  }

  for (const message of [
    'This video is private',
    'This content has been deleted',
    'Video unavailable',
    'This video is no longer available',
    'This media link has expired'
  ]) {
    assertNormalizedFailure(classifySourceFailure(new Error(message)), 'unavailable');
  }
});

test('unsupported URLs require explicit evidence and generic extractor failures stay unknown', () => {
  assertNormalizedFailure(
    classifySourceFailure(new Error('Unsupported URL: https://media.example/unavailable/429/private')),
    'unsupported'
  );
  assertNormalizedFailure(
    classifySourceFailure(new Error('ERROR: extractor failed while parsing the player response')),
    'unknown'
  );
  assertNormalizedFailure(
    classifySourceFailure(new Error('Unable to extract initial media data')),
    'unknown'
  );
});

test('DRM and access-controlled media remain explicitly unsupported', () => {
  for (const message of [
    'This video is DRM protected with Widevine',
    'Access-controlled media is not supported'
  ]) {
    const protectedFailure = classifySourceFailure(new Error(message));
    assertNormalizedFailure(protectedFailure, 'protected');
    assert.match(protectedFailure.help, /does not bypass drm or access controls/i);
  }
});

test('requested formats provide alternate-choice help and stale manual choices require a fresh Preview', () => {
  const unavailable = classifySourceFailure(new Error('Requested format is not available'));
  assertNormalizedFailure(unavailable, 'format_unavailable');
  assert.match(unavailable.help, /fresh Preview/i);
  assert.match(unavailable.help, /another format, profile, or resolution/i);

  const manual = classifySourceFailure(
    new Error('Requested format is not available'),
    { sourceFormatMode: 'manual' }
  );
  assertNormalizedFailure(manual, 'format_unavailable');
  assert.match(manual.title, /no longer available/i);
  assert.match(manual.help, /Run Preview again and choose a current source format/i);
});

test('thumbnail rejection stays distinct and unknown diagnostics are not exposed as user copy', () => {
  const thumbnail = classifySourceFailure(new Error('Unable to download video thumbnail 41: HTTP Error 403: Forbidden'));
  assertNormalizedFailure(thumbnail, 'extra_rejected');
  assert.match(thumbnail.help, /without Thumbnail/i);

  const limitedThumbnail = classifySourceFailure(new Error('Unable to download video thumbnail 41: HTTP Error 429: Too Many Requests'));
  assertNormalizedFailure(limitedThumbnail, 'rate_limited');

  const unknown = classifySourceFailure(new Error('opaque internal failure at https://private.invalid/token/secret'));
  assertNormalizedFailure(unknown, 'unknown');
  assert.doesNotMatch(JSON.stringify(unknown), /private\.invalid|opaque internal failure|Original error/i);
});

test('local failures use a neutral boundary while unknown source failures keep the source fallback', async () => {
  const ffmpegError = Object.assign(new Error('FFmpeg is not installed or is not on PATH.'), {
    failureScope: 'local'
  });
  const ffmpeg = classifyFailure(ffmpegError);
  assertNormalizedFailure(ffmpeg, 'local_error');
  assert.equal(ffmpeg.explanation, 'FFmpeg is not installed or is not on PATH.');
  assert.doesNotMatch(`${ffmpeg.title} ${ffmpeg.help}`, /source request|media url|update yt-dlp/i);

  const filesystemError = Object.assign(new Error('EACCES: synthetic private workspace path'), {
    failureScope: 'local'
  });
  const filesystem = classifyFailure(filesystemError);
  assertNormalizedFailure(filesystem, 'local_error');
  assert.doesNotMatch(JSON.stringify(filesystem), /EACCES|private workspace path/i);
  assert.doesNotMatch(`${filesystem.title} ${filesystem.explanation} ${filesystem.help}`, /media url|update yt-dlp/i);

  const job = app.createDownloadJob();
  job.historyRecordStarted = true;
  await app.settleDownloadFailure(job, filesystemError);
  assert.deepEqual(app.publicJob(job).failure, filesystem);

  const sourceUnknown = classifyFailure(new Error('synthetic acquisition failure without specific evidence'));
  assertNormalizedFailure(sourceUnknown, 'unknown');
  assert.match(sourceUnknown.title, /source request/i);
  assert.match(sourceUnknown.help, /url/i);
});

test('Preview and download paths publish the same normalized failure contract', async () => {
  const error = new Error('HTTP Error 429: Too Many Requests');
  const normalized = classifySourceFailure(error);
  assert.deepEqual(app.classifyPreviewError(error, 'https://media.example/watch/1'), normalized);

  const job = app.createDownloadJob();
  job.historyRecordStarted = true;
  job.historyContext = createHistoryContext(
    'https://media.example/watch/1',
    { content: 'video', profile: 'maximum', sourceFormat: { mode: 'auto' } },
    { entryUrls: [] }
  );
  assert.equal(await app.settleDownloadFailure(job, error), 'error');
  assert.deepEqual(app.publicJob(job).failure, normalized);
  assert.equal(job.message, normalized.title);
  assert.equal(job.error, normalized.explanation);
  assert.equal(job.errorCategory, normalized.category);

  const history = createHistoryEntry(job);
  assert.equal(history.failure.category, normalized.category);
  assert.equal(history.failure.title, normalized.title);
  assert.equal(history.failure.message, normalized.explanation);
  assert.equal(history.failure.help, normalized.help);
});

test('download classification uses retained manual source-format context', async () => {
  const job = app.createDownloadJob();
  job.historyRecordStarted = true;
  job.historyContext = createHistoryContext(
    'https://media.example/watch/1',
    { content: 'video', profile: 'maximum', sourceFormat: { mode: 'manual', type: 'video', videoId: 'stale' } },
    { entryUrls: [] }
  );

  await app.settleDownloadFailure(job, new Error('Requested format is not available'));
  assert.equal(job.failure.category, 'format_unavailable');
  assert.match(job.failure.help, /Run Preview again and choose a current source format/i);
});

test('classification remains a pure explanation layer with no retry or source-work mechanism', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'failure-classification.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|spawn|enqueue|setTimeout)\s*\(/);
  assert.doesNotMatch(source, /require\(['"]\.\/request-safety['"]\)/);
});

test('browser failure renderers consume title, explanation, and next-step help', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(source, /details\?\.explanation/);
  assert.match(source, /details\?\.help/);
  assert.match(source, /failure\.title/);
  assert.match(source, /failure\.explanation/);
  assert.match(source, /failure\.help/);
  assert.match(source, /queue-failure-help/);
});
