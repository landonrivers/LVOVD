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

async function start(mediaUrl) {
  const requests = [];
  const endpoint = '/api/skipSegments/' + createHash('sha256').update(videoId).digest('hex').slice(0, 4);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (Object.hasOwn(captions, url.pathname)) {
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
      formats: [{ url: mediaUrl, format_id: 'combined', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a.40.2' }],
      subtitles: { en: track('/creator.srt') },
      automatic_captions: { en: track('/automatic.srt'), fr: track('/fallback.srt') },
    };
    return { url, port: server.address().port, info, requests, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function verify(browser, fixture, destination, ffprobe) {
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
  async function save(description) {
    const before = (await browser.$$('#download-jobs li')).length;
    await browser.$('#download-start').click();
    const row = () => browser.$('#download-jobs li:last-child');
    await browser.waitUntil(async () => (await browser.$$('#download-jobs li')).length === before + 1 &&
      ['saved', 'failed', 'saveFailed', 'cancelled'].includes(await row().getAttribute('data-status')),
      { timeout: 90000, timeoutMsg: description + ' did not reach a terminal state' });
    assert.equal(await row().getAttribute('data-status'), 'saved', description + ': ' + await row().getText());
    return browser.execute(() => Array.from(document.querySelectorAll('#download-jobs li:last-child select option'), opt => opt.textContent));
  }
  await browser.$('#download-choose-folder').click();
  await browser.waitUntil(async () => await browser.$('#download-folder').getText() === destination);
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
}
module.exports = { start, verify };
