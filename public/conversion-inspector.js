'use strict';

(function attachConversionInspector(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) api.init(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createConversionInspectorApi() {
  const MAX_LOCAL_MEDIA_BYTES = 100 * 1024 * 1024 * 1024;
  const CODEC_LABELS = Object.freeze({
    h264: 'H.264',
    hevc: 'H.265 / HEVC',
    h265: 'H.265 / HEVC',
    av1: 'AV1',
    vp9: 'VP9',
    aac: 'AAC',
    opus: 'Opus',
    mp3: 'MP3',
    flac: 'FLAC',
    pcm_s16le: 'PCM 16-bit'
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function familiarCodecName(value) {
    const codec = String(value || '').trim().toLowerCase();
    if (!codec) return 'Unknown';
    return CODEC_LABELS[codec] || codec.replace(/_/g, ' ').toUpperCase();
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
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

  function formatDuration(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Unknown';
    const milliseconds = Math.round(seconds * 1000);
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor(milliseconds % 3_600_000 / 60_000);
    const wholeSeconds = Math.floor(milliseconds % 60_000 / 1000);
    const remainder = milliseconds % 1000;
    return [hours, minutes, wholeSeconds]
      .map((part) => String(part).padStart(2, '0')).join(':')
      + `.${String(remainder).padStart(3, '0')}`;
  }

  function mediaKindLabel(value) {
    if (value === 'video') return 'Video';
    if (value === 'audio') return 'Audio';
    return 'Unsupported or unknown';
  }

  function countLabel(value) {
    return Number.isInteger(value) && value >= 0 ? String(value) : 'Unknown';
  }

  function inspectionFacts(snapshot) {
    const inspection = snapshot?.inspection || {};
    const video = inspection.video;
    const audio = inspection.audio;
    const counts = inspection.trackCounts || {};
    const facts = [
      ['Filename', snapshot?.source?.name || 'Local media'],
      ['File size', formatBytes(snapshot?.source?.size ?? inspection.sourceSize)],
      ['Media type', mediaKindLabel(inspection.mediaKind)],
      ['Container', inspection.format || 'Unknown'],
      ['Duration', formatDuration(inspection.durationSeconds)]
    ];
    if (video) {
      facts.push(
        ['Video codec', familiarCodecName(video.codec)],
        ['Video profile', video.profile || 'Unknown'],
        ['Resolution', Number.isFinite(video.width) && Number.isFinite(video.height)
          ? `${video.width} × ${video.height}` : 'Unknown'],
        ['Frame rate', Number.isFinite(video.frameRate) ? `${video.frameRate} fps` : 'Unknown'],
        ['Pixel format', video.pixelFormat || 'Unknown']
      );
    }
    if (audio) {
      facts.push(
        ['Audio codec', familiarCodecName(audio.codec)],
        ['Sample rate', Number.isFinite(audio.sampleRate)
          ? (audio.sampleRate >= 1000
            ? `${audio.sampleRate / 1000} kHz`
            : `${audio.sampleRate} Hz`)
          : 'Unknown'],
        ['Channels', Number.isFinite(audio.channels) ? String(audio.channels) : 'Unknown'],
        ['Channel layout', audio.channelLayout || 'Unknown'],
        ['Audio bitrate', Number.isFinite(audio.bitRate)
          ? `${Math.round(audio.bitRate / 1000)} kbps` : 'Unknown']
      );
    }
    facts.push([
      'Tracks',
      `${countLabel(counts.video)} video · ${countLabel(counts.audio)} audio · ${countLabel(counts.subtitle)} subtitle`
    ]);
    return facts;
  }

  function init(root) {
    const document = root.document;
    const panel = document.querySelector('#conversion-inspector-panel');
    if (!panel) return;
    const dropZone = document.querySelector('#conversion-drop-zone');
    const fileInput = document.querySelector('#conversion-file-input');
    const chooseButton = document.querySelector('#conversion-choose-button');
    const status = document.querySelector('#conversion-status');
    const progress = document.querySelector('#conversion-progress');
    const progressLabel = document.querySelector('#conversion-progress-label');
    const progressBar = document.querySelector('#conversion-progress-bar');
    const cancelButton = document.querySelector('#conversion-cancel');
    const failure = document.querySelector('#conversion-failure');
    const failureTitle = document.querySelector('#conversion-failure-title');
    const failureExplanation = document.querySelector('#conversion-failure-explanation');
    const failureHelp = document.querySelector('#conversion-failure-help');
    const failureDiscard = document.querySelector('#conversion-failure-discard');
    const result = document.querySelector('#conversion-result');
    const mediaName = document.querySelector('#conversion-media-name');
    const facts = document.querySelector('#conversion-facts');
    const assessment = document.querySelector('#conversion-assessment');
    const assessmentTitle = document.querySelector('#conversion-assessment-title');
    const assessmentExplanation = document.querySelector('#conversion-assessment-explanation');
    const assessmentMissing = document.querySelector('#conversion-assessment-missing');
    const discardButton = document.querySelector('#conversion-discard');

    let upload = null;
    let activeWorkspaceId = null;
    let snapshot = null;
    let progressSource = null;

    function setStatus(message, type = '') {
      status.textContent = message || '';
      status.className = `status${type ? ` ${type}` : ''}`;
    }

    function setProgress(percent, label, indeterminate = false) {
      progress.hidden = false;
      progressLabel.textContent = label || '';
      progressBar.classList.toggle('indeterminate', indeterminate);
      progressBar.style.width = Number.isFinite(percent) ? `${clamp(percent, 0, 100)}%` : '36%';
    }

    function closeProgressSource() {
      if (progressSource) progressSource.close();
      progressSource = null;
    }

    function clearFailure() {
      failure.hidden = true;
      failureTitle.textContent = '';
      failureExplanation.textContent = '';
      failureHelp.textContent = '';
      failureDiscard.hidden = true;
    }

    function showFailure(details, fallback = 'Local media inspection failed') {
      failureTitle.textContent = details?.title || fallback;
      failureExplanation.textContent = details?.explanation || '';
      failureHelp.textContent = details?.help || '';
      failureDiscard.hidden = !activeWorkspaceId;
      failure.hidden = false;
      setStatus(failureTitle.textContent, 'error');
    }

    function reset(message = '') {
      closeProgressSource();
      upload = null;
      activeWorkspaceId = null;
      snapshot = null;
      fileInput.value = '';
      chooseButton.disabled = false;
      dropZone.hidden = false;
      dropZone.classList.remove('dragover');
      progress.hidden = true;
      cancelButton.disabled = false;
      failureDiscard.disabled = false;
      discardButton.disabled = false;
      result.hidden = true;
      facts.replaceChildren();
      assessment.hidden = true;
      clearFailure();
      setStatus(message);
    }

    function renderFacts(data) {
      facts.replaceChildren();
      for (const [label, value] of inspectionFacts(data)) {
        const item = document.createElement('div');
        const term = document.createElement('dt');
        const description = document.createElement('dd');
        term.textContent = label;
        description.textContent = value;
        item.append(term, description);
        facts.append(item);
      }
    }

    function renderReady(data) {
      const inspection = data.inspection || {};
      mediaName.textContent = data.source?.name || 'Local media';
      renderFacts(data);
      const compatibility = data.compatibility;
      const showAssessment = inspection.mediaKind === 'video' && compatibility;
      assessment.hidden = !showAssessment;
      if (showAssessment) {
        assessment.dataset.status = compatibility.status || 'unknown';
        assessmentTitle.textContent = compatibility.title || 'Compatibility unknown';
        assessmentExplanation.textContent = compatibility.explanation || '';
        const missing = Array.isArray(compatibility.missing) ? compatibility.missing : [];
        assessmentMissing.textContent = missing.length ? `Missing: ${missing.join(', ')}.` : '';
        assessmentMissing.hidden = !missing.length;
      }
      dropZone.hidden = true;
      chooseButton.disabled = true;
      progress.hidden = true;
      failure.hidden = true;
      result.hidden = false;
      setStatus('Local media inspection ready.', 'success');
    }

    function renderWorkspace(data) {
      if (!data || data.purpose !== 'convert') {
        showFailure(null, 'LVOVD received an unexpected inspection workspace.');
        return;
      }
      snapshot = data;
      activeWorkspaceId = data.id;
      const percent = Number(data.percent);
      if (data.status === 'receiving') {
        setProgress(percent, data.message || 'Copying local media…', !Number.isFinite(percent));
      } else if (data.status === 'inspecting') {
        setProgress(null, 'Inspecting locally with ffprobe and FFmpeg…', true);
      } else if (data.status === 'cancelling') {
        setProgress(null, 'Cancelling and cleaning temporary files…', true);
        cancelButton.disabled = true;
      } else if (data.status === 'error') {
        closeProgressSource();
        progress.hidden = true;
        showFailure(data.failure, data.message);
      } else if (data.status === 'ready') {
        renderReady(data);
      } else {
        setProgress(null, data.message || 'Preparing local inspection…', true);
      }
    }

    function startProgress(workspaceId) {
      closeProgressSource();
      progressSource = new root.EventSource(`/api/workspace/progress?workspace=${encodeURIComponent(workspaceId)}`);
      progressSource.onmessage = (event) => {
        try { renderWorkspace(JSON.parse(event.data)); }
        catch { showFailure(null, 'LVOVD received an unreadable inspection update.'); }
      };
      progressSource.onerror = () => {
        if (!snapshot || !['ready', 'error'].includes(snapshot.status)) {
          setStatus('Inspection progress connection was interrupted.', 'error');
        }
      };
    }

    async function discardWorkspace() {
      if (upload) {
        upload.abort();
        return;
      }
      if (!activeWorkspaceId) {
        reset();
        return;
      }
      const id = activeWorkspaceId;
      const reconnect = Boolean(snapshot && snapshot.status !== 'error');
      closeProgressSource();
      cancelButton.disabled = true;
      failureDiscard.disabled = true;
      discardButton.disabled = true;
      setStatus(snapshot?.status === 'ready'
        ? 'Discarding inspection workspace…'
        : 'Cancelling inspection and cleaning temporary files…');
      try {
        const response = await root.fetch(`/api/workspace?workspace=${encodeURIComponent(id)}`, {
          method: 'DELETE', cache: 'no-store'
        });
        let data = null;
        try { data = await response.json(); } catch {}
        if (response.status === 404) {
          reset('Inspection workspace was already discarded.');
          return;
        }
        if (!response.ok) throw new Error(data?.error || 'Could not discard the inspection workspace.');
        reset('Inspection workspace discarded.');
      } catch (error) {
        cancelButton.disabled = false;
        failureDiscard.disabled = false;
        discardButton.disabled = false;
        if (reconnect) startProgress(id);
        setStatus(error.message || 'Could not discard the inspection workspace.', 'error');
      }
    }

    function beginUpload(file) {
      if (!file || upload || activeWorkspaceId) return;
      clearFailure();
      if (file.size > MAX_LOCAL_MEDIA_BYTES) {
        showFailure({
          title: 'This local file is too large',
          explanation: 'LVOVD accepts one local media file up to 100 GiB.',
          help: 'Choose a local video or audio file no larger than 100 GiB.'
        });
        return;
      }
      if (!file.size) {
        showFailure({
          title: 'The selected file is empty',
          explanation: 'LVOVD cannot inspect an empty local file.',
          help: 'Choose one non-empty local video or audio file.'
        });
        return;
      }

      chooseButton.disabled = true;
      dropZone.hidden = true;
      cancelButton.disabled = false;
      clearFailure();
      setStatus('Copying the selected file into LVOVD temporary storage…');
      setProgress(0, `Copying ${file.name} · 0 / ${formatBytes(file.size)}`);
      const xhr = new root.XMLHttpRequest();
      upload = xhr;
      xhr.open('POST', '/api/conversion/local');
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-LVOVD-Filename', encodeURIComponent(file.name || 'Local media'));
      xhr.upload.onprogress = (event) => {
        const total = event.lengthComputable ? event.total : file.size;
        const percent = total > 0 ? event.loaded / total * 100 : null;
        setProgress(percent, `Copying ${file.name} · ${formatBytes(event.loaded)} / ${formatBytes(total)}`);
      };
      xhr.onerror = () => {
        upload = null;
        reset();
        showFailure(null, 'The local media copy was interrupted.');
      };
      xhr.onabort = () => {
        upload = null;
        reset('Local media copy cancelled; partial temporary data was removed.');
      };
      xhr.onload = () => {
        upload = null;
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 200 || xhr.status >= 300) {
          reset();
          showFailure(data?.details, data?.error || 'LVOVD could not inspect that local file.');
          return;
        }
        activeWorkspaceId = data.workspaceId;
        renderWorkspace(data.workspace);
        if (data.workspace?.status !== 'error') startProgress(activeWorkspaceId);
      };
      xhr.send(file);
    }

    chooseButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => beginUpload(fileInput.files?.[0]));
    cancelButton.addEventListener('click', discardWorkspace);
    failureDiscard.addEventListener('click', discardWorkspace);
    discardButton.addEventListener('click', discardWorkspace);
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
          title: 'Choose one local media file',
          explanation: 'This inspection workspace accepts exactly one local video or audio file at a time.',
          help: 'Drop one file, or use Choose Media File.'
        });
        return;
      }
      beginUpload(files[0]);
    });
  }

  return {
    familiarCodecName,
    formatBytes,
    formatDuration,
    mediaKindLabel,
    inspectionFacts,
    init
  };
});
