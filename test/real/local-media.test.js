'use strict';

// Required real-tool suite: missing ffmpeg/ffprobe is a failure, never a skip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { localMediaInputArgs } = require('../../local-media-input');
const { createMediaWorkspaceManager } = require('../../media-workspace');
const { getFfmpegCapabilities, hasSoftwareDecoder } = require('../../ffmpeg-capabilities');

let root;
let source;
let reference;
let sibling;
let traceIndex = 0;
const calls = [];
const traceRequired = process.env.LVOVD_TRACE_LOCAL_INPUT === '1';

function ffmpeg(args) {
  return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    windowsHide: true, cwd: root, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe']
  });
}

// Instrument the actual production spawn path, without changing its input
// restrictions. Linux CI additionally records kernel file-open system calls.
function observedSpawn(command, args, options) {
  const recorded = { command, args, diagnostics: '', trace: null };
  calls.push(recorded);
  const childArgs = [...args];
  const level = childArgs.indexOf(command === 'ffprobe' ? '-v' : '-loglevel');
  if (level >= 0) childArgs[level + 1] = 'debug';
  if (traceRequired) {
    recorded.trace = path.join(root, `opens-${traceIndex++}.log`);
    return attach(spawn('strace', ['-f', '-e', 'trace=open,openat', '-o', recorded.trace, command, ...childArgs], options));
  }
  return attach(spawn(command, childArgs, options));
  function attach(child) {
    child.stderr.on('data', chunk => { recorded.diagnostics += chunk.toString(); });
    return child;
  }
}

async function managerFor(t) {
  const tempDir = path.join(root, `intake-${traceIndex++}`);
  await fsp.mkdir(tempDir);
  const manager = createMediaWorkspaceManager({ tempDir, spawnProcess: observedSpawn });
  t.after(() => manager.clearAll());
  return manager;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'real media operation timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function receive(manager, file, displayName = 'fixture.bin', purpose = 'edit') {
  const workspace = await manager.receiveLocalStream(fs.createReadStream(file), { displayName, purpose, claimedType: 'application/octet-stream' });
  await waitFor(() => ['ready', 'error'].includes(workspace.status));
  return workspace;
}

test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-real-media-test-'));
  console.log(execFileSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]);
  console.log(execFileSync('ffprobe', ['-version'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]);
  if (traceRequired) execFileSync('strace', ['-V'], { stdio: 'pipe' });
  source = path.join(root, 'fixture.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source]);
  sibling = path.join(root, 'generated-dependencies');
  await fsp.mkdir(sibling);
  const manifest = path.join(sibling, 'generated.mpd');
  ffmpeg(['-i', source, '-map', '0', '-c', 'copy', '-f', 'dash', manifest.replaceAll('\\', '/')]);
  reference = await fsp.readFile(manifest, 'utf8');
});

test.after(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

for (const [extension, kind, status] of [['mp4', 'mp4', 'already-compatible'], ['mov', 'mov', 'remux'], ['mkv', 'matroska', 'remux']]) {
  test(`real Convert ${extension} container identity and assessment without a proxy or output`, async t => {
    const manager = await managerFor(t);
    const file = path.join(root, `convert.${extension}`);
    ffmpeg([...localMediaInputArgs(), '-i', source, '-c', 'copy', file]);
    const raw = JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));
    if (extension === 'mov') assert.equal(raw.format.tags.major_brand.trim(), 'qt');
    if (extension === 'mp4') assert.equal(raw.format.tags.major_brand.trim(), 'isom');
    const start = calls.length;
    const workspace = await receive(manager, file, 'misleading-name.data', 'convert');
    assert.equal(workspace.status, 'ready', JSON.stringify(workspace.failure));
    assert.equal(workspace.inspection.container.kind, kind);
    assert.equal(workspace.compatibility.status, status);
    assert.equal(workspace.inspection.sourceSize, (await fsp.stat(file)).size);
    assert.deepEqual(calls.slice(start).map(call => call.command), ['ffprobe']);
    assert.ok(calls[start].args.includes('-format_whitelist'));
    assert.ok(calls[start].args.includes('-enable_drefs'));
    const state = manager.publicWorkspace(workspace);
    assert.equal(state.playback, null);
    assert.equal(state.editedOutput, null);
    assert.deepEqual(state.assets.map(asset => asset.role), ['source']);
    console.log(JSON.stringify({ conversionFixture: extension, container: state.inspection.container, assessment: status }));
  });
}

