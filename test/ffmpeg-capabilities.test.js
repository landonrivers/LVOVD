'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  parseCodecCapabilities,
  parseMuxerCapabilities,
  parseFfmpegVersion,
  runBoundedCommand,
  discoverFfmpegCapabilities,
  createFfmpegCapabilityDiscovery,
  publicCapabilitySummary
} = require('../ffmpeg-capabilities');

function completedChild({ stdout = '', stderr = '', code = 0, onKill = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { if (onKill) onKill(); };
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  });
  return child;
}

test('FFmpeg encoder and decoder listings normalize only capability names', () => {
  const encoders = parseCodecCapabilities(`
 Encoders:
 V..... libx264              H.264 / AVC / MPEG-4 AVC
 A..... aac                  AAC (Advanced Audio Coding)
 ------
`);
  const decoders = parseCodecCapabilities(`
 Decoders:
 V....D h264                 H.264 / AVC / MPEG-4 AVC
 A....D aac                  AAC (Advanced Audio Coding)
`);

  assert.deepEqual([...encoders], ['libx264', 'aac']);
  assert.deepEqual([...decoders], ['h264', 'aac']);
});

test('FFmpeg muxer and version listings expose normalized product facts', () => {
  const muxers = parseMuxerCapabilities(`
  E mp4             MP4 (MPEG-4 Part 14)
 DE matroska,webm   Matroska / WebM
 --
`);

  assert.deepEqual([...muxers], ['mp4', 'matroska', 'webm']);
  assert.equal(parseFfmpegVersion('ffmpeg version 7.1-full_build Copyright'), '7.1-full_build');
});

test('bounded FFmpeg capability commands use shell false and stop oversized output', async () => {
  let killed = 0;
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return completedChild({ stdout: 'x'.repeat(65), onKill: () => { killed += 1; } });
  };

  await assert.rejects(
    runBoundedCommand(spawnProcess, ['-encoders'], 64),
    /bounded capture limit/i
  );
  assert.equal(killed, 1);
  assert.deepEqual(calls, [{
    command: 'ffmpeg',
    args: ['-encoders'],
    options: { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
  }]);
});

test('capability discovery runs fixed bounded commands and caches them for process reuse', async () => {
  const calls = [];
  const outputs = new Map([
    ['-version', 'ffmpeg version 7.1-test\n'],
    ['-hide_banner -encoders', ' V..... libx264 software encoder\n A..... aac audio encoder\n'],
    ['-hide_banner -decoders', ' V....D h264 video decoder\n A....D aac audio decoder\n'],
    ['-hide_banner -muxers', ' E mp4 MP4 muxer\n']
  ]);
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    return completedChild({ stdout: outputs.get(args.join(' ')) || '' });
  };
  const getCapabilities = createFfmpegCapabilityDiscovery({ spawnProcess, maxOutputBytes: 4096 });

  const [first, second] = await Promise.all([getCapabilities(), getCapabilities()]);

  assert.equal(first, second);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.args), [
    ['-version'],
    ['-hide_banner', '-encoders'],
    ['-hide_banner', '-decoders'],
    ['-hide_banner', '-muxers']
  ]);
  assert.ok(calls.every((call) => call.command === 'ffmpeg'
    && call.options.shell === false && call.options.windowsHide === true));
  assert.deepEqual(publicCapabilitySummary(first), {
    available: true,
    version: '7.1-test',
    broadMp4: {
      h264SoftwareEncoder: true,
      aacEncoder: true,
      mp4Muxer: true
    }
  });
});

