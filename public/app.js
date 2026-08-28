const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const form = $('#lookup-form');
const urlInput = $('#video-url');
const previewButton = $('#preview-button');
const preview = $('#preview');
const thumbnail = $('#thumbnail');
const duration = $('#duration');
const channel = $('#channel');
const title = $('#title');
const metaRow = $('#meta-row');
const status = $('#status');
const previewError = $('#preview-error');
const previewErrorTitle = $('#preview-error-title');
const previewErrorMessage = $('#preview-error-message');
const previewErrorHint = $('#preview-error-hint');
const sourceName = $('#source-name');
const sourceDetail = $('#source-detail');
const sourceMode = $('#source-mode');
const capabilityList = $('#capability-list');
const capabilityNote = $('#capability-note');
const playlistPanel = $('#playlist-panel');
const playlistSummary = $('#playlist-summary');
const playlistList = $('#playlist-list');
const playlistAll = $('#playlist-all');
const playlistNone = $('#playlist-none');
const videoOptions = $('#video-options');
const audioOptions = $('#audio-options');
const resolutionSelect = $('#resolution-select');
const audioFormat = $('#audio-format');
const compatibleSummary = $('#compatible-summary');
const maximumSummary = $('#maximum-summary');
const rangeDetails = $('#range-details');
const customRangeOption = $('#custom-range-option');
const chapterRangeOption = $('#chapter-range-option');
const customRangeFields = $('#custom-range-fields');
const rangeStart = $('#range-start');
const rangeEnd = $('#range-end');
const chapterList = $('#chapter-list');
const rangeHelp = $('#range-help');
const extraThumbnail = $('#extra-thumbnail');
const extraMetadata = $('#extra-metadata');
const extraSubtitles = $('#extra-subtitles');
const subtitleOptions = $('#subtitle-options');
const subtitleMode = $('#subtitle-mode');
const subtitleLanguage = $('#subtitle-language');
const subtitleLanguageList = $('#subtitle-language-list');
const subtitleAvailability = $('#subtitle-availability');
const extrasDetails = $('#extras-details');
const sponsorDetails = $('#sponsor-details');
const sponsorMode = $('#sponsor-mode');
const sponsorCategories = $('#sponsor-categories');
const downloadButton = $('#download-button');
const progressPanel = $('#download-progress');
const progressStage = $('#progress-stage');
const progressItem = $('#progress-item');
const progressPercent = $('#progress-percent');
const progressBar = $('#progress-bar');
const progressStream = $('#progress-stream');
const progressDetails = $('#progress-details');
const stageDownload = $('#stage-download');
const stageProcess = $('#stage-process');
const stageReady = $('#stage-ready');
const outputList = $('#output-list');
const clearJobButton = $('#clear-job');
const recheck = $('#recheck');
const nodeCheck = $('#node-check');
const ytCheck = $('#yt-check');
const ffmpegCheck = $('#ffmpeg-check');

let currentUrl = '';
let currentInfo = null;
let progressSource = null;
let activeJobId = null;
let autoDownloadStarted = false;
const trackedJobs = new Map();
const queueSources = new Map();
const autoDownloadedQueueJobs = new Set();
const historyNotifiedJobs = new Set();
const TERMINAL_JOB_STATUSES = new Set(['ready', 'error', 'cancelled']);
let queuePanel = null;
let queueList = null;
let queueSummary = null;

function setStatus(message, kind = '') {
  status.textContent = message || '';
  status.className = `status${kind ? ` ${kind}` : ''}`;
}

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.round(seconds);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function ensureQueuePanel() {
  if (queuePanel) return;
  queuePanel = document.createElement('section');
  queuePanel.className = 'download-progress';
  queuePanel.hidden = true;

  const head = document.createElement('div');
  head.className = 'progress-head';
  const heading = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = 'Download queue';
  const help = document.createElement('span');
  help.className = 'progress-item';
  help.textContent = 'Remote downloads run one at a time. Prepared items stay here while their temporary file is available.';
  heading.append(strong, help);
  queueSummary = document.createElement('span');
  head.append(heading, queueSummary);

  queueList = document.createElement('div');
  queueList.className = 'output-list';
  queueList.hidden = false;
  queuePanel.append(head, queueList);
  preview.insertAdjacentElement('afterend', queuePanel);
}

function queueStateLabel(data = {}) {
  if (data.phase === 'cancelling') return 'Cancelling';
  if (data.status === 'cancelled') return 'Cancelled';
  if (data.status === 'ready') return 'Prepared';
  if (data.status === 'error') return 'Failed';
  if (data.status === 'running') {
    if (data.phase === 'waiting') return 'Waiting';
    if (data.phase === 'processing') return 'Processing';
    return 'Downloading';
  }
  return 'Queued';
}

