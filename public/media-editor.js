'use strict';

(function attachMediaEditor(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) api.init(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMediaEditorApi() {
  const MAX_LOCAL_MEDIA_BYTES = 100 * 1024 * 1024 * 1024;
  const MIN_SELECTION_SECONDS = 0.001;
  const MIN_VISIBLE_SECONDS = 0.25;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function roundMilliseconds(value) {
    return Math.round(Number(value) * 1000) / 1000;
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

  function fullRetainedRange(durationSeconds) {
    const result = validateSelection(0, durationSeconds, durationSeconds);
    if (!result.valid) return null;
    return { startSeconds: result.startSeconds, endSeconds: result.endSeconds };
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

  function isFullDurationEditPlan(plan, durationSeconds) {
    const duration = roundMilliseconds(durationSeconds);
    const range = plan?.version === 1 && Array.isArray(plan.keepRanges) && plan.keepRanges.length === 1
      ? plan.keepRanges[0]
      : null;
    return Boolean(range && range.startSeconds === 0 && range.endSeconds === duration);
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

    const dropZone = document.querySelector('#media-drop-zone');
    const chooseButton = document.querySelector('#media-choose-button');
    const fileInput = document.querySelector('#media-file-input');
    const storageNote = document.querySelector('#workspace-storage-note');
    const workspaceStatus = document.querySelector('#workspace-status');
    const workspaceProgress = document.querySelector('#workspace-progress');
    const workspaceProgressBar = document.querySelector('#workspace-progress-bar');
    const workspaceProgressLabel = document.querySelector('#workspace-progress-label');
    const workspaceCancel = document.querySelector('#workspace-cancel');
    const failurePanel = document.querySelector('#workspace-failure');
    const failureTitle = document.querySelector('#workspace-failure-title');
    const failureExplanation = document.querySelector('#workspace-failure-explanation');
    const failureHelp = document.querySelector('#workspace-failure-help');
    const failureDiscard = document.querySelector('#workspace-failure-discard');
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
    const removedBefore = document.querySelector('#timeline-removed-before');
    const retained = document.querySelector('#timeline-retained');
    const removedAfter = document.querySelector('#timeline-removed-after');
    const playhead = document.querySelector('#timeline-playhead');
    const startHandle = document.querySelector('#timeline-start-handle');
    const endHandle = document.querySelector('#timeline-end-handle');
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
    const zoomIn = document.querySelector('#timeline-zoom-in');
    const zoomOut = document.querySelector('#timeline-zoom-out');
    const fit = document.querySelector('#timeline-fit');
    const discard = document.querySelector('#workspace-discard');
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

    let upload = null;
    let progressSource = null;
    let activeWorkspaceId = null;
    let workspaceSnapshot = null;
    let durationSeconds = 0;
    let editPlan = null;
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

    function setProgress(percent, label, indeterminate = false) {
      workspaceProgress.hidden = false;
      workspaceProgressLabel.textContent = label || '';
      workspaceProgressBar.classList.toggle('indeterminate', indeterminate);
      workspaceProgressBar.style.width = Number.isFinite(percent)
        ? `${clamp(percent, 0, 100)}%`
        : '36%';
    }

    function showFailure(failure, fallback) {
      failureTitle.textContent = failure?.title || fallback || 'Local media preparation failed';
      failureExplanation.textContent = failure?.explanation || '';
      failureHelp.textContent = failure?.help || '';
      failureDiscard.hidden = !activeWorkspaceId;
      failurePanel.hidden = false;
      setStatus(failureTitle.textContent, 'error');
    }

    function clearFailure() {
      failurePanel.hidden = true;
      failureTitle.textContent = '';
      failureExplanation.textContent = '';
      failureHelp.textContent = '';
      failureDiscard.hidden = true;
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
      createEditedFile.disabled = !editPlan || fullDuration || busy;
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
        renderNoop.textContent = 'Move the start or end before creating an edited file.';
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

    function closeProgressSource() {
      if (progressSource) progressSource.close();
      progressSource = null;
    }

    function releaseWorkspaceConnectionsForDiscard() {
      const playbackUrl = workspaceSnapshot?.status === 'ready'
        ? workspaceSnapshot.playback?.url || null
        : null;
      const recovery = {
        playbackUrl,
        playbackTime: clamp(Number(video.currentTime) || 0, 0, durationSeconds || 0),
        reconnectProgress: Boolean(workspaceSnapshot && workspaceSnapshot.status !== 'error')
      };
      closeProgressSource();
      if (playbackUrl) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      return recovery;
    }

    function restoreWorkspaceConnectionsAfterDiscardFailure(workspaceId, recovery) {
      if (activeWorkspaceId !== workspaceId) return;
      if (recovery.playbackUrl) {
        video.src = recovery.playbackUrl;
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = clamp(recovery.playbackTime, 0, durationSeconds || 0);
          renderPlayhead();
        }, { once: true });
        video.load();
      }
      if (recovery.reconnectProgress) startProgress(workspaceId);
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
      editPlan = null;
      workspaceSnapshot = null;
      renderProgress.hidden = true;
      renderNoop.hidden = false;
      renderNoop.textContent = 'Move the start or end before creating an edited file.';
      editedOutput.hidden = true;
      createEditedFile.disabled = true;
      cancelEditedRender.disabled = false;
      downloadEditedFile.removeAttribute('href');
      downloadEditedFile.removeAttribute('download');
      clearRenderFailure();
      setFieldError(startField, startError, '');
      setFieldError(endField, endError, '');
    }

    function resetWorkspaceUi(message = '') {
      closeProgressSource();
      resetEditor();
      upload = null;
      activeWorkspaceId = null;
      fileInput.value = '';
      chooseButton.disabled = false;
      dropZone.hidden = false;
      storageNote.hidden = true;
      dropZone.classList.remove('dragover');
      workspaceProgress.hidden = true;
      workspaceCancel.hidden = true;
      workspaceCancel.disabled = false;
      failureDiscard.disabled = false;
      discard.disabled = false;
      clearFailure();
      setStatus(message);
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

    function renderTimeline({ normalizeFields = true } = {}) {
      if (!editPlan) return;
      const range = editPlan.keepRanges[0];
      setSpan(removedBefore, visibleWindow.startSeconds, Math.min(range.startSeconds, visibleWindow.endSeconds));
      setSpan(retained, Math.max(range.startSeconds, visibleWindow.startSeconds), Math.min(range.endSeconds, visibleWindow.endSeconds));
      setSpan(removedAfter, Math.max(range.endSeconds, visibleWindow.startSeconds), visibleWindow.endSeconds);

      const startVisible = range.startSeconds >= visibleWindow.startSeconds && range.startSeconds <= visibleWindow.endSeconds;
      const endVisible = range.endSeconds >= visibleWindow.startSeconds && range.endSeconds <= visibleWindow.endSeconds;
      startHandle.hidden = !startVisible;
      endHandle.hidden = !endVisible;
      startHandle.style.left = `${timeToPercent(range.startSeconds, visibleWindow)}%`;
      endHandle.style.left = `${timeToPercent(range.endSeconds, visibleWindow)}%`;
      startHandle.setAttribute('aria-valuenow', String(range.startSeconds));
      endHandle.setAttribute('aria-valuenow', String(range.endSeconds));
      startHandle.setAttribute('aria-valuetext', formatTimecode(range.startSeconds));
      endHandle.setAttribute('aria-valuetext', formatTimecode(range.endSeconds));
      if (normalizeFields) {
        startField.value = formatTimecode(range.startSeconds);
        endField.value = formatTimecode(range.endSeconds);
      }
      renderRuler();
      renderPlayhead();
    }

    function commitSelection(startSeconds, endSeconds, { normalizeFields = true } = {}) {
      const result = validateSelection(startSeconds, endSeconds, durationSeconds);
      if (!result.valid) return result;
      editPlan = {
        version: 1,
        keepRanges: [{
          startSeconds: result.startSeconds,
          endSeconds: result.endSeconds
        }]
      };
      renderTimeline({ normalizeFields });
      setFieldError(startField, startError, '');
      setFieldError(endField, endError, '');
      renderRenderState();
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
      const current = editPlan.keepRanges[0];
      const result = commitSelection(
        which === 'start' ? parsed : current.startSeconds,
        which === 'end' ? parsed : current.endSeconds
      );
      if (!result.valid) {
        setFieldError(field, output, result.reason);
        return;
      }
      setFieldError(startField, startError, '');
      setFieldError(endField, endError, '');
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

    function beginHandleDrag(event, which) {
      event.preventDefault();
      event.stopPropagation();
      const handle = which === 'start' ? startHandle : endHandle;
      handle.setPointerCapture(event.pointerId);
      handleDrag = { pointerId: event.pointerId, which, handle };
    }

    function moveHandle(event) {
      if (!handleDrag || event.pointerId !== handleDrag.pointerId || !editPlan) return;
      const range = editPlan.keepRanges[0];
      const value = pointerTime(event, track);
      if (handleDrag.which === 'start') {
        commitSelection(clamp(value, 0, range.endSeconds - MIN_SELECTION_SECONDS), range.endSeconds);
      } else {
        commitSelection(range.startSeconds, clamp(value, range.startSeconds + MIN_SELECTION_SECONDS, durationSeconds));
      }
    }

    function endHandleDrag(event) {
      if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
      try { handleDrag.handle.releasePointerCapture(event.pointerId); } catch {}
      handleDrag = null;
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
      const editorAlreadyReady = Boolean(
        workspaceSnapshot?.id === data.id
        && workspaceSnapshot.status === 'ready'
        && editPlan
      );
      workspaceSnapshot = data;
      const percent = Number.isFinite(data.percent) ? data.percent : null;
      if (data.status === 'inspecting') {
        setProgress(null, 'Inspecting locally with ffprobe…', true);
        workspaceCancel.hidden = false;
      } else if (data.status === 'proxying') {
        setProgress(percent, Number.isFinite(percent)
          ? `Preparing local playback proxy · ${percent.toFixed(0)}%`
          : 'Preparing local playback proxy…', !Number.isFinite(percent));
        workspaceCancel.hidden = false;
      } else if (data.status === 'cancelling') {
        setProgress(null, 'Cancelling and cleaning temporary files…', true);
        workspaceCancel.hidden = true;
      } else if (data.status === 'error') {
        closeProgressSource();
        workspaceProgress.hidden = true;
        workspaceCancel.textContent = 'Discard';
        workspaceCancel.hidden = false;
        showFailure(data.failure, data.message);
      } else if (data.status === 'ready') {
        workspaceProgress.hidden = true;
        workspaceCancel.hidden = true;
        if (!editorAlreadyReady) initializeEditor(data);
        renderRenderState(data);
      }
      if (!['error', 'ready'].includes(data.status)) setStatus(data.message || 'Preparing local media…');
    }

    function initializeEditor(data) {
      const inspection = data.inspection || {};
      durationSeconds = Number(inspection.durationSeconds);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !data.playback?.url) {
        showFailure(null, 'The prepared editor state is incomplete.');
        return;
      }

      editPlan = {
        version: 1,
        keepRanges: [{ startSeconds: 0, endSeconds: roundMilliseconds(durationSeconds) }]
      };
      visibleWindow = { startSeconds: 0, endSeconds: durationSeconds };
      startHandle.setAttribute('aria-valuemax', String(durationSeconds));
      endHandle.setAttribute('aria-valuemax', String(durationSeconds));
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
        ? 'Playback uses a temporary local H.264/AAC proxy. The staged source remains separate and unchanged.'
        : 'This staged source is directly compatible with browser playback; no proxy copy was needed.';
      proxyNote.classList.toggle('proxy', Boolean(data.playback.proxy));
      const trackCounts = inspection.trackCounts || {};
      trackWarning.hidden = !(Number(trackCounts.audio) > 1 || Number(trackCounts.subtitle) > 0);
      video.src = data.playback.url;
      editor.hidden = false;
      chooseButton.disabled = true;
      dropZone.hidden = true;
      setStatus('Local editor ready.', 'success');
      clearFailure();
      renderTimeline();
      renderRenderState(data);
    }

    function startProgress(workspaceId) {
      closeProgressSource();
      progressSource = new root.EventSource(`/api/workspace/progress?workspace=${encodeURIComponent(workspaceId)}`);
      progressSource.onmessage = (event) => {
        try { renderWorkspace(JSON.parse(event.data)); }
        catch { showFailure(null, 'LVOVD received an unreadable workspace update.'); }
      };
      progressSource.onerror = () => {
        if (!workspaceSnapshot || !['ready', 'error'].includes(workspaceSnapshot.status)) {
          setStatus('Workspace progress connection was interrupted.', 'error');
        }
      };
    }

    async function discardWorkspace() {
      if (upload) {
        upload.abort();
        return;
      }
      if (!activeWorkspaceId) {
        resetWorkspaceUi();
        return;
      }
      const id = activeWorkspaceId;
      const connections = releaseWorkspaceConnectionsForDiscard();
      workspaceCancel.disabled = true;
      failureDiscard.disabled = true;
      discard.disabled = true;
      setStatus(workspaceSnapshot?.status === 'ready'
        ? 'Discarding local workspace…'
        : 'Cancelling local preparation and cleaning temporary files…');
      try {
        const response = await root.fetch(`/api/workspace?workspace=${encodeURIComponent(id)}`, {
          method: 'DELETE',
          cache: 'no-store'
        });
        const data = await response.json();
        if (response.status === 404) {
          resetWorkspaceUi('Local media workspace was already discarded.');
          return;
        }
        if (!response.ok) throw new Error(data.error || 'Could not discard the local workspace.');
        resetWorkspaceUi('Local media workspace discarded.');
      } catch (error) {
        restoreWorkspaceConnectionsAfterDiscardFailure(id, connections);
        workspaceCancel.disabled = false;
        failureDiscard.disabled = false;
        discard.disabled = false;
        setStatus(error.message || 'Could not discard the local workspace.', 'error');
      }
    }

    async function startEditedRender() {
      if (!activeWorkspaceId || !editPlan || isFullDurationEditPlan(editPlan, durationSeconds)) return;
      createEditedFile.disabled = true;
      clearRenderFailure();
      renderProgress.hidden = false;
      renderProgressLabel.textContent = 'Starting edited-file creation…';
      renderProgressBar.classList.add('indeterminate');
      renderProgressBar.style.width = '36%';
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
        renderWorkspace(data.workspace);
      } catch (error) {
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
      try {
        const response = await root.fetch(
          `/api/workspace/render?workspace=${encodeURIComponent(activeWorkspaceId)}`,
          { method: 'DELETE', cache: 'no-store' }
        );
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok) throw new Error(data?.error || 'Could not cancel edited-file creation.');
        renderWorkspace(data.workspace);
      } catch (error) {
        cancelEditedRender.disabled = false;
        showRenderFailure(null, error.message || 'Could not cancel edited-file creation.');
      }
    }

    function beginUpload(file) {
      if (!file || upload || activeWorkspaceId) return;
      clearFailure();
      if (file.size > MAX_LOCAL_MEDIA_BYTES) {
        showFailure({
          title: 'This local file is too large',
          explanation: 'LVOVD accepts one local video up to 100 GiB.',
          help: 'Choose a local video no larger than 100 GiB.'
        });
        return;
      }
      if (!file.size) {
        showFailure({
          title: 'The selected file is empty',
          explanation: 'LVOVD cannot stage an empty file as local media.',
          help: 'Choose a non-empty local video file.'
        });
        return;
      }

      chooseButton.disabled = true;
      dropZone.hidden = true;
      storageNote.hidden = false;
      workspaceCancel.textContent = 'Cancel';
      workspaceCancel.hidden = false;
      setStatus('Copying the selected file into LVOVD temporary storage…');
      setProgress(0, `Copying ${file.name} · 0 / ${formatBytes(file.size)}`);

      const xhr = new root.XMLHttpRequest();
      upload = xhr;
      xhr.open('POST', '/api/workspace/local');
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-LVOVD-Filename', encodeURIComponent(file.name || 'Local video'));
      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        const percent = total > 0 ? event.loaded / total * 100 : null;
        setProgress(percent, `Copying ${file.name} · ${formatBytes(event.loaded)} / ${formatBytes(total)}`);
      };
      xhr.onerror = () => {
        upload = null;
        resetWorkspaceUi();
        showFailure(null, 'The local file copy was interrupted.');
      };
      xhr.onabort = () => {
        upload = null;
        resetWorkspaceUi('Local file copy cancelled; partial temporary data was removed.');
      };
      xhr.onload = () => {
        upload = null;
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 200 || xhr.status >= 300) {
          resetWorkspaceUi();
          showFailure(data?.details, data?.error || 'LVOVD could not stage that local file.');
          return;
        }
        activeWorkspaceId = data.workspaceId;
        workspaceCancel.textContent = 'Cancel preparation';
        renderWorkspace(data.workspace);
        if (data.workspace?.status !== 'error') startProgress(activeWorkspaceId);
      };
      xhr.send(file);
    }

    chooseButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => beginUpload(fileInput.files?.[0]));
    dropZone.addEventListener('dragenter', (event) => {
      event.preventDefault();
      if (!upload && !activeWorkspaceId) dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = activeWorkspaceId ? 'none' : 'copy';
    });
    dropZone.addEventListener('dragleave', (event) => {
      if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropZone.classList.remove('dragover');
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length !== 1) {
        showFailure({
          title: 'Choose one local video',
          explanation: 'This editor workspace accepts exactly one local video at a time.',
          help: 'Drop one file, or use Choose File.'
        });
        return;
      }
      beginUpload(files[0]);
    });

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
    for (const handle of [startHandle, endHandle]) {
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
    setStart.addEventListener('click', () => {
      if (!editPlan) return;
      const range = editPlan.keepRanges[0];
      const next = retainedRangeWithPlayhead(range, 'start', video.currentTime);
      const result = commitSelection(next.startSeconds, next.endSeconds);
      setFieldError(startField, startError, result.valid ? '' : result.reason);
    });
    setEnd.addEventListener('click', () => {
      if (!editPlan) return;
      const range = editPlan.keepRanges[0];
      const next = retainedRangeWithPlayhead(range, 'end', video.currentTime);
      const result = commitSelection(next.startSeconds, next.endSeconds);
      setFieldError(endField, endError, result.valid ? '' : result.reason);
    });
    goToStart.addEventListener('click', () => {
      if (!editPlan) return;
      video.currentTime = retainedBoundaryTime(editPlan.keepRanges[0], 'start', durationSeconds);
      renderPlayhead();
    });
    goToEnd.addEventListener('click', () => {
      if (!editPlan) return;
      video.currentTime = retainedBoundaryTime(editPlan.keepRanges[0], 'end', durationSeconds);
      renderPlayhead();
    });
    resetRange.addEventListener('click', () => {
      if (!editPlan) return;
      const range = fullRetainedRange(durationSeconds);
      if (range) commitSelection(range.startSeconds, range.endSeconds);
    });
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
    workspaceCancel.addEventListener('click', discardWorkspace);
    failureDiscard.addEventListener('click', discardWorkspace);
    discard.addEventListener('click', discardWorkspace);
    root.addEventListener('resize', () => {
      if (editPlan) renderRuler();
    });
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
    fullRetainedRange,
    retainedRangeWithPlayhead,
    retainedBoundaryTime,
    editPlansEqual,
    isFullDurationEditPlan,
    init
  };
});
