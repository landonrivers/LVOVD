'use strict';

(function attachHistoryUi(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) api.init(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createHistoryUiApi() {
  const INITIAL_HISTORY_COUNT = 10;
  const HISTORY_INCREMENT = 10;
  const TERMINAL_QUEUE_PATTERN = /\b(?:Ready|Failed|Cancelled)\b/;

  function historyTime(entry) {
    const value = Date.parse(entry?.finishedAt || entry?.createdAt || 0);
    return Number.isFinite(value) ? value : 0;
  }

  function sortHistoryEntries(entries) {
    return [...(Array.isArray(entries) ? entries : [])].sort((a, b) => historyTime(b) - historyTime(a));
  }

  function isExactAvailable(value, availableValues) {
    const wanted = value == null ? '' : String(value);
    return (Array.isArray(availableValues) ? availableValues : []).some((item) => String(item) === wanted);
  }

  function intersectPlaylistUrls(savedUrls, currentUrls) {
    const saved = new Set((Array.isArray(savedUrls) ? savedUrls : []).filter((value) => typeof value === 'string'));
    return (Array.isArray(currentUrls) ? currentUrls : []).filter((url) => saved.has(url));
  }

  function planRangeRestore(savedRange, { customSupported = false } = {}) {
    const type = savedRange?.type || 'full';
    if (type === 'full') return { type: 'full', restored: true, reason: null };
    if (type === 'chapters') return { type: 'full', restored: false, reason: 'chapter selection' };
    if (type === 'custom') {
      const start = Number(savedRange?.start);
      const end = Number(savedRange?.end);
      if (customSupported && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start) {
        return { type: 'custom', start, end, restored: true, reason: null };
      }
      return { type: 'full', restored: false, reason: 'custom range' };
    }
    return { type: 'full', restored: false, reason: 'time range' };
  }

  function init(root) {
    const document = root.document;
    const historyPanel = document.querySelector('#history-panel');
    if (!historyPanel) return;

    const form = document.querySelector('#lookup-form');
    const urlInput = document.querySelector('#video-url');
    const preview = document.querySelector('#preview');
    const previewError = document.querySelector('#preview-error');
    const mainStatus = document.querySelector('#status');
    const historyMessage = document.querySelector('#history-message');
    const historyList = document.querySelector('#history-list');
    const historyShowMore = document.querySelector('#history-show-more');
    const historyRetry = document.querySelector('#history-retry');
    const historyClearAll = document.querySelector('#history-clear-all');
    const playlistPanel = document.querySelector('#playlist-panel');
    const playlistList = document.querySelector('#playlist-list');
    const resolutionSelect = document.querySelector('#resolution-select');
    const audioFormat = document.querySelector('#audio-format');
    const customRangeOption = document.querySelector('#custom-range-option');
    const rangeStart = document.querySelector('#range-start');
    const rangeEnd = document.querySelector('#range-end');
    const extraThumbnail = document.querySelector('#extra-thumbnail');
    const extraMetadata = document.querySelector('#extra-metadata');
    const extraSubtitles = document.querySelector('#extra-subtitles');
    const subtitleMode = document.querySelector('#subtitle-mode');
    const subtitleLanguage = document.querySelector('#subtitle-language');
    const subtitleLanguageList = document.querySelector('#subtitle-language-list');
    const sponsorDetails = document.querySelector('#sponsor-details');
    const sponsorMode = document.querySelector('#sponsor-mode');
    const sponsorCategories = document.querySelector('#sponsor-categories');

    if (!form || !urlInput || !preview || !previewError || !historyMessage || !historyList) return;

    let entries = [];
    let visibleCount = INITIAL_HISTORY_COUNT;
    let pendingRestore = null;
    let lastTerminalSignature = '';
    let liveRefreshGeneration = 0;

    function setHistoryMessage(message, kind = '') {
      historyMessage.textContent = message || '';
      historyMessage.className = `status${kind ? ` ${kind}` : ''}`;
    }

    function setMainStatus(message, kind = 'success') {
      if (!mainStatus) return;
      mainStatus.textContent = message || '';
      mainStatus.className = `status${kind ? ` ${kind}` : ''}`;
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

    function formatTimestamp(value) {
      const date = new Date(value || 0);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleString();
    }

    function formatTimecode(seconds) {
      const value = Math.max(0, Number(seconds) || 0);
      const whole = Math.floor(value);
      const h = Math.floor(whole / 3600);
      const m = Math.floor((whole % 3600) / 60);
      const s = whole % 60;
      return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
    }

    function conciseText(value, limit = 160) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text.length <= limit) return text;
      return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
    }

    function hostnameFromUrl(value) {
      try { return new URL(value).hostname.replace(/^www\./i, ''); } catch { return ''; }
    }

    function statusInfo(status) {
      if (status === 'ready') return { label: 'Completed', className: 'check good' };
      if (status === 'error') return { label: 'Failed', className: 'check bad' };
      if (status === 'cancelled') return { label: 'Cancelled', className: 'check' };
      return { label: 'Unknown', className: 'check pending' };
    }

    function contentLabel(content) {
      return ({
        av: 'Video + Audio',
        video: 'Video Only',
        audio: 'Audio Only',
        extras: 'Extras Only'
      })[content] || '';
    }

    function profileLabel(profile) {
      return ({ compatible: 'Compatible MP4', maximum: 'Maximum Quality' })[profile] || '';
    }

    function audioFormatLabel(format) {
      return ({
        source: 'Source Audio',
        m4a: 'M4A / AAC',
        mp3: 'MP3',
        opus: 'Opus',
        flac: 'FLAC',
        wav: 'WAV'
      })[format] || format || '';
    }

    function subtitleModeLabel(mode) {
      return ({ manual: 'Manual only', auto: 'Automatic only', both: 'Manual, then automatic' })[mode] || mode || '';
    }

    function sponsorModeLabel(mode) {
      return ({ off: 'Off', mark: 'Mark as chapters', remove: 'Remove segments' })[mode] || mode || '';
    }

    function extraLabels(options) {
      const labels = [];
      if (options?.thumbnail) labels.push('Thumbnail');
      if (options?.metadata) labels.push('Metadata');
      if (options?.subtitles) labels.push('Subtitles');
      return labels;
    }

    function appendDetail(container, label, value) {
      if (value == null || value === '') return;
      const line = document.createElement('p');
      line.className = 'help';
      line.textContent = `${label}: ${value}`;
      container.appendChild(line);
    }

    function appendDetailList(container, label, values) {
      const items = (Array.isArray(values) ? values : []).filter(Boolean);
      if (!items.length) return;
      appendDetail(container, label, items.join(' · '));
    }

    function detailsForEntry(entry) {
      const details = document.createElement('details');
      details.className = 'advanced-panel';
      const summary = document.createElement('summary');
      summary.textContent = 'Details';
      const body = document.createElement('div');
      body.className = 'advanced-content';
      const options = entry?.request?.options || {};
      const selection = entry?.request?.selection || {};

      appendDetail(body, 'Source URL', entry?.source?.url);
      appendDetail(body, 'Content', contentLabel(options.content));
      if (['av', 'video'].includes(options.content)) {
        appendDetail(body, 'Profile', profileLabel(options.profile));
        appendDetail(body, 'Resolution', options.maxHeight ? `${options.maxHeight}p` : 'Best available');
      }
      if (options.content === 'audio') appendDetail(body, 'Audio output', audioFormatLabel(options.audioFormat));

      if (options.content !== 'extras') {
        if (options.range?.type === 'custom') {
          appendDetail(body, 'Range', `${formatTimecode(options.range.start)}–${formatTimecode(options.range.end)}`);
        } else if (options.range?.type === 'chapters') {
          appendDetail(body, 'Range', `${options.range.chapterIndexes?.length || 0} selected chapter${options.range.chapterIndexes?.length === 1 ? '' : 's'}`);
        } else {
          appendDetail(body, 'Range', 'Full media');
        }
      }

      const extras = extraLabels(options.extras);
      appendDetail(body, 'Extras', extras.length ? extras.join(', ') : 'None');
      if (options.extras?.subtitles) {
        appendDetail(body, 'Subtitle mode', subtitleModeLabel(options.extras.subtitleMode));
        appendDetail(body, 'Subtitle language', options.extras.subtitleLanguage);
      }
      if (options.content !== 'extras') {
        const sponsor = sponsorModeLabel(options.sponsor?.mode || 'off');
        const categories = options.sponsor?.mode && options.sponsor.mode !== 'off'
          ? ` · ${(options.sponsor.categories || []).join(', ')}`
          : '';
        appendDetail(body, 'SponsorBlock', `${sponsor}${categories}`);
      }

      const selectedUrls = Array.isArray(selection.entryUrls) ? selection.entryUrls : [];
      if (selectedUrls.length) {
        appendDetail(body, 'Playlist selection', `${selectedUrls.length} exact item URL${selectedUrls.length === 1 ? '' : 's'}`);
        appendDetailList(body, 'Selected item URLs', selectedUrls);
      }

      for (const output of entry?.outputs || []) {
        const size = formatBytes(output?.size);
        appendDetail(body, 'Output', [output?.filename, output?.label, size].filter(Boolean).join(' · '));
      }
      appendDetail(body, 'Terminal time', formatTimestamp(entry?.finishedAt || entry?.createdAt));
      if (entry?.failure) {
        appendDetail(body, 'Failure category', String(entry.failure.category || '').replace(/_/g, ' '));
        appendDetail(body, 'Failure message', entry.failure.message);
      }

      details.append(summary, body);
      return details;
    }

    function renderHistory() {
      historyList.replaceChildren();
      historyRetry.hidden = true;
      historyClearAll.hidden = entries.length === 0;

      if (!entries.length) {
        historyList.hidden = true;
        historyShowMore.hidden = true;
        setHistoryMessage('No download history yet. Completed, failed, and cancelled downloads will appear here.');
        return;
      }

      const visible = entries.slice(0, visibleCount);
      historyList.hidden = false;
      setHistoryMessage(`Showing ${visible.length} of ${entries.length} local history record${entries.length === 1 ? '' : 's'}.`);
      historyShowMore.hidden = visible.length >= entries.length;

      for (const entry of visible) {
        const row = document.createElement('div');
        row.className = 'output-row';

        const copy = document.createElement('div');
        const state = statusInfo(entry?.status);
        const badge = document.createElement('span');
        badge.className = state.className;
        badge.textContent = state.label;

        const strong = document.createElement('strong');
        strong.textContent = entry?.title || 'Media download';

        const source = entry?.source?.name || hostnameFromUrl(entry?.source?.url) || 'Source';
        const options = entry?.request?.options || {};
        const summaryBits = [formatTimestamp(entry?.finishedAt || entry?.createdAt), source, contentLabel(options.content)];
        const firstOutput = entry?.outputs?.[0];
        if (firstOutput?.filename) {
          const more = entry.outputs.length > 1 ? ` + ${entry.outputs.length - 1} more` : '';
          summaryBits.push(`${firstOutput.filename}${more}${Number.isFinite(firstOutput.size) ? ` · ${formatBytes(firstOutput.size)}` : ''}`);
        }
        if (entry?.status === 'error' && entry?.failure?.message) summaryBits.push(conciseText(entry.failure.message));

        const small = document.createElement('small');
        small.textContent = summaryBits.filter(Boolean).join(' · ');
        copy.append(badge, strong, small, detailsForEntry(entry));

        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        if (entry?.source?.url) {
          const useAgain = document.createElement('button');
          useAgain.type = 'button';
          useAgain.className = 'button secondary mini';
          useAgain.textContent = 'Use Again';
          useAgain.addEventListener('click', () => useAgainEntry(entry));
          actions.appendChild(useAgain);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button secondary mini';
        remove.textContent = 'Delete';
        remove.addEventListener('click', () => deleteHistoryEntry(entry.id));
        actions.appendChild(remove);

        row.append(copy, actions);
        historyList.appendChild(row);
      }
    }

    async function readResponseJson(response) {
      try { return await response.json(); } catch { return {}; }
    }

    async function loadHistory({ keepVisibleCount = true } = {}) {
      if (!keepVisibleCount) visibleCount = INITIAL_HISTORY_COUNT;
      historyRetry.hidden = true;
      if (!entries.length) setHistoryMessage('Loading download history…');
      try {
        const response = await root.fetch('/api/history', { cache: 'no-store' });
        const data = await readResponseJson(response);
        if (!response.ok) throw new Error(data.error || 'Local download history could not be read.');
        entries = sortHistoryEntries(data.entries);
        renderHistory();
        return true;
      } catch (error) {
        historyList.hidden = true;
        historyShowMore.hidden = true;
        historyClearAll.hidden = entries.length === 0;
        historyRetry.hidden = false;
        setHistoryMessage(`${error.message || 'Download history could not be loaded.'} Preview and downloads are still available.`, 'error');
        return false;
      }
    }

    async function deleteHistoryEntry(id) {
      try {
        const response = await root.fetch(`/api/history?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await readResponseJson(response);
        if (!response.ok) throw new Error(data.error || 'That history record could not be deleted.');
        entries = entries.filter((entry) => entry?.id !== id);
        renderHistory();
      } catch (error) {
        historyRetry.hidden = false;
        setHistoryMessage(error.message || 'That history record could not be deleted.', 'error');
      }
    }

    async function clearAllHistory() {
      const confirmed = root.confirm(
        'Clear all download history?\n\nThis removes LVOVD’s local history records. It does not delete media files saved by your browser.'
      );
      if (!confirmed) return;
      try {
        const response = await root.fetch('/api/history?all=1', { method: 'DELETE' });
        const data = await readResponseJson(response);
        if (!response.ok) throw new Error(data.error || 'Download history could not be cleared.');
        entries = [];
        visibleCount = INITIAL_HISTORY_COUNT;
        renderHistory();
      } catch (error) {
        historyRetry.hidden = false;
        setHistoryMessage(error.message || 'Download history could not be cleared.', 'error');
      }
    }

    function radioInput(name, value) {
      return [...document.querySelectorAll(`input[name="${name}"]`)].find((input) => input.value === String(value));
    }

    function selectRadio(name, value) {
      const input = radioInput(name, value);
      if (!input || input.disabled) return false;
      input.checked = true;
      input.dispatchEvent(new root.Event('change', { bubbles: true }));
      return true;
    }

    function setSelectExact(select, value) {
      if (!select) return false;
      const wanted = value == null ? '' : String(value);
      const values = [...select.options].map((option) => option.value);
      if (!isExactAvailable(wanted, values)) return false;
      select.value = wanted;
      select.dispatchEvent(new root.Event('change', { bubbles: true }));
      return true;
    }

    function currentPlaylistUrls() {
      return [...document.querySelectorAll('[data-playlist-entry]')]
        .map((checkbox) => checkbox.value)
        .filter(Boolean);
    }

    function currentSubtitleCodes() {
      return subtitleLanguageList ? [...subtitleLanguageList.options].map((option) => option.value).filter(Boolean) : [];
    }

    function addWarning(warnings, message) {
      if (message) warnings.add(message);
    }

    function restoreExtra(input, wanted, label, warnings, { requireKnownSubtitles = false } = {}) {
      if (!input) return;
      if (!wanted) {
        if (!input.disabled) {
          const changed = input.checked;
          input.checked = false;
          if (changed) input.dispatchEvent(new root.Event('change', { bubbles: true }));
        }
        return;
      }
      const playlistUnknown = requireKnownSubtitles && playlistPanel && !playlistPanel.hidden;
      if (!input.disabled && !playlistUnknown) {
        input.checked = true;
        input.dispatchEvent(new root.Event('change', { bubbles: true }));
      } else {
        input.checked = false;
        addWarning(warnings, label);
      }
    }

    function resetRestorationDefaults() {
      const contentChoices = [...document.querySelectorAll('input[name="content"]')];
      const defaultContent = contentChoices.find((input) => input.value === 'av' && !input.disabled)
        || contentChoices.find((input) => !input.disabled);
      if (defaultContent) selectRadio('content', defaultContent.value);

      const currentContent = [...document.querySelectorAll('input[name="content"]')].find((input) => input.checked)?.value;
      if (['av', 'video'].includes(currentContent)) {
        if (!selectRadio('profile', 'compatible')) selectRadio('profile', 'maximum');
        setSelectExact(resolutionSelect, '');
      }
      setSelectExact(audioFormat, 'm4a');
      selectRadio('range', 'full');

      for (const input of [extraThumbnail, extraMetadata, extraSubtitles]) {
        if (input && !input.disabled) {
          const changed = input.checked;
          input.checked = false;
          if (changed) input.dispatchEvent(new root.Event('change', { bubbles: true }));
        }
      }
      setSelectExact(subtitleMode, 'both');
      if (subtitleLanguage) subtitleLanguage.value = 'en';
      if (sponsorMode) {
        sponsorMode.value = 'off';
        sponsorMode.dispatchEvent(new root.Event('change', { bubbles: true }));
      }
      if (sponsorCategories) {
        for (const input of sponsorCategories.querySelectorAll('input[type="checkbox"]')) {
          input.checked = input.value === 'sponsor';
        }
      }
    }

    function restoreHistoryChoices(entry) {
      const saved = entry?.request?.options;
      const warnings = new Set();
      if (!saved) {
        addWarning(warnings, 'saved download settings');
        return [...warnings];
      }

      const savedContent = saved.content || 'av';
      const contentRestored = selectRadio('content', savedContent);
      if (!contentRestored) addWarning(warnings, `content mode (${contentLabel(savedContent) || savedContent})`);
      const effectiveContent = radioInput('content', savedContent)?.checked ? savedContent : null;

      if (effectiveContent && ['av', 'video'].includes(savedContent)) {
        if (!selectRadio('profile', saved.profile || 'compatible')) {
          addWarning(warnings, `profile (${profileLabel(saved.profile) || saved.profile || 'unknown'})`);
        }
        const wantedHeight = saved.maxHeight == null ? '' : String(saved.maxHeight);
        if (!setSelectExact(resolutionSelect, wantedHeight) && saved.maxHeight != null) {
          addWarning(warnings, `resolution (${saved.maxHeight}p)`);
        }
      }

      if (effectiveContent === 'audio' && !setSelectExact(audioFormat, saved.audioFormat || 'm4a')) {
        addWarning(warnings, `audio format (${audioFormatLabel(saved.audioFormat) || saved.audioFormat || 'unknown'})`);
      }

      const fullRange = () => selectRadio('range', 'full');
      if (effectiveContent === 'extras') {
        fullRange();
        if (saved.range?.type && saved.range.type !== 'full') addWarning(warnings, 'previous range setting');
      } else if (effectiveContent) {
        const rangePlan = planRangeRestore(saved.range, { customSupported: !customRangeOption?.hidden });
        if (rangePlan.type === 'custom') {
          selectRadio('range', 'custom');
          if (rangeStart) rangeStart.value = formatTimecode(rangePlan.start);
          if (rangeEnd) rangeEnd.value = formatTimecode(rangePlan.end);
        } else {
          fullRange();
        }
        if (!rangePlan.restored) {
          addWarning(warnings, rangePlan.reason === 'chapter selection'
            ? 'chapter selection (choose chapters again)'
            : rangePlan.reason);
        }
      } else if (saved.range?.type && saved.range.type !== 'full') {
        addWarning(warnings, saved.range.type === 'chapters' ? 'chapter selection (choose chapters again)' : 'previous range setting');
      }

      restoreExtra(extraThumbnail, Boolean(saved.extras?.thumbnail), 'thumbnail extra', warnings);
      restoreExtra(extraMetadata, Boolean(saved.extras?.metadata), 'metadata extra', warnings);
      restoreExtra(extraSubtitles, Boolean(saved.extras?.subtitles), 'subtitles', warnings, { requireKnownSubtitles: true });

      if (saved.extras?.subtitles && extraSubtitles?.checked) {
        const codes = currentSubtitleCodes();
        if (isExactAvailable(saved.extras.subtitleLanguage, codes)) {
          subtitleLanguage.value = saved.extras.subtitleLanguage;
          if (!setSelectExact(subtitleMode, saved.extras.subtitleMode || 'both')) addWarning(warnings, 'subtitle mode');
        } else {
          addWarning(warnings, `subtitle language (${saved.extras.subtitleLanguage || 'unknown'})`);
        }
      }

      if (effectiveContent === 'extras') {
        if (sponsorMode) sponsorMode.value = 'off';
        if (saved.sponsor?.mode && saved.sponsor.mode !== 'off') addWarning(warnings, 'SponsorBlock setting');
      } else if (saved.sponsor?.mode && saved.sponsor.mode !== 'off') {
        if (!sponsorDetails || sponsorDetails.hidden || !setSelectExact(sponsorMode, saved.sponsor.mode)) {
          if (sponsorMode) sponsorMode.value = 'off';
          addWarning(warnings, 'SponsorBlock setting');
        } else {
          const boxes = sponsorCategories ? [...sponsorCategories.querySelectorAll('input[type="checkbox"]')] : [];
          const available = boxes.map((input) => input.value);
          const wantedCategories = Array.isArray(saved.sponsor.categories) ? saved.sponsor.categories : [];
          const restoredCategories = wantedCategories.filter((category) => isExactAvailable(category, available));
          boxes.forEach((input) => { input.checked = restoredCategories.includes(input.value); });
          if (!restoredCategories.length) {
            sponsorMode.value = 'off';
            sponsorMode.dispatchEvent(new root.Event('change', { bubbles: true }));
            addWarning(warnings, 'SponsorBlock categories');
          } else if (restoredCategories.length !== wantedCategories.length) {
            addWarning(warnings, 'some SponsorBlock categories');
          }
        }
      } else if (sponsorMode && saved.sponsor?.mode === 'off') {
        sponsorMode.value = 'off';
        sponsorMode.dispatchEvent(new root.Event('change', { bubbles: true }));
      }

      const savedPlaylistUrls = Array.isArray(entry?.request?.selection?.entryUrls)
        ? entry.request.selection.entryUrls
        : [];
      if (savedPlaylistUrls.length) {
        if (playlistPanel && !playlistPanel.hidden) {
          const currentUrls = currentPlaylistUrls();
          const restoredUrls = intersectPlaylistUrls(savedPlaylistUrls, currentUrls);
          const restoredSet = new Set(restoredUrls);
          for (const checkbox of document.querySelectorAll('[data-playlist-entry]')) {
            checkbox.checked = restoredSet.has(checkbox.value);
          }
          playlistList?.dispatchEvent(new root.Event('change', { bubbles: true }));
          if (restoredUrls.length !== savedPlaylistUrls.length) {
            addWarning(warnings, `playlist selection (${restoredUrls.length} of ${savedPlaylistUrls.length} items still matched exactly)`);
          }
        } else {
          addWarning(warnings, 'playlist selection');
        }
      }

      return [...warnings];
    }

    function finishPendingRestore() {
      if (!pendingRestore || preview.hidden) return;
      const entry = pendingRestore;
      pendingRestore = null;
      resetRestorationDefaults();
      const warnings = restoreHistoryChoices(entry);
      const message = warnings.length
        ? `Fresh Preview complete. Some previous settings could not be restored: ${warnings.join(', ')}. Review the current settings, then click Download when ready.`
        : 'Fresh Preview complete. Previous settings were restored where currently supported. Review them, then click Download when ready.';
      setMainStatus(message, 'success');
      preview.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }

    function useAgainEntry(entry) {
      const sourceUrl = entry?.source?.url;
      if (!sourceUrl) return;
      pendingRestore = entry;
      urlInput.value = sourceUrl;
      setMainStatus('Refreshing Preview before restoring previous settings…');
      form.requestSubmit();
    }

    const previewObserver = new root.MutationObserver(() => {
      if (!pendingRestore) return;
      if (!preview.hidden) {
        root.queueMicrotask ? root.queueMicrotask(finishPendingRestore) : Promise.resolve().then(finishPendingRestore);
      } else if (!previewError.hidden) {
        pendingRestore = null;
      }
    });
    previewObserver.observe(preview, { attributes: true, attributeFilter: ['hidden'] });
    previewObserver.observe(previewError, { attributes: true, attributeFilter: ['hidden'] });

    async function refreshAfterTerminalQueueChange() {
      const generation = ++liveRefreshGeneration;
      const knownIds = new Set(entries.map((entry) => entry?.id).filter(Boolean));
      const loaded = await loadHistory({ keepVisibleCount: true });
      const foundNew = loaded && entries.some((entry) => entry?.id && !knownIds.has(entry.id));
      if (foundNew || generation !== liveRefreshGeneration) return;
      root.setTimeout(() => {
        if (generation === liveRefreshGeneration) loadHistory({ keepVisibleCount: true });
      }, 500);
    }

    function inspectQueueForTerminalState() {
      const queue = [...document.querySelectorAll('section.download-progress')].find((section) =>
        section !== historyPanel && section.querySelector('.progress-head strong')?.textContent === 'Download queue');
      if (!queue || queue.hidden) {
        lastTerminalSignature = '';
        return;
      }
      const terminalRows = [...queue.querySelectorAll('.output-row')]
        .map((row) => row.textContent.trim())
        .filter((text) => TERMINAL_QUEUE_PATTERN.test(text));
      const signature = terminalRows.join('\n---\n');
      if (!signature || signature === lastTerminalSignature) return;
      lastTerminalSignature = signature;
      refreshAfterTerminalQueueChange();
    }

    const queueObserver = new root.MutationObserver(inspectQueueForTerminalState);
    queueObserver.observe(historyPanel.parentElement || document.body, { childList: true, subtree: true, characterData: true });

    historyShowMore.addEventListener('click', () => {
      visibleCount += HISTORY_INCREMENT;
      renderHistory();
    });
    historyRetry.addEventListener('click', () => loadHistory({ keepVisibleCount: true }));
    historyClearAll.addEventListener('click', clearAllHistory);

    loadHistory({ keepVisibleCount: false });
  }

  return {
    sortHistoryEntries,
    isExactAvailable,
    intersectPlaylistUrls,
    planRangeRestore,
    init
  };
});