test('real Convert audio-only intake succeeds without loosening Edit eligibility', async t => {
  const manager = await managerFor(t);
  const file = path.join(root, 'convert-audio.flac');
  ffmpeg([...localMediaInputArgs(), '-i', source, '-vn', '-c:a', 'flac', file]);
  const workspace = await receive(manager, file, 'audio.bin', 'convert');
  assert.equal(workspace.status, 'ready');
  assert.equal(workspace.inspection.mediaKind, 'audio');
  assert.equal(workspace.compatibility.status, 'not-applicable');
  assert.equal(workspace.playbackAssetId, null);
  assert.equal((await receive(manager, file)).status, 'error');
});

test('real installed FFmpeg listings produce codec-to-software-decoder evidence', async () => {
  const capabilities = await getFfmpegCapabilities();
  assert.equal(capabilities.available, true);
  assert.ok(capabilities.version);
  assert.ok(capabilities.encoders.has('libx264'));
  assert.ok(capabilities.encoders.has('aac'));
  assert.ok(capabilities.muxers.has('mp4'));
  assert.ok(hasSoftwareDecoder(capabilities, 'h264'));
  assert.ok(hasSoftwareDecoder(capabilities, 'aac'));
  assert.ok(hasSoftwareDecoder(capabilities, 'mp3'));
  assert.ok(capabilities.decoderCodecs.get('mp3').some(decoder => decoder.name === 'mp3float' && decoder.software));
});

for (const extension of ['mp4', 'mov', 'mkv', 'webm', 'avi', 'ts']) {
  test(`real ${extension} intake, playback preparation, edited rendering, and output validation retain the local policy`, async t => {
    const manager = await managerFor(t);
    const file = path.join(root, `ordinary.${extension}`);
    const codec = extension === 'webm' ? ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'] : ['-c', 'copy'];
    ffmpeg(['-i', source, ...codec, file]);
    const workspace = await receive(manager, file, 'misleading-extension.data');
    assert.equal(workspace.status, 'ready', JSON.stringify(workspace.failure));
    assert.equal(workspace.inspection.video.width, 160);
    assert.ok(workspace.playbackAssetId);
    if (['mkv', 'webm', 'avi', 'ts'].includes(extension)) assert.equal(workspace.playbackProxy, true);
    const sourceAsset = workspace.assets.get(workspace.sourceAssetId);
    const callStart = calls.length;
    await manager.startRender(workspace.id, { version: 1, keepRanges: [
      { startSeconds: 0, endSeconds: 0.5 }, { startSeconds: 1, endSeconds: 1.5 }
    ] });
    await waitFor(() => ['ready', 'error'].includes(workspace.render.status));
    assert.equal(workspace.render.status, 'ready', JSON.stringify(workspace.render.failure));
    const output = manager.publicWorkspace(workspace).editedOutput;
    assert.ok(Math.abs(output.inspection.durationSeconds - 1) < 0.2);
    const renderCall = calls.slice(callStart).find(call => call.command === 'ffmpeg');
    assert.equal(renderCall.args[renderCall.args.indexOf('-i') + 1], sourceAsset.filePath);
    const outputProbe = calls.slice(callStart).find(call => call.command === 'ffprobe');
    assert.ok(outputProbe.args.includes('-format_whitelist'));
  });
}

