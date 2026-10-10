'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
process.env.YTDLP_PATH = 'generated-yt-dlp';
process.env.HOST = '127.0.0.1';
process.env.PORT = String(32000 + process.pid % 10000);
let behavior = 'present';
const calls = [];
childProcess.spawn = (command, args, options) => {
  calls.push({ command, args, options });
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.unref = () => {};
  child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
  queueMicrotask(() => {
    if (command === 'ffprobe' && behavior === 'missing') {
      child.emit('error', Object.assign(new Error('private path'), { code: 'ENOENT' })); return;
    }
    child.pid = 123;
    if (command === 'ffprobe' && behavior === 'timeout') return;
    child.stdout.write(`${command} version fixture\n`);
    child.emit('close', command === 'ffprobe' && behavior === 'failed' ? 1 : 0);
  });
  return child;
};
const { server } = require('../server');
childProcess.spawn = originalSpawn;
test.before(async () => { await new Promise(resolve => server.listen(Number(process.env.PORT), '127.0.0.1', resolve)); });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

for (const scenario of ['present', 'missing', 'failed', 'timeout']) {
  test(`protected health reports FFprobe ${scenario} without blocking other tools`, { timeout: 8000 }, async () => {
    behavior = scenario; calls.length = 0;
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.node.installed, true); assert.equal(result.ytdlp.installed, true); assert.equal(result.ffmpeg.installed, true);
    assert.equal(result.localOnly, true); assert.equal(result.ffprobe.installed, scenario === 'present');
    if (scenario === 'present') assert.equal(result.ffprobe.version, 'ffprobe version fixture');
    else assert.match(result.ffprobe.error, /not found|failed|timed out/);
    assert.doesNotMatch(JSON.stringify(result), /private path/);
    assert.deepEqual(calls.map(call => call.command), ['generated-yt-dlp', 'ffmpeg', 'ffprobe']);
    assert.deepEqual(calls[0].args, ['--ignore-config', '--js-runtimes', 'node', '--no-colors', '--version']);
    assert.deepEqual(calls[2].args, ['-version']);
    assert.ok(calls.every(call => call.options.shell === false && call.options.windowsHide));
  });
}
