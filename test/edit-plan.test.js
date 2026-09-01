'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_KEEP_RANGES,
  normalizeEditPlan,
  totalRetainedDuration,
  subtractKeepRanges,
  intersectKeepRanges,
  deriveInternalRemovedGaps,
  deriveRemovedRanges,
  restoreInternalGap,
  outerRetainedBounds,
  isFullDurationEditPlan
} = require('../public/edit-plan');

function plan(keepRanges) {
  return { version: 1, keepRanges };
}

test('edit-plan normalization preserves one range and accepts sorted multiple ranges', () => {
  assert.deepEqual(
    normalizeEditPlan(plan([{ startSeconds: 1.23449, endSeconds: 9.87651 }]), 10),
    plan([{ startSeconds: 1.234, endSeconds: 9.877 }])
  );
  assert.deepEqual(
    normalizeEditPlan(plan([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 4, endSeconds: 6 },
      { startSeconds: 8, endSeconds: 10 }
    ]), 10),
    plan([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 4, endSeconds: 6 },
      { startSeconds: 8, endSeconds: 10 }
    ])
  );
});

test('edit-plan normalization enforces the maximum range bound and rejects empty content', () => {
  const maximum = Array.from({ length: MAX_KEEP_RANGES }, (_value, index) => ({
    startSeconds: index * 2,
    endSeconds: index * 2 + 1
  }));
  assert.equal(normalizeEditPlan(plan(maximum), 100).keepRanges.length, MAX_KEEP_RANGES);
  assert.throws(
    () => normalizeEditPlan(plan([...maximum, { startSeconds: 100, endSeconds: 101 }]), 102),
    /more than 50/i
  );
  assert.throws(() => normalizeEditPlan(plan([]), 10), /retain at least one/i);
});

test('edit-plan normalization rejects out-of-order, overlap, and unsafe bounds', () => {
  const invalid = [
    plan([{ startSeconds: 4, endSeconds: 6 }, { startSeconds: 1, endSeconds: 2 }]),
    plan([{ startSeconds: 1, endSeconds: 5 }, { startSeconds: 4, endSeconds: 7 }]),
    plan([{ startSeconds: -1, endSeconds: 2 }]),
    plan([{ startSeconds: 2, endSeconds: 2 }]),
    plan([{ startSeconds: 3, endSeconds: 2 }]),
    plan([{ startSeconds: 0, endSeconds: 11 }]),
    plan([{ startSeconds: Number.NaN, endSeconds: 2 }]),
    plan([{ startSeconds: '1', endSeconds: 2 }])
  ];
  for (const value of invalid) assert.throws(() => normalizeEditPlan(value, 10));
});

test('millisecond adjacency and sub-millisecond gaps merge during normalization', () => {
  assert.deepEqual(
    normalizeEditPlan(plan([
      { startSeconds: 0, endSeconds: 2.0004 },
      { startSeconds: 2.00049, endSeconds: 4 }
    ]), 10),
    plan([{ startSeconds: 0, endSeconds: 4 }])
  );
  assert.throws(
    () => normalizeEditPlan(plan([
      { startSeconds: 0, endSeconds: 2.1 },
      { startSeconds: 2, endSeconds: 4 }
    ]), 10),
    /overlap/i
  );
});

test('total retained duration sums every canonical range', () => {
  assert.equal(totalRetainedDuration(plan([
    { startSeconds: 0, endSeconds: 2 },
    { startSeconds: 4, endSeconds: 6.125 },
    { startSeconds: 8, endSeconds: 9 }
  ])), 5.125);
});

test('subtracting a middle interval splits one range without storing removed ranges', () => {
  assert.deepEqual(
    subtractKeepRanges([{ startSeconds: 0, endSeconds: 10 }], 3, 7),
    [{ startSeconds: 0, endSeconds: 3 }, { startSeconds: 7, endSeconds: 10 }]
  );
});

