'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { environment } = require('../../scripts/desktop.cjs');
const root = path.resolve(__dirname, '../..');
const resultDir = path.join(root, 'desktop/test-results');
fs.mkdirSync(resultDir, { recursive: true });
const env = environment().env;
const ffmpeg = env.LVOVD_DESKTOP_FFMPEG;
assert.ok(ffmpeg, 'FFmpeg must be installed for the native playback gate');
function generate(name, args) {
  const file = path.join(resultDir, name);
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, file], { windowsHide: true, timeout: 120000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr); return file;
}
const video = generate('synthetic.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=20', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-b:v', '8M', '-minrate', '8M', '-maxrate', '8M', '-bufsize', '8M', '-x264-params', 'nal-hrd=cbr', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']);
assert.ok(fs.statSync(video).size > 8 * 1024 * 1024, 'video must exercise bounded range responses');
const audio = generate('synthetic.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=700:duration=4', '-c:a', 'aac']);
const tailIndex = generate('synthetic-tail-index.mp4', ['-i', video, '-c', 'copy']);
if (process.platform === 'linux') {
  // A direct decode distinguishes missing codecs from custom-URI transport errors.
  const decode = spawnSync('gst-launch-1.0', ['-q', 'filesrc', `location=${video}`, '!', 'decodebin', 'name=decoded',
    'decoded.', '!', 'queue', '!', 'video/x-raw', '!', 'fakesink',
    'decoded.', '!', 'queue', '!', 'audio/x-raw', '!', 'fakesink'], { timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  assert.equal(decode.status, 0, decode.error?.message || decode.stderr);
  console.log('PASS linux: the generated MP4 decodes through installed GStreamer codecs using the file transport');
}
async function waitForDriver(port, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Desktop exited before the driver became ready');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1000) });
      // The driver can listen before Tauri has created the application window.
      if (response.ok && (await response.json()).value?.ready === true) return;
    } catch {}
    await delay(200);
  }
  throw new Error('Native driver did not become ready');
}
async function scenario(file, index) {
  const port = 4455 + index, log = fs.openSync(path.join(resultDir, `native-${index}.log`), 'w');
  // Exercise the same tool discovery as a direct executable launch, without the
  // Node development wrapper's LVOVD_DESKTOP_* tool-path overrides.
  const directEnv = { ...env, TAURI_WEBDRIVER_PORT: String(port), LVOVD_DESKTOP_TEST_FILE: file };
  for (const key of ['FFPROBE', 'FFMPEG', 'NODE', 'YTDLP']) delete directEnv['LVOVD_DESKTOP_' + key];
  const child = spawn(path.join(root, 'target/debug/lvovd' + (process.platform === 'win32' ? '.exe' : '')), [], {
    cwd: resultDir, env: directEnv, windowsHide: true, stdio: ['ignore', log, log]
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  let browser;
  try {
    await waitForDriver(port, child);
    const { remote } = await import('webdriverio');
    browser = await remote({ hostname: '127.0.0.1', port, logLevel: 'error', connectionRetryCount: 0, capabilities: { browserName: 'wry' } });
    await browser.waitUntil(async () => (await browser.$('#connection').getText()).startsWith('Desktop ·'), { timeout: 15000 });
    await browser.waitUntil(async () => (await browser.$$('#runtime span')).length === 4, { timeout: 10000, timeoutMsg: 'Bounded runtime health did not finish' });
    await browser.$('#add-file').click();
    await browser.waitUntil(async () => browser.execute(() => document.getElementById('player').readyState >= 1), { timeout: 25000, timeoutMsg: 'Native media did not load metadata' });
    // WebKit honors preload=metadata strictly; decoded frames require playback.
    await browser.execute(() => { const p = document.getElementById('player'); p.muted = true; p.play(); });
    await browser.waitUntil(async () => browser.execute(() => document.getElementById('player').readyState >= 2), { timeout: 15000, timeoutMsg: 'Native media did not decode for playback' });
    await browser.execute(() => document.getElementById('player').pause());
    const metadata = await browser.execute(() => ({ duration: document.getElementById('player').duration, url: document.getElementById('player').currentSrc }));
    assert.ok(metadata.duration > 0); assert.match(metadata.url, /lvovd-media/);
    for (const target of [metadata.duration - 0.5, 0.25, metadata.duration / 2]) {
      await browser.execute(t => { document.getElementById('player').currentTime = t; }, target);
      await browser.waitUntil(async () => browser.execute(t => { const p = document.getElementById('player'); return !p.seeking && Math.abs(p.currentTime - t) < 0.15 && p.readyState >= 2; }, target), { timeout: 10000 });
    }
    await browser.execute(() => { const p = document.getElementById('player'); p.muted = true; p.play(); });
    const before = await browser.execute(() => document.getElementById('player').currentTime);
    await browser.waitUntil(async () => (await browser.execute(() => document.getElementById('player').currentTime)) > before + 0.15, { timeout: 10000 });
    await browser.setWindowSize(1280, 720);
    assert.equal(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, 'desktop workflow must fit without outer-page scrolling');
    await browser.saveScreenshot(path.join(resultDir, `desktop-${process.platform}-${index}.png`));
    await browser.setWindowSize(960, 640);
    assert.equal(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, 'narrow workflow must fit without outer-page scrolling');
    await browser.saveScreenshot(path.join(resultDir, `narrow-${process.platform}-${index}.png`));
    // A second owned copy exercises selection changes while the first decoder
    // may still have queued reads. Removing it must preserve the other entry.
    await browser.$('#add-file').click();
    await browser.waitUntil(async () => (await browser.$$('#files option')).length === 2, { timeout: 10000 });
    await browser.waitUntil(async () => browser.execute(previous => {
      const player = document.getElementById('player');
      return player.currentSrc !== previous && player.readyState >= 1;
    }, metadata.url), { timeout: 10000 });
    await browser.$('#remove-file').click();
    await browser.waitUntil(async () => (await browser.$$('#files option')).length === 1, { timeout: 10000 });
    await browser.waitUntil(async () => browser.execute(previous => {
      const player = document.getElementById('player');
      return player.currentSrc === previous && player.readyState >= 1;
    }, metadata.url), { timeout: 10000 });
    await browser.$('#remove-file').click();
    await browser.waitUntil(async () => (await browser.$$('#files option')).length === 0, { timeout: 10000 });
    await browser.waitUntil(async () => (await browser.$$('#cleanup button')).length === 0, { timeout: 10000, timeoutMsg: 'The decoder did not release temporary media after removal' });
    assert.equal(fs.existsSync(file), true, 'removal must not delete the selected original');
    const denied = await browser.execute(async path => {
      try { await window.__TAURI__.core.invoke('plugin:fs|read_file', { path }); return ''; } catch (error) { return String(error); }
    }, file);
    assert.match(denied, /not allowed|not found|denied/i, 'existing files must be protected by command permissions');
    const shape = await browser.execute(async () => {
      try { await window.__TAURI__.core.invoke('remove_source', { request: { assetId: '00000000-0000-4000-8000-000000000000', path: '/not-allowed' } }); return false; } catch { return true; }
    });
    assert.equal(shape, true, 'unknown command fields must be rejected');
    console.log(`PASS ${process.platform}: ${path.basename(file)} native playback, seeking, removal, capabilities, narrow layout`);
    await browser.execute(() => { setTimeout(() => window.__TAURI__.core.invoke('shutdown_desktop'), 100); });
    const timeout = new AbortController();
    try {
      await Promise.race([closed, delay(10000, undefined, { signal: timeout.signal }).then(() => { throw new Error('Desktop shutdown timed out'); })]);
      assert.equal(child.exitCode, 0, 'coordinated shutdown must exit successfully');
    } finally { timeout.abort(); }
  } catch (error) {
    if (browser) {
      console.error('Native page diagnostics:', await browser.execute(() => {
        const player = document.getElementById('player');
        return { url: location.href, text: document.body?.innerText?.slice(0, 2000), media: { error: player?.error?.code, message: player?.error?.message, readyState: player?.readyState, networkState: player?.networkState } };
      }).catch(() => 'unavailable'));
      await browser.saveScreenshot(path.join(resultDir, `failure-${process.platform}-${index}.png`)).catch(() => {});
    }
    console.error('Native process diagnostics:', fs.readFileSync(path.join(resultDir, `native-${index}.log`), 'utf8').slice(-8192));
    throw error;
  } finally {
    if (child.exitCode === null) child.kill();
    await closed; fs.closeSync(log);
  }
}
(async () => { await scenario(video, 0); await scenario(audio, 1); await scenario(tailIndex, 2); })().catch(error => { console.error(error); process.exitCode = 1; });
