'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_NODE_MAJOR,
  localUrl,
  localhostUrl,
  nodeMajor,
  npmInvocation,
  npmWorks
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

test('launcher uses platform-appropriate npm invocation', () => {
  assert.deepEqual(npmInvocation(['--version'], 'linux'), {
    command: 'npm',
    args: ['--version']
  });
  assert.deepEqual(npmInvocation(['--version'], 'win32', 'cmd.exe'), {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd --version']
  });
  assert.deepEqual(npmInvocation(['install', '--no-audit', '--no-fund'], 'win32', 'C:\\Windows\\System32\\cmd.exe'), {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd install --no-audit --no-fund']
  });
});

test('Windows launcher can actually execute npm through cmd.exe', { skip: process.platform !== 'win32' }, () => {
  assert.equal(npmWorks(), true);
});
