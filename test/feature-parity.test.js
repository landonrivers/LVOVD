'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateRegister, updatedGuide, stableV3, BASELINE, PLATFORMS } = require('../scripts/check-feature-parity.cjs');
const root = path.resolve(__dirname, '..');
const register = JSON.parse(fs.readFileSync(path.join(root, 'docs/v3-feature-parity.json'), 'utf8'));
const clone = value => structuredClone(value);

function sample(status = 'Missing') {
  return { schemaVersion: 1, baseline: { version: '2.7.0', commit: BASELINE, acceptedFixes: [] }, platforms: [...PLATFORMS],
    accessException: { id: 'standalone-access', behavior: 'Native window replaces browser access.', approval: 'User decision.' },
    capabilities: [{ id: 'download.example', title: 'Synthetic workflow', origin: 'baseline',
      reference: { behavior: 'Preserve synthetic behavior.', sources: ['app-server.js'] },
      desktop: { location: 'Download', stage: '8D', operations: ['download_example'] }, status,
      implementation: { rust: [], native: [] }, tests: { reference: ['test/options.test.js'], rust: [], native: [] },
      acceptance: ['Exercise the generated workflow.'], evidence: [], remaining: 'Not implemented.' }] };
}
const read = () => '#[test]\nfn synthetic() {}';
function verified() {
  const data = sample('Verified'), c = data.capabilities[0];
  c.implementation = { rust: ['crates/core/src/download.rs'], native: ['desktop/app.js'] };
  c.tests.rust = ['crates/core/tests/download.rs']; c.tests.native = ['desktop/test/download.cjs'];
  c.remaining = '';
  c.evidence = PLATFORMS.map(platform => ({ platform, commit: 'a'.repeat(40), kind: 'native-workflow', result: 'passed',
    url: 'https://github.com/landonrivers/LVOVD/actions/runs/123/job/456', tests: ['desktop/test/download.cjs'], notes: 'Synthetic native fixture.' }));
  return data;
}

test('checked-in inventory resolves its implementation/test references and generated table', () => {
  assert.deepEqual(validateRegister(register), []);
  const guide = fs.readFileSync(path.join(root, 'docs/v3-feature-parity.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(updatedGuide(guide, register), guide);
});
test('missing work is valid during migration but blocks the release gate', () => {
  const data = sample();
  assert.deepEqual(validateRegister(data, { read }), []);
  assert.ok(validateRegister(data, { read, release: true }).some(e => e.includes('release blocked (Missing)')));
  data.capabilities[0].origin = 'desktop';
  assert.ok(validateRegister(data, { read, release: true }).some(e => e.includes('release blocked')));
});
test('ported and integrated claims require actual code/test mappings without requiring premature verification', () => {
  const data = sample('Ported'), c = data.capabilities[0];
  assert.ok(validateRegister(data, { read }).some(e => e.includes('Rust implementation')));
  c.implementation.rust = ['crates/core/src/download.rs']; c.tests.rust = ['crates/core/tests/download.rs'];
  assert.deepEqual(validateRegister(data, { read }), []);
  c.status = 'Integrated';
  assert.ok(validateRegister(data, { read }).some(e => e.includes('native integration')));
  c.implementation.native = ['desktop/app.js'];
  assert.deepEqual(validateRegister(data, { read }), []);
});
test('Verified cannot be manufactured from unit/Chromium evidence or missing architectures', () => {
  assert.deepEqual(validateRegister(verified(), { read, release: true }), []);
  for (const mutate of [
    d => d.capabilities[0].evidence.pop(),
    d => { d.capabilities[0].evidence[0].kind = 'core'; },
    d => { d.capabilities[0].evidence[0].result = 'failed'; },
    d => { d.capabilities[0].evidence[0].commit = 'b'.repeat(40); },
    d => { d.capabilities[0].evidence[0].url = 'https://example.com/fake'; },
    d => { d.capabilities[0].evidence[0].tests = ['test/browser/local-media.spec.js']; },
    d => { d.capabilities[0].remaining = 'Download does not work.'; },
    d => { d.capabilities[0].tests.native = []; },
    d => { d.platforms.pop(); }
  ]) { const data = verified(); mutate(data); assert.notDeepEqual(validateRegister(data, { read, release: true }), []); }
});
test('invalid, duplicate, missing and unsafe references fail closed', () => {
  for (const mutate of [
    d => d.capabilities.push(clone(d.capabilities[0])),
    d => { d.capabilities[0].status = 'Waived'; },
    d => { d.capabilities[0].optional = true; },
    d => { d.capabilities[0].reference.sources = ['../outside']; },
    d => { d.capabilities[0].tests.reference = ['app-server.js']; },
    d => { d.capabilities[0].acceptance = []; },
    d => { d.capabilities[0].desktop.operations = []; },
    d => { d.baseline.commit = 'b'.repeat(40); }
  ]) { const data = sample(); mutate(data); assert.notDeepEqual(validateRegister(data, { read }), []); }
  assert.ok(validateRegister(sample(), { read: () => { throw new Error('not found'); } }).some(e => e.includes('missing reference')));
});
test('baseline comparison prevents deletions, renaming, reclassification and rewritten reference facts', () => {
  const before = sample();
  for (const mutate of [
    d => { d.capabilities = []; },
    d => { d.capabilities[0].id = 'download.renamed'; },
    d => { d.capabilities[0].origin = 'desktop'; },
    d => { d.capabilities[0].reference.behavior = 'Drop the old behavior.'; },
    d => { d.accessException.behavior = 'Drop all downloads.'; }
  ]) { const data = clone(before); mutate(data); assert.notDeepEqual(validateRegister(data, { read, previous: before }), []); }
  const extended = clone(before);
  extended.capabilities.push({ ...clone(before.capabilities[0]), id: 'download.discovered' });
  extended.baseline.acceptedFixes.push({ commit: 'c'.repeat(40), capabilities: ['download.example'], reason: 'Accepted behavior correction.', approval: 'Accepted PR.' });
  assert.deepEqual(validateRegister(extended, { read, previous: before }), []);
  assert.ok(validateRegister(before, { read, previous: extended }).some(e => e.includes('accepted fixes cannot be removed')));
});
test('stable metadata enables gating while prerelease metadata permits unfinished migration', () => {
  for (const value of ['3.0.0', '3.0.1+build.1', '4.0.0', '10.2.3']) assert.equal(stableV3(value), true);
  for (const value of ['2.7.0', '3.0.0-alpha.1', '3.0.0-rc.1', undefined, '3.0']) assert.equal(stableV3(value), false);
});
test('guide regeneration replaces only the bounded table and rejects ambiguous markers', () => {
  const guide = 'Before\n<!-- parity-table:start -->\nstale\n<!-- parity-table:end -->\nAfter';
  const next = updatedGuide(guide, sample());
  assert.ok(next.startsWith('Before\n')); assert.ok(next.endsWith('\nAfter'));
  assert.match(next, /download\.example/); assert.doesNotMatch(next, /stale/);
  assert.throws(() => updatedGuide('No markers', sample()));
  assert.throws(() => updatedGuide(guide + '\n<!-- parity-table:start -->', sample()));
});
