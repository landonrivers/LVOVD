'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const videoId = 'native-fixture';
const captions = {
  '/creator.srt': 'Creator English',
  '/automatic.srt': 'Automatic English',
  '/fallback.srt': 'Automatic French',
};
const categories = [
  // yt-dlp folds subsecond chapters into their neighbors.
  ['sponsor', 'Sponsor', 0, 1.25],
  ['filler', 'Filler', 1.25, 2.5],
  ['hook', 'Hook', 2.5, 3.75],
  ['selfpromo', 'Promotion', 3.75, 5],
  ['intro', 'Intro', 5, 6.25],
  ['preview', 'Preview', 6.25, 7.5],
  ['interaction', 'Interaction', 7.5, 8.75],
  ['music_offtopic', 'Non-Music', 8.75, 10],
  ['outro', 'Endcards', 10, 20],
];

async function start(media, ffmpeg) {
  const requests = [];
  const image = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x32',
    '-frames:v', '1', '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'], { timeout: 15000, windowsHide: true });
  assert.equal(image.status, 0, image.error?.message || String(image.stderr));
  let rejectImage = false;
  let rejectedReads = 0;
  const endpoint = '/api/skipSegments/' + createHash('sha256').update(videoId).digest('hex').slice(0, 4);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/cover.png') {
      if (rejectImage) {
        rejectedReads++;
        res.writeHead(403).end();
      } else {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.stdout.length }).end(image.stdout);
      }
    } else if (Object.hasOwn(captions, url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/x-subrip' });
      res.end('1\n00:00:00,000 --> 00:00:01,000\n' + captions[url.pathname] + '\n');
    } else if (url.pathname === endpoint && url.searchParams.get('service') === 'YouTube') {
      const selected = JSON.parse(url.searchParams.get('categories'));
      requests.push(selected.sort());
      const matching = categories.filter(([category]) => selected.includes(category))
        .map(([category, , start, end]) => ({ category, segment: [start, end], actionType: 'skip', videoDuration: 20 }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ videoID: videoId, segments: matching }]));
    } else {
      res.writeHead(404).end();
    }
  });
  async function close() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const api = 'http://127.0.0.1:' + server.address().port;
    const url = api + '/source';
    const track = name => [{ url: api + name, ext: 'srt' }];
    const info = {
      id: videoId, title: 'Synthetic replay', extractor: 'youtube', extractor_key: 'Youtube',
      duration: 20, webpage_url: url,
      formats: [{ url: media.url, format_id: 'combined', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a.40.2' }],
      thumbnail: api + '/cover.png', thumbnails: [{ url: api + '/cover.png', ext: 'png' }],
      subtitles: { en: track('/creator.srt') },
      automatic_captions: { en: track('/automatic.srt'), fr: track('/fallback.srt') },
    };
    return { url, port: server.address().port, info, requests, close, mediaReads: media.gets,
      rejectImage: () => { rejectImage = true; }, rejectedReads: () => rejectedReads };
  } catch (error) {
    await close();
    throw error;
  }
}

