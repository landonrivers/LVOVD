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
});

test('queue exposes remove, cancel, dismiss and clear lifecycle actions', () => {
  assert.match(appSource, /async function manageQueueJob\(jobId\)/);
  assert.match(appSource, /method: 'DELETE'/);
  for (const label of ['Cancel', 'Remove', 'Dismiss', 'Clear']) {
    assert.match(appSource, new RegExp(`'${label}'`));
  }
});

test('queue auto-download is deduplicated across queue and focused progress streams', () => {
  assert.match(appSource, /const autoDownloadedQueueJobs = new Set\(\)/);
  assert.match(appSource, /function triggerAutoDownload\(jobId, url\)/);
  assert.match(appSource, /autoDownloadedQueueJobs\.has\(jobId\)/);
});
