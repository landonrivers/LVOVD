'use strict';

(function attachMediaEditor(root, factory) {
  const editPlanApi = typeof module === 'object' && module.exports
    ? require('./edit-plan')
    : root?.LVOVDEditPlan;
  const api = factory(editPlanApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) api.init(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMediaEditorApi(editPlanApi) {
  const MAX_LOCAL_MEDIA_BYTES = 100 * 1024 * 1024 * 1024;
  const {
    MAX_KEEP_RANGES,
    MIN_RANGE_SECONDS,
    roundMilliseconds,
    normalizeEditPlan,
    subtractKeepRanges,
    intersectKeepRanges,
    deriveInternalRemovedGaps,
    deriveRemovedRanges,
    restoreInternalGap,
    outerRetainedBounds,
    isFullDurationEditPlan
  } = editPlanApi;
  const MIN_SELECTION_SECONDS = MIN_RANGE_SECONDS;
  const MIN_VISIBLE_SECONDS = 0.25;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function parseTimecode(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const parts = text.split(':');
    if (parts.length > 3 || parts.some((part) => part === '')) return null;
    if (parts.length === 1) {
      if (!/^\d+(?:\.\d{1,3})?$/.test(parts[0])) return null;
      const seconds = Number(parts[0]);
      return Number.isFinite(seconds) ? roundMilliseconds(seconds) : null;
    }

    const secondsText = parts.at(-1);
    if (!/^\d{1,2}(?:\.\d{1,3})?$/.test(secondsText)) return null;
    const seconds = Number(secondsText);
    if (!Number.isFinite(seconds) || seconds >= 60) return null;

    const minutesText = parts.at(-2);
    if (!/^\d{1,2}$/.test(minutesText)) return null;
    const minutes = Number(minutesText);
    if (!Number.isFinite(minutes) || (parts.length === 3 && minutes >= 60)) return null;

    let hours = 0;
    if (parts.length === 3) {
      if (!/^\d+$/.test(parts[0])) return null;
      hours = Number(parts[0]);
      if (!Number.isSafeInteger(hours)) return null;
    }
    return roundMilliseconds(hours * 3600 + minutes * 60 + seconds);
  }

  function formatTimecode(value) {
    const totalMilliseconds = Math.max(0, Math.round(Number(value || 0) * 1000));
    const hours = Math.floor(totalMilliseconds / 3_600_000);
    const minutes = Math.floor(totalMilliseconds % 3_600_000 / 60_000);
    const seconds = Math.floor(totalMilliseconds % 60_000 / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return [hours, minutes, seconds]
      .map((part) => String(part).padStart(2, '0'))
      .join(':') + `.${String(milliseconds).padStart(3, '0')}`;
  }

  function validateSelection(startSeconds, endSeconds, durationSeconds) {
    const start = roundMilliseconds(startSeconds);
    const end = roundMilliseconds(endSeconds);
    const duration = roundMilliseconds(durationSeconds);
    if (![start, end, duration].every(Number.isFinite) || duration <= 0) {
      return { valid: false, reason: 'A finite media duration and numeric start/end values are required.' };
    }
    if (start < 0 || end > duration) {
      return { valid: false, reason: `Use values between ${formatTimecode(0)} and ${formatTimecode(duration)}.` };
    }
    if (end - start < MIN_SELECTION_SECONDS) {
      return { valid: false, reason: 'The retained end must be after the retained start.' };
    }
    return { valid: true, startSeconds: start, endSeconds: end };
  }

  function clampVisibleWindow(window, durationSeconds, minimumSpan = MIN_VISIBLE_SECONDS) {
    const duration = Math.max(0, Number(durationSeconds) || 0);
    if (!duration) return { startSeconds: 0, endSeconds: 0 };
    const minimum = Math.min(duration, Math.max(0.001, Number(minimumSpan) || MIN_VISIBLE_SECONDS));
    const rawStart = Number(window?.startSeconds);
    const rawEnd = Number(window?.endSeconds);
    let span = Number.isFinite(rawStart) && Number.isFinite(rawEnd) ? rawEnd - rawStart : duration;
    span = clamp(Number.isFinite(span) ? span : duration, minimum, duration);
    let start = Number.isFinite(rawStart) ? rawStart : 0;
    start = clamp(start, 0, duration - span);
    return {
      startSeconds: roundMilliseconds(start),
      endSeconds: roundMilliseconds(start + span)
    };
  }

  function zoomVisibleWindow(window, durationSeconds, scale, anchorSeconds) {
    const current = clampVisibleWindow(window, durationSeconds);
    const duration = Math.max(0, Number(durationSeconds) || 0);
    const currentSpan = current.endSeconds - current.startSeconds;
    if (!currentSpan || !duration) return current;
    const nextSpan = clamp(currentSpan * Number(scale), Math.min(MIN_VISIBLE_SECONDS, duration), duration);
    const anchor = clamp(Number(anchorSeconds), current.startSeconds, current.endSeconds);
    const anchorRatio = currentSpan ? (anchor - current.startSeconds) / currentSpan : 0.5;
    return clampVisibleWindow({
      startSeconds: anchor - nextSpan * anchorRatio,
      endSeconds: anchor + nextSpan * (1 - anchorRatio)
    }, duration);
  }

  function panVisibleWindow(window, durationSeconds, deltaSeconds) {
    const current = clampVisibleWindow(window, durationSeconds);
    const span = current.endSeconds - current.startSeconds;
    return clampVisibleWindow({
      startSeconds: current.startSeconds + Number(deltaSeconds || 0),
      endSeconds: current.startSeconds + Number(deltaSeconds || 0) + span
    }, durationSeconds);
  }

  function timeToPercent(timeSeconds, window) {
    const span = window.endSeconds - window.startSeconds;
    if (span <= 0) return 0;
    return clamp((timeSeconds - window.startSeconds) / span * 100, 0, 100);
  }

  function formatTimelineTick(value, stepSeconds = 1) {
    const step = Math.abs(Number(stepSeconds)) || 1;
    const precision = step >= 1 ? 0 : step >= 0.1 ? 1 : 3;
    const precisionMilliseconds = precision === 0 ? 1000 : precision === 1 ? 100 : 1;
    const totalMilliseconds = Math.max(0,
      Math.round(Number(value || 0) * 1000 / precisionMilliseconds) * precisionMilliseconds);
    const hours = Math.floor(totalMilliseconds / 3_600_000);
    const minutes = Math.floor(totalMilliseconds % 3_600_000 / 60_000);
    const seconds = Math.floor(totalMilliseconds % 60_000 / 1000);
    const fraction = totalMilliseconds % 1000;
    const secondsText = String(seconds).padStart(2, '0')
      + (precision === 1 ? `.${Math.floor(fraction / 100)}` : '')
      + (precision === 3 ? `.${String(fraction).padStart(3, '0')}` : '');
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`;
    const minutesText = precision === 0 ? String(minutes) : String(minutes).padStart(2, '0');
    return `${minutesText}:${secondsText}`;
  }

  function timelineTickStep(spanSeconds, pixelWidth = 600) {
    const span = Math.max(0, Number(spanSeconds) || 0);
    if (!span) return 1;
    const maxIntervals = clamp(Math.floor(Math.max(1, Number(pixelWidth) || 0) / 96), 2, 6);
    const rawStep = span / maxIntervals;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / magnitude;
    const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return factor * magnitude;
  }

  function buildTimelineTicks(window, pixelWidth = 600) {
    const start = Number(window?.startSeconds);
    const end = Number(window?.endSeconds);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { stepSeconds: 1, ticks: [] };
    }
    const span = end - start;
    const stepSeconds = timelineTickStep(span, pixelWidth);
    const epsilon = stepSeconds / 1000;
    const first = Math.ceil((start - epsilon) / stepSeconds) * stepSeconds;
    const ticks = [];
    for (let time = first; time <= end + epsilon && ticks.length < 12; time += stepSeconds) {
      const normalizedTime = roundMilliseconds(time);
      ticks.push({
        timeSeconds: normalizedTime,
        percent: timeToPercent(normalizedTime, { startSeconds: start, endSeconds: end }),
        label: formatTimelineTick(normalizedTime, stepSeconds)
      });
    }
    return { stepSeconds, ticks };
  }

  function formatTimelineWindowTime(value) {
    return formatTimecode(value).replace(/^00:/, '');
  }

  function playbackShortcutForKey(key) {
    if (key === ' ' || key === 'Spacebar') return 'toggle';
    if (key === 'ArrowLeft') return -5;
    if (key === 'ArrowRight') return 5;
    return null;
  }

  function seekBySeconds(currentSeconds, deltaSeconds, durationSeconds) {
    const duration = Math.max(0, Number(durationSeconds) || 0);
    const current = Number.isFinite(Number(currentSeconds)) ? Number(currentSeconds) : 0;
    const delta = Number.isFinite(Number(deltaSeconds)) ? Number(deltaSeconds) : 0;
    return roundMilliseconds(clamp(current + delta, 0, duration));
  }

  function sliderDeltaForKey(key, shiftKey = false) {
    const step = shiftKey ? 1 : 0.1;
    if (key === 'ArrowLeft' || key === 'ArrowDown') return -step;
    if (key === 'ArrowRight' || key === 'ArrowUp') return step;
    return null;
  }

  function fullRetainedRange(durationSeconds) {
    const result = validateSelection(0, durationSeconds, durationSeconds);
    if (!result.valid) return null;
    return { startSeconds: result.startSeconds, endSeconds: result.endSeconds };
  }

  function fullEditPlan(durationSeconds) {
    const range = fullRetainedRange(durationSeconds);
    return range ? { version: 1, keepRanges: [range] } : null;
  }

  function retainedRangeWithPlayhead(range, boundary, playheadSeconds) {
    if (!range || !['start', 'end'].includes(boundary)) return null;
    const playhead = roundMilliseconds(playheadSeconds);
    if (!Number.isFinite(playhead)) return null;
    return {
      startSeconds: boundary === 'start' ? playhead : range.startSeconds,
      endSeconds: boundary === 'end' ? playhead : range.endSeconds
    };
  }

  function retainedBoundaryTime(range, boundary, durationSeconds) {
    const duration = Math.max(0, Number(durationSeconds) || 0);
    const rawValue = boundary === 'end' ? range?.endSeconds : range?.startSeconds;
    const value = Number.isFinite(Number(rawValue)) ? Number(rawValue) : 0;
    return roundMilliseconds(clamp(value, 0, duration));
  }

  function editPlansEqual(first, second) {
    if (first?.version !== 1 || second?.version !== 1) return false;
    if (!Array.isArray(first.keepRanges) || !Array.isArray(second.keepRanges)
      || first.keepRanges.length !== second.keepRanges.length) return false;
    return first.keepRanges.every((range, index) => (
      range?.startSeconds === second.keepRanges[index]?.startSeconds
      && range?.endSeconds === second.keepRanges[index]?.endSeconds
    ));
  }

  function recomputeAuthoringState(state, durationSeconds) {
    const duration = roundMilliseconds(durationSeconds);
    const middleCutPlan = normalizeEditPlan(state?.middleCutPlan, duration);
    const outerStartSeconds = roundMilliseconds(state?.outerStartSeconds);
    const outerEndSeconds = roundMilliseconds(state?.outerEndSeconds);
    if (![duration, outerStartSeconds, outerEndSeconds].every(Number.isFinite) || duration <= 0) {
      throw new Error('Finite outer boundaries and media duration are required.');
    }
    if (outerStartSeconds < 0 || outerEndSeconds > duration
      || outerEndSeconds - outerStartSeconds < MIN_SELECTION_SECONDS) {
      throw new Error('The retained end must be after the retained start within the media duration.');
    }
    const keepRanges = intersectKeepRanges(middleCutPlan, outerStartSeconds, outerEndSeconds);
    if (!keepRanges.length) throw new Error('Keep at least one section of the video.');
    const editPlan = normalizeEditPlan({ version: 1, keepRanges }, duration);
    const bounds = outerRetainedBounds(editPlan);
    return {
      middleCutPlan,
      outerStartSeconds: bounds.startSeconds,
      outerEndSeconds: bounds.endSeconds,
      editPlan
    };
  }

  function fullAuthoringState(durationSeconds) {
    const editPlan = fullEditPlan(durationSeconds);
    if (!editPlan) return null;
    const bounds = outerRetainedBounds(editPlan);
    return {
      middleCutPlan: editPlan,
      outerStartSeconds: bounds.startSeconds,
      outerEndSeconds: bounds.endSeconds,
      editPlan
    };
  }

  function applyOuterBoundary(state, boundary, value, durationSeconds) {
    const requested = roundMilliseconds(value);
    const duration = roundMilliseconds(durationSeconds);
    if (!state?.middleCutPlan || !['start', 'end'].includes(boundary)
      || !Number.isFinite(requested) || !Number.isFinite(duration) || duration <= 0) {
      return { valid: false, reason: 'A finite retained boundary is required.' };
    }
    if (requested < 0 || requested > duration) {
      return { valid: false, reason: `Use values between ${formatTimecode(0)} and ${formatTimecode(duration)}.` };
    }
    const outerStart = boundary === 'start' ? requested : state.outerStartSeconds;
    const outerEnd = boundary === 'end' ? requested : state.outerEndSeconds;
    if (outerEnd - outerStart < MIN_SELECTION_SECONDS) {
      return { valid: false, reason: 'The retained end must be after the retained start.' };
    }
    let authoringState;
    try {
      authoringState = recomputeAuthoringState({
        ...state,
        outerStartSeconds: outerStart,
        outerEndSeconds: outerEnd
      }, duration);
    } catch (error) {
      return { valid: false, reason: error.message };
    }
    return {
      valid: true,
      authoringState,
      editPlan: authoringState.editPlan,
      boundarySeconds: authoringState[boundary === 'start' ? 'outerStartSeconds' : 'outerEndSeconds']
    };
  }

  function adjustOuterBoundaryBy(state, boundary, deltaSeconds, durationSeconds) {
    const property = boundary === 'start' ? 'outerStartSeconds' : boundary === 'end' ? 'outerEndSeconds' : null;
    const duration = roundMilliseconds(durationSeconds);
    const rawCurrent = property ? state?.[property] : null;
    const current = typeof rawCurrent === 'number' && Number.isFinite(rawCurrent)
      ? roundMilliseconds(rawCurrent)
      : null;
    const delta = typeof deltaSeconds === 'number' && Number.isFinite(deltaSeconds)
      ? roundMilliseconds(deltaSeconds)
      : null;
    if (!property || !Number.isFinite(duration) || duration <= 0
      || !Number.isFinite(current) || !Number.isFinite(delta)) {
      return { valid: false, reason: 'A finite retained boundary adjustment is required.' };
    }
    const requested = roundMilliseconds(clamp(current + delta, 0, duration));
    const ordinary = applyOuterBoundary(
      state,
      boundary,
      requested,
      duration
    );
    const movingOutward = boundary === 'start' ? delta < 0 : delta > 0;
    if (!movingOutward || !ordinary.valid || ordinary.boundarySeconds !== current || requested === current) {
      return ordinary;
    }

    const ranges = state.middleCutPlan?.keepRanges;
    if (!Array.isArray(ranges)) return ordinary;
    const adjacent = boundary === 'start'
      ? [...ranges].reverse().find((range) => range.endSeconds <= requested)
      : ranges.find((range) => range.startSeconds >= requested);
    if (!adjacent) return ordinary;

    const gapTarget = boundary === 'start'
      ? Math.max(adjacent.startSeconds, roundMilliseconds(adjacent.endSeconds + delta))
      : Math.min(adjacent.endSeconds, roundMilliseconds(adjacent.startSeconds + delta));
    return applyOuterBoundary(state, boundary, gapTarget, duration);
  }

  function validatePendingCut(pendingCut, durationSeconds) {
    const start = roundMilliseconds(pendingCut?.startSeconds);
    const end = roundMilliseconds(pendingCut?.endSeconds);
    const duration = roundMilliseconds(durationSeconds);
    if (![start, end, duration].every(Number.isFinite) || duration <= 0) {
      return { valid: false, reason: 'Set both cut boundaries from the playhead or exact fields.' };
    }
    if (start < 0 || end > duration) {
      return { valid: false, reason: `Use values between ${formatTimecode(0)} and ${formatTimecode(duration)}.` };
    }
    if (end - start < MIN_SELECTION_SECONDS) {
      return { valid: false, reason: 'Cut End must be after Cut Start.' };
    }
    return { valid: true, startSeconds: start, endSeconds: end };
  }

  function adjustPendingCutBoundary(pendingCut, boundary, deltaSeconds, durationSeconds) {
    const property = boundary === 'start' ? 'startSeconds' : boundary === 'end' ? 'endSeconds' : null;
    const duration = roundMilliseconds(durationSeconds);
    const rawCurrent = property ? pendingCut?.[property] : null;
    const current = typeof rawCurrent === 'number' && Number.isFinite(rawCurrent)
      ? roundMilliseconds(rawCurrent)
      : null;
    const delta = typeof deltaSeconds === 'number' && Number.isFinite(deltaSeconds)
      ? roundMilliseconds(deltaSeconds)
      : null;
    if (!property || !Number.isFinite(duration) || duration <= 0
      || !Number.isFinite(current) || !Number.isFinite(delta)) {
      return { valid: false, reason: 'Set this cut boundary before adjusting it.' };
    }
    const boundarySeconds = roundMilliseconds(clamp(current + delta, 0, duration));
    return {
      valid: true,
      boundarySeconds,
      pendingCut: { ...pendingCut, [property]: boundarySeconds }
    };
  }

  function removePendingSection(state, pendingCut, durationSeconds) {
    const cut = validatePendingCut(pendingCut, durationSeconds);
    if (!cut.valid) return cut;
    if (!state?.middleCutPlan || !state?.editPlan) {
      return { valid: false, reason: 'The local edit plan is unavailable.' };
    }
    const startSeconds = Math.max(cut.startSeconds, state.outerStartSeconds);
    const endSeconds = Math.min(cut.endSeconds, state.outerEndSeconds);
    if (endSeconds - startSeconds < MIN_SELECTION_SECONDS) {
      return { valid: false, reason: 'That section is outside the current retained output.' };
    }
    const effectiveRanges = subtractKeepRanges(state.editPlan, startSeconds, endSeconds);
    if (!effectiveRanges.length) return { valid: false, reason: 'A removal cannot discard all retained content.' };
    if (editPlansEqual(state.editPlan, { version: 1, keepRanges: effectiveRanges })) {
      return { valid: false, reason: 'That section is already outside the retained content.' };
    }
    const middleRanges = subtractKeepRanges(state.middleCutPlan, startSeconds, endSeconds);
    if (middleRanges.length > MAX_KEEP_RANGES) {
      return { valid: false, reason: `Keep the edit plan to ${MAX_KEEP_RANGES} retained sections or fewer.` };
    }
    let authoringState;
    try {
      authoringState = recomputeAuthoringState({
        ...state,
        middleCutPlan: normalizeEditPlan({ version: 1, keepRanges: middleRanges }, durationSeconds)
      }, durationSeconds);
    } catch (error) {
      return { valid: false, reason: error.message };
    }
    return {
      valid: true,
      authoringState,
      editPlan: authoringState.editPlan,
      appliedCut: { startSeconds, endSeconds }
    };
  }

  function restoreRemovedSection(state, gap, durationSeconds) {
    const keepRanges = restoreInternalGap(
      state?.middleCutPlan,
      gap?.startSeconds,
      gap?.endSeconds
    );
    if (!keepRanges) return { valid: false, reason: 'That removed section is no longer available to restore.' };
    let authoringState;
    try {
      authoringState = recomputeAuthoringState({
        ...state,
        middleCutPlan: normalizeEditPlan({ version: 1, keepRanges }, durationSeconds)
      }, durationSeconds);
    } catch (error) {
      return { valid: false, reason: error.message };
    }
    return {
      valid: true,
      authoringState,
      editPlan: authoringState.editPlan
    };
  }

  function timelineRegions(plan, durationSeconds) {
    return {
      retained: plan?.keepRanges?.map((range) => ({ ...range })) || [],
      removed: deriveRemovedRanges(plan, 0, roundMilliseconds(durationSeconds))
    };
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let index = -1;
    do {
      amount /= 1024;
      index += 1;
    } while (amount >= 1024 && index < units.length - 1);
    return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function init(root) {
    const document = root.document;
    const panel = document.querySelector('#media-workspace-panel');
    if (!panel) return;

    const workspaceStatus = document.querySelector('#editor-status');
    const editor = document.querySelector('#media-editor');
    const video = document.querySelector('#editor-video');
    const mediaName = document.querySelector('#editor-media-name');
    const mediaFacts = document.querySelector('#editor-media-facts');
    const proxyNote = document.querySelector('#editor-proxy-note');
    const trackWarning = document.querySelector('#editor-track-warning');
    const clock = document.querySelector('#editor-clock');
    const ruler = document.querySelector('#timeline-ruler');
    const rulerTicks = document.querySelector('#timeline-ruler-ticks');
    const track = document.querySelector('#timeline-track');
    const timelineRegionsLayer = document.querySelector('#timeline-regions');
    const pendingCutOverlay = document.querySelector('#timeline-pending-cut');
    const playhead = document.querySelector('#timeline-playhead');
    const startHandle = document.querySelector('#timeline-start-handle');
    const endHandle = document.querySelector('#timeline-end-handle');
    const cutStartHandle = document.querySelector('#timeline-cut-start-handle');
    const cutEndHandle = document.querySelector('#timeline-cut-end-handle');
    const visibleLabel = document.querySelector('#timeline-visible-label');
    const startField = document.querySelector('#editor-start-time');
    const endField = document.querySelector('#editor-end-time');
    const startError = document.querySelector('#editor-start-error');
    const endError = document.querySelector('#editor-end-error');
    const setStart = document.querySelector('#set-start-playhead');
    const setEnd = document.querySelector('#set-end-playhead');
    const goToStart = document.querySelector('#go-to-start');
    const goToEnd = document.querySelector('#go-to-end');
    const resetRange = document.querySelector('#reset-range');
    const cutStartField = document.querySelector('#cut-start-time');
    const cutEndField = document.querySelector('#cut-end-time');
    const cutStartError = document.querySelector('#cut-start-error');
    const cutEndError = document.querySelector('#cut-end-error');
    const pendingCutError = document.querySelector('#pending-cut-error');
    const setCutStart = document.querySelector('#set-cut-start');
    const setCutEnd = document.querySelector('#set-cut-end');
    const removeSection = document.querySelector('#remove-section');
    const clearPendingCutButton = document.querySelector('#clear-pending-cut');
    const removedSections = document.querySelector('#removed-sections');
    const removedSectionsList = document.querySelector('#removed-sections-list');
    const zoomIn = document.querySelector('#timeline-zoom-in');
    const zoomOut = document.querySelector('#timeline-zoom-out');
    const fit = document.querySelector('#timeline-fit');
    const createEditedFile = document.querySelector('#create-edited-file');
    const renderNoop = document.querySelector('#editor-render-noop');
    const renderProgress = document.querySelector('#editor-render-progress');
    const renderProgressLabel = document.querySelector('#editor-render-progress-label');
    const renderProgressBar = document.querySelector('#editor-render-progress-bar');
    const cancelEditedRender = document.querySelector('#cancel-edited-render');
    const renderFailure = document.querySelector('#editor-render-failure');
    const renderFailureTitle = document.querySelector('#editor-render-failure-title');
    const renderFailureExplanation = document.querySelector('#editor-render-failure-explanation');
    const renderFailureHelp = document.querySelector('#editor-render-failure-help');
    const editedOutput = document.querySelector('#editor-edited-output');
    const outputFilename = document.querySelector('#editor-output-filename');
    const outputFacts = document.querySelector('#editor-output-facts');
    const outputStale = document.querySelector('#editor-output-stale');
    const downloadEditedFile = document.querySelector('#download-edited-file');

    let activeWorkspaceId = null;
    let workspaceSnapshot = null;
    let durationSeconds = 0;
    let authoringState = null;
    let editPlan = null;
    let pendingCut = { startSeconds: null, endSeconds: null };
    let visibleWindow = { startSeconds: 0, endSeconds: 0 };
    let animationFrame = null;
    let seekPointer = null;
    let handleDrag = null;
    let panDrag = null;
    let playheadDrag = null;
    let playheadSeekFrame = null;
    let pendingPlayheadTime = null;

    function setStatus(message, type = '') {
      workspaceStatus.textContent = message || '';
      workspaceStatus.className = `status${type ? ` ${type}` : ''}`;
    }

    function showRenderFailure(failure, fallback) {
      renderFailureTitle.textContent = failure?.title || fallback || 'Edited-file creation failed';
      renderFailureExplanation.textContent = failure?.explanation || '';
      renderFailureHelp.textContent = failure?.help || '';
      renderFailure.hidden = false;
    }

    function clearRenderFailure() {
      renderFailure.hidden = true;
      renderFailureTitle.textContent = '';
      renderFailureExplanation.textContent = '';
      renderFailureHelp.textContent = '';
    }

    function renderEditedOutput() {
      const output = workspaceSnapshot?.editedOutput;
      if (!output) {
        editedOutput.hidden = true;
        downloadEditedFile.removeAttribute('href');
        downloadEditedFile.removeAttribute('download');
        return;
      }
      outputFilename.textContent = output.filename || 'Edited video.mp4';
      outputFacts.textContent = [
        Number.isFinite(output.inspection?.durationSeconds)
          ? formatTimecode(output.inspection.durationSeconds)
          : null,
        formatBytes(output.size)
      ].filter(Boolean).join(' · ');
      const stale = !editPlansEqual(editPlan, output.editPlan);
      outputStale.hidden = !stale;
      downloadEditedFile.href = output.downloadUrl;
      downloadEditedFile.download = output.filename || 'edited-video.mp4';
      editedOutput.hidden = false;
    }

    function renderRenderState(data = workspaceSnapshot) {
      const state = data?.render || { status: 'idle', percent: null, failure: null };
      const busy = ['rendering', 'cancelling'].includes(state.status);
      const fullDuration = isFullDurationEditPlan(editPlan, durationSeconds);
      createEditedFile.disabled = !editPlan || fullDuration || busy || Boolean(data?.activeOperation);
      cancelEditedRender.disabled = state.status === 'cancelling';
      renderProgress.hidden = !busy;
      if (busy) {
        const percent = Number.isFinite(state.percent) ? clamp(state.percent, 0, 100) : null;
        renderProgressLabel.textContent = state.message || (state.status === 'cancelling'
          ? 'Cancelling edited-file creation…'
          : 'Creating edited file…');
        renderProgressBar.classList.toggle('indeterminate', percent == null);
        renderProgressBar.style.width = percent == null ? '36%' : `${percent}%`;
      }

      if (fullDuration) {
        renderNoop.textContent = 'Change the retained range or remove a section before creating an edited file.';
        renderNoop.hidden = false;
      } else if (state.status === 'cancelled') {
        renderNoop.textContent = state.message || 'Edited-file creation cancelled. The editor is still available.';
        renderNoop.hidden = false;
      } else {
        renderNoop.hidden = true;
      }

      clearRenderFailure();
      if (state.status === 'error') showRenderFailure(state.failure, state.message);
      renderEditedOutput();
    }

    function resetEditor() {
      if (animationFrame != null) root.cancelAnimationFrame(animationFrame);
      if (playheadSeekFrame != null) root.cancelAnimationFrame(playheadSeekFrame);
      animationFrame = null;
      playheadSeekFrame = null;
      pendingPlayheadTime = null;
      playheadDrag = null;
      seekPointer = null;
      handleDrag = null;
      panDrag = null;
      playhead.classList.remove('dragging');
      track.classList.remove('seeking');
      ruler.classList.remove('panning');
      video.pause();
      video.removeAttribute('src');
      video.load();
      editor.hidden = true;
      trackWarning.hidden = true;
      durationSeconds = 0;
      authoringState = null;
      editPlan = null;
      pendingCut = { startSeconds: null, endSeconds: null };
      workspaceSnapshot = null;
      renderProgress.hidden = true;
      renderNoop.hidden = false;
      renderNoop.textContent = 'Change the retained range or remove a section before creating an edited file.';
      editedOutput.hidden = true;
      createEditedFile.disabled = true;
      cancelEditedRender.disabled = false;
      downloadEditedFile.removeAttribute('href');
      downloadEditedFile.removeAttribute('download');
      clearRenderFailure();
      setFieldError(startField, startError, '');
      setFieldError(endField, endError, '');
      setFieldError(cutStartField, cutStartError, '');
      setFieldError(cutEndField, cutEndError, '');
      cutStartField.value = '';
      cutEndField.value = '';
      pendingCutError.textContent = '';
      pendingCutOverlay.hidden = true;
      cutStartHandle.hidden = true;
      cutEndHandle.hidden = true;
      removedSections.hidden = true;
      removedSectionsList.replaceChildren();
    }

    function setSpan(element, startSeconds, endSeconds) {
      const from = timeToPercent(startSeconds, visibleWindow);
      const to = timeToPercent(endSeconds, visibleWindow);
      element.style.left = `${from}%`;
      element.style.width = `${Math.max(0, to - from)}%`;
    }

    function renderRuler() {
      rulerTicks.replaceChildren();
      ruler.classList.toggle('can-pan', visibleWindow.endSeconds - visibleWindow.startSeconds < durationSeconds);
      const { ticks } = buildTimelineTicks(visibleWindow, rulerTicks.clientWidth || ruler.clientWidth || 600);
      for (const value of ticks) {
        const tick = document.createElement('span');
        tick.className = 'timeline-tick';
        tick.classList.toggle('edge-start', value.percent < 1);
        tick.classList.toggle('edge-end', value.percent > 99);
        tick.style.left = `${value.percent}%`;
        tick.textContent = value.label;
        rulerTicks.appendChild(tick);
      }
      visibleLabel.textContent = `Showing ${formatTimelineWindowTime(visibleWindow.startSeconds)} – ${formatTimelineWindowTime(visibleWindow.endSeconds)}`;
    }

    function renderPlayhead() {
      const current = clamp(Number(video.currentTime) || 0, 0, durationSeconds || 0);
      playhead.style.left = `${timeToPercent(current, visibleWindow)}%`;
      playhead.hidden = current < visibleWindow.startSeconds || current > visibleWindow.endSeconds;
      track.setAttribute('aria-label', `Timeline seek control, playhead ${formatTimecode(current)}. Space plays or pauses; Left and Right Arrow seek five seconds.`);
      clock.textContent = `${formatTimecode(current)} / ${formatTimecode(durationSeconds)}`;
    }

    function appendTimelineRegion(kind, range) {
      const startSeconds = Math.max(range.startSeconds, visibleWindow.startSeconds);
      const endSeconds = Math.min(range.endSeconds, visibleWindow.endSeconds);
      if (endSeconds <= startSeconds) return;
      const region = document.createElement('div');
      region.className = `timeline-region ${kind}`;
      setSpan(region, startSeconds, endSeconds);
      timelineRegionsLayer.appendChild(region);
    }

    function renderRemovedSections() {
      removedSectionsList.replaceChildren();
      const gaps = deriveInternalRemovedGaps(editPlan);
      removedSections.hidden = gaps.length === 0;
      for (const gap of gaps) {
        const row = document.createElement('div');
        row.className = 'removed-section-row';
        const times = document.createElement('span');
        times.className = 'removed-section-times';
        times.textContent = `${formatTimecode(gap.startSeconds)} – ${formatTimecode(gap.endSeconds)}`;
        const restore = document.createElement('button');
        restore.className = 'text-button';
        restore.type = 'button';
        restore.textContent = 'Restore';
        restore.addEventListener('click', () => {
          const result = restoreRemovedSection(authoringState, gap, durationSeconds);
          if (result.valid) commitAuthoringState(result.authoringState);
        });
        row.append(times, restore);
        removedSectionsList.appendChild(row);
      }
    }

    function renderPendingCut({ normalizeFields = true } = {}) {
      const boundaries = [
        ['start', pendingCut.startSeconds, cutStartHandle, cutStartField],
        ['end', pendingCut.endSeconds, cutEndHandle, cutEndField]
      ];
      for (const [which, value, handle, field] of boundaries) {
        const available = Number.isFinite(value);
        const visible = available && value >= visibleWindow.startSeconds && value <= visibleWindow.endSeconds;
        handle.hidden = !visible;
        if (available) {
          handle.style.left = `${timeToPercent(value, visibleWindow)}%`;
          handle.setAttribute('aria-valuenow', String(value));
          handle.setAttribute('aria-valuetext', formatTimecode(value));
          if (normalizeFields) field.value = formatTimecode(value);
        } else if (normalizeFields) {
          field.value = '';
        }
        handle.setAttribute('aria-label', `Pending cut ${which}`);
      }

      const cut = validatePendingCut(pendingCut, durationSeconds);
      pendingCutOverlay.hidden = !cut.valid;
      if (cut.valid) {
        const startSeconds = Math.max(cut.startSeconds, visibleWindow.startSeconds);
        const endSeconds = Math.min(cut.endSeconds, visibleWindow.endSeconds);
        pendingCutOverlay.hidden = endSeconds <= startSeconds;
        if (!pendingCutOverlay.hidden) setSpan(pendingCutOverlay, startSeconds, endSeconds);
      }

      let removal = cut;
      if (cut.valid) {
        try { removal = removePendingSection(authoringState, pendingCut, durationSeconds); }
        catch (error) { removal = { valid: false, reason: error.message }; }
      }
      removeSection.disabled = !removal.valid;
      const hasBothBoundaries = Number.isFinite(pendingCut.startSeconds) && Number.isFinite(pendingCut.endSeconds);
      pendingCutError.textContent = hasBothBoundaries && !removal.valid ? removal.reason : '';
      clearPendingCutButton.disabled = !Number.isFinite(pendingCut.startSeconds)
        && !Number.isFinite(pendingCut.endSeconds);
    }

    function renderTimeline({ normalizeFields = true } = {}) {
      if (!editPlan) return;
      timelineRegionsLayer.replaceChildren();
      const regions = timelineRegions(editPlan, durationSeconds);
      for (const range of regions.removed) appendTimelineRegion('removed', range);
      for (const range of regions.retained) appendTimelineRegion('retained', range);

      const bounds = outerRetainedBounds(editPlan);
      const startVisible = bounds.startSeconds >= visibleWindow.startSeconds && bounds.startSeconds <= visibleWindow.endSeconds;
      const endVisible = bounds.endSeconds >= visibleWindow.startSeconds && bounds.endSeconds <= visibleWindow.endSeconds;
      startHandle.hidden = !startVisible;
      endHandle.hidden = !endVisible;
      startHandle.style.left = `${timeToPercent(bounds.startSeconds, visibleWindow)}%`;
      endHandle.style.left = `${timeToPercent(bounds.endSeconds, visibleWindow)}%`;
      startHandle.setAttribute('aria-valuenow', String(bounds.startSeconds));
      endHandle.setAttribute('aria-valuenow', String(bounds.endSeconds));
      startHandle.setAttribute('aria-valuetext', formatTimecode(bounds.startSeconds));
      endHandle.setAttribute('aria-valuetext', formatTimecode(bounds.endSeconds));
      if (normalizeFields) {
        startField.value = formatTimecode(bounds.startSeconds);
        endField.value = formatTimecode(bounds.endSeconds);
      }
      renderPendingCut({ normalizeFields });
      renderRemovedSections();
      renderRuler();
      renderPlayhead();
    }

    function commitAuthoringState(nextState, { normalizeFields = true, clearPending = false } = {}) {
      try {
        authoringState = recomputeAuthoringState(nextState, durationSeconds);
        editPlan = authoringState.editPlan;
      } catch (error) {
        return { valid: false, reason: error.message };
      }
      if (clearPending) pendingCut = { startSeconds: null, endSeconds: null };
      renderTimeline({ normalizeFields });
      setFieldError(startField, startError, '');
      setFieldError(endField, endError, '');
      renderRenderState();
      return { valid: true, authoringState, editPlan };
    }

    function commitOuterBoundary(which, value) {
      let result;
      try { result = applyOuterBoundary(authoringState, which, value, durationSeconds); }
      catch (error) { return { valid: false, reason: error.message }; }
      if (!result.valid) return result;
      commitAuthoringState(result.authoringState);
      return result;
    }

    function setFieldError(field, output, message) {
      field.setAttribute('aria-invalid', message ? 'true' : 'false');
      field.classList.toggle('invalid', Boolean(message));
      output.textContent = message || '';
    }

    function commitExactField(which) {
      if (!editPlan) return;
      const field = which === 'start' ? startField : endField;
      const output = which === 'start' ? startError : endError;
      const parsed = parseTimecode(field.value);
      if (parsed == null) {
        setFieldError(field, output, 'Use seconds, MM:SS.mmm, or HH:MM:SS.mmm.');
        return;
      }
      const result = commitOuterBoundary(which, parsed);
      if (!result.valid) {
        setFieldError(field, output, result.reason);
        return;
      }
      setFieldError(startField, startError, '');
      setFieldError(endField, endError, '');
    }

    function commitCutExactField(which) {
      if (!editPlan) return;
      const field = which === 'start' ? cutStartField : cutEndField;
      const output = which === 'start' ? cutStartError : cutEndError;
      const parsed = parseTimecode(field.value);
      if (parsed == null) {
        setFieldError(field, output, 'Use seconds, MM:SS.mmm, or HH:MM:SS.mmm.');
        return;
      }
      if (parsed < 0 || parsed > durationSeconds) {
        setFieldError(field, output, `Use values between ${formatTimecode(0)} and ${formatTimecode(durationSeconds)}.`);
        return;
      }
      pendingCut[`${which}Seconds`] = parsed;
      setFieldError(field, output, '');
      renderPendingCut();
    }

    function clearPendingCut() {
      pendingCut = { startSeconds: null, endSeconds: null };
      setFieldError(cutStartField, cutStartError, '');
      setFieldError(cutEndField, cutEndError, '');
      pendingCutError.textContent = '';
      renderPendingCut();
    }

    function commitPendingCut() {
      let result;
      try { result = removePendingSection(authoringState, pendingCut, durationSeconds); }
      catch (error) { result = { valid: false, reason: error.message }; }
      if (!result.valid) {
        pendingCutError.textContent = result.reason;
        return;
      }
      commitAuthoringState(result.authoringState, { clearPending: true });
    }

    function defaultZoomAnchor() {
      const current = Number(video.currentTime) || 0;
      if (current >= visibleWindow.startSeconds && current <= visibleWindow.endSeconds) return current;
      return (visibleWindow.startSeconds + visibleWindow.endSeconds) / 2;
    }

    function zoom(scale, anchor = defaultZoomAnchor()) {
      visibleWindow = zoomVisibleWindow(visibleWindow, durationSeconds, scale, anchor);
      renderTimeline();
    }

    function pointerTime(event, element) {
      const rect = element.getBoundingClientRect();
      const ratio = rect.width ? clamp((event.clientX - rect.left) / rect.width, 0, 1) : 0;
      return roundMilliseconds(visibleWindow.startSeconds
        + ratio * (visibleWindow.endSeconds - visibleWindow.startSeconds));
    }

    function seekFromPointer(event) {
      if (!durationSeconds) return;
      video.currentTime = clamp(pointerTime(event, track), 0, durationSeconds);
      renderPlayhead();
    }

    function schedulePlayheadSeek(event) {
      pendingPlayheadTime = clamp(pointerTime(event, track), 0, durationSeconds);
      if (playheadSeekFrame != null) return;
      playheadSeekFrame = root.requestAnimationFrame(() => {
        playheadSeekFrame = null;
        if (pendingPlayheadTime == null) return;
        video.currentTime = pendingPlayheadTime;
        pendingPlayheadTime = null;
        renderPlayhead();
      });
    }

    function beginPlayheadDrag(event) {
      if (!editPlan || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      track.focus({ preventScroll: true });
      playhead.setPointerCapture(event.pointerId);
      playheadDrag = event.pointerId;
      playhead.classList.add('dragging');
      schedulePlayheadSeek(event);
    }

    function movePlayhead(event) {
      if (playheadDrag !== event.pointerId) return;
      schedulePlayheadSeek(event);
    }

    function endPlayheadDrag(event) {
      if (playheadDrag !== event.pointerId) return;
      schedulePlayheadSeek(event);
      try { playhead.releasePointerCapture(event.pointerId); } catch {}
      playheadDrag = null;
      playhead.classList.remove('dragging');
    }

    function isPlaybackShortcutBlocked(target) {
      if (!target || target === track || target === video) return false;
      return Boolean(target.closest?.('input, textarea, select, button, [contenteditable="true"]'));
    }

    function handlePlaybackKey(event) {
      if (!editPlan || event.altKey || event.ctrlKey || event.metaKey || isPlaybackShortcutBlocked(event.target)) return;
      const action = playbackShortcutForKey(event.key);
      if (action == null || (action === 'toggle' && event.repeat)) return;
      event.preventDefault();
      if (action === 'toggle') {
        if (video.paused || video.ended) {
          const playing = video.play();
          if (playing?.catch) playing.catch(() => {});
        } else {
          video.pause();
        }
        return;
      }
      video.currentTime = seekBySeconds(video.currentTime, action, durationSeconds);
      renderPlayhead();
    }

    function beginHandleDrag(event, which, kind = 'outer') {
      event.preventDefault();
      event.stopPropagation();
      const handle = kind === 'cut'
        ? (which === 'start' ? cutStartHandle : cutEndHandle)
        : (which === 'start' ? startHandle : endHandle);
      handle.setPointerCapture(event.pointerId);
      handleDrag = { pointerId: event.pointerId, which, kind, handle };
    }

    function moveHandle(event) {
      if (!handleDrag || event.pointerId !== handleDrag.pointerId || !editPlan) return;
      const value = pointerTime(event, track);
      if (handleDrag.kind === 'cut') {
        pendingCut[`${handleDrag.which}Seconds`] = clamp(value, 0, durationSeconds);
        const field = handleDrag.which === 'start' ? cutStartField : cutEndField;
        const error = handleDrag.which === 'start' ? cutStartError : cutEndError;
        setFieldError(field, error, '');
        renderPendingCut();
        return;
      }
      commitOuterBoundary(handleDrag.which, value);
    }

    function endHandleDrag(event) {
      if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
      try { handleDrag.handle.releasePointerCapture(event.pointerId); } catch {}
      handleDrag = null;
    }

    function handleTimelineSliderKey(event, which, kind = 'outer') {
      if (!editPlan || event.altKey || event.ctrlKey || event.metaKey) return;
      const delta = sliderDeltaForKey(event.key, event.shiftKey);
      if (delta == null) return;
      event.preventDefault();
      event.stopPropagation();

      if (kind === 'cut') {
        const result = adjustPendingCutBoundary(pendingCut, which, delta, durationSeconds);
        if (!result.valid) return;
        pendingCut = result.pendingCut;
        const field = which === 'start' ? cutStartField : cutEndField;
        const error = which === 'start' ? cutStartError : cutEndError;
        setFieldError(field, error, '');
        renderPendingCut();
        return;
      }

      const result = adjustOuterBoundaryBy(authoringState, which, delta, durationSeconds);
      const field = which === 'start' ? startField : endField;
      const error = which === 'start' ? startError : endError;
      if (!result.valid) {
        setFieldError(field, error, result.reason);
        return;
      }
      commitAuthoringState(result.authoringState);
    }

    function playbackFrame() {
      renderPlayhead();
      if (!video.paused && !video.ended) animationFrame = root.requestAnimationFrame(playbackFrame);
      else animationFrame = null;
    }

    function beginPlaybackFrames() {
      if (animationFrame == null) animationFrame = root.requestAnimationFrame(playbackFrame);
    }

    function renderWorkspace(data) {
      if (!data || data.id !== activeWorkspaceId) return;
      workspaceSnapshot = data;
      if (data.editor?.status === 'ready' && !editPlan) initializeEditor(data);
      if (editPlan) renderRenderState(data);
    }

    function initializeEditor(data) {
      const inspection = data.inspection || {};
      durationSeconds = Number(inspection.durationSeconds);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !data.playback?.url) {
        setStatus('The prepared editor state is incomplete.', 'error');
        return;
      }

      authoringState = fullAuthoringState(durationSeconds);
      editPlan = authoringState?.editPlan || null;
      pendingCut = { startSeconds: null, endSeconds: null };
      visibleWindow = { startSeconds: 0, endSeconds: durationSeconds };
      for (const handle of [startHandle, endHandle, cutStartHandle, cutEndHandle]) {
        handle.setAttribute('aria-valuemax', String(durationSeconds));
      }
      mediaName.textContent = data.source?.name || 'Local video';
      const facts = [
        `${inspection.video.width}×${inspection.video.height}`,
        inspection.video.codec?.toUpperCase(),
        inspection.audio ? `Audio ${inspection.audio.codec?.toUpperCase()}` : 'No audio',
        inspection.format,
        formatBytes(data.source?.size)
      ].filter(Boolean);
      mediaFacts.textContent = facts.join(' · ');
      proxyNote.textContent = data.playback.proxy
        ? 'Playback uses a temporary local H.264/AAC proxy. The workspace source remains separate and unchanged.'
        : 'This workspace source is directly compatible with browser playback; no proxy copy was needed.';
      proxyNote.classList.toggle('proxy', Boolean(data.playback.proxy));
      const trackCounts = inspection.trackCounts || {};
      trackWarning.hidden = !(Number(trackCounts.audio) > 1 || Number(trackCounts.subtitle) > 0);
      video.src = data.playback.url;
      editor.hidden = false;
      setStatus(data.source?.origin === 'url' ? 'URL media is ready in the editor.' : 'Local editor ready.', 'success');
      renderTimeline();
      renderRenderState(data);
    }

    async function startEditedRender() {
      if (!activeWorkspaceId || !editPlan || isFullDurationEditPlan(editPlan, durationSeconds)) return;
      createEditedFile.disabled = true;
      clearRenderFailure();
      renderProgress.hidden = false;
      renderProgressLabel.textContent = 'Starting edited-file creation…';
      renderProgressBar.classList.add('indeterminate');
      renderProgressBar.style.width = '36%';
      const requestWorkspaceId = activeWorkspaceId;
      try {
        const response = await root.fetch('/api/workspace/render', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: activeWorkspaceId,
            editPlan
          })
        });
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok) throw Object.assign(
          new Error(data?.error || 'Could not start edited-file creation.'),
          { failure: data?.details }
        );
        if (activeWorkspaceId !== requestWorkspaceId) return;
        root.LVOVDLocalWorkspace?.accept(data.workspace);
      } catch (error) {
        if (activeWorkspaceId !== requestWorkspaceId) return;
        renderProgress.hidden = true;
        renderRenderState();
        showRenderFailure(error.failure, error.message);
      }
    }

    async function cancelRender() {
      if (!activeWorkspaceId || !['rendering', 'cancelling'].includes(workspaceSnapshot?.render?.status)) return;
      cancelEditedRender.disabled = true;
      renderProgressLabel.textContent = 'Cancelling edited-file creation…';
      renderProgressBar.classList.add('indeterminate');
      renderProgressBar.style.width = '36%';
      const requestWorkspaceId = activeWorkspaceId;
      try {
        const response = await root.fetch(
          `/api/workspace/render?workspace=${encodeURIComponent(activeWorkspaceId)}`,
          { method: 'DELETE', cache: 'no-store' }
        );
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok) throw new Error(data?.error || 'Could not cancel edited-file creation.');
        if (activeWorkspaceId !== requestWorkspaceId) return;
        root.LVOVDLocalWorkspace?.accept(data.workspace);
      } catch (error) {
        if (activeWorkspaceId !== requestWorkspaceId) return;
        cancelEditedRender.disabled = false;
        showRenderFailure(null, error.message || 'Could not cancel edited-file creation.');
      }
    }

    track.addEventListener('pointerdown', (event) => {
      if (!editPlan || event.button !== 0) return;
      event.preventDefault();
      track.focus({ preventScroll: true });
      track.setPointerCapture(event.pointerId);
      seekPointer = event.pointerId;
      track.classList.add('seeking');
      seekFromPointer(event);
    });
    track.addEventListener('pointermove', (event) => {
      if (seekPointer === event.pointerId) seekFromPointer(event);
      moveHandle(event);
    });
    track.addEventListener('pointerup', (event) => {
      if (seekPointer === event.pointerId) {
        try { track.releasePointerCapture(event.pointerId); } catch {}
        seekPointer = null;
        track.classList.remove('seeking');
      }
      endHandleDrag(event);
    });
    track.addEventListener('pointercancel', (event) => {
      seekPointer = null;
      track.classList.remove('seeking');
      endHandleDrag(event);
    });
    playhead.addEventListener('pointerdown', beginPlayheadDrag);
    playhead.addEventListener('pointermove', movePlayhead);
    playhead.addEventListener('pointerup', endPlayheadDrag);
    playhead.addEventListener('pointercancel', endPlayheadDrag);
    startHandle.addEventListener('pointerdown', (event) => beginHandleDrag(event, 'start'));
    endHandle.addEventListener('pointerdown', (event) => beginHandleDrag(event, 'end'));
    cutStartHandle.addEventListener('pointerdown', (event) => beginHandleDrag(event, 'start', 'cut'));
    cutEndHandle.addEventListener('pointerdown', (event) => beginHandleDrag(event, 'end', 'cut'));
    startHandle.addEventListener('keydown', (event) => handleTimelineSliderKey(event, 'start'));
    endHandle.addEventListener('keydown', (event) => handleTimelineSliderKey(event, 'end'));
    cutStartHandle.addEventListener('keydown', (event) => handleTimelineSliderKey(event, 'start', 'cut'));
    cutEndHandle.addEventListener('keydown', (event) => handleTimelineSliderKey(event, 'end', 'cut'));
    for (const handle of [startHandle, endHandle, cutStartHandle, cutEndHandle]) {
      handle.addEventListener('pointermove', moveHandle);
      handle.addEventListener('pointerup', endHandleDrag);
      handle.addEventListener('pointercancel', endHandleDrag);
    }

    ruler.addEventListener('pointerdown', (event) => {
      if (!editPlan || event.button !== 0 || visibleWindow.endSeconds - visibleWindow.startSeconds >= durationSeconds) return;
      event.preventDefault();
      ruler.setPointerCapture(event.pointerId);
      panDrag = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        window: { ...visibleWindow }
      };
      ruler.classList.add('panning');
    });
    ruler.addEventListener('pointermove', (event) => {
      if (!panDrag || panDrag.pointerId !== event.pointerId) return;
      const rect = ruler.getBoundingClientRect();
      const span = panDrag.window.endSeconds - panDrag.window.startSeconds;
      const deltaSeconds = rect.width ? -(event.clientX - panDrag.clientX) / rect.width * span : 0;
      visibleWindow = panVisibleWindow(panDrag.window, durationSeconds, deltaSeconds);
      renderTimeline();
    });
    const endPan = (event) => {
      if (!panDrag || panDrag.pointerId !== event.pointerId) return;
      try { ruler.releasePointerCapture(event.pointerId); } catch {}
      panDrag = null;
      ruler.classList.remove('panning');
    };
    ruler.addEventListener('pointerup', endPan);
    ruler.addEventListener('pointercancel', endPan);
    track.addEventListener('wheel', (event) => {
      if (!editPlan) return;
      event.preventDefault();
      zoom(event.deltaY < 0 ? 0.5 : 2, pointerTime(event, track));
    }, { passive: false });

    startField.addEventListener('change', () => commitExactField('start'));
    endField.addEventListener('change', () => commitExactField('end'));
    for (const [field, which] of [[startField, 'start'], [endField, 'end']]) {
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitExactField(which);
        }
      });
    }
    cutStartField.addEventListener('change', () => commitCutExactField('start'));
    cutEndField.addEventListener('change', () => commitCutExactField('end'));
    for (const [field, which] of [[cutStartField, 'start'], [cutEndField, 'end']]) {
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitCutExactField(which);
        }
      });
    }
    setStart.addEventListener('click', () => {
      if (!editPlan) return;
      const result = commitOuterBoundary('start', video.currentTime);
      setFieldError(startField, startError, result.valid ? '' : result.reason);
    });
    setEnd.addEventListener('click', () => {
      if (!editPlan) return;
      const result = commitOuterBoundary('end', video.currentTime);
      setFieldError(endField, endError, result.valid ? '' : result.reason);
    });
    goToStart.addEventListener('click', () => {
      if (!editPlan) return;
      video.currentTime = retainedBoundaryTime(outerRetainedBounds(editPlan), 'start', durationSeconds);
      renderPlayhead();
    });
    goToEnd.addEventListener('click', () => {
      if (!editPlan) return;
      video.currentTime = retainedBoundaryTime(outerRetainedBounds(editPlan), 'end', durationSeconds);
      renderPlayhead();
    });
    resetRange.addEventListener('click', () => {
      if (!editPlan) return;
      const state = fullAuthoringState(durationSeconds);
      if (state) commitAuthoringState(state, { clearPending: true });
    });
    setCutStart.addEventListener('click', () => {
      pendingCut.startSeconds = roundMilliseconds(clamp(video.currentTime, 0, durationSeconds));
      setFieldError(cutStartField, cutStartError, '');
      renderPendingCut();
    });
    setCutEnd.addEventListener('click', () => {
      pendingCut.endSeconds = roundMilliseconds(clamp(video.currentTime, 0, durationSeconds));
      setFieldError(cutEndField, cutEndError, '');
      renderPendingCut();
    });
    removeSection.addEventListener('click', commitPendingCut);
    clearPendingCutButton.addEventListener('click', clearPendingCut);
    createEditedFile.addEventListener('click', startEditedRender);
    cancelEditedRender.addEventListener('click', cancelRender);
    zoomIn.addEventListener('click', () => zoom(0.5));
    zoomOut.addEventListener('click', () => zoom(2));
    fit.addEventListener('click', () => {
      visibleWindow = { startSeconds: 0, endSeconds: durationSeconds };
      renderTimeline();
    });
    track.addEventListener('keydown', handlePlaybackKey);
    video.addEventListener('keydown', handlePlaybackKey);
    video.addEventListener('play', beginPlaybackFrames);
    video.addEventListener('timeupdate', renderPlayhead);
    video.addEventListener('seeked', renderPlayhead);
    video.addEventListener('loadedmetadata', renderPlayhead);
    root.addEventListener('resize', () => {
      if (editPlan) renderRuler();
    });
    root.LVOVDEditorView = {
      update(data) {
        if (data?.id !== activeWorkspaceId) { resetEditor(); activeWorkspaceId = data?.id || null; }
        renderWorkspace(data);
      },
      show(visible) {
        editor.hidden = !visible || !editPlan;
        if (!visible) {
          video.pause();
          if (animationFrame != null) root.cancelAnimationFrame(animationFrame);
          animationFrame = null;
        } else if (editPlan) renderTimeline();
      },
      reset() { resetEditor(); activeWorkspaceId = null; },
      hasCuts() { return Boolean(editPlan && !isFullDurationEditPlan(editPlan, durationSeconds)); }
    };
  }

  return {
    parseTimecode,
    formatTimecode,
    validateSelection,
    clampVisibleWindow,
    zoomVisibleWindow,
    panVisibleWindow,
    timeToPercent,
    formatTimelineTick,
    timelineTickStep,
    buildTimelineTicks,
    playbackShortcutForKey,
    seekBySeconds,
    sliderDeltaForKey,
    fullRetainedRange,
    retainedRangeWithPlayhead,
    retainedBoundaryTime,
    editPlansEqual,
    fullEditPlan,
    recomputeAuthoringState,
    fullAuthoringState,
    applyOuterBoundary,
    adjustOuterBoundaryBy,
    validatePendingCut,
    adjustPendingCutBoundary,
    removePendingSection,
    restoreRemovedSection,
    timelineRegions,
    isFullDurationEditPlan,
    init
  };
});
