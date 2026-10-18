'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { evaluate, fixturePath } = require('../scripts/desktop-policy-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('shared desktop policy fixtures match the released JavaScript reference', () => {
  assert.equal(fixtures.schemaVersion, 1);
  assert.equal(new Set(fixtures.cases.map(item => item.id)).size, fixtures.cases.length);
  for (const item of fixtures.cases) assert.deepEqual(evaluate(item), item.expected, item.id);
});
