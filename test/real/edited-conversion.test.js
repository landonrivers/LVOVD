'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { createMediaWorkspaceManager } = require('../../media-workspace');
const { localMediaInputArgs } = require('../../local-media-input');

let root, source;
const A = { version: 1, keepRanges: [{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 6, endSeconds: 9 }] };
const B = { version: 1, keepRanges: [{ startSeconds: 1, endSeconds: 5 }] };
function run(command, args) { return execFileSync(command, args, { windowsHide: true, shell: false, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }); }
function ffmpeg(args) { return run('ffmpeg', ['-v', 'error', '-y', ...args]); }
function decode(file, inspection) { return ffmpeg([...localMediaInputArgs(inspection), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']); }
function frequency(bytes, start, end) {
  const first = Math.round(start * 48000), last = Math.round(end * 48000);
  assert.ok(bytes.length >= last * 4); let crossings = 0;
  for (let i = first + 1; i < last; i++) if (bytes.readFloatLE((i - 1) * 4) <= 0 && bytes.readFloatLE(i * 4) > 0) crossings++;
  return crossings / (end - start);
}
function markers(bytes, expected) {
  // Half-second analysis windows stay far from cuts/priming. Crossing-count
  // resolution is 2 Hz; 8 Hz allows AAC/MP3 edge ripple, never a wrong section.
  for (const [start, hz] of expected) assert.ok(Math.abs(frequency(bytes, start, start + 0.5) - hz) <= 8, `marker at ${start}s must be ${hz} Hz`);
}
async function setup(t) {
  const calls = [];
  const manager = createMediaWorkspaceManager({ tempDir: root, spawnProcess: (command, args, options) => { calls.push({ command, args }); return spawn(command, args, options); } });
  t.after(() => manager.clearAll());
  const workspace = await manager.receiveLocalStream(fs.createReadStream(source), { displayName: 'generated-sections.mkv', purpose: 'local' });
  await workspace.activePromise; assert.equal(workspace.status, 'ready');
  manager.prepareEditor(workspace.id, workspace.sourceAssetId); await workspace.activePromise; assert.equal(workspace.editor.status, 'ready');
  const render = async plan => { manager.startRender(workspace.id, plan); await workspace.activePromise; assert.equal(workspace.render.status, 'ready', JSON.stringify(workspace.render.failure)); return workspace.assets.get(workspace.render.outputAssetId); };
  const convert = async (asset, targetId) => {
    const editPlan = asset.role === 'edited-output' ? asset.editPlan : undefined;
    const plan = await manager.conversions.plan(workspace.id, asset.id, targetId, editPlan);
    assert.ok(['executable', 'no-op'].includes(plan.status), JSON.stringify(plan));
    await manager.conversions.start({ workspaceId: workspace.id, inputAssetId: asset.id, editPlan, targetId, planKey: plan.key }); await workspace.activePromise;
    assert.equal(workspace.conversion.status, 'ready', JSON.stringify(workspace.conversion.failure));
    return { output: workspace.conversion.output, asset: manager.conversions.resolve(workspace.id, workspace.conversion.output.assetId).asset, plan };
  };
  return { manager, workspace, calls, render, convert };
}

test.before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-edited-conversion-real-')); source = path.join(root, 'sections.mkv');
  console.log(run('ffmpeg', ['-version']).toString().split(/\r?\n/)[0]); run('ffprobe', ['-version']);
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:size=96x64:rate=20:duration=9', '-f', 'lavfi', '-i', 'aevalsrc=0.125*sin(2*PI*(400+400*floor(t/3))*t):s=48000:d=9:n=480',
    '-vf', "geq=lum='40+70*floor(T/3)':cb=128:cr=128", '-c:v', 'ffv1', '-c:a', 'pcm_s16le', source]);
  const raw = JSON.parse(run('ffprobe', ['-v', 'error', ...localMediaInputArgs(), '-show_streams', '-show_frames', '-of', 'json', source]));
  const video = raw.frames.filter(frame => frame.media_type === 'video');
  assert.equal(Number(video[0].best_effort_timestamp_time), 0); assert.equal(Number(video.at(-1).best_effort_timestamp_time), 8.95);
  const audio = raw.frames.filter(frame => frame.media_type === 'audio'); assert.equal(Number(audio[0].best_effort_timestamp_time), 0);
});
test.after(async () => { if (root) await fsp.rm(root, { recursive: true, force: true }); });

