'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

test('browser download queue tracks jobs independently from the focused progress panel', () => {
  assert.match(appSource, /const trackedJobs = new Map\(\)/);
  assert.match(appSource, /const queueSources = new Map\(\)/);
  assert.match(appSource, /function trackQueueJob\(jobId, snapshot\)/);
  assert.match(appSource, /new EventSource\(`\/api\/download\/progress\?id=/);
  assert.match(appSource, /Added to the download queue\. Downloads run one at a time\./);
  assert.match(appSource, /preview\.insertAdjacentElement\('afterend', queuePanel\)/);
});

test('queue lifecycle actions use authoritative server responses', () => {
  assert.match(appSource, /async function manageQueueJob\(jobId\)/);
  assert.match(appSource, /method: 'DELETE'/);
  assert.match(appSource, /if \(!response\.ok\) throw new Error/);
  assert.match(appSource, /job\.data = data\.job \|\| job\.data/);
  assert.match(appSource, /data\.action === 'cancelling'/);
  assert.match(appSource, /data\.action === 'cancelled'/);
  assert.match(appSource, /data\.action === 'cleared'/);
  for (const label of ['Cancel', 'Remove', 'Dismiss', 'Clear', 'Cancelling…']) {
    assert.match(appSource, new RegExp(`'${label}'`));
  }
});

test('queue closes terminal streams and auto-download stays deduplicated', () => {
  assert.match(appSource, /TERMINAL_JOB_STATUSES\.has\(data\.status\)/);
  assert.match(appSource, /const autoDownloadedQueueJobs = new Set\(\)/);
  assert.match(appSource, /function triggerAutoDownload\(jobId, url\)/);
  assert.match(appSource, /autoDownloadedQueueJobs\.has\(jobId\)/);
});

test('queue snapshots keep distinguishing request choices and the session-only Preview thumbnail', () => {
  assert.match(appSource, /const playlistUrls = selectedPlaylistUrls\(\)/);
  assert.match(appSource, /thumbnailUrl: currentInfo\.thumbnail \|\| ''/);
  assert.match(appSource, /\n\s*options,\n/);
  assert.match(appSource, /isPlaylist: currentInfo\.kind === 'playlist'/);
  assert.match(appSource, /selectionCount: playlistUrls\.length/);
  assert.match(appSource, /selection: \{ entryUrls: playlistUrls \}/);
});

test('queue rows show mode detail, prepared state, and compact thumbnails', () => {
  assert.match(appSource, /function queueModeSummary\(job = \{\}\)/);
  for (const label of ['Video + Audio', 'Video Only', 'Audio Only', 'Extras Only', 'Compatible MP4', 'Maximum Quality', 'Source Audio', 'MP3']) {
    assert.match(appSource, new RegExp(`'${label.replace(/[+]/g, '\\+')}'`));
  }
  assert.match(appSource, /data\.status === 'ready'\) return 'Prepared'/);
  assert.match(appSource, /const mode = queueModeSummary\(job\)/);
  assert.match(appSource, /image\.className = 'queue-thumbnail'/);
  assert.match(styleSource, /\.queue-thumbnail \{ width: 56px; height: 56px;/);
  assert.match(styleSource, /\.queue-row\.prepared/);
});

test('multiple prepared outputs collapse into one named queue file menu', () => {
  const helperStart = appSource.indexOf('function appendQueueOutputActions');
  const helperEnd = appSource.indexOf('function closeQueueSource', helperStart);
  const helperSource = appSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /outputs\.length === 1/);
  assert.match(helperSource, /queueDownloadLink\(outputs\[0\]\)/);
  assert.match(helperSource, /files\.className = 'queue-files'/);
  assert.match(helperSource, /summary\.textContent = `Files \(\$\{outputs\.length\}\)`/);
  assert.match(helperSource, /output\.label \|\| `File \$\{index \+ 1\}`/);
  assert.match(helperSource, /output\.filename, formatBytes\(output\.size\)/);

  const renderStart = appSource.indexOf('function renderQueue');
  const renderEnd = appSource.indexOf('function trackQueueJob', renderStart);
  const renderSource = appSource.slice(renderStart, renderEnd);
  assert.match(renderSource, /appendQueueOutputActions\(actions, data\.outputs \|\| \[\]\)/);
  assert.doesNotMatch(renderSource, /for \(const output of data\.outputs/);

  for (const selector of ['.queue-files', '.queue-files-menu', '.queue-file-item']) {
    assert.match(styleSource, new RegExp(selector.replace('.', '\\.')));
  }
});

test('terminal queue jobs notify History by exact job id and retire failures only after confirmation', () => {
  assert.match(appSource, /function notifyHistoryTerminal\(jobId, statusValue\)/);
  assert.match(appSource, /new CustomEvent\('lvovd:terminal-job'/);
  assert.match(appSource, /detail: \{ jobId, status: statusValue \}/);
  assert.match(appSource, /notifyHistoryTerminal\(jobId, data\.status\)/);
  assert.match(appSource, /document\.addEventListener\('lvovd:history-confirmed'/);

  const start = appSource.indexOf('function retireHistoryBackedQueueJob');
  const end = appSource.indexOf('function triggerAutoDownload', start);
  const retireSource = appSource.slice(start, end);
  assert.match(retireSource, /\['error', 'cancelled'\]\.includes\(statusValue\)/);
  assert.match(retireSource, /trackedJobs\.delete\(jobId\)/);
  assert.doesNotMatch(retireSource, /'ready'/);
});

test('download start sends bounded Preview display context for local history', () => {
  assert.match(appSource, /display:\s*\{/);
  assert.match(appSource, /title: currentInfo\.title \|\| ''/);
  assert.match(appSource, /sourceName: currentInfo\.source\?\.name \|\| currentInfo\.source\?\.hostname \|\| ''/);
});