test('capability discovery fails closed without exposing raw local diagnostics', async () => {
  const capabilities = await discoverFfmpegCapabilities({
    spawnProcess() {
      const error = new Error('spawn C:\\private\\ffmpeg.exe ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
  });

  assert.equal(capabilities.available, false);
  assert.equal(capabilities.version, null);
  assert.equal(capabilities.encoders.size, 0);
  assert.doesNotMatch(JSON.stringify(publicCapabilitySummary(capabilities)), /private|ffmpeg\.exe/i);
});

const OUTPUTS = new Map([
  ['-version', 'ffmpeg version 7.1-test\n'],
  ['-hide_banner -encoders', ' V..... libx264 software encoder\n A..... aac audio encoder\n'],
  ['-hide_banner -decoders', ' V....D h264 video decoder\n A....D mp3float MP3 (codec mp3)\n'],
  ['-hide_banner -muxers', ' E mp4 MP4 muxer\n']
]);

function controlledChild(onKill = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); onKill(child, signal); return true; };
  child.unref = () => { child.unreferenced = true; };
  return child;
}

function assertListenersRemoved(child) {
  for (const event of ['error', 'exit', 'close']) assert.equal(child.listenerCount(event), 0, event);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(child.stdout.listenerCount('error'), 0);
  assert.equal(child.stderr.listenerCount('error'), 0);
}

test('silent child times out, escalates, and settles even without exit or close', { timeout: 1000 }, async () => {
  const child = controlledChild();
  await assert.rejects(runBoundedCommand(() => child, ['-version'], 4096, { timeoutMs: 10, terminationGraceMs: 10 }), error => {
    assert.equal(error.discoveryReason, 'timeout');
    assert.equal(error.terminationConfirmed, false, 'kill returning true is not an observed exit');
    return true;
  });
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.unreferenced, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assertListenersRemoved(child);
  child.emit('close', 0); // late completion cannot resurrect success
});

