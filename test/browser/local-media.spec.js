'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let root;
function ffmpeg(args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, timeout: 20000 }); }

test.beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvovd-browser-fixtures-'));
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=20:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=5',
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', path.join(root, 'generated.mp4')]);
  ffmpeg(['-i', path.join(root, 'generated.mp4'), '-c', 'copy', path.join(root, 'generated.mov')]);
});
test.afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => {
  // Media-provider traffic is never needed by these local paths.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/');
});
test.afterEach(async ({ page }) => {
  const discard = page.locator('#workspace-discard');
  if (await discard.isVisible()) { await discard.click(); await expect(page.locator('#media-drop-zone')).toBeVisible(); }
});

async function intake(page, filename = 'generated.mp4') {
  const connection = page.waitForRequest(request => request.url().includes('/api/workspace/progress?workspace='));
  await page.locator('#media-file-input').setInputFiles(path.join(root, filename));
  const id = new URL((await connection).url()).searchParams.get('workspace');
  await expect(page.locator('#local-media-ready')).toBeVisible();
  await expect(page.locator('#workspace-progress')).toBeHidden();
  return id;
}
async function snapshot(workspaceId) {
  const response = await fetch(`http://127.0.0.1:3017/api/workspace/progress?workspace=${workspaceId}`);
  const reader = response.body.getReader();
  let text = '';
  try {
    while (!text.includes('\n\n')) { const next = await reader.read(); text += Buffer.from(next.value).toString(); }
    return JSON.parse(text.split('\n\n')[0].replace(/^data: /, ''));
  } finally { await reader.cancel(); }
}
async function downloaded(page) {
  const waiting = page.waitForEvent('download');
  await page.locator('#conversion-download').click();
  const result = await waiting;
  expect(await result.failure()).toBeNull();
  return { name: result.suggestedFilename(), bytes: await fs.readFile(await result.path()) };
}

test('one intake, keyboard access, actual MP4 no-op download, and normal security gate', async ({ page, request }) => {
  await expect(page.getByRole('heading', { name: 'Local Media', exact: true })).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Inspect Local Media' })).toHaveCount(0);
  await page.locator('#media-choose-button').focus(); await expect(page.locator('#media-choose-button')).toBeFocused();
  const id = await intake(page);
  await page.locator('#local-open-converter').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#conversion-plan-title')).toHaveText('No conversion needed');
  await page.locator('#conversion-start').click();
  await expect(page.locator('#conversion-download')).toBeVisible();
  const result = await downloaded(page);
  expect(result.name).toMatch(/\.mp4$/); expect(result.bytes).toEqual(await fs.readFile(path.join(root, 'generated.mp4')));
  const state = await snapshot(id); expect(state.assets.map(asset => asset.role)).toEqual(['source']); expect(state.playback).toBeNull();
  expect((await request.post('/api/conversion/plan', { headers: { Origin: 'https://invalid.example' }, data: {} })).status()).toBe(403);
});

test('Convert-only MOV remux downloads actual MP4 without an editor proxy', async ({ page }) => {
  const id = await intake(page, 'generated.mov');
  await page.locator('#local-open-converter').click();
  await expect(page.locator('#conversion-plan-title')).toContainText('Remux');
  await page.locator('#conversion-start').click(); await expect(page.locator('#conversion-download')).toBeVisible();
  const output = await downloaded(page); const file = path.join(root, 'browser-remux.mp4'); await fs.writeFile(file, output.bytes);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));
  expect(probe.streams.map(stream => stream.codec_name)).toEqual(['h264', 'aac']);
  expect((await snapshot(id)).assets.some(asset => asset.role === 'playback-proxy')).toBe(false);
  expect((await snapshot(id)).editor.status).toBe('idle');
});

test('Edit/Convert switching preserves outer bounds, middle and pending cuts, playhead, zoom, and edited output with one upload/SSE', async ({ page }) => {
  const uploads = [], connections = [];
  page.on('request', request => { if (request.url().endsWith('/api/media/local')) uploads.push(request); if (request.url().includes('/api/workspace/progress')) connections.push(request); });
  await intake(page); await page.locator('#local-open-editor').click(); await expect(page.locator('#media-editor')).toBeVisible();
  await page.locator('#editor-start-time').fill('0.5'); await page.locator('#editor-start-time').press('Enter');
  await page.locator('#editor-end-time').fill('4.5'); await page.locator('#editor-end-time').press('Enter');
  await page.locator('#cut-start-time').fill('1'); await page.locator('#cut-start-time').press('Enter');
  await page.locator('#cut-end-time').fill('2'); await page.locator('#cut-end-time').press('Enter'); await page.locator('#remove-section').click();
  await page.locator('#create-edited-file').click(); await expect(page.locator('#download-edited-file')).toBeVisible();
  const editedUrl = await page.locator('#download-edited-file').getAttribute('href');
  await page.locator('#cut-start-time').fill('3'); await page.locator('#cut-start-time').press('Enter');
  await page.locator('#timeline-zoom-in').click();
  await page.locator('#go-to-start').click();
  const window = await page.locator('#timeline-visible-label').textContent();
  const time = await page.locator('#editor-video').evaluate(video => video.currentTime);
  await page.locator('#local-open-converter').click(); await expect(page.locator('#conversion-cuts-note')).toBeVisible();
  await page.locator('#conversion-target').selectOption('m4a-aac');
  await expect(page.locator('#conversion-start')).toBeEnabled(); await page.locator('#conversion-start').click(); await expect(page.locator('#conversion-download')).toBeVisible();
  await page.locator('#local-open-editor').click();
  await expect(page.locator('#editor-start-time')).toHaveValue('00:00:00.500'); await expect(page.locator('#editor-end-time')).toHaveValue('00:00:04.500');
  await expect(page.locator('#cut-start-time')).toHaveValue('00:00:03.000'); await expect(page.locator('#removed-sections')).toBeVisible();
  await expect(page.locator('#timeline-visible-label')).toHaveText(window); await expect(page.locator('#download-edited-file')).toHaveAttribute('href', editedUrl);
  expect(await page.locator('#editor-video').evaluate(video => video.currentTime)).toBeCloseTo(time, 2);
  expect(uploads).toHaveLength(1); expect(connections).toHaveLength(1);
  await page.locator('#local-open-converter').click(); await expect(page.locator('#conversion-download')).toBeVisible();
});

test('Discard restores intake and a delayed real plan response cannot resurrect the old view', async ({ page }) => {
  await intake(page);
  let release, fetched;
  const ready = new Promise(resolve => { fetched = resolve; }); const hold = new Promise(resolve => { release = resolve; });
  await page.route('**/api/conversion/plan', async route => { const response = await route.fetch(); fetched(); await hold; await route.fulfill({ response }); });
  await page.locator('#local-open-converter').click(); await ready;
  await page.locator('#workspace-discard').click(); await expect(page.locator('#media-drop-zone')).toBeVisible();
  release(); await expect(page.locator('#media-converter')).toBeHidden(); await expect(page.locator('#local-media-ready')).toBeHidden();
  await page.unroute('**/api/conversion/plan');
  await intake(page, 'generated.mov'); await expect(page.locator('#local-media-name')).toHaveText('generated.mov');
});

test('narrow viewport exposes details, target controls, and download without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await intake(page); await page.getByText('Media Details', { exact: true }).click(); await expect(page.locator('#conversion-facts')).toBeVisible();
  await page.locator('#local-open-converter').click(); await expect(page.locator('#conversion-start')).toBeEnabled();
  await page.locator('#conversion-start').click(); await expect(page.locator('#conversion-download')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
