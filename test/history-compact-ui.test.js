'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { historyMediaInfo } = require('../public/history-ui');

const root = path.join(__dirname, '..');
const historySource = fs.readFileSync(path.join(root, 'public', 'history-ui.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `Expected ${name} in source`);
  const end = nextName ? source.indexOf(`function ${nextName}`, start + 1) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
}

test('history media tiles derive locally from the persisted content mode', () => {
  assert.deepEqual(historyMediaInfo({ request: { options: { content: 'av' } } }), { glyph: '▶', label: 'Video' });
  assert.deepEqual(historyMediaInfo({ request: { options: { content: 'video' } } }), { glyph: '▶', label: 'Video only' });
  assert.deepEqual(historyMediaInfo({ request: { options: { content: 'audio' } } }), { glyph: '♪', label: 'Audio' });
  assert.deepEqual(historyMediaInfo({ request: { options: { content: 'extras' } } }), { glyph: '+', label: 'Extras' });
});

test('collapsed history rows use compact local UI rather than remote thumbnails', () => {
  const render = functionSource(historySource, 'renderHistory', 'readResponseJson');
  assert.match(render, /row\.className = 'output-row history-row'/);
  assert.match(render, /mediaIcon\.className = 'history-media-icon'/);
  assert.match(render, /titleLine\.className = 'history-title-line'/);
  assert.match(render, /actions\.className = 'inline-actions history-actions'/);
  assert.doesNotMatch(render, /createElement\('img'\)|thumbnailUrl|\.thumbnail/);

  const details = functionSource(historySource, 'detailsForEntry', 'renderHistory');
  assert.match(details, /details\.className = 'history-details'/);
  assert.match(details, /body\.className = 'history-details-body'/);
  assert.doesNotMatch(details, /advanced-panel|advanced-content/);
});

test('history compact styling keeps status inline and details lightweight', () => {
  for (const selector of [
    '.history-row',
    '.history-entry-main',
    '.history-media-icon',
    '.history-title-line',
    '.history-status',
    '.history-details',
    '.history-details-body',
    '.history-actions'
  ]) {
    assert.match(stylesSource, new RegExp(selector.replace('.', '\\.')));
  }
  assert.match(stylesSource, /\.history-status\.completed/);
  assert.match(stylesSource, /\.history-status\.failed/);
  assert.match(stylesSource, /\.history-status\.cancelled/);
  assert.match(stylesSource, /\.history-details summary \{[^}]*display: inline-flex/s);
});
