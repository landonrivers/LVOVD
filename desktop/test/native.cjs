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
const wave = generate('synthetic.wav', ['-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=44100:duration=4', '-c:a', 'pcm_s24le']);
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
  const directEnv = { ...env, TAURI_WEBDRIVER_PORT: String(port), LVOVD_DESKTOP_TEST_FILE: file,
    LVOVD_DESKTOP_TEST_MEDIA_CONTENTION: '1', LVOVD_DESKTOP_TEST_SAVE_FOLDER: resultDir };
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
    await browser.execute(() => { window.__errors=[]; window.addEventListener('error',e=>window.__errors.push(e.message)); window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason))); });
    await browser.$('#media-choose-button').click();
    await browser.waitUntil(async () => browser.execute(() => document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').readyState >= 1), { timeout: 25000, timeoutMsg: 'Native media did not load metadata' });
    // WebKit honors preload=metadata strictly; decoded frames require playback.
    await browser.execute(() => { const p = document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])'); p.muted = true; p.play(); });
    await browser.waitUntil(async () => browser.execute(() => document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').readyState >= 2), { timeout: 15000, timeoutMsg: 'Native media did not decode for playback' });
    await browser.execute(() => document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').pause());
    const metadata = await browser.execute(() => ({ duration: document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').duration, url: document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').currentSrc }));
    assert.ok(metadata.duration > 0); assert.match(metadata.url, /lvovd-media/);
    for (const target of [metadata.duration - 0.5, 0.25, metadata.duration / 2]) {
      await browser.execute(t => { document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').currentTime = t; }, target);
      await browser.waitUntil(async () => browser.execute(t => { const p = document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])'); return !p.seeking && Math.abs(p.currentTime - t) < 0.15 && p.readyState >= 2; }, target), { timeout: 10000 });
    }
    await browser.execute(() => { const p = document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])'); p.muted = true; p.play(); });
    const before = await browser.execute(() => document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').currentTime);
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').currentTime)) > before + 0.15, { timeout: 10000 });
    await browser.setWindowSize(1280, 720);
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), {timeout:2000}).catch(async error => { console.error(await browser.execute(() => ({width:innerWidth,height:innerHeight,scrollW:document.documentElement.scrollWidth,scrollH:document.documentElement.scrollHeight,outside:[...document.querySelectorAll("body *")].filter(e=>getComputedStyle(e).position==="absolute" && e.getBoundingClientRect().bottom>innerHeight).map(e=>({id:e.id,cls:e.className,rect:e.getBoundingClientRect().toJSON()})).slice(0,15)}))); throw error; });
    assert.equal(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, 'desktop workflow must fit without outer-page scrolling');
    await browser.saveScreenshot(path.join(resultDir, `desktop-${process.platform}-${index}.png`));
    await browser.setWindowSize(960, 640);
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), {timeout:2000}).catch(async error => { console.error(await browser.execute(() => ({width:innerWidth,height:innerHeight,scrollW:document.documentElement.scrollWidth,scrollH:document.documentElement.scrollHeight}))); throw error; });
    assert.equal(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true, 'narrow workflow must fit without outer-page scrolling');
    await browser.saveScreenshot(path.join(resultDir, `narrow-${process.platform}-${index}.png`));
    // A second owned copy exercises selection changes while the first decoder
    // may still have queued reads. Removing it must preserve the other entry.
    // The test build holds these eight small reads for 1.5 seconds per batch.
    // All four read slots are occupied when the new decoder requests metadata;
    // normal contention must wait instead of returning a fatal 429 to WebKit.
    // Linux's decoder uses the broker; these fetches still test its URI handler.
    await browser.execute(() => {
      const url = document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])').currentSrc;
      window.__rangeContention = Promise.all(Array.from({ length: 8 }, async () => {
        const response = await fetch(url, { headers: { Range: 'bytes=128-255' } });
        return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
      }));
    });
    await browser.$('#processing-add-files').click();
    await browser.waitUntil(async () => (await browser.$$('#processing-file-list option')).length === 2, { timeout: 10000 });
    await browser.execute(() => { const list = document.getElementById('processing-file-list'); list.selectedIndex = 1; list.dispatchEvent(new Event('change', { bubbles: true })); });
    await browser.waitUntil(async () => browser.execute(previous => {
      const player = document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])');
      return player.currentSrc !== previous && player.readyState >= 1;
    }, metadata.url), { timeout: 10000 });
    const burst = await browser.execute(async () => {
      const results = await window.__rangeContention; delete window.__rangeContention; return results;
    });
    assert.deepEqual(burst, Array.from({ length: 8 }, () => ({ status: 206, bytes: 128 })), 'read contention must not reject valid ranges');
    await browser.execute(() => { window.confirm = () => true; });
    await browser.$('#workspace-discard').click();
    await browser.waitUntil(async () => (await browser.$$('#processing-file-list option')).length === 1, { timeout: 10000 });
    await browser.waitUntil(async () => browser.execute(previous => {
      const player = document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])');
      return player.currentSrc === previous && player.readyState >= 1;
    }, metadata.url), { timeout: 10000 });
    await browser.execute(() => { window.confirm = () => true; });
    await browser.$('#workspace-discard').click();
    await browser.waitUntil(async () => (await browser.$$('#processing-file-list option')).length === 0, { timeout: 10000 });
    await browser.waitUntil(async () => !(await browser.$('#workspace-retry-cleanup').isDisplayed()), { timeout: 10000, timeoutMsg: 'The decoder did not release temporary media after removal' });
    // One native workbench is reopened idempotently; files share settings but
    // retain independent cuts. Drive actual controls, not a command-only demo.
    const identity = await browser.execute(async () => {
      const id = window.LVOVDWorkspaceTransport.owner();
      const opened = await window.__TAURI__.core.invoke('create_workbench');
      return { id, opened: opened.workbenchId };
    });
    assert.equal(identity.id, identity.opened);
    await browser.$('#media-choose-button').click();
    await browser.waitUntil(async () => (await browser.$$('#processing-file-list option')).length === 1, { timeout:15000 });
    await browser.waitUntil(async () => (await browser.$('#conversion-plan-title').getText()).length > 0 && (await browser.$('#conversion-start').isEnabled()), {timeout:15000});
    await browser.$('#conversion-start').click();
    await browser.waitUntil(async () => browser.execute(() => !!window.LVOVDLocalWorkspace.collectionState().entries[0]?.workspace.conversion?.output), {timeout:20000});
    const result = await browser.execute(() => window.LVOVDLocalWorkspace.collectionState().entries[0].workspace.conversion.output);
    assert.equal(result.noOp,true); assert.equal(result.size,fs.statSync(file).size);
    await browser.$('#conversion-download').click();
    await browser.waitUntil(async () => (await browser.$('[data-result="status"]').getText()).startsWith('Saved '), {timeout:15000});
    const saved = (await browser.$('[data-result="status"]').getText()).slice(6);
    assert.deepEqual(fs.readFileSync(path.join(resultDir,saved)),fs.readFileSync(file),'native no-op saving preserves bytes');
    await browser.$('[data-result="edit"]').click();
    const owner = await browser.execute(() => window.LVOVDWorkspaceTransport.owner());
    const deniedSource = await browser.execute(async id => {
      try { await window.__TAURI__.core.invoke('remove_source',{request:{workbenchId:'00000000-0000-4000-8000-000000000000',sourceId:id}}); return false; } catch { return true; }
    }, result.sourceId);
    assert.equal(deniedSource,true);
    if (index === 1 || index === 3) {
      await browser.waitUntil(async () => browser.execute(() => window.LVOVDLocalWorkspace.collectionState().entries[0]?.workspace.waveform?.status === 'ready'), {timeout:20000});
      assert.match(await browser.$('#audio-waveform-note').getText(), /overview/);
    }
    if (index === 0 || index === 3) {
      const field = async (id, value) => browser.execute((id, value) => { const input=document.getElementById(id); input.value=value; input.dispatchEvent(new Event('change',{bubbles:true})); },id,value);
      await field('editor-end-time','00:00:01.500');
      await browser.$('#processing-add-files').click();
      await browser.waitUntil(async () => (await browser.$$('#processing-file-list option')).length===2,{timeout:15000});
      await browser.execute(() => { const list=document.getElementById('processing-file-list');list.selectedIndex=1;list.dispatchEvent(new Event('change',{bubbles:true})); });
      await field('editor-start-time','00:00:00.250'); await field('editor-end-time','00:00:01.750');
      await field('cut-start-time','00:00:00.750'); await field('cut-end-time','00:00:01.000');
      await browser.$('#remove-section').click();
      await browser.waitUntil(async () => (await browser.$$('#removed-sections-list button')).length===1,{timeout:5000});
      await browser.$('#timeline-zoom-in').click();
      assert.notEqual(await browser.$('#timeline-visible-label').getText(),'Showing full timeline');
      await browser.$('#timeline-fit').click();
      await browser.execute(() => { const list=document.getElementById('processing-file-list');list.selectedIndex=0;list.dispatchEvent(new Event('change',{bubbles:true})); });
      assert.equal(await browser.$('#editor-end-time').getValue(),'00:00:01.500','per-file cut draft must survive selection');
      await browser.$('#processing-process-all').click();
      await browser.waitUntil(async () => (await browser.$('#processing-batch-submit')).isEnabled(),{timeout:15000});
      await browser.$('#processing-batch-submit').click();
      // Later edits cannot rewrite either captured queue ticket.
      await field('editor-end-time','00:00:01.000');
      await browser.waitUntil(async () => browser.execute(() => {
        const entries=window.LVOVDLocalWorkspace.collectionState().entries;
        return entries.length===2 && entries.every(e=>e.workspace.conversion.output && !e.workspace.conversion.output.noOp);
      }),{timeout:40000});
      const outputs=await browser.execute(() => window.LVOVDLocalWorkspace.collectionState().entries.map(e=>e.workspace.conversion.output));
      assert.ok(Math.abs(outputs[0].inspection.durationSeconds-1.5)<0.15);
      assert.ok(Math.abs(outputs[1].inspection.durationSeconds-1.25)<0.15);
      await (await browser.$$('[data-result="preview"]'))[0].click();
      await browser.waitUntil(async () => browser.execute(()=>document.getElementById('result-player').readyState>=1),{timeout:15000});
      await browser.$('#close-result').click();
      await browser.$('#processing-download-all').click();
      await browser.waitUntil(async () => (await browser.$('#processing-download-note').getText()).startsWith('Saved '),{timeout:15000});
      assert.equal((await browser.$('#processing-download-note').getText()).match(/Saved /g).length,2);
      await browser.execute(() => { window.confirm=()=>true; });
      await browser.$('#workspace-discard').click();
      await browser.waitUntil(async () => (await browser.$$('#processing-file-list option')).length===1,{timeout:10000});
    }
    await browser.execute(() => { window.confirm=()=>true; });
    await browser.$('#workspace-discard').click();
    await expectEmptyFiles(browser);
    await browser.waitUntil(async () => browser.execute(async id => {
      const snapshot = (await window.__TAURI__.core.invoke('list_workbenches')).find(e=>e.workbenchId===id);
      return snapshot && !snapshot.cleanup.length;
    }, owner), {timeout:15000});
    assert.equal(fs.existsSync(file), true, 'removal must not delete the selected original');
    const denied = await browser.execute(async path => {
      try { await window.__TAURI__.core.invoke('plugin:fs|read_file', { path }); return ''; } catch (error) { return String(error); }
    }, file);
    assert.match(denied, /not allowed|not found|denied/i, 'existing files must be protected by command permissions');
    const shape = await browser.execute(async () => {
      try { await window.__TAURI__.core.invoke('remove_source', { request: { assetId: '00000000-0000-4000-8000-000000000000', path: '/not-allowed' } }); return false; } catch { return true; }
    });
    assert.equal(shape, true, 'unknown command fields must be rejected');
    console.log(`PASS ${process.platform}: ${path.basename(file)} native playback, seeking, single workbench, editor controls, owned processing and saving, removal, permissions, desktop/narrow layout`);
    await browser.execute(() => { setTimeout(() => window.__TAURI__.core.invoke('shutdown_desktop'), 100); });
    const timeout = new AbortController();
    try {
      await Promise.race([closed, delay(10000, undefined, { signal: timeout.signal }).then(() => { throw new Error('Desktop shutdown timed out'); })]);
      assert.equal(child.exitCode, 0, 'coordinated shutdown must exit successfully');
    } finally { timeout.abort(); }
  } catch (error) {
    if (browser) {
      console.error('Native page diagnostics:', await browser.execute(() => {
        const player = document.querySelector('#editor-video:not([hidden]), #editor-audio:not([hidden])');
        return { errors: window.__errors, workspace: window.LVOVDLocalWorkspace?.collectionState(), url: location.href, text: document.body?.innerText?.slice(0, 2000), media: { error: player?.error?.code, message: player?.error?.message, readyState: player?.readyState, networkState: player?.networkState } };
      }).catch(() => 'unavailable'));
      await browser.saveScreenshot(path.join(resultDir, `failure-${process.platform}-${index}.png`)).catch(() => {});
    }
    if (browser) console.error('Native owned state:', await browser.execute(async () => window.__TAURI__.core.invoke('list_workbenches')).catch(()=>null));
    console.error('Native process diagnostics:', fs.readFileSync(path.join(resultDir, `native-${index}.log`), 'utf8').slice(-8192));
    throw error;
  } finally {
    if (child.exitCode === null) child.kill();
    await closed; fs.closeSync(log);
  }
}
async function expectEmptyFiles(browser) {
  await browser.waitUntil(async () => (await browser.$$('#processing-file-list option')).length === 0, { timeout: 10000 });
}
(async () => { await scenario(video, 0); await scenario(audio, 1); await scenario(tailIndex, 2); await scenario(wave, 3); })().catch(error => { console.error(error); process.exitCode = 1; });
