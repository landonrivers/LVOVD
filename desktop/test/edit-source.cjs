'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Drive the visible Download/editor controls. Compare a no-op save with the
// encoded fixture packets, independently of the player and its playback proxy.
async function verifyHandoff(browser, fixture, preview, choose, ffprobe, destination, localExports) {
  const wait = (test, timeoutMsg) => browser.waitUntil(test, { timeout: 45000, timeoutMsg });
  const button = () => browser.$('#download-edit-source');
  const state = () => browser.execute(() => window.LVOVDLocalWorkspace.collectionState());
  const jobs = () => browser.execute(() => document.querySelectorAll('#download-jobs li').length);
  const beforeJobs = await jobs(), beforeExports = fs.readdirSync(destination);
  const candidate = fixture.cases.find(c => c.source === 'separate' && c.cap === 720);
  await preview(candidate.url);
  await choose('dl-profile', 'maximum');
  await choose('dl-height', '720');
  await browser.$('#dl-times summary').click();
  await choose('dl-range', 'custom');
  await browser.$('#dl-start').setValue('0.25');
  await browser.$('#dl-end').setValue('0.50');
  await browser.$('#dl-extras summary').click();
  await browser.$('#dl-metadata').click();
  const beforeReads = fixture.mediaReads();
  await (await button()).click();
  await wait(async () => (await state()).entries.length === 1 && await browser.$('#conversion-start').isEnabled(),
    'The selected video did not open for processing');
  const first = await state();
  assert.equal(first.entries[0].workspace.id, first.selectedId);
  const { video, audio, durationSeconds } = first.entries[0].workspace.inspection;
  assert.deepEqual([video.codec, video.height, audio.codec], ['vp9', 720, 'opus']);
  assert.ok(durationSeconds >= 0.99 && durationSeconds < 1.1, 'Download range must leave the full editor source intact');
  const acquired = fixture.mediaReads();
  assert.deepEqual(acquired, { ...beforeReads, '/vp9.mp4': (beforeReads['/vp9.mp4'] || 0) + 1,
    '/opus.mp4': (beforeReads['/opus.mp4'] || 0) + 1 }, 'Acquire exactly the selected video and audio once');
  await browser.$('#conversion-start').click();
  await wait(async () => (await state()).entries[0].workspace.conversion?.output?.noOp, 'Local no-op result missing');
  await browser.$('#conversion-download').click();
  const saved = () => browser.$('[data-result="status"]').getText();
  await wait(async () => (await saved()).startsWith('Saved '), 'Local no-op was not saved');
  require('./profile-fixture.cjs').verify(ffprobe, path.join(localExports, (await saved()).slice(6)), candidate, true);

  await browser.execute(() => {
    const input = document.getElementById('editor-start-time');
    input.value = '00:00:00.250';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await browser.$('#nav-download').click();
  assert.equal(await browser.$('#dl-profile-maximum').isSelected(), true);
  assert.equal(await browser.$('#dl-height').getValue(), '720');
  assert.equal(await browser.$('#dl-range').getValue(), 'custom');
  assert.equal(await browser.$('#dl-metadata').isSelected(), true);
  await (await button()).click();
  await wait(() => browser.execute(() => ['desktop-local', 'editor-media-name', 'processing-file-list'].includes(document.activeElement.id)),
    'Reopening the source did not reveal Local Media');
  assert.equal((await state()).selectedId, first.selectedId);
  assert.equal(await browser.$('#editor-start-time').getValue(), '00:00:00.250');
  assert.deepEqual(fixture.mediaReads(), acquired, 'Reopen and local processing must reuse the owned original');

  await browser.$('#nav-download').click();
  await choose('dl-profile', 'compatible');
  fixture.holdMedia();
  try {
    await (await button()).click();
    await wait(() => fixture.held() > 0, 'A different source choice did not start a new acquisition');
    await browser.$('#native-intake-cancel').click();
    await wait(async () => fixture.held() === 0 && await (await button()).isEnabled(), 'Cancellation did not release the provider');
  } finally { fixture.release(); }
  const cancelled = await state();
  assert.equal(cancelled.entries.length, 1);
  assert.equal(cancelled.selectedId, first.selectedId);
  assert.equal(await browser.$('#editor-start-time').getValue(), '00:00:00.250');
  // This deliberately mixes the compatible AVC video with the maximum-quality
  // Opus audio. Neither automatic profile supplies this exact pair uncapped.
  await browser.$('#nav-download').click();
  await browser.$('#dl-formats summary').click();
  await choose('dl-selection', 'separate');
  const ids = await browser.execute(() => ['video','stream'].map((key, index) => {
    const wanted = index ? /\bopus\b/i : /\bavc1\b/i;
    return Array.from(document.getElementById('dl-' + key).options).find(option => wanted.test(option.textContent))?.value;
  }));
  assert.ok(ids.every(Boolean), 'The Preview must expose the reviewed AVC and Opus format IDs');
  assert.equal(await choose('dl-video', ids[0]), ids[0]);
  assert.equal(await choose('dl-stream', ids[1]), ids[1]);
  const beforeManual = fixture.mediaReads();
  await (await button()).click();
  await wait(async () => (await state()).entries.length === 2 && await browser.$('#conversion-start').isEnabled(), 'Manual source pair did not open in the editor');
  const manual = await state(), selected = manual.entries.find(entry => entry.workspace.id === manual.selectedId);
  assert.notEqual(manual.selectedId, first.selectedId);
  assert.deepEqual([selected.workspace.inspection.video.codec, selected.workspace.inspection.video.height,
    selected.workspace.inspection.audio.codec], ['h264', 360, 'opus']);
  assert.deepEqual(fixture.mediaReads(), { ...beforeManual, '/avc.mp4': (beforeManual['/avc.mp4'] || 0) + 1,
    '/opus.mp4': (beforeManual['/opus.mp4'] || 0) + 1 });
  assert.equal(await jobs(), beforeJobs, 'Editor acquisition must not create Download queue rows');
  assert.deepEqual(fs.readdirSync(destination), beforeExports, 'Editor acquisition must not publish Download outputs');
  await browser.execute(() => { window.confirm = () => true; });
  await browser.$('#workspace-discard').click();
  await wait(async () => (await state()).selectedId === first.selectedId, 'Removing the new source must restore the prior file');
  assert.equal(await browser.$('#editor-start-time').getValue(), '00:00:00.250');
  await browser.$('#workspace-discard').click();
  await wait(async () => (await state()).entries.length === 0, 'Removing the adopted source did not empty the workbench');
  console.log('PASS native Edit Source Video: one capped VP9/Opus acquisition, full source packets, retained draft, reopen and cancellation');
}

module.exports = { verifyHandoff };
