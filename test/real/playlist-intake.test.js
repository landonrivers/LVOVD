'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { managedBinaryPath } = require('../../ytdlp-manager');
const { playlistSource } = require('../helpers/playlist-source');
const { localMediaInputArgs } = require('../../local-media-input');
function tool(command, args) { return childProcess.execFileSync(command, args, { windowsHide: true, shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }); }
function markers(file, pairs, sourceIndex) {
  const raw = JSON.parse(tool('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-show_streams', '-show_format', '-show_frames', '-of', 'json', file]));
  const video = raw.streams.find(item => item.codec_type === 'video');
  assert.equal(video.codec_name, 'h264'); assert.equal(raw.streams.find(item => item.codec_type === 'audio').codec_name, 'aac');
  const duration = pairs.reduce((sum, [start, end]) => sum + end - start, 0);
  assert.ok(Math.abs(Number(raw.format.duration) - duration) <= 0.11);
  const frames = raw.frames.filter(frame => frame.media_type === 'video');
  assert.ok(Math.abs(frames.length - duration * 10) <= 1);
  const input = localMediaInputArgs({ formatNames: raw.format.format_name.split(',') });
  const pixels = tool('ffmpeg', ['-v', 'error', ...input, '-i', file, '-map', '0:v:0', '-fps_mode', 'passthrough', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
  const audio = tool('ffmpeg', ['-v', 'error', ...input, '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
  let offset = 0;
  for (const [start, end] of pairs) {
    for (let local = 0.25; local + 0.1 < end - start; local += 0.3) {
      const source = start + local; if (source % 1 > 0.8) continue;
      const frameIndex = frames.findIndex(frame => Number(frame.best_effort_timestamp_time) >= offset + local);
      assert.ok(frameIndex >= 0);
      const frameSource = start + Number(frames[frameIndex].best_effort_timestamp_time) - offset;
      const expected = Math.round((40 + sourceIndex * 20 + 10 * Math.floor(frameSource) - 16) * 255 / 219);
      assert.ok(Math.abs(pixels[frameIndex * 96 * 64 + 97] - expected) <= 10, 'correct original file and retained frame');
      const first = Math.round((offset + local) * 48000), count = Math.round(0.08 * 48000); let crossings = 0, sum = 0;
      for (let i = first; i < first + count; i++) { const value = audio.readFloatLE(i * 4); sum += value * value;
        if (i > first && audio.readFloatLE((i - 1) * 4) <= 0 && value > 0) crossings++; }
      assert.ok(Math.sqrt(sum / count) > 0.04);
      assert.ok(Math.abs(crossings / 0.08 - (400 + sourceIndex * 300 + 100 * Math.floor(source))) < 20, 'correct original file and retained tone');
    }
    offset += end - start;
  }
}

test('real generic playlist Preview imports only selected pages and processes two isolated original sources', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-playlist-real-'));
  const fixture = await playlistSource(root), calls = [];
  const originalSpawn = childProcess.spawn, binary = managedBinaryPath();
  let app, active = 0, maximumActive = 0;
  childProcess.spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = originalSpawn(command, args, options);
    if (command === binary) { maximumActive = Math.max(maximumActive, ++active); child.once('close', () => active--); }
    return child;
  };
  process.env.YTDLP_PATH = binary; process.env.LVOVD_DATA_DIR = path.join(root, 'history');
  app = require('../../app-server'); app.mediaWorkspaces.tempDir = root;
  t.after(async () => { await app.mediaWorkspaces.clearAll(); await fixture.close(); childProcess.spawn = originalSpawn; await fs.rm(root, { recursive: true, force: true }); });
  console.log(`Playlist integration tools: ${tool(binary, ['--ignore-config', '--version']).toString().trim()}; ${tool('ffprobe', ['-version']).toString().split('\n')[0]}`);
  const history = await app.historyStore.list(), initialJobs = app.jobs.size;
  const info = await app.remoteSourceRequests.preview(fixture.url, async () => app.playlistIntake.remember(await app.fetchInfo(fixture.url)));
  assert.equal(info.kind, 'playlist'); assert.equal(info.entries.length, 3);
  assert.equal(fixture.requests.some(item => item.path.startsWith('/item-')), false, 'flat Preview does not preflight each item');
  assert.deepEqual(info.entries.map(item => new URL(item.url).pathname), ['/item-0', '/item-1', '/item-2']);
  const queue = app.mediaWorkspaces.localProcessing, collection = queue.get(queue.createCollection().id);
  const response = app.playlistIntake.admit({ collectionId: collection.id, previewId: info.playlistImportId, requestId: crypto.randomUUID(),
    entryUrls: [info.entries[2].url, info.entries[0].url, info.entries[2].url], acquisition: { content: 'av', profile: 'maximum', maxHeight: null, sourceFormat: { mode: 'automatic' } } });
  assert.equal(response.intake.items.length, 2); await collection.intake.promise;
  const imported = queue.snapshot(collection.id);
  assert.equal(imported.intake.status, 'ready', JSON.stringify(imported.intake));
  assert.deepEqual(imported.workspaces.map(item => item.source.name), ['Generated item 0.mp4', 'Generated item 2.mp4']);
  assert.equal(fixture.requests.some(item => /(?:item|source)-1/.test(item.path)), false);
  assert.equal(fixture.requests.filter(item => item.path === '/feed.xml').length, 1);
  assert.equal(maximumActive, 1); assert.equal(app.jobs.size, initialJobs); assert.deepEqual(await app.historyStore.list(), history);
  assert.equal(calls.filter(item => item.command === binary).length, 3, 'one Preview plus exactly two acquisitions');
  for (const call of calls.filter(item => item.command === binary).slice(1)) {
    assert.ok(call.args.includes('--no-playlist')); assert.ok(call.args.includes('--ignore-config')); assert.equal(call.options.shell, false);
    assert.ok(call.args.at(-1).includes('/item-')); assert.equal(call.args.includes('--download-sections'), false);
  }
  const ranges = [[[0, 1], [4, 6]], [[1, 2], [3, 5]]], reviewed = [];
  for (let i = 0; i < imported.workspaces.length; i++) {
    const snapshot = imported.workspaces[i], workspace = app.mediaWorkspaces.get(snapshot.id);
    assert.equal(snapshot.playback, null); assert.equal(snapshot.inspection.durationSeconds, 6);
    const source = workspace.assets.get(workspace.sourceAssetId);
    assert.deepEqual(await fs.readFile(source.filePath), fixture.files[i * 2].bytes);
    markers(source.filePath, [[0, 6]], i * 2);
    const intent = { workspaceId: workspace.id, sourceAssetId: workspace.sourceAssetId, draftRevision: 1,
      editPlan: { version: 1, keepRanges: ranges[i].map(([startSeconds, endSeconds]) => ({ startSeconds, endSeconds })) },
      settings: { videoCodec: 'h264', container: 'mp4', audio: { codec: 'aac', bitrateKbps: 128 }, filenameSuffix: `_selected_${i}` } };
    const plan = await app.mediaWorkspaces.processing.plan(intent); assert.equal(plan.status, 'executable', JSON.stringify(plan));
    reviewed.push({ ...intent, planKey: plan.key, acknowledgedWarnings: plan.warnings.map(item => item.id) });
  }
  await queue.enqueue(collection.id, reviewed);
  const deadline = Date.now() + 30000;
  while (queue.snapshot(collection.id).jobs.some(job => ['queued', 'starting', 'running'].includes(job.status))) {
    assert.ok(Date.now() < deadline, 'real processing completes'); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(queue.snapshot(collection.id).jobs.every(job => job.status === 'completed'));
  for (let i = 0; i < imported.workspaces.length; i++) {
    const workspace = app.mediaWorkspaces.get(imported.workspaces[i].id), output = workspace.conversion.output;
    markers(workspace.assets.get(output.assetId).filePath, ranges[i], i * 2);
    assert.equal(output.provenance.inputAssetId, workspace.sourceAssetId);
  }
  assert.equal(calls.filter(item => item.command === binary).length, 3, 'local processing never reacquires');
  assert.equal(app.jobs.size, initialJobs); assert.deepEqual(await app.historyStore.list(), history);
});
