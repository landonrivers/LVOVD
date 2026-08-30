'use strict';

process.env.YTDLP_PATH = process.platform === 'win32' ? 'C:\\fake\\yt-dlp.exe' : '/tmp/fake-yt-dlp';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  sortHistoryEntries,
  hasHistoryEntry,
  isExactAvailable,
  intersectPlaylistUrls,
  planRangeRestore
} = require('../public/history-ui');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `Expected ${name} in source`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
}

test('history ordering is newest first even when stored input is not ordered', () => {
  const entries = sortHistoryEntries([
    { id: 'old', finishedAt: '2026-08-20T12:00:00.000Z' },
    { id: 'new', finishedAt: '2026-08-22T12:00:00.000Z' },
    { id: 'middle', finishedAt: '2026-08-21T12:00:00.000Z' }
  ]);
  assert.deepEqual(entries.map((entry) => entry.id), ['new', 'middle', 'old']);
});

test('history confirmation checks the exact terminal job id', () => {
  const entries = [{ id: 'job-a' }, { id: 'job-b' }];
  assert.equal(hasHistoryEntry(entries, 'job-a'), true);
  assert.equal(hasHistoryEntry(entries, 'job-c'), false);
  assert.equal(hasHistoryEntry(entries, ''), false);
  assert.equal(hasHistoryEntry(null, 'job-a'), false);
});

test('safe reuse requires exact current choices instead of inventing substitutes', () => {
  assert.equal(isExactAvailable('av', ['av', 'audio']), true);
  assert.equal(isExactAvailable('video', ['av', 'audio']), false);
  assert.equal(isExactAvailable('compatible', ['maximum']), false);
  assert.equal(isExactAvailable(1080, ['', '2160', '1080', '720']), true);
  assert.equal(isExactAvailable(1080, ['', '2160', '720']), false);
  assert.equal(isExactAvailable(null, ['', '1080']), true);
});

test('playlist reuse intersects exact current item URLs and never guesses by order or title', () => {
  const saved = [
    'https://example.com/watch/a',
    'https://example.com/watch/b',
    'https://example.com/watch/removed'
  ];
  const current = [
    'https://example.com/watch/b',
    'https://example.com/watch/new',
    'https://example.com/watch/a'
  ];
  assert.deepEqual(intersectPlaylistUrls(saved, current), [
    'https://example.com/watch/b',
    'https://example.com/watch/a'
  ]);
});

test('range reuse restores custom ranges only with current support and never reapplies chapter indexes', () => {
  assert.deepEqual(
    planRangeRestore({ type: 'custom', start: 15, end: 45 }, { customSupported: true }),
    { type: 'custom', start: 15, end: 45, restored: true, reason: null }
  );
  assert.deepEqual(
    planRangeRestore({ type: 'custom', start: 15, end: 45 }, { customSupported: false }),
    { type: 'full', restored: false, reason: 'custom range' }
  );
  assert.deepEqual(
    planRangeRestore({ type: 'chapters', chapterIndexes: [0, 2] }, { customSupported: true }),
    { type: 'full', restored: false, reason: 'chapter selection' }
  );
});

test('Extras Only server normalization discards hidden range and SponsorBlock semantics', () => {
  const { normalizeOptions, buildYtdlpArgs } = require('../app-server');
  const options = normalizeOptions({
    content: 'extras',
    range: { type: 'custom', start: 'not-a-time', end: 'also-not-a-time' },
    extras: { metadata: true },
    sponsor: { mode: 'remove', categories: ['sponsor', 'intro'] }
  });

  assert.deepEqual(options.range, { type: 'full' });
  assert.equal(options.sponsor.mode, 'off');

  const args = buildYtdlpArgs(
    { url: 'https://media.example/watch/1' },
    options,
    '/tmp/%(title)s.%(ext)s',
    'download:test'
  );
  assert.equal(args.includes('--download-sections'), false);
  assert.equal(args.some((value) => /^--sponsorblock-/.test(value)), false);
});

test('history panel is separate from Preview, queue placement, and Runtime Status', () => {
  const html = read('public/index.html');
  const previewIndex = html.indexOf('id="preview"');
  const historyIndex = html.indexOf('id="history-panel"');
  const runtimeIndex = html.indexOf('class="requirements"');
  assert.ok(previewIndex >= 0 && historyIndex > previewIndex && runtimeIndex > historyIndex);
  assert.match(html, /id="history-show-more"/);
  assert.match(html, /id="history-retry"/);
  assert.match(html, /id="history-clear-all"/);
  assert.match(html, /<script src="\/app\.js" defer><\/script>\s*<script src="\/history-ui\.js" defer><\/script>/);
  assert.match(read('app-server.js'), /'\/history-ui\.js': \['history-ui\.js', 'text\/javascript; charset=utf-8'\]/);
});