test('timeout observes a cooperative exit and clears escalation timers', { timeout: 1000 }, async () => {
  const child = controlledChild(current => queueMicrotask(() => current.emit('exit', null, 'SIGTERM')));
  await assert.rejects(runBoundedCommand(() => child, ['-version'], 4096, { timeoutMs: 10, terminationGraceMs: 10 }), error => error.terminationConfirmed === true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(child.signals, ['SIGTERM']);
  assertListenersRemoved(child);
});

test('SIGKILL escalation can confirm exit, while signal errors stay finite', { timeout: 1000 }, async () => {
  for (const responds of [true, false]) {
    const child = controlledChild((current, signal) => {
      if (responds && signal === 'SIGKILL') queueMicrotask(() => current.emit('close', null, signal));
      if (!responds) throw new Error('synthetic signal failure');
    });
    await assert.rejects(runBoundedCommand(() => child, ['-version'], 4096, { timeoutMs: 10, terminationGraceMs: 10 }), error => error.terminationConfirmed === responds);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assertListenersRemoved(child);
  }
});

test('combined stdout/stderr overflow terminates a non-closing child', { timeout: 1000 }, async () => {
  const child = controlledChild();
  const result = runBoundedCommand(() => child, ['-version'], 8, { timeoutMs: 100, terminationGraceMs: 5 });
  child.stdout.write('12345');
  child.stderr.write('6789');
  await assert.rejects(result, error => error.discoveryReason === 'output-limit');
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assertListenersRemoved(child);
});

test('successful and failed commands remove owned listeners and timers', async () => {
  for (const code of [0, 1]) {
    const child = completedChild({ stdout: 'ffmpeg version 7.1-test', code });
    const result = runBoundedCommand(() => child, ['-version'], 4096, { timeoutMs: 10, terminationGraceMs: 5 });
    if (code === 0) assert.match((await result).stdout, /7.1-test/);
    else await assert.rejects(result, error => error.discoveryReason === 'command-failed');
    assertListenersRemoved(child);
  }
});

test('asynchronous failed spawn returns normalized failure without raw diagnostics', async () => {
  const child = controlledChild();
  const pending = discoverFfmpegCapabilities({ spawnProcess: () => child });
  child.emit('error', Object.assign(new Error('spawn C:\\private\\ffmpeg.exe ENOENT'), { code: 'ENOENT' }));
  const result = await pending;
  assert.equal(result.available, false);
  assert.equal(result.failureReason, 'spawn-failed');
  assert.deepEqual(child.signals, []);
  assertListenersRemoved(child);
  const summary = publicCapabilitySummary(result);
  assert.equal(summary.broadMp4.mp4Muxer, null, 'failed discovery is not a missing muxer');
  assert.doesNotMatch(JSON.stringify(summary), /private|ffmpeg\.exe|ENOENT/);
});

for (const command of OUTPUTS.keys()) {
  test(`unrecognized ${command} output is not a successful empty capability set`, async () => {
    const result = await discoverFfmpegCapabilities({
      spawnProcess: (_command, args) => completedChild({ stdout: args.join(' ') === command ? 'not a capability listing' : OUTPUTS.get(args.join(' ')) })
    });
    assert.equal(result.available, false);
    assert.equal(result.failureReason, 'unparseable');
    assert.equal(publicCapabilitySummary(result).broadMp4.h264SoftwareEncoder, null);
  });
}

test('pure listing parsers retain finite bounds and exclude paths as version identifiers', () => {
  assert.throws(() => parseCodecCapabilities('x'.repeat(4097)), /recognized/);
  assert.throws(() => parseMuxerCapabilities('\n'.repeat(10001)), /recognized/);
  assert.equal(parseFfmpegVersion('ffmpeg version C:\\private\\build'), null);
});

test('failed discovery shares work, settles, cools down, and retries only on a later request', { timeout: 1000 }, async () => {
  let now = 1000, calls = 0;
  const child = controlledChild();
  const get = createFfmpegCapabilityDiscovery({
    clock: () => now, failureCooldownMs: 50, timeoutMs: 10, terminationGraceMs: 5,
    spawnProcess(_command, args) {
      calls++;
      return calls === 1 ? child : completedChild({ stdout: OUTPUTS.get(args.join(' ')) });
    }
  });
  const first = get();
  assert.equal(get(), first, 'concurrent callers share the pending attempt');
  const failure = await first;
  assert.equal(failure.available, false);
  assert.equal(failure.failureReason, 'timeout');
  assert.equal(get(), first, 'failure is a settled promise during cooldown');
  now += 49;
  assert.equal(await get(), failure);
  assert.equal(calls, 1);
  now += 1;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1, 'no background retry');
  const retry = get();
  assert.notEqual(retry, first);
  assert.equal(get(), retry);
  assert.equal((await retry).available, true);
  assert.equal(calls, 5);
  now += 100000;
  assert.equal(get(), retry, 'success remains cached for the process');
});

test('capability command runner rejects media processing arguments', async () => {
  let spawned = false;
  await assert.rejects(runBoundedCommand(() => { spawned = true; }, ['-i', 'user-media']));
  assert.equal(spawned, false);
});

test('output pipe failure terminates the owned child and settles without exposing diagnostics', { timeout: 1000 }, async () => {
  const child = controlledChild(current => queueMicrotask(() => current.emit('close', 1)));
  const pending = runBoundedCommand(() => child, ['-version'], 4096, { timeoutMs: 50, terminationGraceMs: 5 });
  child.stderr.emit('error', new Error('C:\\private\\pipe failed'));
  await assert.rejects(pending, error => error.discoveryReason === 'command-failed' && !error.message.includes('private'));
  assert.deepEqual(child.signals, ['SIGTERM']);
  assertListenersRemoved(child);
});

test('nonzero process exit settles even when its pipes never emit close', { timeout: 1000 }, async () => {
  const child = controlledChild();
  const pending = runBoundedCommand(() => child, ['-version']);
  child.emit('exit', 1);
  await assert.rejects(pending, error => error.discoveryReason === 'command-failed' && error.terminationConfirmed);
  assert.deepEqual(child.signals, []);
  assertListenersRemoved(child);
});
