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

function localError(message, {
  code = null,
  diagnostic = null,
  operation = null,
  tool = null,
  reason = null
} = {}) {
  const error = new Error(message);
  error.failureScope = 'local';
  if (code) error.code = code;
  if (diagnostic) error.diagnostic = diagnostic;
  error.localFailure = {
    ...(operation ? { operation } : {}),
    ...(tool ? { tool } : {}),
    ...(reason ? { reason } : {}),
    ...(code ? { systemCode: code } : {})
  };
  return error;
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

test('missing FFmpeg and managed yt-dlp executables are required-local-runtime failures', () => {
  const ffmpeg = classifyFailure(localError('spawn ffmpeg ENOENT', {
    code: 'ENOENT',
    operation: 'process_start',
    tool: 'ffmpeg'
  }));
  assertNormalizedFailure(ffmpeg, 'local_runtime_unavailable');
  assert.equal(ffmpeg.explanation, 'FFmpeg is not installed or is not on PATH.');
  assert.match(ffmpeg.help, /Install FFmpeg|PATH/i);

  const ytdlp = classifyFailure(localError('spawn managed executable ENOENT', {
    code: 'ENOENT',
    operation: 'process_start',
    tool: 'yt-dlp'
  }));
  assertNormalizedFailure(ytdlp, 'local_runtime_unavailable');
  assert.match(ytdlp.title, /downloader/i);
  assert.match(ytdlp.help, /update-ytdlp/i);
});

test('structured filesystem codes distinguish disk, permission, and missing-file failures', () => {
  const disk = classifyFailure(localError('write failed in C:\\Users\\person\\private\\job.tmp', {
    code: 'ENOSPC',
    operation: 'workspace_creation'
  }));
  assertNormalizedFailure(disk, 'local_disk_full');
  assert.doesNotMatch(JSON.stringify(disk), /ENOSPC|Users|person|job\.tmp|write failed/i);

  for (const code of ['EACCES', 'EPERM']) {
    const permission = classifyFailure(localError(`private path rejected with ${code}`, {
      code,
      operation: 'local_file_operation'
    }));
    assertNormalizedFailure(permission, 'local_access_denied');
    assert.doesNotMatch(JSON.stringify(permission), new RegExp(`${code}|private path`, 'i'));
  }

  const missing = classifyFailure(localError('/tmp/lvovd-private/input.webm disappeared', {
    code: 'ENOENT',
    operation: 'local_file_operation'
  }));
  assertNormalizedFailure(missing, 'local_file_missing');
  assert.doesNotMatch(JSON.stringify(missing), /tmp|lvovd-private|input\.webm|ENOENT|disappeared/i);
});

test('explicit FFmpeg encoder or decoder evidence is distinct from generic processing failure', () => {
  for (const diagnostic of [
    "Unknown encoder 'libmp3lame'",
    'Decoder (codec secret_codec) not found for input stream #0:0'
  ]) {
    const codec = classifyFailure(localError('FFmpeg exited with code 1.', {
      diagnostic,
      operation: 'ffmpeg_processing',
      tool: 'ffmpeg'
    }));
    assertNormalizedFailure(codec, 'local_codec_unavailable');
    assert.match(codec.explanation, /encoder or decoder is unavailable/i);
  }

  const generic = classifyFailure(localError('Conversion failed at C:\\private\\source.webm', {
    diagnostic: 'opaque FFmpeg failure for C:\\private\\source.webm',
    operation: 'ffmpeg_processing',
    tool: 'ffmpeg'
  }));
  assertNormalizedFailure(generic, 'local_processing_failed');
  assert.doesNotMatch(JSON.stringify(generic), /private|source\.webm|opaque/i);
});

test('output inconsistencies and unknown local failures remain neutral and path-safe', () => {
  const output = classifyFailure(localError('No output at /tmp/lvovd-private/result.mp3', {
    operation: 'output_collection',
    reason: 'output_inconsistent'
  }));
  assertNormalizedFailure(output, 'local_output_inconsistent');

  const unknown = classifyFailure(localError('Unexpected I/O at C:\\Users\\person\\private\\token.bin', {
    operation: 'workspace_creation'
  }));
  assertNormalizedFailure(unknown, 'local_error');

  const ambiguousText = Object.assign(
    new Error('Permission denied; disk is full; arbitrary unstructured text.'),
    { failureScope: 'local' }
  );
  assertNormalizedFailure(classifyFailure(ambiguousText), 'local_error');

  for (const normalized of [output, unknown]) {
    assert.doesNotMatch(JSON.stringify(normalized), /lvovd-private|token\.bin|Users\\\\person|No output|Unexpected I\/O/i);
    assert.doesNotMatch(`${normalized.title} ${normalized.explanation} ${normalized.help}`, /media url|update yt-dlp/i);
  }
});

test('local scope cannot become a source category and 5A source categories remain unchanged', () => {
  assertNormalizedFailure(classifyFailure(localError('HTTP Error 429: Too Many Requests')), 'local_error');

  const sourceCases = [
    ['HTTP Error 429: Too Many Requests', 'rate_limited'],
    ['HTTP Error 403: Forbidden', 'access_rejected'],
    ['Sign in required. Use browser cookies to continue.', 'authentication'],
    ['Video unavailable', 'unavailable'],
    ['Unsupported URL: https://example.invalid/media', 'unsupported'],
    ['This video is DRM protected with Widevine', 'protected'],
    ['Requested format is not available', 'format_unavailable'],
    ['Unable to download video thumbnail: HTTP Error 403: Forbidden', 'extra_rejected'],
    ['opaque acquisition failure', 'unknown']
  ];
  for (const [message, category] of sourceCases) {
    assertNormalizedFailure(classifyFailure(new Error(message)), category);
  }
});

test('unknown source failures keep the source fallback', () => {
  const sourceUnknown = classifyFailure(new Error('synthetic acquisition failure without specific evidence'));
  assertNormalizedFailure(sourceUnknown, 'unknown');
  assert.match(sourceUnknown.title, /source request/i);
  assert.match(sourceUnknown.help, /url/i);
});

test('History preserves normalized local failure information without raw provenance', async () => {
  const error = localError('ENOSPC writing C:\\Users\\person\\private\\output.mp3', {
    code: 'ENOSPC',
    operation: 'output_collection'
  });
  const normalized = classifyFailure(error);
  const job = app.createDownloadJob();
  job.historyRecordStarted = true;
  job.historyContext = createHistoryContext(
    'https://media.example/watch/1',
    { content: 'audio', audioFormat: 'mp3' },
    { entryUrls: [] }
  );

  assert.equal(await app.settleDownloadFailure(job, error), 'error');
  assert.deepEqual(app.publicJob(job).failure, normalized);
  const history = createHistoryEntry(job);
  assert.deepEqual(history.failure, {
    category: normalized.category,
    title: normalized.title,
    message: normalized.explanation,
    help: normalized.help
  });
  assert.doesNotMatch(JSON.stringify(history.failure), /ENOSPC|Users\\\\person|output\.mp3|localFailure/i);
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
