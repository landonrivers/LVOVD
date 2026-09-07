'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Verify keeps master and Roadmap staging branch filters aligned', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'verify.yml'), 'utf8');
  const branchBlocks = [...workflow.matchAll(
    /^  (push|pull_request):\r?\n    branches:\r?\n((?:      - [^\r\n]+\r?\n)+)/gm
  )];

  assert.deepEqual(branchBlocks.map((match) => match[1]), ['push', 'pull_request']);
  for (const [, trigger, branches] of branchBlocks) {
    assert.match(branches, /^      - master$/m, `${trigger} retains master verification`);
    assert.doesNotMatch(
      branches,
      /^      - roadmap\/6-local-edit-staging$/m,
      `${trigger} removes the obsolete Roadmap 6 staging branch`
    );
    assert.match(
      branches,
      /^      - roadmap\/7-local-convert-staging$/m,
      `${trigger} includes the Roadmap 7 staging branch`
    );
  }
});

test('Verify requires real media tools and Windows runs the workspace cleanup regressions', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'verify.yml'), 'utf8');
  const verify = workflow.slice(workflow.indexOf('  verify:'), workflow.indexOf('  windows-launcher:'));
  assert.match(verify, /sudo apt-get install -y ffmpeg strace/);
  assert.match(verify, /npm run update-ytdlp/);
  assert.match(verify, /LVOVD_TRACE_LOCAL_INPUT: '1'/);
  assert.match(verify, /run: npm run test:media/);
  assert.match(verify, /run: npm ci/);
  assert.match(verify, /playwright install --with-deps --only-shell chromium/);
  assert.match(verify, /run: npm run test:browser/);
  assert.doesNotMatch(verify, /continue-on-error|\|\| true/);
  const windows = workflow.slice(workflow.indexOf('  windows-launcher:'));
  for (const name of ['launcher', 'ytdlp-manager', 'media-workspace', 'media-workspace-api', 'workspace-cleanup',
    'media-inspection', 'ffmpeg-capabilities', 'conversion-compatibility', 'conversion-assessment', 'conversion-workspace', 'conversion-ui', 'conversion-plan', 'conversion-lifecycle']) {
    assert.ok(windows.includes(`test/${name}.test.js`));
  }
});
