'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LOCAL_INPUT_FORMATS, localMediaInputArgs } = require('../local-media-input');
const { createMediaWorkspaceManager, playbackProxyArgs, editedOutputArgs } = require('../media-workspace');

test('local input policy excludes reference demuxers, restricts protocols, and pins inspected demuxers without a codec whitelist', () => {
  for (const name of ['dash', 'hls', 'concat', 'image2', 'sbg', 'imf', 'mxf']) {
    assert.equal(LOCAL_INPUT_FORMATS.includes(name), false);
  }
  const probe = localMediaInputArgs();
  assert.equal(probe[probe.indexOf('-format_whitelist') + 1], LOCAL_INPUT_FORMATS.join(','));
  assert.equal(probe[probe.indexOf('-protocol_whitelist') + 1], 'file');
  assert.equal(probe[probe.indexOf('-enable_drefs') + 1], '0');
  assert.equal(probe[probe.indexOf('-use_absolute_path') + 1], '0');
  assert.equal(probe.includes('-codec_whitelist'), false);
  assert.equal(probe.includes('-f'), false, 'inspection detects media bytes, not an extension');
  const mov = localMediaInputArgs({ formatNames: ['mov', 'mp4'] });
  assert.equal(mov[mov.indexOf('-f') + 1], 'mov');
  assert.equal(mov[mov.indexOf('-enable_drefs') + 1], '0');
  const mkv = localMediaInputArgs({ formatNames: ['matroska', 'webm'] });
  assert.equal(mkv[mkv.indexOf('-f') + 1], 'matroska');
  assert.equal(mkv.includes('-enable_drefs'), false, 'FFmpeg rejects unused MOV AVOptions for MKV');
  assert.throws(() => localMediaInputArgs({ formatNames: ['dash'] }), /Unsupported local media container/);
});

test('source and output-validation probes apply the same policy before opening their input', async () => {
  const manager = createMediaWorkspaceManager();
  const seen = [];
  manager.runOwnedProcess = async (_workspace, command, args, options) => {
    seen.push({ command, args, options });
    return { stdout: JSON.stringify({
      format: { format_name: 'mov,mp4', duration: '2' },
      streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 160, height: 90 }]
    }) };
  };
  await manager.defaultInspectAsset({}, { filePath: 'source.bin' });
  await manager.defaultInspectOutputAsset({}, { filePath: 'edited-output.mp4' });
  assert.equal(seen.length, 2);
  for (const { command, args } of seen) {
    assert.equal(command, 'ffprobe');
    assert.deepEqual(args.slice(2, 2 + localMediaInputArgs().length), localMediaInputArgs());
    assert.ok(args.indexOf('-format_whitelist') < args.length - 1);
  }
});

test('proxy and single/multiple-cut render builders apply the shared policy to the original source', () => {
  const inspection = {
    formatNames: ['mov', 'mp4'], video: { streamIndex: 2 }, audio: { streamIndex: 3 }
  };
  const one = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 1 }] };
  const two = { version: 1, keepRanges: [...one.keepRanges, { startSeconds: 2, endSeconds: 3 }] };
  for (const args of [
    playbackProxyArgs('original.bin', 'proxy.mp4', inspection),
    editedOutputArgs('original.bin', 'edited.mp4', inspection, one),
    editedOutputArgs('original.bin', 'edited.mp4', inspection, two)
  ]) {
    assert.deepEqual(args.slice(4, args.indexOf('-i')), localMediaInputArgs(inspection));
    assert.equal(args[args.indexOf('-i') + 1], 'original.bin');
    assert.equal(args.filter(value => value === '-i').length, 1);
  }
});

test('pre-header local policy rejection is normalized and never exposes diagnostics or paths', async () => {
  const manager = createMediaWorkspaceManager();
  manager.runOwnedProcess = async () => {
    throw Object.assign(new Error('untrusted path'), { diagnostic: "Format not on whitelist 'policy'\nuntrusted path" });
  };
  await assert.rejects(manager.defaultInspectAsset({}, { filePath: 'untrusted path' }), error => {
    const failure = manager.failureFor(error);
    assert.equal(failure.category, 'local_media_unsupported');
    assert.match(failure.title, /self-contained/);
    assert.doesNotMatch(JSON.stringify(failure), /untrusted path|whitelist/);
    return true;
  });
});