test('real ordinary audio containers still probe under the policy, while audio/cover-art remains editor-ineligible', async t => {
  const manager = await managerFor(t);
  for (const [extension, codec] of [['wav', 'pcm_s16le'], ['flac', 'flac'], ['mp3', 'libmp3lame'], ['m4a', 'aac'], ['ogg', 'libvorbis']]) {
    const file = path.join(root, `audio.${extension}`);
    ffmpeg(['-i', source, '-vn', '-c:a', codec, file]);
    const raw = JSON.parse(execFileSync('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-show_streams', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));
    assert.ok(raw.streams.some(stream => stream.codec_type === 'audio'));
    assert.equal((await receive(manager, file)).status, 'error');
  }
  const cover = path.join(root, 'cover.jpg');
  ffmpeg(['-i', source, '-frames:v', '1', cover]);
  const coveredAudio = path.join(root, 'covered.mp3');
  ffmpeg(['-i', path.join(root, 'audio.mp3'), '-i', cover, '-map', '0:a', '-map', '1:v', '-c', 'copy', '-disposition:v', 'attached_pic', coveredAudio]);
  const workspace = await receive(manager, coveredAudio);
  assert.equal(workspace.status, 'error');
  assert.equal(workspace.playbackAssetId, null);
});

test('generated reference input is rejected before dependency reads through upload and URL-file adoption despite its name', async t => {
  for (const origin of ['local', 'url', 'convert']) {
    const manager = await managerFor(t);
    const workspace = await manager.createUrlWorkspace({ displayName: 'looks-like-video.mp4' });
    const ownedDirectory = workspace.tempDir;
    const relative = path.relative(ownedDirectory, sibling).replaceAll('\\', '/') + '/';
    const bytes = Buffer.from(reference.replace('<Period ', `<BaseURL>${relative}</BaseURL><Period `));
    const start = calls.length;
    let target = workspace;
    if (origin !== 'url') {
      await manager.discard(workspace.id);
      // Both intake workspaces have the same depth under their owned root.
      target = await manager.receiveLocalStream(Readable.from(bytes), { displayName: 'looks-like-video.mp4', claimedType: 'video/mp4',
        purpose: origin === 'convert' ? 'convert' : 'edit' });
      await waitFor(() => target.status === 'error' || target.status === 'ready');
    } else {
      const file = path.join(workspace.tempDir, 'source.mp4');
      await fsp.writeFile(file, bytes);
      await manager.adoptAcquiredFile(workspace.id, file);
    }
    assert.equal(target.status, 'error');
    assert.equal(target.failure.category, 'local_media_unsupported');
    assert.equal(target.tempDir, null);
    assert.deepEqual(manager.publicWorkspace(target).assets, []);
    assert.equal(manager.publicWorkspace(target).playback, null);
    assert.equal(manager.publicWorkspace(target).editedOutput, null);
    assert.equal(manager.cleanupStatus(target).status, 'complete');
    const probe = calls.slice(start).find(call => call.command === 'ffprobe');
    assert.match(probe.diagnostics, /Format not on whitelist/);
    assert.doesNotMatch(probe.diagnostics, /DASH request for url|init-stream|chunk-stream/);
    assert.equal(calls.slice(start).some(call => call.command === 'ffmpeg'), false);
    if (traceRequired) {
      const opens = await fsp.readFile(probe.trace, 'utf8');
      assert.doesNotMatch(opens, /generated-dependencies|init-stream|chunk-stream/);
      assert.match(opens, /source\.(bin|mp4)/, 'trace observes the owned top-level open');
    }
  }
});