for (const target of ['m4a-aac', 'mp3']) {
  test(`real edited → ${target} contains retained markers only; original → ${target} preserves the nine-second original`, async t => {
    const { workspace, render, convert, calls } = await setup(t); const edited = await render(A);
    assert.ok(Math.abs(edited.inspection.durationSeconds - 6) <= 0.06);
    const handoff = await convert(edited, target);
    assert.equal(handoff.plan.inputDurationSeconds, edited.inspection.durationSeconds);
    const editedPcm = decode(handoff.asset.filePath, handoff.output.inspection);
    assert.ok(Math.abs(editedPcm.length / (4 * 48000) - 6) <= 0.06);
    markers(editedPcm, [[0.5, 400], [2.2, 400], [3.5, 1200], [5.2, 1200]]);
    assert.equal(calls.filter(call => call.command === 'ffmpeg').at(-1).args.includes(edited.filePath), true);
    assert.equal(handoff.output.provenance.inputRole, 'edited-output');
    if (target === 'm4a-aac') assert.equal(handoff.plan.streams[0].action, 'copy');
    const original = await convert(workspace.assets.get(workspace.sourceAssetId), target);
    const originalPcm = decode(original.asset.filePath, original.output.inspection);
    assert.ok(Math.abs(originalPcm.length / (4 * 48000) - 9) <= 0.06);
    markers(originalPcm, [[0.5, 400], [3.5, 800], [6.5, 1200]]);
    assert.equal(original.output.provenance.inputRole, 'source');
    console.log(JSON.stringify({ handoffTarget: target, editedDuration: editedPcm.length / 192000, originalDuration: originalPcm.length / 192000,
      editedMarkersHz: [frequency(editedPcm, 0.5, 1), frequency(editedPcm, 3.5, 4)], originalMiddleHz: frequency(originalPcm, 3.5, 4) }));
  });
}

test('real edited MP4 no-op retains identical A bytes after rendering B, then releases A on successful replacement', async t => {
  const { manager, workspace, render, convert, calls } = await setup(t); const editedA = await render(A);
  const before = calls.length, files = await fsp.readdir(workspace.tempDir), bytes = await fsp.readFile(editedA.filePath);
  const alias = await convert(editedA, 'broad-compatibility-mp4');
  assert.equal(alias.plan.status, 'no-op'); assert.equal(calls.length, before); assert.deepEqual(await fsp.readdir(workspace.tempDir), files);
  assert.deepEqual(await fsp.readFile(alias.asset.filePath), bytes);
  const editedB = await render(B); assert.notEqual(editedA.id, editedB.id);
  assert.equal(workspace.conversion.output, alias.output); assert.equal(manager.resolveOutputAsset(workspace.id, editedA.id), null);
  assert.deepEqual(await fsp.readFile(manager.conversions.resolve(workspace.id, editedA.id).asset.filePath), bytes);
  markers(decode(editedA.filePath, editedA.inspection), [[0.5, 400], [3.5, 1200]]);
  markers(decode(editedB.filePath, editedB.inspection), [[0.5, 400], [2.5, 800]]);
  await convert(editedB, 'm4a-aac'); await assert.rejects(fsp.stat(editedA.filePath), { code: 'ENOENT' });
  assert.equal(manager.conversions.resolve(workspace.id, editedA.id), null); assert.equal(workspace.retiredOutputs.size, 0);
});
