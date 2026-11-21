'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../desktop');
require('../../scripts/desktop.cjs').prepare();

test('single-media options follow the reviewed formats, chapter selection and content mode', async ({ page }) => {
  const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
  await page.setContent(html);
  await page.addScriptTag({path:path.join(root,'download-options.js')});
  await page.evaluate(()=>{
    document.querySelector('#download-preview').hidden=false;
    window.optionsForm=LVOVDDownloadOptions(()=>{});
    optionsForm.reset({filename:'Fixture.mp4',profile:'compatible',choices:{
      available:true,av:true,video:true,audio:true,compatibleVideo:true,heights:[720,1080],compatibleHeights:[720],
      videoHeights:[720,1080],compatibleVideoHeights:[720],formats:[
        {id:'v',kind:'video',selectable:true,height:720},{id:'a',kind:'audio',selectable:true},{id:'c',kind:'combined',selectable:true}],
      chapters:[{index:0,title:'First'},{index:1,title:'Second'}],thumbnail:true,manualLanguages:['fr'],autoLanguages:['en'],sponsor:true
    }});
  });
  const field=k=>page.locator('#dl-'+k);
  const read=()=>page.evaluate(()=>optionsForm.read());
  await field('profile').selectOption('maximum');
  await field('height').selectOption('1080');
  expect((await read()).maxHeight).toBe(1080);
  await page.locator('#dl-formats summary').click();
  await field('selection').selectOption('separate');
  expect((await read()).formatIds).toEqual(['v','a']);
  await page.locator('#dl-times summary').click();
  await field('range').selectOption('chapters');
  await page.getByLabel('2. Second').check();
  await expect(page.locator('#download-filename')).toHaveText('Fixture - Chapter 2.mp4');
  await page.locator('#dl-sponsors summary').click();
  await field('sponsor').selectOption('remove');
  await page.getByLabel('Intro',{exact:true}).check();
  expect((await read()).sponsor).toEqual({mode:'remove',categories:['sponsor','intro']});
  await field('content').selectOption('audio');
  await field('audio').selectOption('flac');
  expect((await read()).audioFormat).toBe('flac');
  await field('content').selectOption('extras');
  await field('metadata').check();
  await field('subs').check();
  await field('submode').selectOption('manual');
  await field('langs').fill('fr');
  expect(await read()).toMatchObject({content:'extras',formatIds:[],range:{type:'full'},metadata:true,
    subtitles:{mode:'manual',languages:'fr'},sponsor:null});
});

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
  await page.addScriptTag({ path: path.join(root, 'download-options.js') });
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