function queueModeSummary(job = {}) {
  const options = job.options || {};
  const bits = [];
  const contentLabels = {
    av: 'Video + Audio',
    video: 'Video Only',
    audio: 'Audio Only',
    extras: 'Extras Only'
  };
  const profileLabels = {
    compatible: 'Compatible MP4',
    maximum: 'Maximum Quality'
  };
  const audioLabels = {
    source: 'Source Audio',
    m4a: 'M4A / AAC',
    mp3: 'MP3',
    opus: 'Opus',
    flac: 'FLAC',
    wav: 'WAV'
  };

  bits.push(contentLabels[options.content] || 'Media');
  if (['av', 'video'].includes(options.content)) {
    bits.push(profileLabels[options.profile] || options.profile || 'Video');
    bits.push(options.maxHeight ? `${options.maxHeight}p` : 'Best available');
  } else if (options.content === 'audio') {
    bits.push(audioLabels[options.audioFormat] || options.audioFormat || 'Audio');
  } else if (options.content === 'extras') {
    const extras = [];
    if (options.extras?.thumbnail) extras.push('Thumbnail');
    if (options.extras?.metadata) extras.push('Metadata');
    if (options.extras?.subtitles) extras.push('Subtitles');
    if (extras.length) bits.push(extras.join(' + '));
  }

  if (job.isPlaylist) {
    bits.push(`${job.selectionCount || 0} selected item${job.selectionCount === 1 ? '' : 's'}`);
  } else if (options.content !== 'extras' && options.range?.type === 'custom') {
    bits.push(`${options.range.start || '?'}–${options.range.end || '?'}`);
  } else if (options.content !== 'extras' && options.range?.type === 'chapters') {
    const count = options.range.chapterIndexes?.length || 0;
    bits.push(`${count} chapter${count === 1 ? '' : 's'}`);
  }
  return bits.filter(Boolean).join(' · ');
}

function notifyHistoryTerminal(jobId, statusValue) {
  if (!jobId || !TERMINAL_JOB_STATUSES.has(statusValue) || historyNotifiedJobs.has(jobId)) return;
  historyNotifiedJobs.add(jobId);
  document.dispatchEvent(new CustomEvent('lvovd:terminal-job', {
    detail: { jobId, status: statusValue }
  }));
}

function retireHistoryBackedQueueJob(jobId, statusValue) {
  if (!['error', 'cancelled'].includes(statusValue)) return;
  const job = trackedJobs.get(jobId);
  if (!job || job.data?.status !== statusValue) return;
  closeQueueSource(jobId);
  trackedJobs.delete(jobId);
  renderQueue();
}

