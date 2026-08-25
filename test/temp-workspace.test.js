'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  createProcessWorkRoot,
  createJobWorkDir
} = require('../app-server');

const ROOT = path.join(__dirname, '..');

async function temporarySandbox(t) {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-workspace-test-'));
  t.after(() => fsp.rm(sandbox, { recursive: true, force: true }));
  return sandbox;
}

async function linkDirectory(target, linkPath) {
  await fsp.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

test('startup does not traverse the old predictable temporary path', async (t) => {
  const sandbox = await temporarySandbox(t);
  const linkedTarget = path.join(sandbox, 'linked-target');
  const oldJob = path.join(linkedTarget, 'old-job');
  const marker = path.join(oldJob, 'keep.txt');
  await fsp.mkdir(oldJob, { recursive: true });
  await fsp.writeFile(marker, 'keep', 'utf8');
  await linkDirectory(linkedTarget, path.join(sandbox, 'lvovd'));

  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await fsp.utimes(oldJob, oldTime, oldTime);

  const result = spawnSync(process.execPath, ['-e', "require('./app-server.js')"], {
    cwd: ROOT,
    env: {
      ...process.env,
      TMPDIR: sandbox,
      TMP: sandbox,
      TEMP: sandbox,
      YTDLP_PATH: process.env.YTDLP_PATH
    },
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message || 'app-server import failed');
  assert.equal(await fsp.readFile(marker, 'utf8'), 'keep');
});

test('download workspaces use a real process-private root', async (t) => {
  const sandbox = await temporarySandbox(t);
  const linkedTarget = path.join(sandbox, 'linked-target');
  const marker = path.join(linkedTarget, 'keep.txt');
  await fsp.mkdir(linkedTarget, { recursive: true });
  await fsp.writeFile(marker, 'keep', 'utf8');
  await linkDirectory(linkedTarget, path.join(sandbox, 'lvovd'));

  const workRoot = await createProcessWorkRoot(sandbox);
  const rootStat = await fsp.lstat(workRoot);
  assert.equal(rootStat.isDirectory(), true);
  assert.equal(rootStat.isSymbolicLink(), false);
  assert.equal(path.dirname(workRoot), sandbox);
  assert.match(path.basename(workRoot), /^lvovd-run-/);
  assert.notEqual(workRoot, path.join(sandbox, 'lvovd'));
  assert.equal(await fsp.readFile(marker, 'utf8'), 'keep');

  const jobDir = await createJobWorkDir(workRoot);
  assert.equal(path.dirname(jobDir), workRoot);
  assert.match(path.basename(jobDir), /^job-/);
});
