'use strict';

(function attachLocalWorkspace(root) {
  if (!root.document) return;
  const document = root.document, $ = selector => document.querySelector(selector);
  const panel = $('#media-workspace-panel');
  if (!panel) return;
  const editor = root.LVOVDEditorView, facts = root.LVOVDMediaFacts, profiles = root.LVOVDProcessingProfile;
  const intake = $('#media-drop-zone'), input = $('#media-file-input'), choose = $('#media-choose-button');
  const ready = $('#local-media-ready'), status = $('#workspace-status'), progress = $('#workspace-progress');
  const settingsForm = $('#processing-settings'), start = $('#conversion-start'), retry = $('#conversion-retry'), cancel = $('#conversion-cancel');
  let generation = 0, workspaceId = null, snapshot = null, upload = null, starting = false, source = null, profile = null;
  let plan = null, planVersion = 0, planBusy = false, reviewInFlight = false, reviewQueued = false, reviewTimer = null, retryTimer = null;
  let operationRequest = false, previewRequest = false, discarding = false, resetting = false, retainedCleanupId = null;
  let previewAttempted = false, previewError = null;

  const processingHelp = {
    pan: ['More timeline to explore', 'Drag the time ruler sideways to pan the zoomed view, or click an arrow to move by half a window. Arrows appear only where more of the timeline is off-screen.', 'Panning changes the view, not your cuts or playback position. Use Full Timeline to see the complete source again.'],
    relationship: ['Choose what to control', 'The fields are linked, but one value drives the calculation. Bitrate targets data per second; size sets a maximum budget and calculates video bitrate. CRF targets visual quality, so bitrate and size vary. You cannot independently promise all three.', 'Editing a calculated bitrate or size selects that target. Audio and retained duration then update the budget. For a first H.264 trial, try Quality 22 with Medium speed, then inspect the result.'],
    quality: ['H.264 quality (CRF)', 'Trial starting points: 18 for more detail, 22 for a balance, 26 for a smaller file with more visible compression. Lower numbers preserve more detail and generally use more bytes. These are starting points, not quality guarantees.', 'CRF does not specify a bitrate or file size. The application default remains 18. Choose Bitrate or File size when a predictable budget matters more.'],
    video: ['Average video bitrate', 'Rough H.264 trial ranges at 24–30 fps: 480p: 1,000–2,500 kbps; 720p: 2,500–5,000; 1080p: 5,000–10,000. Motion, fine detail, grain and higher frame rates can need more. A small portrait video can be a reasonable place to try 2,000 kbps.', 'This is an average target, not a fixed stream rate. Short or simple clips can undershoot, especially in one pass. Two passes usually improve budget accuracy; actual size can still differ.'],
    audio: ['Audio bitrate', 'Mono/stereo trial examples: AAC speech at 64–96 kbps for mono; AAC music at 128–192 kbps for stereo, or 256 for more headroom. For stereo MP3, try 160–192 kbps. Listen to speech and music before choosing a lower rate.', 'Leaving this empty uses copied audio or the existing codec default. Entering a bitrate requests audio encoding. Channel count stays unchanged; the examples above are not surround-audio budgets.'],
    size: ['Estimated size and maximum size', 'Size ≈ (video kbps + audio kbps) × retained seconds ÷ 8,000 MB, plus container overhead. At 2,000 kbps, ten seconds of video is about 2.5 MB before audio and overhead.', 'An estimate is not a promise: the encoder may undershoot and the budget reserves extra space. Editing this field sets a maximum per output, with two-pass encoding and a completed-byte check. The result may be smaller. 1 MB = 1,000,000 bytes; other apps may display binary MiB.'],
    passes: ['Two-pass encoding', 'The first pass analyzes the retained video; the second allocates the bitrate using that analysis. It takes more processing time and usually gets closer to the requested average than one pass.', 'It does not guarantee an exact size or visual quality. File-size mode already uses two passes and validates the completed byte count.'],
    speed: ['Software encoding speed', 'Medium is the general starting point. Fast finishes sooner; Slow spends longer looking for efficient compression. This changes encoding effort, not playback speed.', 'Keep Medium while comparing quality or bitrate so you change one thing at a time.']
  };
  const helpTip = document.createElement('div');
  helpTip.id = 'processing-help-tooltip'; helpTip.className = 'processing-help-tooltip'; helpTip.setAttribute('role', 'tooltip'); helpTip.hidden = true;
  document.body.append(helpTip);
  let helpButton = null, helpPinned = false, helpTimer = null;
  function closeHelp() {
    clearTimeout(helpTimer); helpTip.hidden = true;
    helpButton?.removeAttribute('aria-describedby'); helpButton?.setAttribute('aria-expanded', 'false'); helpButton = null; helpPinned = false;
  }
  function positionHelp() {
    if (!helpButton || helpTip.hidden) return;
    if (!helpButton.getClientRects().length) { closeHelp(); return; }
    const rect = helpButton.getBoundingClientRect();
    helpTip.style.left = `${Math.max(8, Math.min(rect.left, root.innerWidth - helpTip.offsetWidth - 8))}px`;
    helpTip.style.top = `${rect.bottom + 6 + helpTip.offsetHeight <= root.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - helpTip.offsetHeight - 6)}px`;
  }
  function showHelp(button) {
    clearTimeout(helpTimer);
    if (helpButton !== button) closeHelp();
    helpButton = button; helpTip.replaceChildren();
    processingHelp[button.dataset.processingHelp].forEach((text, index) => {
      const item = document.createElement(index ? 'p' : 'strong'); item.textContent = text; helpTip.append(item);
    });
    button.setAttribute('aria-describedby', helpTip.id); button.setAttribute('aria-expanded', 'true');
    helpTip.hidden = false; positionHelp();
  }
  function dismissHelpLater() {
    clearTimeout(helpTimer); helpTimer = setTimeout(() => {
      if (!helpPinned && !helpButton?.matches(':hover, :focus') && !helpTip.matches(':hover')) closeHelp();
    }, 180);
  }
  for (const button of panel.querySelectorAll('[data-processing-help]')) {
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') showHelp(button); });
    button.addEventListener('pointerleave', dismissHelpLater);
    button.addEventListener('focus', () => showHelp(button)); button.addEventListener('blur', dismissHelpLater);
    button.addEventListener('click', event => { if (button.hasAttribute('data-help-action')) { closeHelp(); return; } event.preventDefault(); if (helpButton === button && helpPinned) closeHelp(); else { showHelp(button); helpPinned = true; } });
  }
  helpTip.addEventListener('pointerenter', () => clearTimeout(helpTimer)); helpTip.addEventListener('pointerleave', dismissHelpLater);
  document.addEventListener('pointerdown', event => { if (helpButton && !helpButton.contains(event.target) && !helpTip.contains(event.target)) closeHelp(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && helpButton) { event.preventDefault(); closeHelp(); } });
  root.addEventListener('resize', positionHelp); document.addEventListener('scroll', positionHelp, true);

  function publish() {
    document.dispatchEvent(new root.CustomEvent('lvovd:workspace-state', { detail: {
      active: Boolean(workspaceId || upload || starting || retainedCleanupId), status: snapshot?.status || (upload ? 'uploading' : starting ? 'starting' : 'idle'),
      origin: snapshot?.source?.origin || (upload ? 'local' : starting ? 'url' : null)
    } }));
  }
  function message(text, error = false) { status.textContent = text || ''; status.className = `status${error ? ' error' : ''}`; }
  function closeSource() { source?.close(); source = null; }
  async function post(url, body) {
    const response = await root.fetch(url, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The local operation could not complete.');
    return data;
  }
  function number(selector) { const value = $(selector).value.trim(); return value === '' ? null : Number(value); }
  function rateMode() { return settingsForm.querySelector('input[name="processing-rate"]:checked').value; }
  function readSettings() {
    const settings = profiles.defaults(), hasVideo = Boolean(snapshot?.inspection?.video) && !['m4a', 'mp3'].includes($('#processing-container').value), hasAudio = Boolean(snapshot?.inspection?.audio);
    settings.container = $('#processing-container').value;
    settings.filenameSuffix = $('#processing-suffix-enabled').checked ? $('#processing-filename-suffix').value : '';
    if (hasVideo) {
      settings.videoCodec = $('#processing-video-codec').value;
      const scale = $('#processing-scale').value;
      settings.scale.mode = scale === 'unchanged' ? 'unchanged' : scale.includes(':') ? scale.split(':')[0] : 'fit';
      if (settings.scale.mode === 'fit') {
        const [width, height] = scale === 'fit' ? [number('#processing-width'), number('#processing-height')] : scale.split('x').map(Number);
        Object.assign(settings.scale, { width, height, allowUpscale: !$('#processing-no-upscale').checked });
      } else if (settings.scale.mode !== 'unchanged') {
        settings.scale[settings.scale.mode] = Number(scale.split(':')[1]);
        settings.scale.allowUpscale = !$('#processing-no-upscale').checked;
      }
      settings.frameRate = number('#processing-frame-rate');
      settings.rate.mode = rateMode();
      if (settings.rate.mode !== 'automatic') settings.rate.preset = $('#processing-preset').value;
      if (settings.rate.mode === 'quality') settings.rate.crf = number('#processing-crf');
      if (settings.rate.mode === 'bitrate') Object.assign(settings.rate, { videoKbps: number('#processing-video-bitrate'), twoPass: $('#processing-two-pass').checked });
      if (settings.rate.mode === 'size') Object.assign(settings.rate, { maximumMB: number('#processing-maximum-mb'), twoPass: true });
    }
    if (hasAudio) settings.audio = { codec: $('#processing-audio-codec').value, bitrateKbps: number('#processing-audio-bitrate') };
    return settings;
  }
  function renderSettings() {
    const hasVideo = Boolean(snapshot?.inspection?.video) && !['m4a', 'mp3'].includes($('#processing-container').value), hasAudio = Boolean(snapshot?.inspection?.audio);
    for (const id of ['processing-video-settings', 'processing-transform-settings', 'processing-rate-mode', 'processing-rate-help', 'processing-bitrate-fields', 'processing-size-fields']) $(`#${id}`).hidden = !hasVideo;
    $('#processing-rate-settings').hidden = !hasVideo && !hasAudio;
    $('#processing-audio-settings').hidden = !hasAudio;
    $('#processing-scale-fields').hidden = $('#processing-scale').value !== 'fit';
    const mode = rateMode();
    $('#processing-quality-fields').hidden = !hasVideo || mode !== 'quality';
    $('#processing-two-pass-field').hidden = !hasVideo || mode !== 'bitrate';
    $('#processing-size-policy').hidden = mode !== 'size';
    $('#processing-preset-field').hidden = !hasVideo || mode === 'automatic';
    $('#processing-video-rate-label').textContent = mode === 'bitrate' ? 'Video bitrate (target)' : mode === 'size' ? 'Video bitrate (calculated)' : 'Video bitrate (auto)';
    $('#processing-size-label').textContent = mode === 'size' ? 'Maximum file size' : 'Estimated file size';
    $('#processing-video-bitrate').required = hasVideo && mode === 'bitrate';
    $('#processing-maximum-mb').required = hasVideo && mode === 'size';
    // Observed/calculated values are not requested limits. Large source rates
    // or estimates must not make an otherwise valid unchanged draft invalid.
    $('#processing-video-bitrate').max = mode === 'bitrate' ? '1000000' : '';
    $('#processing-maximum-mb').max = mode === 'size' ? '107374.1824' : '';
    $('#processing-rate-help').textContent = {
      automatic: 'Auto: copy where possible; required H.264 encoding uses CRF 18. Size can vary.',
      quality: 'Quality is in control. Bitrate and file size vary with the footage.',
      bitrate: 'Video bitrate is in control. File size is an estimate, not an exact result.',
      size: 'Maximum size is in control. Video bitrate is calculated after reserving audio and container space.'
    }[mode];
    for (const control of settingsForm.elements) control.disabled = Boolean(control.closest('[hidden]'));
    const suffix = $('#processing-filename-suffix'); suffix.disabled = !$('#processing-suffix-enabled').checked;
    suffix.setCustomValidity(/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(suffix.value) ? 'Use a suffix without path separators or reserved filename characters.' : '');
  }
  function renderEstimates() {
    const estimate = plan.sizeEstimate || {}, mode = rateMode();
    const video = $('#processing-video-bitrate'), size = $('#processing-maximum-mb');
    // Companion values come from the reviewed server plan. Editing either
    // selects it as the new controlling intent; programmatic updates do not.
    if (mode !== 'bitrate') {
      video.value = estimate.videoBitrate >= 1000 ? String(Number((estimate.videoBitrate / 1000).toFixed(3))) : '';
      video.placeholder = plan.streams?.find(stream => stream.role === 'video')?.action === 'encode' ? 'Variable' : 'Unknown';
    }
    if (mode !== 'size') {
      size.value = estimate.bytes >= 1000 ? String(Number((estimate.bytes / 1e6).toFixed(6))) : '';
      size.placeholder = estimate.bytes == null ? 'Variable' : '< 0.001';
    }
    const audioRate = estimate.audioBitrate;
    $('#processing-audio-bitrate').placeholder = audioRate > 0 ? `${Number((audioRate / 1000).toFixed(1))} auto` : 'Auto';
    $('#processing-audio-rate-help').textContent = `${audioRate > 0 ? `${Number((audioRate / 1000).toFixed(1))} kbps ${plan.streams?.find(stream => stream.role === 'audio')?.action === 'copy' ? 'copied (inspected average)' : 'encoding target'}. ` : 'Audio rate is variable or unknown. '}Enter a bitrate to encode explicitly. Clear it to use Auto. No automatic downmix.`;
  }
  function refreshDraft() {
    if (!profile || resetting) return;
    const authoring = editor.authoringState();
    const changed = profile.update({ editPlan: authoring.editPlan, editorState: authoring, settings: readSettings() });
    if (changed) invalidatePlan();
    renderSettings(); processingControls();
  }
  function invalidatePlan() {
    planVersion++; plan = null; planBusy = true; reviewQueued = true;
    clearTimeout(reviewTimer); clearTimeout(retryTimer); retry.hidden = true;
    $('#conversion-warnings').replaceChildren(); $('#conversion-changes').replaceChildren(); $('#processing-plan-facts').replaceChildren();
    $('#conversion-plan-title').textContent = 'Reviewing current cuts and output settings…';
    $('#processing-filename-preview').textContent = 'Reviewing download name…';
    reviewTimer = setTimeout(reviewPlan, 300);
  }
  function reset(text = '') {
    closeHelp();
    generation++; planVersion++;
    closeSource(); clearTimeout(reviewTimer); clearTimeout(retryTimer);
    const oldUpload = upload; upload = null; oldUpload?.abort();
    workspaceId = null; snapshot = null; profile = null; starting = false; plan = null; planBusy = false; reviewQueued = false;
    operationRequest = false; previewRequest = false; previewAttempted = false; previewError = null; discarding = false;
    $('#processing-file-list').replaceChildren();
    editor.reset(); ready.hidden = true; intake.hidden = false; choose.disabled = Boolean(retainedCleanupId); input.value = '';
    progress.hidden = true; $('#workspace-failure').hidden = true; $('#conversion-output').hidden = true;
    $('#conversion-download').removeAttribute('href'); $('#conversion-warnings').replaceChildren();
    settingsForm.reset(); message(text); publish();
  }
  function appendFact(list, label, value) {
    const item = document.createElement('div'), term = document.createElement('dt'), description = document.createElement('dd');
    term.textContent = label; description.textContent = value; item.append(term, description); list.append(item);
  }
  function rateDescription(rate = {}) {
    return rate.mode === 'quality' ? `CRF ${rate.crf} · ${rate.preset} · final size varies`
      : rate.mode === 'bitrate' ? `${rate.videoKbps} kbps average video · ${rate.preset}${rate.twoPass ? ' · two passes' : ''}`
      : rate.mode === 'size' ? `Maximum ${rate.maximumMB} MB · ${rate.preset} · two passes` : 'Automatic / no override';
  }
  function sizeInMB(bytes) { return Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1e6).toFixed(3)} MB` : 'Size unavailable'; }
  function renderFacts(data) {
    $('#local-media-name').textContent = data.source?.name || 'Local media';
    const files = $('#processing-file-list');
    if (files.options[0]?.value !== data.sourceAssetId) {
      const option = document.createElement('option');
      option.value = data.sourceAssetId; option.textContent = data.source?.name || 'Local media'; option.selected = true;
      files.replaceChildren(option);
    }
    files.title = data.source?.name || 'Local media';
    const inspection = data.inspection || {};
    $('#local-media-summary').textContent = [facts.mediaKindLabel(inspection.mediaKind), inspection.format,
      inspection.video && facts.familiarCodecName(inspection.video.codec), inspection.audio && facts.familiarCodecName(inspection.audio.codec),
      facts.formatDuration(inspection.durationSeconds)].filter(Boolean).join(' · ');
    const list = $('#conversion-facts'); list.replaceChildren();
    for (const [label, value] of facts.inspectionFacts(data)) appendFact(list, label, value);
  }
  function processingControls() {
    const state = snapshot?.conversion || {}, current = profile?.state();
    const busy = Boolean(snapshot?.activeOperation || operationRequest || previewRequest || discarding);
    const acknowledged = [...$('#conversion-warnings').querySelectorAll('input[required]')].every(box => box.checked);
    start.disabled = !profile || busy || planBusy || Boolean(plan && !['executable', 'no-op'].includes(plan.status)) || !acknowledged
      || state.cleanupPending || snapshot?.outputCleanup?.blocked;
    start.textContent = 'Process File';
    cancel.hidden = !['running', 'validating', 'cancelling'].includes(state.status);
    cancel.disabled = state.status === 'cancelling' || discarding;
    $('#processing-reset').disabled = !profile || discarding;
    const preview = $('#processing-prepare-preview');
    preview.hidden = !snapshot?.editor?.eligible || Boolean(snapshot?.playback?.url) || (!previewError && snapshot?.editor?.status !== 'failed');
    preview.disabled = busy;
    $('#processing-preview-note').textContent = !snapshot?.inspection?.video ? 'Audio file — choose output settings, then Process File.'
      : !snapshot?.editor?.eligible ? 'Video preview and cuts are unavailable for this source. Review the supported output settings.'
        : previewRequest || snapshot?.editor?.status === 'preparing' ? 'Preparing playback from the selected original file…'
          : previewError ? `${previewError} You can still review processing settings or retry playback.` : '';
    $('#conversion-cleanup').hidden = !state.cleanupPending && !snapshot?.outputCleanup?.blocked;
    $('#conversion-cleanup').disabled = busy;
    $('#output-cleanup-status').textContent = snapshot?.outputCleanup?.message || (state.cleanupPending ? 'Temporary output cleanup needs a retry.' : '');
    $('#conversion-progress').hidden = !['running', 'validating', 'cancelling'].includes(state.status);
    const bar = $('#conversion-progress-bar'); bar.classList.toggle('indeterminate', state.percent == null);
    bar.style.width = `${state.percent == null ? 36 : Math.max(0, Math.min(100, state.percent))}%`;
    const phases = { preparing: 'Preparing', analyzing: 'Analyzing', 'pass-1': 'Pass 1', 'pass-2': 'Pass 2', encoding: 'Encoding', validating: 'Validating', retrying: 'Fitting the size target' };
    const phaseProgress = state.status === 'running' && Number.isFinite(state.phasePercent)
      ? `${Math.floor(state.phasePercent)}% of this phase${Number.isFinite(state.percent) ? ` · about ${Math.floor(state.percent)}% overall` : ' · overall progress indeterminate'}` : null;
    $('#conversion-status').textContent = [phases[state.phase], state.message, phaseProgress, state.failure?.explanation, state.failure?.help,
      state.cleanupPending ? 'Some temporary attempt files remain. Retry cleanup or Remove File.' : null].filter(Boolean).join(' · ');
    const submitted = current?.submitted, newer = submitted && submitted.draftRevision !== current.draftRevision;
    $('#processing-draft-status').textContent = current ? `Draft ${current.draftRevision}`
      + (newer ? ` · Newer settings or cuts. The submitted work remains draft ${submitted.draftRevision}.` : '')
      + (editor.hasPendingWork() ? ' · Pending cut selection is not applied until Remove Section.' : '') : '';
    const output = state.output;
    $('#conversion-output').hidden = !output;
    if (output) {
      const inspection = output.inspection || {}, video = inspection.video, audio = inspection.audio;
      $('#conversion-output-name').textContent = output.filename;
      $('#conversion-output-facts').textContent = [`${sizeInMB(output.size)} (${output.size.toLocaleString()} bytes)`, facts.formatDuration(inspection.durationSeconds), inspection.format,
        video && facts.familiarCodecName(video.codec), video && `${video.width} × ${video.height}`,
        video?.sampleAspectRatio && !['1:1', '1/1'].includes(video.sampleAspectRatio) && `Pixel aspect ${video.sampleAspectRatio} preserves display proportions`,
        audio && `${facts.familiarCodecName(audio.codec)} · ${audio.sampleRate} Hz · ${audio.channels} channels`].filter(Boolean).join(' · ');
      const revision = output.draftRevision ?? output.processingSnapshot?.draftRevision ?? output.provenance?.draftRevision;
      $('#conversion-output-target').textContent = `${output.noOp ? 'Existing original bytes; no processing required' : 'Processed from the original source'}`
        + (Number.isInteger(revision) ? ` · Draft ${revision}` : '')
        + (Number.isInteger(revision) && revision !== current?.draftRevision ? ' · Previous draft; this download has not changed.' : '');
      $('#conversion-download').href = output.downloadUrl; $('#conversion-download').download = output.filename;
      const processed = output.processingSnapshot, actualSettings = processed?.settings;
      $('#conversion-output-settings').textContent = actualSettings ? [video && rateDescription(actualSettings.rate),
        `Container: ${actualSettings.container === 'source' ? 'keep source' : actualSettings.container}`,
        video && `Requested ${actualSettings.videoCodec === 'unchanged' ? 'unchanged video codec' : facts.familiarCodecName(actualSettings.videoCodec)}`,
        video && (actualSettings.scale?.mode === 'fit' ? `Fit within ${actualSettings.scale.width} × ${actualSettings.scale.height}${actualSettings.scale.allowUpscale ? '' : ' · no upscale'}`
          : actualSettings.scale?.mode === 'percent' ? `Scale ${actualSettings.scale.percent}%`
            : ['width', 'height'].includes(actualSettings.scale?.mode) ? `Fit ${actualSettings.scale.mode} ${actualSettings.scale[actualSettings.scale.mode]}` : 'Scale unchanged'),
        video && (actualSettings.frameRate ? `${actualSettings.frameRate} fps requested` : 'Frame rate unchanged'),
        audio && (actualSettings.audio?.codec === 'unchanged' ? 'Audio codec unchanged' : `${facts.familiarCodecName(actualSettings.audio?.codec)} audio`),
        actualSettings.audio?.bitrateKbps ? `${actualSettings.audio.bitrateKbps} kbps audio` : null,
        output.effectiveVideoBitrate ? `Final video bitrate budget ${(output.effectiveVideoBitrate / 1000).toFixed(1)} kbps` : null,
        video?.bitRate > 0 ? `Measured video ${(video.bitRate / 1000).toFixed(1)} kbps average` : null,
        output.attempts > 1 ? `Size fitting used ${output.attempts} attempts` : null].filter(Boolean).join(' · ') : '';
    }
  }
  function accept(data) {
    if (!data || data.id !== workspaceId || discarding) return;
    snapshot = data; publish();
    if (data.playback?.url) previewError = null;
    const inspected = Boolean(data.inspection && data.sourceAssetId);
    ready.hidden = !inspected; intake.hidden = true; choose.disabled = true;
    progress.hidden = data.status === 'ready';
    $('#workspace-progress-label').textContent = data.message || 'Preparing local media…';
    const bar = $('#workspace-progress-bar'); bar.classList.toggle('indeterminate', data.percent == null);
    bar.style.width = `${data.percent == null ? 36 : Math.max(0, Math.min(100, data.percent))}%`;
    $('#workspace-failure').hidden = data.status !== 'error';
    if (data.status === 'error') {
      $('#workspace-failure-title').textContent = data.failure?.title || data.message;
      $('#workspace-failure-explanation').textContent = data.failure?.explanation || '';
      $('#workspace-failure-help').textContent = [data.failure?.help, data.cleanup?.message].filter(Boolean).join(' ');
    }
    if (inspected) {
      renderFacts(data); editor.update(data); editor.show(Boolean(data.editor?.eligible));
      if (!profile) { profile = profiles.create(data); profile.update({ editorState: editor.authoringState() }); invalidatePlan(); }
      if (data.conversion?.output) profile.acceptResult(data.conversion.output);
      renderSettings();
    }
    message(data.status === 'error' ? data.message : '', data.status === 'error');
    processingControls();
    if (inspected && data.status === 'ready' && data.editor?.eligible && !data.playback?.url
      && !data.activeOperation && !previewAttempted) preparePreview();
  }
  function connect(id, token) {
    closeSource();
    const eventSource = new root.EventSource(`/api/workspace/progress?workspace=${encodeURIComponent(id)}`); source = eventSource;
    eventSource.onmessage = event => {
      if (generation !== token || workspaceId !== id || source !== eventSource) return;
      try { accept(JSON.parse(event.data)); } catch { message('Unreadable local workspace update.', true); }
    };
    eventSource.onerror = () => { if (generation === token && workspaceId === id) message('Workspace connection interrupted; reconnecting…', true); };
  }
  async function removeOwned(id) {
    const response = await root.fetch(`/api/workspace?workspace=${encodeURIComponent(id)}`, { method: 'DELETE', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok && response.status !== 404) throw new Error(data.error || 'Remove File could not complete.');
    return data;
  }
  function hasTemporaryWork() { return Boolean(profile?.hasChanges() || editor.hasPendingWork() || snapshot?.activeOperation || snapshot?.playback || snapshot?.conversion?.output || snapshot?.editedOutput || upload || starting || retainedCleanupId); }
  async function discard() {
    if (discarding) return;
    if (hasTemporaryWork() && !root.confirm('Remove this file and discard its cuts, output settings, and temporary results? Any running work will be cancelled.')) return;
    if (!workspaceId) { reset('Local copy cancelled. Cleanup of any partial copy will be attempted.'); return; }
    const id = workspaceId, token = ++generation;
    discarding = true; planVersion++; clearTimeout(reviewTimer); reviewQueued = false;
    closeSource(); editor.show(false);
    const video = $('#editor-video'), playback = video.getAttribute('src'), time = video.currentTime;
    video.pause(); video.removeAttribute('src'); video.load();
    message('Removing local file…'); processingControls();
    try {
      const data = await removeOwned(id);
      if (generation !== token || workspaceId !== id) return;
      retainedCleanupId = data.cleanup && data.cleanup.status !== 'complete' ? id : null;
      reset(`Local file removed. ${data.cleanup?.message || ''}`); $('#workspace-retry-cleanup').hidden = !retainedCleanupId; choose.focus();
    } catch (error) {
      if (generation !== token || workspaceId !== id) return;
      discarding = false; operationRequest = false;
      if (playback) { video.src = playback; video.addEventListener('loadedmetadata', () => { if (workspaceId === id) video.currentTime = time; }, { once: true }); }
      connect(id, token); editor.show(Boolean(snapshot?.editor?.eligible)); invalidatePlan(); message(error.message, true); processingControls();
    }
  }
  function beginUpload(file) {
    if (!file || workspaceId || upload || starting || retainedCleanupId) return;
    if (!file.size || file.size > 100 * 1024 ** 3) return message('Choose one nonempty video or audio file up to 100 GiB.', true);
    const token = ++generation; intake.hidden = true; progress.hidden = false; choose.disabled = true;
    const xhr = new root.XMLHttpRequest(); upload = xhr; publish();
    xhr.open('POST', '/api/media/local'); xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-LVOVD-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = event => {
      if (generation !== token) return;
      $('#workspace-progress-label').textContent = `Copying ${file.name.slice(0, 255)} · ${facts.formatBytes(event.loaded)} / ${facts.formatBytes(file.size)}`;
      $('#workspace-progress-bar').style.width = `${Math.min(100, event.loaded / file.size * 100)}%`;
    };
    xhr.onerror = () => { if (generation === token) reset('The local file copy was interrupted.'); };
    xhr.onabort = () => { if (generation === token) reset('Local copy cancelled. Cleanup of the partial copy will be attempted.'); };
    xhr.onload = () => {
      let data; try { data = JSON.parse(xhr.responseText); } catch {}
      if (generation !== token) { if (data?.workspaceId) removeOwned(data.workspaceId).catch(() => {}); return; }
      upload = null;
      if (xhr.status < 200 || xhr.status >= 300 || !data?.workspaceId) { reset([data?.error || 'Local intake failed.', data?.cleanup?.message].filter(Boolean).join(' ')); return; }
      workspaceId = data.workspaceId; accept(data.workspace); connect(workspaceId, token);
    };
    xhr.send(file);
  }
  async function acquire(detail) {
    if (!detail || workspaceId || upload || starting || retainedCleanupId) { publish(); return; }
    const token = ++generation; starting = true; publish(); intake.hidden = true; progress.hidden = false;
    message('Acquiring the selected source once for local use…'); panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const data = await post('/api/workspace/url', detail);
      if (generation !== token) { if (data.workspaceId) await removeOwned(data.workspaceId); return; }
      starting = false; workspaceId = data.workspaceId; accept(data.workspace); connect(workspaceId, token);
    } catch (error) { if (generation === token) reset(error.message); }
  }
  function renderOptions(options) {
    if (!options) return;
    $('#processing-capability-note').textContent = options.checked === false
      ? 'Local capabilities could not be checked. Keep the original bytes, or retry the capability check to show available output choices.' : '';
    const choices = [
      ['#processing-video-codec', options.videoCodecs], ['#processing-container', options.containers], ['#processing-audio-codec', options.audioCodecs],
      ['#processing-frame-rate', [{ value: '', label: 'Unchanged' }, ...(options.frameRates || []).map(value => ({ value: String(value), label: `${value} fps` }))]],
      ['#processing-preset', (options.presets || []).map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }))]
    ];
    for (const [selector, entries] of choices) {
      if (!entries?.length) continue;
      const select = $(selector), chosen = select.value;
      select.replaceChildren();
      const defaultValue = selector === '#processing-container' ? 'source' : selector === '#processing-frame-rate' ? '' : selector === '#processing-preset' ? 'medium' : 'unchanged';
      for (const entry of entries) { const option = document.createElement('option'); option.value = entry.value; option.textContent = entry.label; option.defaultSelected = entry.value === defaultValue; select.append(option); }
      if (![...select.options].some(option => option.value === chosen)) {
        const option = document.createElement('option'); option.value = chosen; option.textContent = `${chosen} (unavailable)`; option.disabled = true; select.append(option);
      }
      select.value = chosen;
    }
  }
  function renderPlan() {
    $('#conversion-plan-title').textContent = plan.message;
    const list = $('#processing-plan-facts'); list.replaceChildren();
    appendFact(list, 'Source duration', facts.formatDuration(plan.inputDurationSeconds ?? snapshot.inspection.durationSeconds));
    appendFact(list, 'Retained duration', facts.formatDuration(plan.timing?.durationSeconds));
    const output = plan.output || {}, settings = plan.settings || profile.draft().settings;
    appendFact(list, 'Output', [output.videoCodec && facts.familiarCodecName(output.videoCodec), output.container || output.extension].filter(Boolean).join(' · ') || 'See review');
    if (output.width && output.height) appendFact(list, 'Dimensions', `${output.width} × ${output.height}${settings.scale?.mode !== 'unchanged' ? ' (adjusted to fit aspect)' : ''}${output.frameRate ? ` · ${output.frameRate} fps` : ''}`);
    if (output.sampleAspectRatio && !['1:1', '1/1'].includes(output.sampleAspectRatio)) appendFact(list, 'Pixel aspect', `${output.sampleAspectRatio} · preserves display proportions`);
    appendFact(list, 'Encoding', rateDescription(settings.rate));
    const estimate = plan.sizeEstimate;
    appendFact(list, 'Estimated size', estimate?.bytes != null ? `${sizeInMB(estimate.bytes)}${estimate.exact ? ' (exact original bytes)' : ' (approx.)'}` : estimate?.explanation || 'Size varies with quality and content');
    if (plan.rateBudget?.videoBitrate != null) appendFact(list, 'Video bitrate budget', `${(plan.rateBudget.videoBitrate / 1000).toFixed(1)} kbps`);
    if (plan.rateBudget?.audioBitsPerSecond != null) appendFact(list, 'Audio budget', `${(plan.rateBudget.audioBitsPerSecond / 1000).toFixed(1)} kbps · ${sizeInMB(plan.rateBudget.audioBytes)}`);
    if (plan.rateBudget?.overheadBytes != null) appendFact(list, 'Container reserve', sizeInMB(plan.rateBudget.overheadBytes));
    appendFact(list, 'Audio', output.audioCodec ? `${facts.familiarCodecName(output.audioCodec)}${settings.audio?.bitrateKbps ? ` · ${settings.audio.bitrateKbps} kbps` : ''} · ${plan.streams?.find(stream => stream.role === 'audio')?.action || 'unchanged'}` : 'No audio output');
    $('#conversion-changes').replaceChildren(); $('#conversion-warnings').replaceChildren();
    for (const change of plan.changes || []) { const item = document.createElement('li'); item.textContent = change; $('#conversion-changes').append(item); }
    for (const warning of plan.warnings || []) {
      const label = document.createElement('label'), text = document.createElement('span'); text.textContent = warning.message; label.className = 'conversion-warning';
      if (warning.required !== false) { const box = document.createElement('input'); box.type = 'checkbox'; box.required = true; box.value = warning.id; box.addEventListener('change', processingControls); label.append(box); }
      label.append(text); $('#conversion-warnings').append(label);
    }
    $('#processing-filename-preview').textContent = plan.downloadFilename || snapshot.source?.name || '';
    renderEstimates(); renderOptions(plan.options); renderSettings();
  }
  async function reviewPlan() {
    clearTimeout(reviewTimer);
    if (!workspaceId || !profile || discarding) return;
    if (reviewInFlight) { reviewQueued = true; return; }
    reviewQueued = false;
    if (!settingsForm.checkValidity()) { planBusy = false; $('#conversion-plan-title').textContent = 'Enter valid values in the output settings.'; processingControls(); return; }
    const token = generation, version = planVersion, submittedDraft = profile.draft();
    reviewInFlight = true; planBusy = true; retry.hidden = true; clearTimeout(retryTimer); processingControls();
    try {
      const data = await post('/api/processing/plan', submittedDraft);
      if (token !== generation || version !== planVersion || submittedDraft.draftRevision !== profile?.draft().draftRevision) return;
      plan = data.plan; renderPlan();
      if (plan.reason === 'capability-check' || plan.options?.checked === false) {
        retry.hidden = false; retry.disabled = true; retry.textContent = 'Retry Capability Check (available in 30 seconds)';
        retryTimer = setTimeout(() => { if (token === generation && version === planVersion) { retry.disabled = false; retry.textContent = 'Retry Capability Check'; } }, 30000);
      }
    } catch (error) { if (token === generation && version === planVersion) $('#conversion-plan-title').textContent = error.message; }
    finally {
      reviewInFlight = false;
      if (token === generation && version === planVersion) { planBusy = false; processingControls(); }
      if (reviewQueued && workspaceId && !discarding) reviewTimer = setTimeout(reviewPlan, 300);
    }
  }
  async function preparePreview() {
    if (!profile || !snapshot?.editor?.eligible || snapshot?.playback?.url || snapshot?.activeOperation || previewRequest || discarding) return;
    const token = generation; previewRequest = true; previewAttempted = true; previewError = null; processingControls();
    try { const data = await post('/api/workspace/editor', { workspaceId, sourceAssetId: snapshot.sourceAssetId }); if (token === generation) accept(data.workspace); }
    catch (error) { if (token === generation && !snapshot?.playback?.url) previewError = error.message; }
    finally { if (token === generation) { previewRequest = false; processingControls(); } }
  }
  $('#processing-prepare-preview').addEventListener('click', preparePreview);
  $('#processing-file-list').addEventListener('change', () => {
    // Selection belongs to this one original source. Re-selecting never resets
    // its profile or reacquires media; playback preparation is idempotent.
    if (!previewAttempted) preparePreview();
  });
  settingsForm.addEventListener('submit', event => event.preventDefault());
  function settingsChanged(event) {
    if (event.target.id === 'processing-video-bitrate') settingsForm.querySelector('[name="processing-rate"][value="bitrate"]').checked = true;
    if (event.target.id === 'processing-maximum-mb') settingsForm.querySelector('[name="processing-rate"][value="size"]').checked = true;
    if (event.target.name === 'processing-rate') {
      if (rateMode() === 'bitrate' && !$('#processing-video-bitrate').value) $('#processing-video-bitrate').value = '2000';
      if (rateMode() === 'size' && !$('#processing-maximum-mb').value) $('#processing-maximum-mb').value = '10';
    }
    refreshDraft();
  }
  settingsForm.addEventListener('change', settingsChanged); settingsForm.addEventListener('input', settingsChanged);
  for (const id of ['processing-suffix-enabled', 'processing-filename-suffix']) {
    $(`#${id}`).addEventListener('change', refreshDraft); $(`#${id}`).addEventListener('input', refreshDraft);
  }
  document.addEventListener('lvovd:editor-plan-changed', refreshDraft);
  document.addEventListener('lvovd:editor-state-changed', () => { if (profile) { profile.update({ editorState: editor.authoringState() }); processingControls(); } });
  $('#processing-reset').addEventListener('click', () => {
    if (!profile) return;
    if ((profile.hasChanges() || editor.hasPendingWork()) && !root.confirm('Reset this file’s cuts and output settings? The original source and any previous download will be kept.')) return;
    resetting = true; settingsForm.reset(); editor.resetFile(); profile.reset(); resetting = false;
    profile.update({ editorState: editor.authoringState() }); invalidatePlan(); renderSettings(); processingControls();
  });
  retry.addEventListener('click', reviewPlan);
  start.addEventListener('click', async () => {
    if (start.disabled) return;
    if (!settingsForm.reportValidity()) return;
    if (!plan) { await reviewPlan(); return; }
    const token = generation, reviewed = plan, submitted = profile.submit(reviewed);
    operationRequest = true; processingControls();
    try {
      const data = await post('/api/processing/start', { ...submitted,
        acknowledgedWarnings: [...$('#conversion-warnings').querySelectorAll('input:checked')].map(box => box.value) });
      if (token === generation) accept(data.workspace);
    } catch (error) { if (token === generation) { $('#conversion-plan-title').textContent = error.message; plan = null; } }
    finally { if (token === generation) { operationRequest = false; processingControls(); } }
  });
  for (const [button, endpoint] of [[cancel, '/api/conversion/cancel'], [$('#conversion-cleanup'), '/api/conversion/cleanup']]) {
    button.addEventListener('click', async () => {
      const token = generation; button.disabled = true;
      try { const data = await post(endpoint, { workspaceId }); if (token === generation) accept(data.workspace); }
      catch (error) { if (token === generation) $('#conversion-status').textContent = error.message; }
      finally { if (token === generation) processingControls(); }
    });
  }
  $('#workspace-retry-cleanup').addEventListener('click', async () => {
    const button = $('#workspace-retry-cleanup'), id = retainedCleanupId; if (!id) return; button.disabled = true;
    try { const data = await removeOwned(id); if (!data.cleanup || data.cleanup.status === 'complete') { retainedCleanupId = null; button.hidden = true; choose.disabled = false; publish(); } message(data.cleanup?.message || 'Temporary cleanup complete.'); }
    catch (error) { message(error.message, true); }
    finally { button.disabled = false; }
  });
  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files?.length !== 1) message('Choose exactly one local video or audio file.', true); else beginUpload(input.files[0]); });
  for (const selector of ['#workspace-discard', '#workspace-cancel', '#workspace-failure-discard']) $(selector).addEventListener('click', discard);
  for (const name of ['dragenter', 'dragover']) panel.addEventListener(name, event => { event.preventDefault(); if (!workspaceId && !upload) intake.classList.add('dragover'); });
  panel.addEventListener('dragleave', () => intake.classList.remove('dragover'));
  panel.addEventListener('drop', event => {
    event.preventDefault(); intake.classList.remove('dragover');
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length !== 1) message('Choose exactly one local video or audio file. No files were added.', true);
    else if (workspaceId || upload || starting || retainedCleanupId) message('Remove the current file before adding another. No files were added.', true);
    else beginUpload(files[0]);
  });
  root.addEventListener('beforeunload', event => { if (hasTemporaryWork()) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('lvovd:workspace-acquire-url', event => acquire(event.detail));
  root.LVOVDLocalWorkspace = { accept, profileState() { if (profile) profile.update({ editorState: editor.authoringState() }); return profile?.state() || null; } };
  publish();
})(typeof globalThis !== 'undefined' ? globalThis : this);