test('MOV external-track aliases remain disabled and do not publish a misleading ready workspace', async t => {
  const manager = await managerFor(t);
  // Modify only generated fixture metadata; the external target is also a
  // generated media file in this disposable test root.
  function atom(type, body) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(body.length + 8); header.write(type, 4, 4, 'ascii');
    return Buffer.concat([header, body]);
  }
  const aliasPath = Buffer.from('generated-dependencies:fixture.mp4\0');
  const field = Buffer.alloc(4);
  field.writeUInt16BE(2); field.writeUInt16BE(aliasPath.length, 2);
  const alias = atom('alis', Buffer.concat([
    Buffer.alloc(4 + 10 + 28 + 12 + 64 + 16 + 4 + 16), field, aliasPath,
    aliasPath.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0), Buffer.from([255, 255, 0, 0])
  ]));
  function rewrite(buffer) {
    const pieces = [];
    for (let offset = 0; offset < buffer.length;) {
      const size = buffer.readUInt32BE(offset);
      assert.ok(size >= 8 && offset + size <= buffer.length);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      let body = buffer.subarray(offset + 8, offset + size);
      if (['moov', 'trak', 'mdia', 'minf', 'dinf'].includes(type)) body = rewrite(body);
      if (type === 'dref') body = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), alias]);
      pieces.push(atom(type, body)); offset += size;
    }
    return Buffer.concat(pieces);
  }
  await fsp.copyFile(source, path.join(sibling, 'fixture.mp4'));
  const file = path.join(root, 'external-tracks.mov');
  await fsp.writeFile(file, rewrite(await fsp.readFile(source)));
  const start = calls.length;
  const workspace = await receive(manager, file);
  assert.equal(workspace.status, 'error');
  assert.equal(workspace.failure.category, 'local_media_unsupported');
  assert.equal(manager.publicWorkspace(workspace).playback, null);
  assert.equal(manager.cleanupStatus(workspace).status, 'complete');
  const probe = calls[start];
  assert.match(probe.diagnostics, /Skipped opening external track/);
  if (traceRequired) assert.doesNotMatch(await fsp.readFile(probe.trace, 'utf8'), /generated-dependencies/);
});

test('the real localhost upload/progress/media boundary exposes no usable URLs for a rejected reference file', async t => {
  process.env.HOST = '127.0.0.1';
  process.env.PORT = String(35000 + process.pid % 10000);
  process.env.YTDLP_PATH = process.execPath; // no source operation is performed
  process.env.LVOVD_DATA_DIR = path.join(root, 'unused-history');
  const { mediaWorkspaces } = require('../../app-server');
  const { server } = require('../../server');
  mediaWorkspaces.tempDir = root;
  mediaWorkspaces.spawnProcess = observedSpawn;
  await new Promise(resolve => server.listen(Number(process.env.PORT), '127.0.0.1', resolve));
  t.after(async () => {
    await mediaWorkspaces.clearAll();
    await new Promise(resolve => server.close(resolve));
  });
  const request = (pathname, method = 'GET', body = null) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), path: pathname, method,
      headers: { Origin: `http://127.0.0.1:${process.env.PORT}`, 'Sec-Fetch-Site': 'same-origin', Connection: 'close',
        ...(body ? { 'Content-Length': body.length, 'Content-Type': 'video/mp4', 'X-LVOVD-Filename': 'fixture.mp4' } : {}) }
    }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(body);
  });
  const created = await request('/api/workspace/local', 'POST', Buffer.from(reference));
  assert.equal(created.status, 202);
  const workspace = mediaWorkspaces.get(created.data.workspaceId);
  await waitFor(() => workspace.status === 'error');
  assert.equal(workspace.failure.category, 'local_media_unsupported');
  const state = mediaWorkspaces.publicWorkspace(workspace);
  assert.equal(state.cleanup.status, 'complete');
  assert.equal(state.playback, null);
  assert.equal((await request(`/api/workspace/media?workspace=${workspace.id}&asset=unknown`)).status, 404);
  assert.equal((await request(`/api/workspace/output?workspace=${workspace.id}&asset=unknown`)).status, 404);
  assert.equal((await request(`/api/workspace?workspace=${workspace.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/workspace/progress?workspace=${workspace.id}`)).status, 404);
  await assert.rejects(fsp.stat(process.env.LVOVD_DATA_DIR), { code: 'ENOENT' });
});
