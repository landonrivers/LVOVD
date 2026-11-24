'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureLayout } = require('./layout.cjs');

// Serve only this generated fixture. Blocking an acquisition GET after Preview lets
// the native workflow deterministically exercise a disconnected folder and cancellation.
async function startProvider(video, ffmpeg, extraAssets = []) {
  // The extracted-ZIP harness serves a single prepared MP4 without build tools.
  const assets = new Map([['/fixture.mp4',video], ...extraAssets]);
  let dash;
  if (ffmpeg) {
    dash = fs.mkdtempSync(path.join(require('node:os').tmpdir(),'lvovd-dash-'));
    const generated = spawnSync(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-i',path.resolve(video),'-t','3',
      '-map','0:v:0','-map','0:a:0','-c','copy','-f','dash','fixture.mpd'],{cwd:dash,encoding:'utf8',timeout:30000,windowsHide:true});
    if (generated.status!==0) {
      fs.rmSync(dash,{recursive:true,force:true});
      throw new Error(generated.error?.message || generated.stderr);
    }
    for (const name of fs.readdirSync(dash)) assets.set('/dash/'+name,path.join(dash,name));
  }
  let hold = false, gets = 0;
  const waiting = new Set();
  const server = http.createServer((request, response) => {
    const file = assets.get(request.url);
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end(); return;
    }
    const bytes=fs.statSync(file).size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(bytes - 1, Number(range[2])) : bytes - 1;
    if (start > end) { response.writeHead(416).end(); return; }
    const type = request.url.endsWith('.mpd') ? 'application/dash+xml' : request.url.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + bytes;
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(range ? 206 : 200, headers);
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = fs.createReadStream(file, { start, end });
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
    dash: dash && 'http://127.0.0.1:' + server.address().port + '/dash/fixture.mpd',
    hold() { hold = true; },
    held() { return waiting.size; },
    gets() { return gets; },
    release() { hold = false; for (const send of waiting) send(); waiting.clear(); },
    async close() {
      this.release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      if (dash) fs.rmSync(dash,{recursive:true,force:true});
    }
  };
}

