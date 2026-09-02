'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('release metadata consistently prepares the 2.5.0 feature release', () => {
  const packageJson = JSON.parse(read('package.json'));
  const packageLock = JSON.parse(read('package-lock.json'));

  assert.equal(packageJson.version, '2.5.0');
  assert.equal(packageLock.version, '2.5.0');
  assert.equal(packageLock.packages[''].version, '2.5.0');
});

test('README ships truthful editing, privacy, temporary-file, and Download History behavior', () => {
  const readme = read('README.md');

  assert.ok(readme.indexOf('## Quick Start') < readme.indexOf('## What it can do'));
  assert.match(readme, /choose or drop one local video/i);
  assert.match(readme, /Edit Source Video[\s\S]*selected source[\s\S]*Compatible\/Maximum[\s\S]*resolution[\s\S]*Manual source choice/i);
  assert.match(readme, /remove and restore multiple middle sections/i);
  assert.match(readme, /high-quality H\.264 MP4[\s\S]*AAC when the source has audio/i);
  assert.match(readme, /not lossless[\s\S]*workspace source remains unchanged/i);
  assert.match(readme, /source service sees those acquisition requests/i);
  assert.match(readme, /Edit uses a separate temporary media workspace/i);
  assert.match(readme, /Discard[\s\S]*idle workspace expires/i);
  assert.match(readme, /visible \*\*Download History\*\* panel/i);
  assert.match(readme, /Edit workspace activity and edited outputs are not currently persisted in Download History/i);
  assert.doesNotMatch(readme, /visible History panel[\s\S]{0,80}next UI slice/i);
});

test('Roadmap and workspace contract mark the first editor baseline complete without erasing deferred work', () => {
  const roadmap = read('ROADMAP.md');
  const contract = read(path.join('docs', 'local-media-workspace.md'));

  assert.match(roadmap, /### 6\. Local edit staging — completed/);
  assert.match(roadmap, /URL editor acquisition[\s\S]*serialized with Preview\/Download source work/i);
  assert.match(roadmap, /multiple middle removals[\s\S]*Restore actions/i);
  assert.match(roadmap, /local re-encode[\s\S]*accurate editing semantics/i);
  assert.match(roadmap, /keyframe-aware stream-copy[\s\S]*future/i);
  assert.match(roadmap, /Edit workspace activity[\s\S]*not persisted in durable Download History/i);

  assert.match(contract, /## Implemented Roadmap #6 baseline/);
  for (const slice of ['6A1', '6B', '6C', '6A2']) assert.match(contract, new RegExp(`\\*\\*${slice}`));
  assert.match(contract, /playback proxy is never the render source/i);
  assert.match(contract, /Remaining deferred work includes conservative\/keyframe-aware stream-copy optimization/i);
  assert.doesNotMatch(contract, /## First implementation direction/);
});
