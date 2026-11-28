'use strict';
const assert = require('node:assert/strict');

async function captureLayout(browser, width, height, file, regionId, controls) {
  await browser.setWindowSize(width, height);
  await browser.execute(id => document.getElementById(id).scrollIntoView({ block: 'start' }), regionId);
  await browser.waitUntil(() => browser.execute(id => {
    const page = document.documentElement;
    const region = document.getElementById(id);
    return page.scrollWidth <= innerWidth && page.scrollHeight <= innerHeight &&
      region.clientWidth > 0 && region.scrollWidth <= region.clientWidth + 1;
  }, regionId), { timeout: 3000, timeoutMsg: regionId + ' overflows at ' + width + '×' + height });

  // A clipped page can pass scroll-size checks. Test actual hit targets
  // and restore the reading position after checking each control.
  const blocked = await browser.execute(ids => {
    const failures = [];
    for (const id of ids) {
      const input = document.getElementById(id);
      const control = input.type === 'radio' ? input.labels[0] : input;
      const ancestors = [];
      for (let node = control.parentElement; node; node = node.parentElement) {
        ancestors.push([node, node.scrollTop, node.scrollLeft]);
      }
      control.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = control.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || !control.contains(hit) || rect.width <= 0 || rect.height <= 0) {
        failures.push({ control: id, hit: hit?.id || hit?.tagName || null });
      }
      for (const [node, top, left] of ancestors) {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
    }
    return failures;
  }, controls);
  assert.deepEqual(blocked, [], 'Unreachable controls at ' + width + '×' + height);
  await browser.saveScreenshot(file);
}

// Expansion may push later controls down, but the activated summary must
// stay in its column and in the row where the user found it.
async function checkDownloadDisclosures(browser) {
  for (const id of ['dl-formats', 'dl-times', 'dl-extras', 'dl-sponsors']) {
    const summary = browser.$('#' + id + ' summary');
    if (!(await summary.isDisplayed())) continue;
    const geometry = () => browser.execute(id => {
      const form = document.getElementById('download-options').getBoundingClientRect();
      const active = document.querySelector('#' + id + ' summary');
      const column = active.closest('.disclosure-column');
      const anchors = [active];
      if (column && getComputedStyle(column.parentElement).gridTemplateColumns.split(' ').length === 2) {
        for (const other of column.parentElement.children) {
          if (other !== column) anchors.push(...other.querySelectorAll('details:not([hidden]) summary'));
        }
      }
      return anchors.flatMap(anchor => {
        const rect = anchor.getBoundingClientRect();
        return [rect.left - form.left, rect.top - form.top, rect.width];
      });
    }, id);
    const before = await geometry();
    await summary.click();
    assert.equal(await browser.execute(id => document.getElementById(id).open, id), true);
    const after = await geometry();
    assert.equal(after.length, before.length);
    assert.ok(before.every((value, i) => Math.abs(value - after[i]) <= 2),
      id + ' moved when opened: ' + JSON.stringify({before, after}));
    await summary.click();
  }
}

async function checkEditorFlow(browser) {
  const flow = await browser.execute(() => {
    const video = document.getElementById('editor-video');
    const local = document.getElementById('desktop-local');
    const pane = document.querySelector('main');
    const nested = [...local.querySelectorAll('div, section, aside, article')].filter(node =>
      node.clientHeight > 0 && node.scrollHeight > node.clientHeight + 2 &&
      /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)
    ).map(node => node.id || node.className);
    const modes = [...local.querySelectorAll('#processing-rate-mode label')].filter(label => label.offsetWidth);
    const modesFit = modes.every(label => {
      const group = label.parentElement.getBoundingClientRect();
      const rect = label.getBoundingClientRect();
      return rect.left >= group.left - 1 && rect.right <= group.right + 1 && getComputedStyle(label).whiteSpace === 'nowrap';
    });
    return {
      nested,
      modesFit,
      mainScrolls: /^(auto|scroll)$/.test(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight,
      playerHeight: video.clientHeight, videoVisible: !video.hidden,
      viewportHeight: innerHeight,
      timelineBelow: video.hidden || local.querySelector('.timeline-editor').getBoundingClientRect().top >= video.getBoundingClientRect().bottom - 1
    };
  });
  assert.equal(flow.mainScrolls, true, 'The main screen must scroll through the entire editor');
  assert.deepEqual(flow.nested, [], 'Independent editor or review scroll areas');
  assert.equal(flow.modesFit, true, 'Compression options must fit with each radio and label together');
  if (flow.videoVisible) {
    assert.ok(flow.playerHeight >= Math.min(300, flow.viewportHeight * 0.42),
      'Video preview is too small for the window: ' + JSON.stringify(flow));
    assert.equal(flow.timelineBelow, true);
  }
}

module.exports = { captureLayout, checkDownloadDisclosures, checkEditorFlow };
