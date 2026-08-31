'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Verify keeps master and future Roadmap 6 staging branch filters aligned', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'verify.yml'), 'utf8');
  const branchBlocks = [...workflow.matchAll(
    /^  (push|pull_request):\r?\n    branches:\r?\n((?:      - [^\r\n]+\r?\n)+)/gm
  )];

  assert.deepEqual(branchBlocks.map((match) => match[1]), ['push', 'pull_request']);
  for (const [, trigger, branches] of branchBlocks) {
    assert.match(branches, /^      - master$/m, `${trigger} retains master verification`);
    assert.match(
      branches,
      /^      - roadmap\/6-local-edit-staging$/m,
      `${trigger} includes the future Roadmap 6 staging branch`
    );
  }
});
