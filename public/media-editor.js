'use strict';

(function attachMediaEditor(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) api.init(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMediaEditorApi() {
  const MAX_LOCAL_MEDIA_BYTES = 100 * 1024 * 1024 * 1024;
  const MIN_SELECTION_SECONDS = 0.001;
  const MIN_VISIBLE_SECONDS = 1;

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
    const zoomIn = document.querySelector('#timeline-zoom-in');
    const zoomOut = document.querySelector('#timeline-zoom-out');
    const fit = document.querySelector('#timeline-fit');
    const discard = document.querySelector('#workspace-discard');

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

    function closeProgressSource() {
      if (progressSource) progressSource.close();
      progressSource = null;
    }

    function resetEditor() {
      if (animationFrame != null) root.cancelAnimationFrame(animationFrame);
      animationFrame = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
      editor.hidden = true;
      durationSeconds = 0;
      editPlan = null;
      workspaceSnapshot = null;
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
      dropZone.classList.remove('disabled', 'dragover');
      workspaceProgress.hidden = true;
      workspaceCancel.hidden = true;
      workspaceCancel.disabled = false;
      failureDiscard.disabled = false;
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
      const span = visibleWindow.endSeconds - visibleWindow.startSeconds;
      for (let index = 0; index <= 8; index += 1) {
        const time = visibleWindow.startSeconds + span * index / 8;
        const tick = document.createElement('span');
        tick.className = 'timeline-tick';
        tick.style.left = `${index / 8 * 100}%`;
        tick.textContent = formatTimecode(time).replace(/^00:/, '');
        rulerTicks.appendChild(tick);
      }
      visibleLabel.textContent = `${formatTimecode(visibleWindow.startSeconds)} — ${formatTimecode(visibleWindow.endSeconds)}`;
    }

    function renderPlayhead() {
      const current = clamp(Number(video.currentTime) || 0, 0, durationSeconds || 0);
      playhead.style.left = `${timeToPercent(current, visibleWindow)}%`;
      playhead.hidden = current < visibleWindow.startSeconds || current > visibleWindow.endSeconds;
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
        initializeEditor(data);
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
      video.src = data.playback.url;
      editor.hidden = false;
      chooseButton.disabled = true;
      dropZone.classList.add('disabled');
      setStatus('Local editor ready.', 'success');
      clearFailure();
      renderTimeline();
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
      workspaceCancel.disabled = true;
      failureDiscard.disabled = true;
      setStatus(workspaceSnapshot?.status === 'ready'
        ? 'Discarding local workspace…'
        : 'Cancelling local preparation and cleaning temporary files…');
      try {
        const response = await root.fetch(`/api/workspace?workspace=${encodeURIComponent(id)}`, {
          method: 'DELETE',
          cache: 'no-store'
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not discard the local workspace.');
        resetWorkspaceUi('Local media workspace discarded.');
      } catch (error) {
        workspaceCancel.disabled = false;
        failureDiscard.disabled = false;
        setStatus(error.message || 'Could not discard the local workspace.', 'error');
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
      dropZone.classList.add('disabled');
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
      track.setPointerCapture(event.pointerId);
      seekPointer = event.pointerId;
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
      }
      endHandleDrag(event);
    });
    track.addEventListener('pointercancel', (event) => {
      seekPointer = null;
      endHandleDrag(event);
    });
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
      const result = commitSelection(video.currentTime, range.endSeconds);
      setFieldError(startField, startError, result.valid ? '' : result.reason);
    });
    setEnd.addEventListener('click', () => {
      if (!editPlan) return;
      const range = editPlan.keepRanges[0];
      const result = commitSelection(range.startSeconds, video.currentTime);
      setFieldError(endField, endError, result.valid ? '' : result.reason);
    });
    zoomIn.addEventListener('click', () => zoom(0.5));
    zoomOut.addEventListener('click', () => zoom(2));
    fit.addEventListener('click', () => {
      visibleWindow = { startSeconds: 0, endSeconds: durationSeconds };
      renderTimeline();
    });
    video.addEventListener('play', beginPlaybackFrames);
    video.addEventListener('timeupdate', renderPlayhead);
    video.addEventListener('seeked', renderPlayhead);
    video.addEventListener('loadedmetadata', renderPlayhead);
    workspaceCancel.addEventListener('click', discardWorkspace);
    failureDiscard.addEventListener('click', discardWorkspace);
    discard.addEventListener('click', discardWorkspace);
  }

  return {
    parseTimecode,
    formatTimecode,
    validateSelection,
    clampVisibleWindow,
    zoomVisibleWindow,
    panVisibleWindow,
    timeToPercent,
    init
  };
});
