'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { probeVersion, VERSION_TIMEOUT_MS, VERSION_OUTPUT_BYTES } = require('../runtime-version');

function child(onKill = () => {}) {
  const process = new EventEmitter();
  process.pid = 123;
  process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.signals = [];
  process.kill = signal => { process.signals.push(signal); onKill(process, signal); return true; };
  process.unref = () => { process.unreferenced = true; };
  return process;
}
function probe(process, options = {}) {
  return probeVersion('ffprobe', ['-version'], 'FFprobe', { spawnProcess: () => process, ...options });
}

test('version probes keep fixed arguments, bounded output and a five-second default deadline', async () => {
  assert.equal(VERSION_TIMEOUT_MS, 5000); assert.equal(VERSION_OUTPUT_BYTES, 256 * 1024);
  const process = child(), calls = [];
  const result = probeVersion('ffprobe', ['-version'], 'FFprobe', { spawnProcess: (...args) => { calls.push(args); return process; } });
  process.stdout.write('ffprobe version generated-test\nconfiguration details\n');
  process.emit('close', 0);
  assert.deepEqual(await result, { installed: true, version: 'ffprobe version generated-test' });
  assert.deepEqual(calls, [['ffprobe', ['-version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }]]);
  assert.equal(process.listenerCount('close'), 0);
  assert.equal(process.stdout.listenerCount('data'), 0);
});

test('missing and failed tools return safe status without raw diagnostics or paths', async () => {
  const missing = Object.assign(new Error('spawn C:\\private\\ffprobe.exe ENOENT'), { code: 'ENOENT' });
  const thrown = await probeVersion('ffprobe', ['-version'], 'FFprobe', { spawnProcess() { throw missing; } });
  assert.deepEqual(thrown, { installed: false, error: 'FFprobe: not found on PATH.' });
  const process = child(); delete process.pid;
  const pending = probe(process); process.emit('error', missing);
  assert.deepEqual(await pending, thrown);
  assert.deepEqual(process.signals, []);
  const failed = child(), failure = probe(failed);
  failed.stderr.write('private diagnostic'); failed.emit('close', 1);
  assert.deepEqual(await failure, { installed: false, error: 'FFprobe: version check failed.' });
});

test('silent version probes terminate and settle even when kill or inherited pipes never close', { timeout: 1000 }, async () => {
  const process = child(() => { throw new Error('synthetic signal failure'); });
  const pending = probe(process, { timeoutMs: 10, terminationGraceMs: 5 });
  assert.deepEqual(await pending, { installed: false, error: 'FFprobe: version check timed out.' });
  assert.deepEqual(process.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(process.unreferenced, true);
  assert.equal(process.stdout.destroyed, true); assert.equal(process.stderr.destroyed, true);
  for (const event of ['error', 'exit', 'close']) assert.equal(process.listenerCount(event), 0);
  process.emit('close', 0);
  const exited = child(), withPipe = probe(exited, { timeoutMs: 10 });
  exited.emit('exit', 0);
  assert.equal((await withPipe).installed, false);
  assert.deepEqual(exited.signals, []);
});

test('stdout and stderr share one byte limit and cooperative termination cancels escalation', async () => {
  const process = child(current => queueMicrotask(() => current.emit('exit', null)));
  const pending = probe(process, { maxOutputBytes: 8, terminationGraceMs: 5 });
  process.stdout.write('12345'); process.stderr.write('6789');
  assert.deepEqual(await pending, { installed: false, error: 'FFprobe: version output exceeded its limit.' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(process.signals, ['SIGTERM']);
});

test('successful version output can use stderr and stays one short line', async () => {
  const process = child(), pending = probe(process);
  process.stderr.write('x'.repeat(300) + '\nextra'); process.emit('close', 0);
  assert.deepEqual(await pending, { installed: true, version: 'x'.repeat(240) });
});
