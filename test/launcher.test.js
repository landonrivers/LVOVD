'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_NODE_MAJOR,
  browserLaunchCommand,
  localUrl,
  nodeMajor,
  npmCommand
} = require('../launch');

test('launcher enforces the documented Node minimum', () => {
  assert.equal(MIN_NODE_MAJOR, 22);
  assert.equal(nodeMajor('22.0.0'), 22);
  assert.equal(nodeMajor('24.18.0'), 24);
});

test('launcher always opens the loopback UI and validates the port', () => {
  assert.equal(localUrl('3000'), 'http://127.0.0.1:3000');
  assert.equal(localUrl('4567'), 'http://127.0.0.1:4567');
  assert.equal(localUrl('not-a-port'), 'http://127.0.0.1:3000');
});

test('launcher uses platform-appropriate npm and browser commands', () => {
  assert.equal(npmCommand('win32'), 'npm.cmd');
  assert.equal(npmCommand('linux'), 'npm');
  assert.equal(browserLaunchCommand('darwin', 'http://127.0.0.1:3000').command, 'open');
  assert.equal(browserLaunchCommand('linux', 'http://127.0.0.1:3000').command, 'xdg-open');
  assert.equal(browserLaunchCommand('win32', 'http://127.0.0.1:3000').command, 'cmd.exe');
});
