'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

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

test('queue closes terminal cancelled streams and auto-download stays deduplicated', () => {
  assert.match(appSource, /\['ready', 'error', 'cancelled'\]\.includes\(data\.status\)/);
  assert.match(appSource, /const autoDownloadedQueueJobs = new Set\(\)/);
  assert.match(appSource, /function triggerAutoDownload\(jobId, url\)/);
  assert.match(appSource, /autoDownloadedQueueJobs\.has\(jobId\)/);
});