test('history UI covers terminal states, details, deletion, clear confirmation, and isolated retry', () => {
  const source = read('public/history-ui.js');
  for (const label of ['Completed', 'Failed', 'Cancelled']) assert.match(source, new RegExp(`'${label}'`));
  for (const label of [
    'Source URL', 'Content', 'Profile', 'Resolution', 'Audio output', 'Range', 'Extras',
    'Subtitle mode', 'Subtitle language', 'SponsorBlock', 'Playlist selection', 'Selected item URLs',
    'Output', 'Terminal time', 'Failure category', 'Failure title', 'Failure message', 'Next step'
  ]) {
    assert.match(source, new RegExp(`'${label}'`));
  }
  assert.match(source, /fetch\(`\/api\/history\?id=\$\{encodeURIComponent\(id\)\}`/);
  assert.match(source, /fetch\('\/api\/history\?all=1', \{ method: 'DELETE' \}\)/);
  assert.match(source, /Clear all download history\?/);
  assert.match(source, /does not delete media files saved by your browser/);
  assert.match(source, /Preview and downloads are still available\./);
  assert.match(source, /historyRetry\.hidden = false/);
  const load = functionSource(source, 'loadHistory', 'deleteHistoryEntry');
  assert.doesNotMatch(load, /setMainStatus/);
});

test('Use Again submits the normal Preview form and does not start a download', () => {
  const source = read('public/history-ui.js');
  const useAgain = functionSource(source, 'useAgainEntry', 'finishPendingRestore');
  assert.match(useAgain, /urlInput\.value = sourceUrl/);
  assert.match(useAgain, /form\.requestSubmit\(\)/);
  assert.doesNotMatch(useAgain, /\/api\/download\/start/);
  assert.doesNotMatch(useAgain, /startDownload/);

  const previewRestore = functionSource(source, 'finishPendingRestore', 'useAgainEntry');
  assert.match(previewRestore, /resetRestorationDefaults\(\)/);
  assert.match(previewRestore, /restoreHistoryChoices\(entry\)/);
  assert.match(previewRestore, /then click Download when ready/);
});

test('reuse policy warns for non-restorable chapters and uses current DOM availability gates', () => {
  const source = read('public/history-ui.js');
  const restore = functionSource(source, 'restoreHistoryChoices', 'finishPendingRestore');
  assert.match(restore, /chapter selection \(choose chapters again\)/);
  assert.match(restore, /customSupported: !customRangeOption\?\.hidden/);
  assert.match(restore, /sponsorDetails\.hidden/);
  assert.match(restore, /intersectPlaylistUrls\(savedPlaylistUrls, currentUrls\)/);
  assert.match(restore, /isExactAvailable\(saved\.extras\.subtitleLanguage, codes\)/);
});

test('terminal job events refresh History by exact job id with at most one delayed retry', () => {
  const source = read('public/history-ui.js');
  assert.doesNotMatch(source, /TERMINAL_QUEUE_PATTERN|inspectQueueForTerminalState/);
  assert.match(source, /document\.addEventListener\('lvovd:terminal-job', handleTerminalJob\)/);

  const confirm = functionSource(source, 'confirmPersistedTerminalJobs', 'refreshPendingTerminalJobs');
  assert.match(confirm, /hasHistoryEntry\(entries, jobId\)/);
  assert.match(confirm, /new root\.CustomEvent\('lvovd:history-confirmed'/);
  assert.match(confirm, /detail: \{ jobId, status: statusValue \}/);

  const refresh = functionSource(source, 'refreshPendingTerminalJobs', 'handleTerminalJob');
  assert.match(refresh, /await loadHistory\(\{ keepVisibleCount: true \}\)/);
  assert.match(refresh, /root\.setTimeout\(/);
  assert.match(refresh, /500/);
  assert.match(refresh, /refreshPendingTerminalJobs\(\{ allowRetry: false \}\)/);

  const handle = functionSource(source, 'handleTerminalJob');
  assert.match(handle, /pendingTerminalJobs\.set\(jobId, statusValue\)/);
  assert.match(handle, /refreshPendingTerminalJobs\(\{ allowRetry: true \}\)/);
});
