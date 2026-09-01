'use strict';

(function attachEditPlan(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LVOVDEditPlan = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createEditPlanApi() {
  const MAX_KEEP_RANGES = 50;
  const MIN_RANGE_SECONDS = 0.001;

  class EditPlanError extends Error {
    constructor(message) {
      super(message);
      this.name = 'EditPlanError';
      this.code = 'LVOVD_EDIT_PLAN_INVALID';
    }
  }

  function roundMilliseconds(value) {
    return Math.round(Number(value) * 1000) / 1000;
  }

  function planError(message) {
    throw new EditPlanError(message);
  }

  function rangeValues(range, index = 0) {
    if (!range || typeof range !== 'object' || Array.isArray(range)
      || typeof range.startSeconds !== 'number' || typeof range.endSeconds !== 'number') {
      planError(`Retained range ${index + 1} must contain numeric start and end times.`);
    }
    if (!Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds)) {
      planError(`Retained range ${index + 1} must contain finite start and end times.`);
    }
    return {
      rawStart: range.startSeconds,
      rawEnd: range.endSeconds,
      startSeconds: roundMilliseconds(range.startSeconds),
      endSeconds: roundMilliseconds(range.endSeconds)
    };
  }

  function isFullDurationEditPlan(plan, durationSeconds) {
    const duration = roundMilliseconds(durationSeconds);
    const range = plan?.version === 1 && Array.isArray(plan.keepRanges) && plan.keepRanges.length === 1
      ? plan.keepRanges[0]
      : null;
    return Boolean(range
      && range.startSeconds === 0
      && range.endSeconds === duration);
  }

  function normalizeEditPlan(rawPlan, durationSeconds, { rejectNoop = false } = {}) {
    const duration = roundMilliseconds(durationSeconds);
    if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
      planError('Edit plan must be an object.');
    }
    if (rawPlan.version !== 1) planError('Edit plan version 1 is required.');
    if (!Array.isArray(rawPlan.keepRanges) || rawPlan.keepRanges.length < 1) {
      planError('Edit plan must retain at least one range.');
    }
    if (rawPlan.keepRanges.length > MAX_KEEP_RANGES) {
      planError(`Edit plan cannot contain more than ${MAX_KEEP_RANGES} retained ranges.`);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      planError('The inspected media duration must be a finite positive number.');
    }

    const normalized = [];
    let previousRawStart = null;
    let previousRawEnd = null;
    for (let index = 0; index < rawPlan.keepRanges.length; index += 1) {
      const value = rangeValues(rawPlan.keepRanges[index], index);
      if (value.rawStart < 0 || value.rawEnd > durationSeconds) {
        planError(`Retained range ${index + 1} must stay within the inspected media duration.`);
      }
      if (value.rawStart >= value.rawEnd || value.startSeconds >= value.endSeconds) {
        planError(`Retained range ${index + 1} end must be after its start.`);
      }
      if (previousRawStart != null && value.rawStart < previousRawStart) {
        planError('Retained ranges must be sorted in ascending chronological order.');
      }
      if (previousRawEnd != null && value.rawStart < previousRawEnd) {
        planError('Retained ranges must not overlap.');
      }
      previousRawStart = value.rawStart;
      previousRawEnd = value.rawEnd;

      const previous = normalized.at(-1);
      if (previous && value.startSeconds <= previous.endSeconds) {
        previous.endSeconds = Math.max(previous.endSeconds, value.endSeconds);
      } else {
        normalized.push({
          startSeconds: value.startSeconds,
          endSeconds: value.endSeconds
        });
      }
    }

    const plan = { version: 1, keepRanges: normalized };
    if (rejectNoop && isFullDurationEditPlan(plan, duration)) {
      planError('Move an outer boundary or remove a section before creating an edited file.');
    }
    return plan;
  }

  function canonicalRanges(planOrRanges) {
    const ranges = Array.isArray(planOrRanges) ? planOrRanges : planOrRanges?.keepRanges;
    if (!Array.isArray(ranges)) planError('Retained ranges are required.');
    return ranges.map((range, index) => {
      const value = rangeValues(range, index);
      if (value.startSeconds >= value.endSeconds) {
        planError(`Retained range ${index + 1} end must be after its start.`);
      }
      return { startSeconds: value.startSeconds, endSeconds: value.endSeconds };
    });
  }

  function interval(startSeconds, endSeconds, label = 'Interval') {
    if (typeof startSeconds !== 'number' || typeof endSeconds !== 'number'
      || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      planError(`${label} must contain finite numeric start and end times.`);
    }
    const start = roundMilliseconds(startSeconds);
    const end = roundMilliseconds(endSeconds);
    if (start >= end) planError(`${label} end must be after its start.`);
    return { startSeconds: start, endSeconds: end };
  }

  function totalRetainedDuration(planOrRanges) {
    const total = canonicalRanges(planOrRanges).reduce(
      (sum, range) => sum + range.endSeconds - range.startSeconds,
      0
    );
    return roundMilliseconds(total);
  }

  function subtractKeepRanges(planOrRanges, removalStartSeconds, removalEndSeconds) {
    const ranges = canonicalRanges(planOrRanges);
    const removal = interval(removalStartSeconds, removalEndSeconds, 'Removed section');
    const result = [];
    for (const range of ranges) {
      if (removal.endSeconds <= range.startSeconds || removal.startSeconds >= range.endSeconds) {
        result.push(range);
        continue;
      }
      const leftEnd = Math.min(removal.startSeconds, range.endSeconds);
      if (leftEnd - range.startSeconds >= MIN_RANGE_SECONDS) {
        result.push({ startSeconds: range.startSeconds, endSeconds: leftEnd });
      }
      const rightStart = Math.max(removal.endSeconds, range.startSeconds);
      if (range.endSeconds - rightStart >= MIN_RANGE_SECONDS) {
        result.push({ startSeconds: rightStart, endSeconds: range.endSeconds });
      }
    }
    return result;
  }

  function intersectKeepRanges(planOrRanges, outerStartSeconds, outerEndSeconds) {
    const ranges = canonicalRanges(planOrRanges);
    const bounds = interval(outerStartSeconds, outerEndSeconds, 'Outer retained bounds');
    const result = [];
    for (const range of ranges) {
      const startSeconds = Math.max(range.startSeconds, bounds.startSeconds);
      const endSeconds = Math.min(range.endSeconds, bounds.endSeconds);
      if (endSeconds - startSeconds >= MIN_RANGE_SECONDS) result.push({ startSeconds, endSeconds });
    }
    return result;
  }

  function deriveInternalRemovedGaps(planOrRanges) {
    const ranges = canonicalRanges(planOrRanges);
    const gaps = [];
    for (let index = 1; index < ranges.length; index += 1) {
      const startSeconds = ranges[index - 1].endSeconds;
      const endSeconds = ranges[index].startSeconds;
      if (endSeconds - startSeconds >= MIN_RANGE_SECONDS) gaps.push({ startSeconds, endSeconds });
    }
    return gaps;
  }

  function deriveRemovedRanges(planOrRanges, startSeconds, endSeconds) {
    const ranges = canonicalRanges(planOrRanges);
    const bounds = interval(startSeconds, endSeconds, 'Timeline bounds');
    const removed = [];
    let cursor = bounds.startSeconds;
    for (const range of ranges) {
      if (range.endSeconds <= bounds.startSeconds) continue;
      if (range.startSeconds >= bounds.endSeconds) break;
      const retainedStart = Math.max(range.startSeconds, bounds.startSeconds);
      const retainedEnd = Math.min(range.endSeconds, bounds.endSeconds);
      if (retainedStart - cursor >= MIN_RANGE_SECONDS) {
        removed.push({ startSeconds: cursor, endSeconds: retainedStart });
      }
      cursor = Math.max(cursor, retainedEnd);
    }
    if (bounds.endSeconds - cursor >= MIN_RANGE_SECONDS) {
      removed.push({ startSeconds: cursor, endSeconds: bounds.endSeconds });
    }
    return removed;
  }

  function restoreInternalGap(planOrRanges, gapStartSeconds, gapEndSeconds) {
    const ranges = canonicalRanges(planOrRanges);
    const gap = interval(gapStartSeconds, gapEndSeconds, 'Removed section');
    for (let index = 0; index < ranges.length - 1; index += 1) {
      if (ranges[index].endSeconds !== gap.startSeconds
        || ranges[index + 1].startSeconds !== gap.endSeconds) continue;
      return [
        ...ranges.slice(0, index),
        { startSeconds: ranges[index].startSeconds, endSeconds: ranges[index + 1].endSeconds },
        ...ranges.slice(index + 2)
      ];
    }
    return null;
  }

  function outerRetainedBounds(planOrRanges) {
    const ranges = canonicalRanges(planOrRanges);
    if (!ranges.length) return null;
    return {
      startSeconds: ranges[0].startSeconds,
      endSeconds: ranges.at(-1).endSeconds
    };
  }

  return {
    MAX_KEEP_RANGES,
    MIN_RANGE_SECONDS,
    EditPlanError,
    roundMilliseconds,
    normalizeEditPlan,
    totalRetainedDuration,
    subtractKeepRanges,
    intersectKeepRanges,
    deriveInternalRemovedGaps,
    deriveRemovedRanges,
    restoreInternalGap,
    outerRetainedBounds,
    isFullDurationEditPlan
  };
});
