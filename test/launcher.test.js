'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_NODE_MAJOR,
  STARTUP_TIMEOUT_MS,
  checkLocalTools,
  localUrl,
  localhostUrl,
  nodeMajor,
  readyMessage
} = require('../scripts/launch');

test('launcher enforces the documented Node minimum', () => {
  assert.equal(MIN_NODE_MAJOR, 22);
  assert.equal(nodeMajor('22.0.0'), 22);
  assert.equal(nodeMajor('24.18.0'), 24);
});

test('launcher uses loopback URLs and validates the port', () => {
  assert.equal(localUrl('3000'), 'http://127.0.0.1:3000');
  assert.equal(localUrl('4567'), 'http://127.0.0.1:4567');
  assert.equal(localUrl('not-a-port'), 'http://127.0.0.1:3000');
  assert.equal(localhostUrl('http://127.0.0.1:3000'), 'http://localhost:3000');
  assert.equal(localhostUrl('http://127.0.0.1:4567'), 'http://localhost:4567');
});

test('launcher prints both local addresses when ready', () => {
  assert.equal(
    readyMessage('http://127.0.0.1:3000'),
    'LVOVD is ready.\nOpen LVOVD: http://127.0.0.1:3000\nOr: http://localhost:3000'
  );
});

test('launcher allows enough time for a first-run verified yt-dlp download', () => {
  assert.ok(STARTUP_TIMEOUT_MS >= 60000);
});

test('launcher warns about missing, failed or timed-out FFprobe and keeps normal startup available', async () => {
  for (const error of ['FFprobe: not found on PATH.', 'FFprobe: version check failed.', 'FFprobe: version check timed out.']) {
    const calls = [];
    const result = await checkLocalTools(async (command, args, label) => {
      calls.push([command, args, label]);
      return command === 'ffprobe' ? { installed: false, error } : { installed: true, version: 'fixture' };
    });
    assert.equal(result.error, null);
    assert.ok(result.warning.startsWith(error));
    assert.match(result.warning, /Local Media requires FFprobe/);
    assert.match(result.warning, /PATH.*Recheck.*Ordinary URL Download remains available/);
    assert.deepEqual(calls, [['ffmpeg', ['-version'], 'FFmpeg'], ['ffprobe', ['-version'], 'FFprobe']]);
  }
});

test('launcher has no warning with both tools and still refuses a missing FFmpeg', async () => {
  assert.deepEqual(await checkLocalTools(async () => ({ installed: true })), { error: null, warning: null });
  const result = await checkLocalTools(async command => command === 'ffmpeg'
    ? { installed: false, error: 'FFmpeg: not found on PATH.' } : { installed: true });
  assert.match(result.error, /Install FFmpeg.*PATH/); assert.equal(result.warning, null);
});
