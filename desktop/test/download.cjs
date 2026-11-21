'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Serve only this generated fixture. Blocking an acquisition GET after Preview lets
// the native workflow deterministically exercise a disconnected folder and cancellation.
async function startProvider(video) {
  const bytes = fs.statSync(video).size;
  let hold = false, gets = 0;
  const waiting = new Set();
  const server = http.createServer((request, response) => {
    if (request.url !== '/fixture.mp4' || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end(); return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(bytes - 1, Number(range[2])) : bytes - 1;
    if (start > end) { response.writeHead(416).end(); return; }
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + bytes;
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = fs.createReadStream(video, { start, end });
      response.once('close', () => stream.destroy());
      stream.on('error', () => response.destroy()).pipe(response);
    };
    if (request.method === 'GET') gets++;
    if (request.method === 'GET' && hold) {
      waiting.add(send);
      response.once('close', () => waiting.delete(send));
    } else send();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/fixture.mp4',
    hold() { hold = true; },
    held() { return waiting.size; },
    gets() { return gets; },
    release() { hold = false; for (const send of waiting) send(); waiting.clear(); },
    async close() { this.release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}

async function downloadScenario(browser, provider, destination, ffprobe, evidence) {
  const wait = (test, message) => browser.waitUntil(test, { timeout: 60000, timeoutMsg: message });
  async function preview() {
    await browser.$('#download-url').setValue(provider.url);
    await browser.$('#download-preview-button').click();
    await wait(async () => (await browser.$('#download-preview').isDisplayed()), 'yt-dlp returned no single-media Preview');
  }
  await browser.$('#download-choose-folder').click();
  await wait(async () => (await browser.$('#download-folder').getText()) === destination, 'Native folder selection did not complete');
  await preview();
  const filename = await browser.$('#download-filename').getText();
  assert.ok(filename && path.basename(filename) === filename, 'Preview exposes the reviewed media filename');
  for (const [width, height] of [[1280, 720], [960, 640]]) {
    await browser.setWindowSize(width, height);
    assert.equal(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
    await browser.saveScreenshot(path.join(evidence, 'download-preview-' + width + '-' + process.platform + '.png'));
  }
  const collision = path.join(destination, filename);
  fs.writeFileSync(collision, 'prior export', { flag: 'wx' });
  provider.hold();
  await browser.$('#download-start').click();
  await wait(() => provider.held() > 0, 'The queued acquisition never read the fixture');
  const disconnected = destination + '-disconnected';
  fs.renameSync(destination, disconnected);
  provider.release();
  const failed = '#download-jobs li[data-status="saveFailed"]';
  await wait(async () => browser.$(failed).isDisplayed(), 'An unavailable destination did not retain the prepared result');
  const reads = provider.gets();
  fs.renameSync(disconnected, destination);
  await browser.$(failed + ' [data-action="retry"]').click();
  const saved = '#download-jobs li[data-status="saved"]';
  await wait(async () => browser.$(saved).isDisplayed(), 'Retry Save did not publish the prepared result');
  assert.equal(provider.gets(), reads, 'Retry Save reacquired the source');
  assert.equal(fs.readFileSync(collision, 'utf8'), 'prior export');
  const outputs = fs.readdirSync(destination).filter(name => name !== filename);
  assert.equal(outputs.length, 1, 'Publish one collision-safe saved file');
  const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', path.join(destination, outputs[0])], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout).streams.map(s => s.codec_type).sort(), ['audio', 'video']);
  assert.equal(await browser.$(saved + ' [data-action="open"]').isDisplayed(), true);
  assert.equal(await browser.$(saved + ' [data-action="reveal"]').isDisplayed(), true);
  await browser.saveScreenshot(path.join(evidence, 'download-saved-' + process.platform + '.png'));
  await preview();
  provider.hold();
  await browser.$('#download-start').click();
  await wait(() => provider.held() > 0, 'Cancellation requires an active provider read');
  await browser.$('#download-jobs li[data-status="downloading"] [data-action="cancel"]').click();
  await wait(async () => browser.$('#download-jobs li[data-status="cancelled"]').isDisplayed(), 'The active download did not cancel');
  provider.release();
  assert.equal(fs.readdirSync(destination).length, 2, 'Cancelled work published an extra file');
}

module.exports = { downloadScenario, startProvider };