async function verify(browser, fixture, destination, ffprobe, ffmpeg) {
  async function preview() {
    await browser.$('#download-url').setValue(fixture.url);
    await browser.$('#download-preview-button').click();
    await browser.waitUntil(() => browser.$('#download-preview').isDisplayed(), { timeout: 60000 });
  }
  async function select(id, value) {
    const actual = await browser.execute((id, value) => {
      const select = document.getElementById(id);
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return select.value;
    }, id, value);
    assert.equal(actual, value);
  }
  async function save(description, expectedStatus = 'saved') {
    const before = (await browser.$$('#download-jobs li')).length;
    await browser.$('#download-start').click();
    const row = () => browser.$('#download-jobs li:last-child');
    await browser.waitUntil(async () => (await browser.$$('#download-jobs li')).length === before + 1 &&
      ['saved', 'failed', 'saveFailed', 'cancelled'].includes(await row().getAttribute('data-status')),
      { timeout: 90000, timeoutMsg: description + ' did not reach a terminal state' });
    assert.equal(await row().getAttribute('data-status'), expectedStatus, description + ': ' + await row().getText());
    return browser.execute(() => Array.from(document.querySelectorAll('#download-jobs li:last-child select option'), opt => opt.textContent));
  }
  await browser.$('#download-choose-folder').click();
  await browser.waitUntil(async () => await browser.$('#download-folder').getText() === destination);
  for (const choices of [['thumbnail'], ['metadata'], ['thumbnail', 'metadata']]) {
    await preview();
    const reviewedTitle = await browser.$('#download-title').getText();
    await select('dl-selection', 'combined');
    await select('dl-range', 'custom');
    await select('dl-sponsor', 'mark');
    await select('dl-content', 'extras');
    assert.equal(await browser.$('#download-start').isEnabled(), false);
    for (const choice of choices) await browser.$('#dl-' + choice).click();
    const existing = new Set(fs.readdirSync(destination));
    const mediaReads = fixture.mediaReads();
    const names = await save('Extras Only ' + choices.join(' and '));
    assert.equal(fixture.mediaReads(), mediaReads, 'Extras Only read source media');
    assert.equal(fixture.requests.length, 0, 'Inactive SponsorBlock option made a request');
    assert.deepEqual(fs.readdirSync(destination).filter(name => !existing.has(name)).sort(), [...names].sort());
    assert.equal(names.length, choices.length);
    if (choices.includes('metadata')) {
      const name = names.find(name => name.endsWith('.info.json'));
      assert.ok(name, 'Missing metadata receipt');
      const json = JSON.parse(fs.readFileSync(path.join(destination, name), 'utf8'));
      assert.deepEqual([json.id, json.title, json.duration], [fixture.info.id, reviewedTitle, fixture.info.duration]);
    }
    if (choices.includes('thumbnail')) {
      const name = names.find(name => name.endsWith('.jpg'));
      assert.ok(name, 'Missing thumbnail receipt');
      const file = path.join(destination, name);
      const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file],
        { encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.equal(probe.status, 0, probe.stderr);
      assert.deepEqual(JSON.parse(probe.stdout).streams, [{ codec_name: 'mjpeg', width: 64, height: 32 }]);
      const pixel = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-vf', 'scale=1:1', '-frames:v', '1',
        '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { timeout: 15000, windowsHide: true });
      assert.equal(pixel.status, 0, String(pixel.stderr));
      assert.ok(pixel.stdout.length === 3 && pixel.stdout[0] > 220 && pixel.stdout[1] < 30 && pixel.stdout[2] < 30);
    }
  }
  for (const [mode, expected] of [
    ['manual', { en: 'Creator English' }],
    ['auto', { en: 'Automatic English', fr: 'Automatic French' }],
    ['both', { en: 'Creator English', fr: 'Automatic French' }],
  ]) {
    await preview();
    assert.equal(await browser.$('#dl-sponsors').isDisplayed(), true);
    await select('dl-content', 'extras');
    assert.equal(await browser.$('#dl-sponsors').isDisplayed(), false);
    await browser.$('#dl-subs').click();
    await select('dl-submode', mode);
    const suggestions = await browser.execute(() => Array.from(document.querySelector('#dl-languages').options, option => option.value));
    assert.deepEqual(suggestions.sort(), Object.keys(expected).sort());
    await browser.$('#dl-langs').setValue(Object.keys(expected).join(','));
    const files = await save(mode + ' captions');
    assert.equal(files.length, Object.keys(expected).length);
    for (const [language, cue] of Object.entries(expected)) {
      const file = files.find(name => name.endsWith('.' + language + '.srt'));
      assert.ok(file, 'Missing language-specific output: ' + language);
      const content = fs.readFileSync(path.join(destination, file), 'utf8').trim().replace(/\r/g, '');
      assert.equal(content, '1\n00:00:00,000 --> 00:00:01,000\n' + cue);
    }
  }
  const expectedRequests = [];
  for (const [mode, selected] of [
    ['off', []],
    ['mark', ['intro', 'outro']],
    ['mark', categories.map(([category]) => category)],
    ['remove', ['outro']],
  ]) {
    await preview();
    if (mode !== 'off') {
      await browser.$('#dl-sponsors summary').click();
      await select('dl-sponsor', mode);
      for (const [category] of categories) {
        const checkbox = browser.$('#dl-categories input[value="' + category + '"]');
        if (await checkbox.isSelected() !== selected.includes(category)) await checkbox.click();
      }
      expectedRequests.push([...selected].sort());
    }
    const files = await save('SponsorBlock ' + mode + ' ' + selected.join(','));
    assert.equal(files.length, 1);
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-show_chapters',
      '-of', 'json', path.join(destination, files[0])], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
    const { streams, format, chapters } = JSON.parse(probe.stdout);
    for (const kind of ['audio', 'video']) assert.equal(streams.filter(s => s.codec_type === kind).length, 1);
    assert.ok(Math.abs(Number(format.duration) - (mode === 'remove' ? 10 : 20)) < 0.5);
    const markers = chapters.filter(ch => ch.tags?.title.includes('SponsorBlock'));
    const marked = categories.filter(([category]) => mode === 'mark' && selected.includes(category));
    assert.deepEqual(markers.map(ch => [Number(ch.start_time), Number(ch.end_time)]), marked.map(([, , start, end]) => [start, end]));
    for (const [index, [, label]] of marked.entries()) {
      assert.ok(markers[index].tags.title.includes(label));
    }
    assert.deepEqual(fixture.requests, expectedRequests);
  }
  console.log('PASS native Download: caption sources and fallback, SponsorBlock requests, marked intervals and removed duration');
  await preview();
  await select('dl-content', 'extras');
  await browser.$('#dl-thumbnail').click();
  const before = fs.readdirSync(destination).sort();
  const reads = fixture.mediaReads();
  fixture.rejectImage();
  assert.deepEqual(await save('Rejected thumbnail', 'failed'), []);
  assert.ok(fixture.rejectedReads() > 0);
  assert.equal(fixture.mediaReads(), reads);
  assert.deepEqual(fs.readdirSync(destination).sort(), before);
  console.log('PASS native Extras Only: JPEG, source metadata, combined receipts, zero media reads and rejected artwork');
}
module.exports = { start, verify };