test('subtraction crosses existing gaps and handles retained boundaries', () => {
  const ranges = [
    { startSeconds: 0, endSeconds: 3 },
    { startSeconds: 5, endSeconds: 8 },
    { startSeconds: 10, endSeconds: 12 }
  ];
  assert.deepEqual(subtractKeepRanges(ranges, 2, 11), [
    { startSeconds: 0, endSeconds: 2 },
    { startSeconds: 11, endSeconds: 12 }
  ]);
  assert.deepEqual(subtractKeepRanges(ranges, 3, 6), [
    { startSeconds: 0, endSeconds: 3 },
    { startSeconds: 6, endSeconds: 8 },
    { startSeconds: 10, endSeconds: 12 }
  ]);
  assert.deepEqual(subtractKeepRanges(ranges, 0, 1), [
    { startSeconds: 1, endSeconds: 3 },
    { startSeconds: 5, endSeconds: 8 },
    { startSeconds: 10, endSeconds: 12 }
  ]);
  assert.deepEqual(subtractKeepRanges(ranges, 11, 12), [
    { startSeconds: 0, endSeconds: 3 },
    { startSeconds: 5, endSeconds: 8 },
    { startSeconds: 10, endSeconds: 11 }
  ]);
  assert.deepEqual(subtractKeepRanges([{ startSeconds: 0, endSeconds: 10 }], 0, 10), []);
});

test('internal removed gaps derive and restore without listing outer trims', () => {
  const ranges = [
    { startSeconds: 2, endSeconds: 5 },
    { startSeconds: 7, endSeconds: 9 },
    { startSeconds: 12, endSeconds: 18 }
  ];
  assert.deepEqual(deriveInternalRemovedGaps(ranges), [
    { startSeconds: 5, endSeconds: 7 },
    { startSeconds: 9, endSeconds: 12 }
  ]);
  assert.deepEqual(deriveRemovedRanges(ranges, 0, 20), [
    { startSeconds: 0, endSeconds: 2 },
    { startSeconds: 5, endSeconds: 7 },
    { startSeconds: 9, endSeconds: 12 },
    { startSeconds: 18, endSeconds: 20 }
  ]);
  assert.deepEqual(restoreInternalGap(ranges, 5, 7), [
    { startSeconds: 2, endSeconds: 9 },
    { startSeconds: 12, endSeconds: 18 }
  ]);
  assert.equal(restoreInternalGap(ranges, 0, 2), null);
});

test('outer intersection preserves middle cuts and snaps boundaries inside gaps', () => {
  const ranges = [
    { startSeconds: 0, endSeconds: 20 },
    { startSeconds: 30, endSeconds: 40 },
    { startSeconds: 50, endSeconds: 100 }
  ];
  assert.deepEqual(intersectKeepRanges(ranges, 10, 100), [
    { startSeconds: 10, endSeconds: 20 },
    { startSeconds: 30, endSeconds: 40 },
    { startSeconds: 50, endSeconds: 100 }
  ]);
  assert.deepEqual(intersectKeepRanges(ranges, 0, 60), [
    { startSeconds: 0, endSeconds: 20 },
    { startSeconds: 30, endSeconds: 40 },
    { startSeconds: 50, endSeconds: 60 }
  ]);
  assert.deepEqual(intersectKeepRanges(ranges, 35, 100), [
    { startSeconds: 35, endSeconds: 40 },
    { startSeconds: 50, endSeconds: 100 }
  ]);
  assert.deepEqual(intersectKeepRanges(ranges, 25, 100)[0], { startSeconds: 30, endSeconds: 40 });
  assert.deepEqual(intersectKeepRanges(ranges, 0, 45).at(-1), { startSeconds: 30, endSeconds: 40 });
});

test('outer bounds and Reset Range retain the canonical full-duration plan', () => {
  const reset = normalizeEditPlan(plan([{ startSeconds: 0, endSeconds: 120 }]), 120);
  assert.deepEqual(outerRetainedBounds(reset), { startSeconds: 0, endSeconds: 120 });
  assert.equal(isFullDurationEditPlan(reset, 120), true);
});
