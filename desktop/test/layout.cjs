'use strict';
const assert = require('node:assert/strict');

async function captureLayout(browser, width, height, file, regionId, controls) {
  await browser.setWindowSize(width, height);
  await browser.waitUntil(() => browser.execute(id => {
    const page = document.documentElement;
    const region = document.getElementById(id);
    return page.scrollWidth <= innerWidth && page.scrollHeight <= innerHeight &&
      region.clientWidth > 0 && region.scrollWidth <= region.clientWidth + 1;
  }, regionId), { timeout: 3000, timeoutMsg: regionId + ' overflows at ' + width + '×' + height });

  // A clipped page can pass scroll-size checks. Verify that its primary controls
  // are reachable through the real panes and that decoration cannot intercept them.
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

module.exports = { captureLayout };