function triggerAutoDownload(jobId, url) {
  if (!jobId || !url || autoDownloadedQueueJobs.has(jobId)) return;
  autoDownloadedQueueJobs.add(jobId);
  if (jobId === activeJobId) autoDownloadStarted = true;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function queueDetails(data = {}) {
  const details = [];
  if (Number.isFinite(data.percent)) details.push(`${data.percent.toFixed(data.percent >= 10 ? 0 : 1)}%`);
  if (Number.isFinite(data.downloadedBytes)) {
    details.push(data.totalBytes
      ? `${formatBytes(data.downloadedBytes)} / ${formatBytes(data.totalBytes)}`
      : formatBytes(data.downloadedBytes));
  }
  if (Number.isFinite(data.speed)) details.push(formatSpeed(data.speed));
  if (Number.isFinite(data.eta) && data.eta > 0) details.push(`ETA ${formatEta(data.eta)}`);
  return details.join(' · ');
}

function closeQueueSource(jobId) {
  const source = queueSources.get(jobId);
  if (source) source.close();
  queueSources.delete(jobId);
}

async function deleteServerJob(jobId) {
  const response = await fetch(`/api/download/job?id=${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  let data = {};
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) throw new Error(data.error || 'LVOVD could not update that download job.');
  return data;
}

async function manageQueueJob(jobId) {
  const job = trackedJobs.get(jobId);
  if (!job) return;
  const previousStatus = job.data?.status || 'queued';

  let data;
  try {
    data = await deleteServerJob(jobId);
  } catch (error) {
    setStatus(error.message || 'Could not contact LVOVD to update that queue item.', 'error');
    return;
  }

  if (data.job) job.data = data.job || job.data;

  if (data.action === 'cancelling') {
    setStatus('Cancelling download…');
    if (activeJobId === jobId && data.job) renderProgress(data.job);
    renderQueue();
    return;
  }

  if (data.action === 'cancelled') {
    if (data.job?.status === 'cancelled') notifyHistoryTerminal(jobId, 'cancelled');
    if (previousStatus === 'queued') {
      closeQueueSource(jobId);
      trackedJobs.delete(jobId);
      if (activeJobId === jobId) resetProgress();
      setStatus('Queued download removed.', 'success');
    } else {
      setStatus('Download cancelled.', 'success');
      if (activeJobId === jobId && data.job) renderProgress(data.job);
    }
    renderQueue();
    return;
  }

  if (data.action === 'cleared') {
    closeQueueSource(jobId);
    trackedJobs.delete(jobId);
    if (activeJobId === jobId) resetProgress();
    setStatus(previousStatus === 'cancelled' ? 'Cancelled item dismissed.' : 'Queue item cleared.', 'success');
    renderQueue();
    return;
  }

  setStatus('LVOVD returned an unexpected job update.', 'error');
}

function renderQueue() {
  ensureQueuePanel();
  queuePanel.hidden = trackedJobs.size === 0;
  queueList.replaceChildren();
  if (!trackedJobs.size) {
    queueSummary.textContent = '';
    return;
  }

  const jobs = [...trackedJobs.values()];
  const activeCount = jobs.filter((job) => job.data?.status === 'running').length;
  const queuedCount = jobs.filter((job) => !job.data?.status || job.data.status === 'queued').length;
  const preparedCount = jobs.filter((job) => job.data?.status === 'ready').length;
  queueSummary.textContent = [
    activeCount ? `${activeCount} active` : '',
    queuedCount ? `${queuedCount} queued` : '',
    preparedCount ? `${preparedCount} prepared` : ''
  ].filter(Boolean).join(' · ') || `${jobs.length} item${jobs.length === 1 ? '' : 's'}`;

  for (const job of jobs) {
    const data = job.data || {};
    const row = document.createElement('div');
    row.className = `output-row queue-row${data.status === 'ready' ? ' prepared' : ''}`;

    const main = document.createElement('div');
    main.className = 'queue-entry-main';
    if (job.thumbnailUrl) {
      const image = document.createElement('img');
      image.className = 'queue-thumbnail';
      image.src = job.thumbnailUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => image.remove(), { once: true });
      main.appendChild(image);
    }

    const copy = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = job.title || 'Media download';
    const small = document.createElement('small');
    const state = queueStateLabel(data);
    const message = data.error || data.message || state;
    const details = queueDetails(data);
    const mode = queueModeSummary(job);
    small.textContent = [
      mode,
      state,
      message && message !== state ? message : '',
      details
    ].filter(Boolean).join(' · ');
    copy.append(strong, small);

    if (Number.isFinite(data.percent) || ['starting', 'processing'].includes(data.phase)) {
      const track = document.createElement('div');
      track.className = 'progress-track';
      const bar = document.createElement('div');
      bar.className = `progress-bar${!Number.isFinite(data.percent) ? ' indeterminate' : ''}`;
      bar.style.width = Number.isFinite(data.percent) ? `${Math.max(0, Math.min(100, data.percent))}%` : '36%';
      track.appendChild(bar);
      copy.appendChild(track);
    }
    main.appendChild(copy);

    const actions = document.createElement('div');
    actions.className = 'inline-actions';
    for (const output of data.outputs || []) {
      const link = document.createElement('a');
      link.className = 'button secondary mini';
      link.href = output.downloadUrl;
      link.textContent = output.kind === 'media' ? 'Download' : output.label || 'File';
      actions.appendChild(link);
    }

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'button secondary mini';
    action.textContent = data.phase === 'cancelling'
      ? 'Cancelling…'
      : data.status === 'running'
        ? 'Cancel'
        : data.status === 'queued' || !data.status
          ? 'Remove'
          : data.status === 'cancelled'
            ? 'Dismiss'
            : 'Clear';
    action.disabled = data.phase === 'cancelling';
    action.addEventListener('click', () => manageQueueJob(job.id));
    actions.appendChild(action);

    row.append(main, actions);
    queueList.appendChild(row);
  }
}

function trackQueueJob(jobId, snapshot) {
  const job = {
    id: jobId,
    ...snapshot,
    data: {
      id: jobId,
      status: 'queued',
      phase: 'queued',
      message: 'Queued…',
      outputs: []
    }
  };
  trackedJobs.set(jobId, job);
  renderQueue();

  const source = new EventSource(`/api/download/progress?id=${encodeURIComponent(jobId)}`);
  queueSources.set(jobId, source);
  source.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      job.data = data;
      renderQueue();
      if (data.autoDownloadUrl) triggerAutoDownload(jobId, data.autoDownloadUrl);
      if (TERMINAL_JOB_STATUSES.has(data.status)) {
        notifyHistoryTerminal(jobId, data.status);
        closeQueueSource(jobId);
      }
    } catch {
      setStatus('Received an unreadable queue update.', 'error');
    }
  };
  source.onerror = () => {
    if (!TERMINAL_JOB_STATUSES.has(job.data?.status)) {
      job.connectionIssue = true;
      renderQueue();
    }
  };
}

function setCheck(element, label, result) {
  element.className = `check ${result?.installed ? 'good' : 'bad'}`;
  element.textContent = result?.installed
    ? `${label}: ${result.version || 'ready'}`
    : `${label}: ${result?.error || 'not available'}`;
}

async function checkHealth() {
  [nodeCheck, ytCheck, ffmpegCheck].forEach((element) => {
    element.className = 'check pending';
  });
  nodeCheck.textContent = 'Node: checking…';
  ytCheck.textContent = 'yt-dlp (project): checking…';
  ffmpegCheck.textContent = 'FFmpeg: checking…';
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const data = await response.json();
    setCheck(nodeCheck, 'Node', data.node);
    setCheck(ytCheck, 'yt-dlp (project)', data.ytdlp);
    setCheck(ffmpegCheck, 'FFmpeg', data.ffmpeg);
  } catch (error) {
    [nodeCheck, ytCheck, ffmpegCheck].forEach((element) => {
      element.className = 'check bad';
      element.textContent = 'Runtime check failed';
    });
  }
}

function setChoiceClasses(name) {
  $$(`input[name="${name}"]`).forEach((input) => {
    input.closest('.choice-card')?.classList.toggle('selected', input.checked);
  });
}

function setStage(element, state) {
  element.className = `stage${state ? ` ${state}` : ''}`;
}

function resetProgress() {
  if (progressSource) progressSource.close();
  progressSource = null;
  activeJobId = null;
  autoDownloadStarted = false;
  progressPanel.hidden = true;
  progressStage.textContent = 'Preparing…';
  progressItem.textContent = '';
  progressPercent.textContent = '';
  progressBar.className = 'progress-bar';
  progressBar.style.width = '0%';
  progressStream.textContent = '';
  progressDetails.textContent = '';
  outputList.hidden = true;
  outputList.replaceChildren();
  clearJobButton.hidden = true;
  setStage(stageDownload, '');
  setStage(stageProcess, '');
  setStage(stageReady, '');
}

function renderMeta(info) {
  metaRow.replaceChildren();
  const pills = [];
  if (info.kind === 'playlist') {
    pills.push(`${info.entryCount || info.entries.length} item${(info.entryCount || info.entries.length) === 1 ? '' : 's'}`);
    if (info.limited) pills.push(`Previewing first ${info.entries.length}`);
  } else {
    if (info.heights?.length) pills.push(`Up to ${info.heights[0]}p`);
    if (info.maxFps) pills.push(`Up to ${info.maxFps} fps`);
    if (info.chapters?.length) pills.push(`${info.chapters.length} chapters`);
    if (info.subtitles?.length) pills.push(`${info.subtitles.length} subtitle languages`);
    if (info.liveStatus === 'is_live') pills.push('Live');
  }
  for (const value of pills) {
    const span = document.createElement('span');
    span.className = 'pill';
    span.textContent = value;
    metaRow.appendChild(span);
  }
}

function renderPlaylist(info) {
  playlistPanel.hidden = info.kind !== 'playlist';
  playlistList.replaceChildren();
  if (info.kind !== 'playlist') return;
  const selectable = info.entries.filter((entry) => entry.url).length;
  playlistSummary.textContent = `${selectable} selectable item${selectable === 1 ? '' : 's'} in this preview. Capabilities can vary by item.`;
  info.entries.forEach((entry, index) => {
    const label = document.createElement('label');
    label.className = 'playlist-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = entry.url || '';
    checkbox.checked = Boolean(entry.url);
    checkbox.disabled = !entry.url;
    checkbox.dataset.playlistEntry = '1';
    const number = document.createElement('span');
    number.className = 'playlist-number';
    number.textContent = String(index + 1);
    const copy = document.createElement('span');
    copy.className = 'playlist-copy';
    const strong = document.createElement('strong');
    strong.textContent = entry.title;
    const small = document.createElement('small');
    const details = [entry.channel, entry.durationString || formatDuration(entry.duration)].filter(Boolean);
    if (!entry.url) details.push('No direct item URL exposed by extractor');
    small.textContent = details.join(' · ');
    copy.append(strong, small);
    label.append(checkbox, number, copy);
    playlistList.appendChild(label);
  });
}

function currentCapabilities() {
  return currentInfo?.capabilities || null;
}

function availabilityState(value) {
  return value === null || value === undefined ? 'unknown' : value ? 'yes' : 'no';
}

function addCapability(label, value) {
  const chip = document.createElement('span');
  chip.className = `capability ${availabilityState(value)}`;
  const marker = value === null || value === undefined ? '?' : value ? '✓' : '–';
  chip.textContent = `${marker} ${label}`;
  capabilityList.appendChild(chip);
}

function renderCapabilities(info) {
  const caps = info.capabilities || {};
  const source = info.source || caps.source || {};
  sourceName.textContent = source.name || source.hostname || 'Detected source';
  sourceDetail.textContent = [source.hostname, source.extractorKey || source.extractor].filter(Boolean).join(' · ');
  sourceMode.textContent = source.generic ? 'Generic extractor' : 'Dedicated extractor';
  capabilityList.replaceChildren();

  const media = caps.media || {};
  if (info.kind === 'playlist' && media.known === false) {
    addCapability('Video availability varies', null);
    addCapability('Audio availability varies', null);
  } else {
    addCapability('Video', media.video);
    addCapability('Audio', media.audio);
    addCapability('Video-only stream', media.videoOnly);
    addCapability('Audio-only stream', media.audioOnly);
    addCapability('H.264', Boolean(media.h264Heights?.length));
    addCapability('AAC', media.nativeAac);
  }
  addCapability('Thumbnail', caps.extras?.thumbnail);
  addCapability('Subtitles', caps.extras?.subtitles);
  addCapability('Chapters', caps.extras?.chapters);
  addCapability('Metadata', caps.extras?.metadata);
  if (caps.extras?.sponsorBlock) addCapability('SponsorBlock', true);
  capabilityNote.textContent = caps.note || (caps.live?.isLive
    ? 'This is a live source. Some range/chapter controls are intentionally disabled.'
    : 'LVOVD built the controls below from the capabilities yt-dlp reported for this URL.');
}

function setChoiceAvailability(name, value, available) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (!input) return;
  const isAvailable = available !== false;
  input.disabled = !isAvailable;
  input.closest('.choice-card')?.classList.toggle('unavailable', !isAvailable);
}

function setCheckboxAvailability(input, available) {
  input.disabled = !available;
  input.closest('.check-option')?.classList.toggle('unavailable', !available);
  if (!available) input.checked = false;
}

function chooseFirstAvailableContent() {
  const checked = document.querySelector('input[name="content"]:checked');
  if (checked && !checked.disabled) return;
  const first = $$('input[name="content"]').find((input) => !input.disabled);
  if (first) first.checked = true;
  setChoiceClasses('content');
}

function resolutionOptions(info, profile) {
  const caps = info?.capabilities?.media;
  const content = selectedValue('content') || 'av';
  if (info?.kind === 'media' && caps) {
    if (content === 'video') {
      const source = profile === 'compatible' ? caps.h264VideoOnlyHeights : caps.videoOnlyHeights;
      return source?.length ? source : [];
    }
    const source = profile === 'compatible' ? caps.h264Heights : caps.heights;
    return source?.length ? source : [];
  }
  return [2160, 1440, 1080, 720, 480, 360];
}

function updateResolutionSelect() {
  const profile = selectedValue('profile') || 'maximum';
  const previous = resolutionSelect.value;
  const heights = resolutionOptions(currentInfo, profile);
  resolutionSelect.replaceChildren();
  const best = document.createElement('option');
  best.value = '';
  best.textContent = profile === 'compatible' ? 'Best compatible resolution' : 'Best available resolution';
  resolutionSelect.appendChild(best);
  for (const height of heights) {
    const option = document.createElement('option');
    option.value = String(height);
    option.textContent = `Up to ${height}p`;
    resolutionSelect.appendChild(option);
  }
  resolutionSelect.disabled = currentInfo?.kind === 'media' && !heights.length;
  if ([...resolutionSelect.options].some((option) => option.value === previous)) resolutionSelect.value = previous;
}

function renderChapters(info) {
  chapterList.replaceChildren();
  const chapters = info?.kind === 'media' ? info.chapters || [] : [];
  if (!chapters.length) return;
  for (const chapter of chapters) {
    const label = document.createElement('label');
    label.className = 'chapter-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(chapter.index);
    checkbox.dataset.chapterIndex = '1';
    const copy = document.createElement('span');
    copy.textContent = `${chapter.title} · ${formatDuration(chapter.start)}–${formatDuration(chapter.end)}`;
    label.append(checkbox, copy);
    chapterList.appendChild(label);
  }
}

function renderSubtitleLanguages(info) {
  subtitleLanguageList.replaceChildren();
  const tracks = info?.kind === 'media' ? info.subtitles || [] : [];
  for (const track of tracks) {
    const option = document.createElement('option');
    option.value = track.code;
    option.label = `${track.name || track.code}${track.manual && track.auto ? ' (manual + auto)' : track.manual ? ' (manual)' : ' (auto)'}`;
    subtitleLanguageList.appendChild(option);
  }
  subtitleAvailability.textContent = tracks.length
    ? `Available here: ${tracks.slice(0, 12).map((track) => track.code).join(', ')}${tracks.length > 12 ? '…' : ''}`
    : currentInfo?.kind === 'playlist'
      ? 'Subtitle availability varies by playlist item. Language code defaults to en.'
      : 'No subtitle tracks were reported by this extractor.';
}

function applyCapabilities() {
  const caps = currentCapabilities();
  if (!caps) return;
  const isPlaylist = currentInfo?.kind === 'playlist';
  const media = caps.media || {};
  const extras = caps.extras || {};

  setChoiceAvailability('content', 'av', isPlaylist || (media.video && media.audio));
  setChoiceAvailability('content', 'video', isPlaylist || media.videoOnly);
  setChoiceAvailability('content', 'audio', isPlaylist || media.audioOnly);
  setChoiceAvailability('content', 'extras', true);
  chooseFirstAvailableContent();

  setCheckboxAvailability(extraThumbnail, isPlaylist ? extras.thumbnail !== false : Boolean(extras.thumbnail));
  setCheckboxAvailability(extraMetadata, extras.metadata !== false);
  setCheckboxAvailability(extraSubtitles, isPlaylist ? extras.subtitles !== false : Boolean(extras.subtitles));

  customRangeOption.hidden = isPlaylist || !caps.range?.custom;
  chapterRangeOption.hidden = isPlaylist || !caps.range?.chapters;
  if ((selectedValue('range') === 'custom' && customRangeOption.hidden) ||
      (selectedValue('range') === 'chapters' && chapterRangeOption.hidden)) {
    document.querySelector('input[name="range"][value="full"]').checked = true;
  }

  sponsorDetails.hidden = !extras.sponsorBlock;
  if (!extras.sponsorBlock) sponsorMode.value = 'off';
}

function updateProfileAvailability() {
  const caps = currentCapabilities();
  if (!caps) return;
  const content = selectedValue('content') || 'av';
  const isPlaylist = currentInfo?.kind === 'playlist';
  const compatible = isPlaylist
    ? true
    : content === 'video'
      ? Boolean(caps.media?.compatibleVideo)
      : content === 'av'
        ? Boolean(caps.media?.compatibleAv)
        : true;
  setChoiceAvailability('profile', 'compatible', compatible);
  setChoiceAvailability('profile', 'maximum', true);
  const selected = document.querySelector('input[name="profile"]:checked');
  if (selected?.disabled) {
    document.querySelector('input[name="profile"][value="maximum"]').checked = true;
    setChoiceClasses('profile');
  }
}

function renderInfo(info) {
  currentInfo = info;
  previewError.hidden = true;
  thumbnail.src = info.thumbnail || '';
  thumbnail.hidden = !info.thumbnail;
  duration.hidden = info.kind !== 'media' || !info.durationString;
  duration.textContent = info.durationString || '';
  channel.textContent = info.channel || (info.kind === 'playlist' ? 'Media collection' : 'Source media');
  title.textContent = info.title || (info.kind === 'playlist' ? 'Media collection' : 'Untitled media');
  renderMeta(info);
  renderCapabilities(info);
  renderPlaylist(info);
  renderChapters(info);
  renderSubtitleLanguages(info);
  applyCapabilities();

  const caps = info.capabilities?.media || {};
  if (info.kind === 'media') {
    compatibleSummary.textContent = caps.compatibleAv
      ? `Native H.264 up to ${caps.h264Heights[0]}p + AAC`
      : caps.compatibleVideo
        ? `H.264 video up to ${caps.h264Heights[0]}p; compatible audio pair not reported`
        : 'Native H.264 was not reported for this source';
    maximumSummary.textContent = caps.heights?.length ? `Source quality up to ${caps.heights[0]}p` : 'Highest source quality reported';
  } else {
    compatibleSummary.textContent = 'H.264 + AAC where each selected item offers it';
    maximumSummary.textContent = 'Highest source quality for each selected item';
  }

  updateProfileAvailability();
  updateResolutionSelect();
  updateOptionVisibility();
  preview.hidden = false;
}

function renderPreviewError(details, fallback) {
  previewErrorTitle.textContent = details?.title || 'Could not preview this URL';
  previewErrorMessage.textContent = details?.message || fallback || 'yt-dlp could not inspect this URL.';
  previewErrorHint.textContent = details?.hint || '';
  previewError.hidden = false;
}

function updateRangeVisibility() {
  const range = selectedValue('range') || 'full';
  customRangeFields.hidden = range !== 'custom';
  chapterList.hidden = range !== 'chapters';
}

function updateDownloadLabel() {
  const content = selectedValue('content') || 'av';
  const labels = {
    av: 'Download video + audio',
    video: 'Download video only',
    audio: 'Download audio only',
    extras: 'Download selected extras'
  };
  if (currentInfo?.kind === 'playlist') {
    const count = $$('[data-playlist-entry]:checked').length;
    downloadButton.textContent = count ? `${labels[content]} (${count})` : labels[content];
  } else {
    downloadButton.textContent = labels[content];
  }
}

function updateOptionVisibility() {
  const content = selectedValue('content') || 'av';
  const isPlaylist = currentInfo?.kind === 'playlist';
  videoOptions.hidden = !['av', 'video'].includes(content);
  audioOptions.hidden = content !== 'audio';
  rangeDetails.hidden = content === 'extras';
  if (content !== 'extras') sponsorDetails.hidden = !currentCapabilities()?.extras?.sponsorBlock;
  else sponsorDetails.hidden = true;
  extrasDetails.hidden = false;

  if (isPlaylist && selectedValue('range') !== 'full') {
    document.querySelector('input[name="range"][value="full"]').checked = true;
  }
  subtitleOptions.hidden = !extraSubtitles.checked || extraSubtitles.disabled;
  sponsorCategories.classList.toggle('disabled', sponsorMode.value === 'off');
  updateProfileAvailability();
  updateResolutionSelect();
  updateRangeVisibility();
  updateDownloadLabel();
}

function setControlsDisabled(disabled) {
  downloadButton.disabled = disabled;
}

function renderOutputs(outputs) {
  outputList.replaceChildren();
  outputList.hidden = !outputs?.length;
  if (!outputs?.length) return;
  for (const output of outputs) {
    const row = document.createElement('div');
    row.className = 'output-row';
    const copy = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = output.label || output.filename;
    const small = document.createElement('small');
    small.textContent = `${output.filename} · ${formatBytes(output.size)}`;
    copy.append(strong, small);
    const link = document.createElement('a');
    link.className = 'button secondary mini';
    link.href = output.downloadUrl;
    link.textContent = 'Download';
    row.append(copy, link);
    outputList.appendChild(row);
  }
}

function renderProgress(data) {
  progressPanel.hidden = false;
  progressStage.textContent = data.message || 'Working…';
  progressItem.textContent = data.itemCount > 1
    ? `Item ${data.itemIndex || 1} of ${data.itemCount}${data.itemLabel ? ` — ${data.itemLabel}` : ''}`
    : (data.itemLabel && !/^Video$/.test(data.itemLabel) ? data.itemLabel : '');

  const hasPercent = Number.isFinite(data.percent);
  progressPercent.textContent = hasPercent ? `${data.percent.toFixed(data.percent >= 10 ? 0 : 1)}%` : '';
  progressBar.classList.toggle('indeterminate', !hasPercent && ['starting', 'processing'].includes(data.phase));
  progressBar.style.width = hasPercent ? `${Math.max(0, Math.min(100, data.percent))}%` : (data.phase === 'ready' ? '100%' : '36%');
  progressStream.textContent = data.streamLabel || '';

  const details = [];
  if (Number.isFinite(data.downloadedBytes)) {
    details.push(data.totalBytes ? `${formatBytes(data.downloadedBytes)} / ${formatBytes(data.totalBytes)}` : formatBytes(data.downloadedBytes));
  }
  if (Number.isFinite(data.speed)) details.push(formatSpeed(data.speed));
  if (Number.isFinite(data.eta) && data.eta > 0) details.push(`ETA ${formatEta(data.eta)}`);
  progressDetails.textContent = details.join(' · ');

  if (['queued', 'starting', 'downloading'].includes(data.phase)) {
    setStage(stageDownload, 'active');
    setStage(stageProcess, '');
    setStage(stageReady, '');
  } else if (data.phase === 'processing') {
    setStage(stageDownload, 'done');
    setStage(stageProcess, 'active');
    setStage(stageReady, '');
  } else if (data.phase === 'ready') {
    setStage(stageDownload, 'done');
    setStage(stageProcess, 'done');
    setStage(stageReady, 'done');
  }

  if (data.phase === 'cancelling') {
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = '0%';
  }

  if (data.status === 'cancelled') {
    setStatus('Download cancelled.', 'success');
    progressStage.textContent = data.message || 'Cancelled by you.';
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = '0%';
    renderOutputs([]);
    clearJobButton.hidden = true;
    setControlsDisabled(false);
    if (progressSource) progressSource.close();
    return;
  }

  if (data.status === 'error') {
    setStatus(data.error || 'Download failed.', 'error');
    progressStage.textContent = data.error || 'Download failed.';
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = '0%';
    setControlsDisabled(false);
    if (progressSource) progressSource.close();
    return;
  }

  if (data.status === 'ready') {
    renderOutputs(data.outputs || []);
    clearJobButton.hidden = false;
    setStatus(data.outputs?.length === 1 ? 'Ready.' : `${data.outputs?.length || 0} files are ready.`, 'success');
    setControlsDisabled(false);
    if (data.autoDownloadUrl) triggerAutoDownload(activeJobId, data.autoDownloadUrl);
    if (progressSource) progressSource.close();
  }
}

function selectedPlaylistUrls() {
  if (currentInfo?.kind !== 'playlist') return [];
  return $$('[data-playlist-entry]:checked').map((checkbox) => checkbox.value).filter(Boolean);
}

function buildRequestOptions() {
  const content = selectedValue('content') || 'av';
  const rangeType = selectedValue('range') || 'full';
  const options = {
    content,
    profile: selectedValue('profile') || 'compatible',
    maxHeight: resolutionSelect.value ? Number(resolutionSelect.value) : null,
    audioFormat: audioFormat.value,
    range: { type: rangeType },
    extras: {
      thumbnail: extraThumbnail.checked,
      metadata: extraMetadata.checked,
      subtitles: extraSubtitles.checked,
      subtitleMode: subtitleMode.value,
      subtitleLanguage: subtitleLanguage.value.trim() || 'en'
    },
    sponsor: {
      mode: sponsorMode.value,
      categories: $$('#sponsor-categories input[type="checkbox"]:checked').map((input) => input.value)
    }
  };

  if (rangeType === 'custom') {
    options.range.start = rangeStart.value.trim();
    options.range.end = rangeEnd.value.trim();
  }
  if (rangeType === 'chapters') {
    options.range.chapterIndexes = $$('[data-chapter-index]:checked').map((checkbox) => Number(checkbox.value));
  }

  if (content === 'extras' && !extraThumbnail.checked && !extraMetadata.checked && !extraSubtitles.checked) {
    throw new Error('Choose at least one extra for Extras Only.');
  }
  if (currentInfo?.kind === 'playlist' && !selectedPlaylistUrls().length) {
    throw new Error('Choose at least one playlist video.');
  }
  if (rangeType === 'chapters' && !options.range.chapterIndexes.length) {
    throw new Error('Choose at least one chapter.');
  }
  if (sponsorMode.value !== 'off' && !options.sponsor.categories.length) {
    throw new Error('Choose at least one SponsorBlock category.');
  }
  return options;
}

async function startDownload() {
  if (!currentUrl || !currentInfo) return;
  let options;
  try {
    options = buildRequestOptions();
  } catch (error) {
    return setStatus(error.message, 'error');
  }

  const playlistUrls = selectedPlaylistUrls();
  const snapshot = {
    title: currentInfo.title || (currentInfo.kind === 'playlist' ? 'Media collection' : 'Media download'),
    url: currentUrl,
    source: currentInfo.source?.name || currentInfo.source?.hostname || '',
    thumbnailUrl: currentInfo.thumbnail || '',
    options,
    isPlaylist: currentInfo.kind === 'playlist',
    selectionCount: playlistUrls.length
  };

  resetProgress();
  progressPanel.hidden = false;
  setControlsDisabled(true);
  setStatus('Adding download to the queue…');

  try {
    const response = await fetch('/api/download/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        url: currentUrl,
        options,
        selection: { entryUrls: playlistUrls },
        display: {
          title: currentInfo.title || '',
          sourceName: currentInfo.source?.name || currentInfo.source?.hostname || ''
        }
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not start the download.');
    activeJobId = data.jobId;
    trackQueueJob(data.jobId, snapshot);
    progressSource = new EventSource(`/api/download/progress?id=${encodeURIComponent(data.jobId)}`);
    progressSource.onmessage = (event) => {
      try {
        renderProgress(JSON.parse(event.data));
      } catch {
        setStatus('Received an unreadable progress update.', 'error');
      }
    };
    progressSource.onerror = () => {
      if (!autoDownloadStarted) setStatus('Progress connection interrupted. The server may still be working.', 'error');
    };
    setControlsDisabled(false);
    setStatus('Added to the download queue. Downloads run one at a time.', 'success');
  } catch (error) {
    setStatus(error.message, 'error');
    progressStage.textContent = error.message;
    setControlsDisabled(false);
  }
}

async function clearActiveJob() {
  if (!activeJobId) return;
  const jobId = activeJobId;
  try {
    const data = await deleteServerJob(jobId);
    if (data.action !== 'cleared') throw new Error('LVOVD could not clear those prepared files yet.');
  } catch (error) {
    setStatus(error.message || 'Could not clear the prepared temporary files.', 'error');
    return;
  }
  closeQueueSource(jobId);
  trackedJobs.delete(jobId);
  renderQueue();
  resetProgress();
  setStatus('Prepared temporary files cleared.', 'success');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  preview.hidden = true;
  previewError.hidden = true;
  resetProgress();
  setStatus('Looking up media…');
  previewButton.disabled = true;
  previewButton.textContent = 'Loading…';
  try {
    const url = urlInput.value.trim();
    const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
      renderPreviewError(data.details, data.error);
      throw new Error(data.details?.title || data.error || 'Could not load that URL.');
    }
    currentUrl = url;
    renderInfo(data);
    const source = data.source?.name ? ` from ${data.source.name}` : '';
    setStatus(data.kind === 'playlist' ? `Collection ready${source}.` : `Media ready${source}.`, 'success');
  } catch (error) {
    currentInfo = null;
    setStatus(error.message, 'error');
  } finally {
    previewButton.disabled = false;
    previewButton.textContent = 'Preview';
  }
});

$$('input[name="content"]').forEach((input) => input.addEventListener('change', () => {
  setChoiceClasses('content');
  updateOptionVisibility();
}));
$$('input[name="profile"]').forEach((input) => input.addEventListener('change', () => {
  setChoiceClasses('profile');
  updateResolutionSelect();
}));
$$('input[name="range"]').forEach((input) => input.addEventListener('change', updateRangeVisibility));
extraSubtitles.addEventListener('change', updateOptionVisibility);
sponsorMode.addEventListener('change', updateOptionVisibility);
playlistList.addEventListener('change', updateDownloadLabel);
playlistAll.addEventListener('click', () => {
  $$('[data-playlist-entry]').forEach((checkbox) => { if (!checkbox.disabled) checkbox.checked = true; });
  updateDownloadLabel();
});
playlistNone.addEventListener('click', () => {
  $$('[data-playlist-entry]').forEach((checkbox) => { checkbox.checked = false; });
  updateDownloadLabel();
});
document.addEventListener('lvovd:history-confirmed', (event) => {
  const jobId = event.detail?.jobId;
  const statusValue = event.detail?.status;
  retireHistoryBackedQueueJob(jobId, statusValue);
});
downloadButton.addEventListener('click', startDownload);
clearJobButton.addEventListener('click', clearActiveJob);
recheck.addEventListener('click', checkHealth);

setChoiceClasses('content');
setChoiceClasses('profile');
checkHealth();
