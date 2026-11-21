'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../desktop');
require('../../scripts/desktop.cjs').prepare();

test('Download keeps the latest preview and job revision across navigation', async ({ page }) => {
  const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link[^>]*>/g, '');
  await page.setContent(html);
  await page.evaluate(() => {
    const choices = { id: 'first', path: '/first' };
    const job = { jobId: 'job-one', title: 'Synthetic video', filename: 'video.mp4', destination: '/first' };
    const fixture = window.fixture = { requests: [], pending: {}, job };
    window.LVOVDWorkspaceTransport = { ready: Promise.resolve({ protocolVersion: 1, downloadGeneration: 0 }) };
    window.__TAURI__ = { core: { Channel: class {} } };
    window.LVOVDNative = { call: async (name, args) => {
      fixture.requests.push({ name, request: args?.request });
      if (name === 'set_local_drop_target') return;
      if (name === 'runtime_health') return Object.fromEntries(['ffmpeg','ffprobe','ytdlp','providerRuntime'].map(key => [key,{ installed:true }]));
      if (name === 'download_destination') return choices;
      if (name === 'choose_download_destination') return { id: 'second', path: '/second' };
      if (name === 'subscribe_downloads') {
        fixture.snapshot = (revision, status) => args.channel.onmessage({ connectionId: 'new', snapshot: { revision, jobs: [{ ...job, status }] } });
        return { connectionId: 'new', snapshot: { revision: 0, jobs: [] } };
      }
      if (name === 'preview_download') return new Promise(resolve => {
        fixture.pending[args.request.url] = title => resolve({ previewId: title, canDownload: true, title, profile: 'compatible', filename: 'video.mp4' });
      });
      if (name === 'start_download') return { revision: 1, jobs: [{ ...job, status: 'queued' }] };
      if (name === 'acknowledge_downloads' || name === 'reveal_download') return;
      throw new Error('Unexpected command ' + name);
    }};
  });
  await page.addScriptTag({ path: path.join(root, 'app.js') });
  await page.addScriptTag({ path: path.join(root, 'downloads.js') });
  const first = 'https://example.invalid/first', second = 'https://example.invalid/second';
  const preview = page.locator('#download-preview-button');
  await page.locator('#download-url').fill(first); await preview.click();
  await page.locator('#download-url').fill(second); await preview.click();
  await page.evaluate(([a,b]) => { fixture.pending[b]('<img src=x>'); fixture.pending[a]('Stale title'); }, [first, second]);
  await expect(page.locator('#download-title')).toHaveText('<img src=x>');
  await expect(page.locator('#download-title img')).toHaveCount(0);
  await page.locator('#download-start').click();
  await expect(page.locator('.download-job-status')).toHaveText('Queued');
  await page.locator('#nav-settings').click();
  await page.locator('#settings-choose-folder').click();
  await page.evaluate(() => { fixture.snapshot(3, 'saved'); fixture.snapshot(2, 'downloading'); });
  await page.locator('#nav-download').click();
  await expect(page.locator('#download-folder')).toHaveText('/second');
  await expect(page.locator('#download-jobs')).toContainText('/first');
  await expect(page.locator('.download-job-status')).toHaveText('Saved');
  await page.getByRole('button', { name:'Show in Folder' }).click();
  const commands = await page.evaluate(() => fixture.requests.filter(r => ['start_download', 'reveal_download'].includes(r.name)));
  expect(commands).toEqual([{ name:'start_download', request:{ previewId:'<img src=x>', destinationId:'first' } }, { name:'reveal_download', request:{ jobId:'job-one' } }]);
});
