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
    options: { windowsHide: true, shell: false }
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
