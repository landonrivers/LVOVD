'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_NODE_MAJOR,
  STARTUP_TIMEOUT_MS,
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
