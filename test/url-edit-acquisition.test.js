'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  normalizeWorkspaceAcquisition,
  runWorkspaceAcquisition,
  mediaWorkspaces,
  historyStore,
  jobs
} = require('../app-server');

const DIRECT_INSPECTION = Object.freeze({
  durationSeconds: 6,
  format: 'MP4',
  formatNames: ['mov', 'mp4'],
  video: { streamIndex: 0, codec: 'h264', width: 640, height: 360, frameRate: 30 },
  audio: { streamIndex: 1, codec: 'aac' },
  trackCounts: { audio: 1, subtitle: 0 }
});

function successfulYtdlpFixture(bytes, observed) {
  return (_command, args, options) => {
    observed.push({ args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(async () => {
      const outputTemplate = args[args.indexOf('--output') + 1];
      const outputPath = outputTemplate.replace('%(ext)s', 'mp4');
      await fsp.writeFile(outputPath, bytes);
      child.stdout.write('__LVOVD_WORKSPACE_PROGRESS__8|16|NA|4|2|50%\n');
      child.stdout.write('__LVOVD_WORKSPACE_PROGRESS__16|16|NA|4|0|100%\n');
      child.emit('close', 0);
    });
    return child;
  };
}

test.beforeEach(async () => {
  await mediaWorkspaces.clearAll();
});

test.after(async () => {
  await mediaWorkspaces.clearAll();
});

test('synthetic URL acquisition produces one authoritative ready workspace without History', async () => {
  const originalInspect = mediaWorkspaces.inspectAsset;
  const historyBefore = await historyStore.list();
  const jobCountBefore = jobs.size;
  const observed = [];
  mediaWorkspaces.inspectAsset = async () => DIRECT_INSPECTION;
  try {
    const workspace = await mediaWorkspaces.createUrlWorkspace({
      displayName: 'Fixture clip',
      sourceName: 'Fixture source'
    });
    await runWorkspaceAcquisition(
      workspace,
      'https://fixture.example/video',
      normalizeWorkspaceAcquisition({
        content: 'av',
        profile: 'compatible',
        maxHeight: 720,
        sourceFormat: { mode: 'automatic' }
      }),
      { title: 'Fixture clip', sourceName: 'Fixture source' },
      { spawnProcess: successfulYtdlpFixture(Buffer.from('synthetic acquired MP4'), observed) }
    );

    const snapshot = mediaWorkspaces.publicWorkspace(workspace);
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.source.origin, 'url');
    assert.equal(snapshot.source.name, 'Fixture clip.mp4');
    assert.equal(snapshot.playback.proxy, false);
    assert.equal(snapshot.playback.role, 'source');
    assert.deepEqual(snapshot.assets.map((asset) => asset.role), ['source']);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].options.shell, false);
    assert.equal(observed[0].args.includes('--no-playlist'), true);
    assert.equal(observed[0].args.includes('--max-filesize'), true);
    assert.equal(jobs.size, jobCountBefore);
    assert.deepEqual(await historyStore.list(), historyBefore);

    const sourceAsset = workspace.assets.get(workspace.sourceAssetId);
    assert.equal(path.dirname(sourceAsset.filePath), workspace.tempDir);
    assert.match(path.basename(sourceAsset.filePath), /^original-source\.mp4$/);
  } finally {
    mediaWorkspaces.inspectAsset = originalInspect;
  }
});

test('discard kills an active URL acquisition and removes the authoritative workspace', async () => {
  let child;
  let killed = false;
  const spawnProcess = () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      if (killed) return;
      killed = true;
      setImmediate(() => child.emit('close', 1));
    };
    return child;
  };
  const workspace = await mediaWorkspaces.createUrlWorkspace({
    displayName: 'Cancel fixture',
    sourceName: 'Fixture source'
  });
  const acquisition = runWorkspaceAcquisition(
    workspace,
    'https://fixture.example/video',
    normalizeWorkspaceAcquisition({
      content: 'video', profile: 'maximum', maxHeight: null, sourceFormat: { mode: 'automatic' }
    }),
    { title: 'Cancel fixture', sourceName: 'Fixture source' },
    { spawnProcess }
  );
  workspace.activePromise = acquisition;
  acquisition.catch(() => {});

  while (!child) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workspace.status, 'acquiring');
  assert.equal(await mediaWorkspaces.discard(workspace.id), true);
  assert.equal(killed, true);
  await assert.rejects(acquisition, /cancelled/i);
  assert.equal(mediaWorkspaces.get(workspace.id, { touch: false }), null);
});
