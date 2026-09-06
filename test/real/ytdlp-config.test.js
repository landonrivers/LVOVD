'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { managedBinaryPath } = require('../../ytdlp-manager');

async function waitFor(predicate) {
  const deadline = Date.now() + 30000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'localhost yt-dlp operation timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('managed yt-dlp ignores unrelated config while Preview, Download, URL Edit, explicit options, and default plugins still work', { timeout: 90000 }, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lvovd-ytdlp-config-test-'));
  let local;
  let app;
  const originalSpawn = childProcess.spawn;
  t.after(async () => {
    if (app) {
      await app.mediaWorkspaces.clearAll();
      for (const job of app.jobs.values()) {
        if (job.historyPromise) await job.historyPromise;
        await app.cleanupJob(job);
      }
      await fsp.rm(await app.createProcessWorkRoot(), { recursive: true, force: true });
    }
    childProcess.spawn = originalSpawn;
    if (local?.listening) await new Promise(resolve => local.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  });
  // Copy only the managed executable, never local plugin/configuration files.
  const managed = managedBinaryPath();
  const binary = path.join(root, path.basename(managed));
  await fsp.copyFile(managed, binary); // A missing managed executable fails this required suite.
  if (process.platform !== 'win32') await fsp.chmod(binary, 0o700);
  const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
  assert.equal(hash(await fsp.readFile(binary)), hash(await fsp.readFile(managed)));
  const isolatedEnv = { ...process.env,
    HOME: root, USERPROFILE: root, APPDATA: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
    PYTHONPATH: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost'
  };
  // This portable config stops further config loading in the control run, so
  // even the intentionally unisolated control cannot read real user options.
  await fsp.writeFile(path.join(root, 'yt-dlp.conf'), '--ignore-config\n--print pre_process:LVOVD_CONFIG_ONLY_MARKER=%(id)s\n--write-info-json\n');
  const pluginDir = path.join(root, 'yt-dlp-plugins', 'fixture', 'yt_dlp_plugins', 'extractor');
  await fsp.mkdir(pluginDir, { recursive: true });
  await fsp.writeFile(path.join(pluginDir, 'local_fixture.py'), `from yt_dlp.extractor.common import InfoExtractor

class LocalFixtureIE(InfoExtractor):
    _VALID_URL = r'http://127\\.0\\.0\\.1:[0-9]+/fixture\\.mp4'
    def _real_extract(self, url):
        return {'id': 'local-fixture', 'title': 'Generated plugin fixture', 'duration': 2,
                'formats': [{'format_id': 'fixture', 'url': url, 'ext': 'mp4',
                             'vcodec': 'avc1', 'acodec': 'mp4a', 'width': 160, 'height': 90}]}
`);
  const fixture = path.join(root, 'generated.mp4');
  childProcess.execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=sample_rate=48000',
    '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', fixture], { cwd: root, windowsHide: true, timeout: 20000 });
  const bytes = await fsp.readFile(fixture);
  let requests = 0;
  local = http.createServer((req, res) => {
    assert.equal(req.url, '/fixture.mp4');
    requests++;
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${local.address().port}/fixture.mp4`;
  const exec = (args) => new Promise((resolve, reject) => {
    childProcess.execFile(binary, args, { env: isolatedEnv, cwd: root, windowsHide: true, timeout: 30000 },
      (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  console.log(`Managed yt-dlp: ${(await exec(['--ignore-config', '--version'])).stdout.trim()}`);
  const control = await exec(['--simulate', '--no-playlist', url]);
  assert.match(control.stdout, /LVOVD_CONFIG_ONLY_MARKER/, 'control proves the disposable config is discoverable');
  assert.match(control.stdout, /local-fixture/);

  const sourceCalls = [];
  childProcess.spawn = (command, args, options) => {
    if (command === binary) sourceCalls.push(args);
    return originalSpawn(command, args, { ...options, env: isolatedEnv, cwd: root });
  };
  process.env.YTDLP_PATH = binary;
  process.env.LVOVD_DATA_DIR = path.join(root, 'history');
  app = require('../../app-server');
  app.mediaWorkspaces.tempDir = root;
  const info = await app.fetchRawInfo(url);
  assert.equal(info.title, 'Generated plugin fixture', 'default plugin discovery survives --ignore-config');
  assert.equal(info.id, 'local-fixture');
  const chapterInfo = await app.fetchRawInfo(url, { playlist: false });
  assert.equal(chapterInfo.id, info.id);
  const job = await app.startDownload(url, { content: 'av', profile: 'maximum' }, {});
  await waitFor(() => ['ready', 'error'].includes(job.status));
  assert.equal(job.status, 'ready', JSON.stringify(job.failure));
  assert.equal(job.outputs.length, 1);
  assert.equal(job.outputs[0].filename.endsWith('.mp4'), true);
  assert.equal((await fsp.readdir(job.tempDir)).some(name => name.endsWith('.info.json')), false);
  const workspace = await app.startWorkspaceAcquisition(url, {
    content: 'av', profile: 'maximum', maxHeight: null, sourceFormat: { mode: 'auto' }
  }, { title: 'Generated fixture', sourceName: 'Local test' });
  await waitFor(() => ['ready', 'error'].includes(workspace.status));
  assert.equal(workspace.status, 'ready', JSON.stringify(workspace.failure));
  assert.equal(workspace.source.origin, 'url');
  assert.equal(workspace.inspection.video.codec, 'h264');
  assert.equal((await fsp.readdir(workspace.tempDir)).some(name => name.endsWith('.info.json')), false);
  assert.ok(requests >= 2, 'real Download and URL Edit each acquire the localhost media fixture');
  assert.equal(sourceCalls.length, 4);
  for (const args of sourceCalls) {
    assert.equal(args[0], '--ignore-config');
    assert.equal(args.includes('--no-plugin-dirs'), false);
  }
});
