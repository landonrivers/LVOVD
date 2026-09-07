'use strict';

process.env.YTDLP_PATH = process.execPath;
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const originalSpawn = childProcess.spawn;
const calls = [];
childProcess.spawn = (command, args, options) => {
  calls.push({ command, args, options });
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('close', 1);
  queueMicrotask(() => {
    child.stdout.end(JSON.stringify({ id: 'fixture', title: 'Fixture', formats: [], chapters: [] }));
    child.stderr.end(); child.emit('close', 0);
  });
  return child;
};
const app = require('../app-server');
test.after(() => { childProcess.spawn = originalSpawn; });

function isolated(args) {
  assert.equal(args.filter(value => value === '--ignore-config').length, 1);
  assert.equal(args[0], '--ignore-config');
  assert.equal(args.includes('--config-locations'), false);
  assert.equal(args.includes('--no-plugin-dirs'), false);
  assert.equal(args.includes('--no-plugins'), false);
}

test('Preview and playlist/chapter metadata use isolated options with the custom executable and shell disabled', async () => {
  await app.fetchInfo('https://media.example/fixture');
  await app.fetchRawInfo('https://media.example/fixture', { playlist: false });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    isolated(call.args);
    assert.equal(call.command, process.execPath);
    assert.equal(call.options.shell, false);
  }
  assert.ok(calls[0].args.includes('--flat-playlist'));
  assert.ok(calls[1].args.includes('--no-playlist'));
});

test('Download and URL Edit share config isolation while keeping explicit source and SponsorBlock choices', () => {
  const url = 'https://media.example/fixture';
  const plain = app.normalizeOptions({ content: 'audio', audioFormat: 'mp3' });
  const download = app.buildYtdlpArgs({ url }, plain, 'owned.%(ext)s', 'progress');
  isolated(download);
  assert.equal(download[download.indexOf('--format') + 1], 'bestaudio');
  assert.equal(download.includes('--extract-audio'), false);
  assert.equal(download.some(value => value.startsWith('--sponsorblock')), false);
  const selected = app.normalizeOptions({ content: 'av', sponsor: { mode: 'remove', categories: ['sponsor'] } });
  const explicit = app.buildYtdlpArgs({ url, section: { start: 1, end: 2 } }, selected, 'owned.%(ext)s', 'progress');
  isolated(explicit);
  assert.ok(explicit.includes('--sponsorblock-remove'));
  assert.ok(explicit.includes('--download-sections'));
  const edit = app.buildWorkspaceAcquisitionArgs(url, app.normalizeWorkspaceAcquisition({
    content: 'av', profile: 'maximum', maxHeight: null, sourceFormat: { mode: 'auto' }
  }), 'owned.%(ext)s');
  isolated(edit);
  assert.ok(edit.includes('--no-simulate'));
  assert.ok(edit.includes('--max-filesize'));
  assert.equal(edit.some(value => value.startsWith('--sponsorblock')), false);
  assert.equal(edit.includes('-protocol_whitelist'), false, 'local policy does not restrict remote HLS/DASH acquisition');
});
