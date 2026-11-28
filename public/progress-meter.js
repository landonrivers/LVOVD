'use strict';

// An indeterminate meter has no numeric value in the accessibility tree.
globalThis.LVOVDProgress = function updateProgress(fill, percent) {
  const track = fill.parentElement;
  const known = Number.isFinite(percent);
  fill.classList.toggle('indeterminate', !known);
  if (known) {
    const value = Math.max(0, Math.min(100, percent));
    fill.style.width = value + '%';
    track.setAttribute('aria-valuenow', String(Math.floor(value)));
  } else {
    fill.style.removeProperty('width');
    track.removeAttribute('aria-valuenow');
  }
};