async function downloadScenario(browser, provider, destination, ffprobe, evidence, ffmpeg) {
  const wait = (test, message) => browser.waitUntil(test, { timeout: 60000, timeoutMsg: message });
  async function preview(url=provider.url) {
    await browser.$('#download-url').setValue(url);
    await browser.$('#download-preview-button').click();
    await wait(async () => (await browser.$('#download-preview').isDisplayed()), 'yt-dlp returned no single-media Preview');
  }
  await browser.$('#download-choose-folder').click();
  await wait(async () => (await browser.$('#download-folder').getText()) === destination, 'Native folder selection did not complete');
  await preview(provider.dash);
  for (const [width, height] of [[1280, 720], [960, 640]]) {
    await captureLayout(browser, width, height, path.join(evidence, 'download-preview-' + width + '-' + process.platform + '.png'),
      'desktop-download', ['nav-download', 'nav-local', 'nav-settings', 'download-url', 'download-preview-button',
        'download-choose-folder', 'dl-content-av', 'dl-content-extras', 'dl-profile-compatible', 'dl-profile-maximum', 'download-start']);
  }
  // Select the visible card face, then exercise keyboard navigation within each group.
  await browser.$('#dl-maximum-title').click();
  assert.equal(await browser.$('#dl-profile-maximum').isSelected(), true);
  await browser.keys('ArrowLeft');
  assert.equal(await browser.$('#dl-profile-compatible').isSelected(), true);
  await browser.$('label:has(#dl-content-audio)').click();
  assert.equal(await browser.$('#download-start').getText(), 'Download Audio');
  assert.equal(await browser.$('#dl-profile-cards').isDisplayed(), false);
  await browser.keys('ArrowRight');
  assert.equal(await browser.$('#download-start').getText(), 'Download Extras');
  await preview();
  assert.equal(await browser.$('#dl-height').isEnabled(), false, 'An unknown source height offers only uncapped Download');
  assert.equal(await browser.$('#dl-height').getValue(), '');
  assert.equal(await browser.$('#dl-sponsors').isDisplayed(), false, 'Generic sources are ineligible for SponsorBlock');
  assert.equal(await browser.$('#dl-thumbnail').isEnabled(), false, 'A source without artwork cannot offer a thumbnail');
  const filename = await browser.$('#download-filename').getText();
  assert.ok(filename && path.basename(filename) === filename, 'Preview exposes the reviewed media filename');
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
  const exported = path.join(destination, outputs[0]);
  fs.renameSync(exported, exported + '.moved');
  try {
    await browser.$(saved + ' [data-action="reveal"]').click();
    await wait(async () => /moved|removed/i.test(await browser.$(saved + ' [role="status"]').getText()), 'Moved exports must report that their receipt no longer resolves');
  } finally { fs.renameSync(exported + '.moved', exported); }
  await preview();
  provider.hold();
  await browser.$('#download-start').click();
  await wait(() => provider.held() > 0, 'Cancellation requires an active provider read');
  await browser.$('#download-jobs li[data-status="downloading"] [data-action="cancel"]').click();
  await wait(async () => browser.$('#download-jobs li[data-status="cancelled"]').isDisplayed(), 'The active download did not cancel');
  provider.release();
  assert.equal(fs.readdirSync(destination).length, 2, 'Cancelled work published an extra file');
  await preview();
  await browser.$('#dl-content-extras').click();
  await wait(async()=>await browser.$('#download-start').getText()==='Download Extras','Content selection did not change to Extras Only');
  assert.equal(await browser.execute(()=>document.getElementById('download-start').disabled), true);
  await browser.$('#dl-metadata').click();
  await browser.$('#download-start').click();
  await wait(async () => fs.readdirSync(destination).some(name=>name.endsWith('.info.json')), 'Extras Only did not publish metadata');
  const metadata=fs.readdirSync(destination).find(name=>name.endsWith('.info.json'));
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(destination,metadata),'utf8')).id,'string');
  assert.equal(fs.readdirSync(destination).length,3,'Extras Only also published media');
  await preview();
  await browser.$('#dl-extras summary').click();
  await browser.$('#dl-metadata').click();
  await browser.$('#download-start').click();
  await wait(async () => (await browser.$$('#download-jobs li[data-status="saved"]')).length===3, 'Media and companion save did not complete');
  const names=await browser.execute(()=>Array.from(
    document.querySelector('#download-jobs li:last-child select').options,option=>option.textContent));
  assert.equal(names.length,2);
  assert.ok(names[0].endsWith('.mp4') && names[1].endsWith('.info.json'));
  for(const name of names) assert.ok(fs.statSync(path.join(destination,name)).size>0);
  async function choose(id, value) {
    if (id === 'dl-content' || id === 'dl-profile') {
      const radio = browser.$('#' + id + '-' + value);
      await radio.click();
      return await radio.isSelected() ? value : null;
    }
    return browser.execute((id,value)=>{
    const select=document.getElementById(id);
    select.value=value; select.dispatchEvent(new Event('change',{bubbles:true}));
    return select.value;
    },id,value);
  }
  const modes = [
    ...Object.entries({source:'aac',m4a:'aac',mp3:'mp3',opus:'opus',flac:'flac',wav:'pcm_s16le'})
      .map(([format,codec])=>({content:'audio',selection:'audio',format,expected:[codec]})),
    {content:'video',selection:'video',expected:['h264']},
    {content:'av',selection:'separate',expected:['aac','h264']},
    {content:'av',selection:'automatic',expected:['aac','h264']}
  ];
  for (const {content,selection,format,expected} of modes) {
    await preview(provider.dash);
    assert.equal(await choose('dl-content',content),content);
    assert.equal(await choose('dl-selection',selection),selection);
    if(format) assert.equal(await choose('dl-audio',format),format);
    if(selection==='automatic') {
      assert.equal(await choose('dl-profile','maximum'),'maximum');
      assert.equal(await choose('dl-height','360'),'360');
    }
    const count=(await browser.$$('#download-jobs li[data-status="saved"]')).length;
    await browser.$('#download-start').click();
    await wait(async ()=>(await browser.$$('#download-jobs li[data-status="saved"]')).length===count+1,'Exact '+content+' selection did not save');
    const name=await browser.execute(()=>document.querySelector('#download-jobs li:last-child select option').textContent);
    const probe=spawnSync(ffprobe,['-v','error','-show_entries','stream=codec_name','-of','json',path.join(destination,name)],{encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(probe.status,0,probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout).streams.map(stream=>stream.codec_name).sort(),expected);
  }
  async function finish(status) {
    const before = (await browser.$$('#download-jobs li')).length;
    const row = () => browser.$('#download-jobs li:last-child');
    await browser.$('#download-start').click();
    await wait(async () => (await browser.$$('#download-jobs li')).length === before + 1 &&
      ['saved', 'failed', 'saveFailed', 'cancelled'].includes(await row().getAttribute('data-status')),
      'New download did not reach a terminal state');
    assert.equal(await row().getAttribute('data-status'), status, await row().getText());
    return browser.execute(() => Array.from(document.querySelectorAll('#download-jobs li:last-child select option'), o => o.textContent));
  }
  const advanced = require('./chapter-caption-fixture.cjs');
  const fixture = await advanced.start(ffmpeg);
  try {
    async function selectChapters(url) {
      await preview(url);
      await browser.$('#dl-times summary').click();
      await choose('dl-range','chapters');
      await browser.$('#dl-chapters input[value="2"]').click();
      await browser.$('#dl-chapters input[value="0"]').click();
    }
    await selectChapters(fixture.chapters);
    const files = await finish('saved');
    advanced.verifyChapters(files.map(name=>path.join(destination,name)),ffmpeg,ffprobe);
    const prior = fs.readdirSync(destination).sort();
    await selectChapters(fixture.changing);
    fixture.change();
    await finish('failed');
    assert.match(await browser.$('#download-jobs li:last-child').getText(),/chapter.*preview/i);
    assert.deepEqual(fs.readdirSync(destination).sort(),prior);
    await preview(fixture.captions);
    await choose('dl-content','extras');
    await browser.$('#dl-subs').click();
    await choose('dl-submode','manual');
    await browser.$('#dl-langs').setValue('en,fr');
    const tracks=await finish('saved');
    advanced.verifyCaptions(tracks.map(name=>path.join(destination,name)));
    const beforeMissing=fs.readdirSync(destination).sort();
    await preview(fixture.captions);
    await choose('dl-content','extras');
    await browser.$('#dl-subs').click();
    await browser.$('#dl-langs').setValue('zz');
    await finish('failed');
    assert.deepEqual(fs.readdirSync(destination).sort(),beforeMissing);
  } finally { await fixture.close(); }
  const profiles = require('./profile-fixture.cjs');
  const competition = await profiles.start(ffmpeg);
  try {
    for (const scenario of competition.cases) {
      await preview(scenario.url);
      const modernOnly = scenario.source === 'modern';
      assert.equal(await browser.$('#dl-profile-' + (modernOnly ? 'maximum' : 'compatible')).isSelected(), true);
      assert.equal(await browser.$('#dl-profile-compatible').isEnabled(), !modernOnly);
      assert.equal(await choose('dl-profile', scenario.profile), scenario.profile);
      if (scenario.cap) assert.equal(await choose('dl-height', String(scenario.cap)), String(scenario.cap));
      const names = await finish('saved');
      assert.equal(names.length, 1);
      profiles.verify(ffprobe, path.join(destination, names[0]), scenario);
      console.log('PASS native profile:', scenario.source, scenario.profile, scenario.cap || 'uncapped', scenario.video, scenario.audio);
    }
    await preview(competition.resolutions);
    const height = browser.$('#dl-height');
    async function checkHeights(best, heights) {
      const options = await browser.execute(() => Array.from(document.querySelector('#dl-height').options,
        o => [o.value, o.textContent]));
      assert.deepEqual(options, [['', best], ...heights.map(h => [String(h), 'Up to ' + h + 'p'])]);
    }
    const compatible = [8640,4320,2160,1440,540,480,360,240,144];
    const maximum = [8640,4320,2160,1440,1080,720,540,480,360,240,144];
    await checkHeights('Best compatible resolution', compatible);
    assert.equal(await height.getValue(), '');
    await choose('dl-profile', 'maximum');
    await checkHeights('Best available resolution', maximum);
    await choose('dl-height', '1080');
    await choose('dl-content', 'video');
    await checkHeights('Best available resolution', maximum.filter(h => h !== 1080));
    assert.equal(await height.getValue(), '', 'The combined-only 1080p cap must reset in Video Only');
    await choose('dl-height', '720');
    await choose('dl-profile', 'compatible');
    await checkHeights('Best compatible resolution', compatible);
    assert.equal(await height.getValue(), '', 'The VP9-only 720p cap must reset in Compatible MP4');
    for (const content of ['audio', 'extras']) {
      await preview(competition.resolutions);
      assert.equal(await choose('dl-height', '144'), '144');
      await choose('dl-content', content);
      assert.equal(await height.isDisplayed(), false);
      assert.equal(await height.isEnabled(), false);
      if (content === 'audio') await choose('dl-audio', 'source');
      else await browser.$('#dl-metadata').click();
      const before = new Set(fs.readdirSync(destination));
      const [savedName] = await finish('saved');
      assert.deepEqual(fs.readdirSync(destination).filter(name => !before.has(name)), [savedName]);
      const file = path.join(destination, savedName);
      if (content === 'audio') profiles.verifySourceAudio(ffprobe, file);
      else {
        assert.ok(savedName.endsWith('.info.json'));
        assert.equal(typeof JSON.parse(fs.readFileSync(file, 'utf8')).id, 'string');
      }
    }
    console.log('PASS native resolution menus from 144p to 8640p, capped video to source audio and metadata-only saves');
  } finally { await competition.close(); }
}

module.exports = { downloadScenario, startProvider };
