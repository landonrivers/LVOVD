'use strict';

(function attachLocalWorkspace(root) {
  if (!root.document) return;
  const document = root.document, $ = selector => document.querySelector(selector);
  const panel = $('#media-workspace-panel');
  if (!panel) return;
  const editor = root.LVOVDEditorView, facts = root.LVOVDMediaFacts;
  const intake = $('#media-drop-zone'), input = $('#media-file-input'), choose = $('#media-choose-button');
  const ready = $('#local-media-ready'), status = $('#workspace-status'), progress = $('#workspace-progress');
  const editButton = $('#local-open-editor'), convertButton = $('#local-open-converter');
  const converter = $('#media-converter'), target = $('#conversion-target'), start = $('#conversion-start');
  const retry = $('#conversion-retry'), cancel = $('#conversion-cancel');
  let generation = 0, workspaceId = null, snapshot = null, upload = null, starting = false, source = null;
  let view = null, plan = null, planRequest = 0, retryTimer = null, planBusy = false;
  let operationRequest = false, discarding = false;

  function publish() {
    document.dispatchEvent(new root.CustomEvent('lvovd:workspace-state', { detail: {
      active: Boolean(workspaceId || upload || starting), status: snapshot?.status || (upload ? 'uploading' : starting ? 'starting' : 'idle'),
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
  function identity() { return { workspaceId, sourceAssetId: snapshot?.sourceAssetId }; }
  function reset(text = '') {
    generation++; planRequest++;
    closeSource(); clearTimeout(retryTimer); retryTimer = null;
    const oldUpload = upload; upload = null; oldUpload?.abort();
    workspaceId = null; snapshot = null; starting = false; view = null; plan = null; planBusy = false; operationRequest = false; discarding = false;
    editor.reset(); converter.hidden = true; ready.hidden = true; intake.hidden = false; choose.disabled = false; input.value = '';
    progress.hidden = true; $('#workspace-failure').hidden = true; $('#conversion-output').hidden = true;
    $('#conversion-download').removeAttribute('href'); $('#conversion-warnings').replaceChildren();
    target.value = 'broad-compatibility-mp4'; message(text); publish();
  }
  function renderFacts(data) {
    $('#local-media-name').textContent = data.source?.name || 'Local media';
    const inspection = data.inspection || {};
    $('#local-media-summary').textContent = [facts.mediaKindLabel(inspection.mediaKind), inspection.format,
      inspection.video && facts.familiarCodecName(inspection.video.codec), inspection.audio && facts.familiarCodecName(inspection.audio.codec),
      facts.formatDuration(inspection.durationSeconds)].filter(Boolean).join(' · ');
    const list = $('#conversion-facts'); list.replaceChildren();
    for (const [label, value] of facts.inspectionFacts(data)) {
      const item = document.createElement('div'), term = document.createElement('dt'), description = document.createElement('dd');
      term.textContent = label; description.textContent = value; item.append(term, description); list.append(item);
    }
  }
  function conversionControls() {
    const state = snapshot?.conversion || {};
    const busy = Boolean(snapshot?.activeOperation || operationRequest);
    const acknowledged = [...$('#conversion-warnings').querySelectorAll('input')].every(box => box.checked);
    start.disabled = planBusy || busy || !plan || !['executable', 'no-op'].includes(plan.status) || !acknowledged || state.cleanupPending;
    start.textContent = plan?.status === 'no-op' ? 'Use Existing File' : 'Create Converted File';
    cancel.hidden = !['running', 'validating', 'cancelling'].includes(state.status);
    cancel.disabled = state.status === 'cancelling';
    target.disabled = Boolean(snapshot?.activeOperation || operationRequest);
    $('#conversion-cleanup').hidden = !state.cleanupPending;
    $('#conversion-progress').hidden = !['running', 'validating', 'cancelling'].includes(state.status);
    const bar = $('#conversion-progress-bar'); bar.classList.toggle('indeterminate', state.percent == null);
    bar.style.width = `${state.percent == null ? 36 : Math.max(0, Math.min(100, state.percent))}%`;
    $('#conversion-status').textContent = [state.message, state.failure?.explanation, state.failure?.help,
      state.cleanupPending ? 'Some temporary conversion files remain owned. Retry cleanup or Discard.' : null].filter(Boolean).join(' ');
    const output = state.output;
    $('#conversion-output').hidden = !output;
    if (output) {
      $('#conversion-output-name').textContent = output.filename;
      $('#conversion-output-facts').textContent = [facts.formatBytes(output.size), facts.formatDuration(output.inspection?.durationSeconds),
        output.inspection?.video && `${output.inspection.video.width} × ${output.inspection.video.height}`,
        output.inspection?.audio && `${facts.familiarCodecName(output.inspection.audio.codec)} · ${output.inspection.audio.sampleRate} Hz · ${output.inspection.audio.channels} channels`].filter(Boolean).join(' · ');
      const label = [...target.options].find(option => option.value === output.targetId)?.textContent || output.targetId;
      $('#conversion-output-target').textContent = `${output.noOp ? 'Existing source bytes' : 'Converted original source'} · ${label}${target.value !== output.targetId ? ' · Previous target; this download has not changed.' : ''}`;
      $('#conversion-download').href = output.downloadUrl; $('#conversion-download').download = output.filename;
    }
  }
  function showView(next, focus = false) {
    view = next;
    editor.show(next === 'edit'); converter.hidden = next !== 'convert';
    editButton.setAttribute('aria-pressed', String(next === 'edit')); convertButton.setAttribute('aria-pressed', String(next === 'convert'));
    $('#conversion-cuts-note').hidden = !editor.hasCuts();
    if (focus) (next === 'convert' ? target : $('#editor-video')).focus({ preventScroll: true });
  }
  function accept(data) {
    if (!data || data.id !== workspaceId || discarding) return;
    snapshot = data; publish();
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
      renderFacts(data);
      editButton.hidden = !data.editor?.eligible;
      convertButton.hidden = !data.inspection.video && !data.inspection.audio;
      editButton.disabled = Boolean(data.activeOperation) && data.editor?.status !== 'ready'; convertButton.disabled = data.status !== 'ready' && !view;
      $('#conversion-input').textContent = `Input: Original source — ${data.source.name}`;
      editor.update(data); showView(view);
    }
    message(data.editor?.status === 'failed' ? `${data.editor.message} The original source remains available for conversion.` : data.message, data.status === 'error');
    conversionControls();
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
    if (!response.ok && response.status !== 404) throw new Error(data.error || 'Discard could not complete.');
    return data;
  }
  async function discard() {
    if (discarding) return;
    if (!workspaceId) { reset('Local copy cancelled. Cleanup of any partial copy will be attempted.'); return; }
    const id = workspaceId, token = ++generation;
    discarding = true; planRequest++;
    closeSource(); editor.show(false);
    // Release owned playback readers before asking the server to delete files.
    const video = $('#editor-video'), playback = video.getAttribute('src'), time = video.currentTime;
    video.pause(); video.removeAttribute('src'); video.load();
    message('Discarding local workspace…');
    try {
      const data = await removeOwned(id);
      if (generation !== token || workspaceId !== id) return;
      reset(`Local workspace discarded. ${data.cleanup?.message || ''}`); choose.focus();
    } catch (error) {
      if (generation !== token || workspaceId !== id) return;
      discarding = false; planBusy = false; operationRequest = false;
      if (playback) { video.src = playback; video.addEventListener('loadedmetadata', () => { if (workspaceId === id) video.currentTime = time; }, { once: true }); }
      connect(id, token); showView(view); message(error.message, true);
    }
  }
  function beginUpload(file) {
    if (!file || workspaceId || upload || starting) return;
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
    if (!detail || workspaceId || upload || starting) { publish(); return; }
    const token = ++generation; starting = true; view = 'edit'; publish(); intake.hidden = true; progress.hidden = false;
    message('Acquiring the selected source once for local use…'); panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const data = await post('/api/workspace/url', detail);
      if (generation !== token) { if (data.workspaceId) await removeOwned(data.workspaceId); return; }
      starting = false; workspaceId = data.workspaceId; accept(data.workspace); connect(workspaceId, token);
    } catch (error) { if (generation === token) reset(error.message); }
  }
  async function reviewPlan() {
    if (!workspaceId || !snapshot?.sourceAssetId) return;
    const token = generation, request = ++planRequest, targetId = target.value;
    plan = null; planBusy = true; retry.hidden = true; clearTimeout(retryTimer);
    $('#conversion-warnings').replaceChildren(); $('#conversion-changes').replaceChildren();
    $('#conversion-plan-title').textContent = 'Checking the selected target…'; conversionControls();
    try {
      const data = await post('/api/conversion/plan', { ...identity(), targetId });
      if (token !== generation || request !== planRequest || target.value !== targetId) return;
      plan = data.plan; $('#conversion-plan-title').textContent = plan.message;
      for (const change of plan.changes) { const item = document.createElement('li'); item.textContent = change; $('#conversion-changes').append(item); }
      for (const warning of plan.warnings) {
        const label = document.createElement('label'), box = document.createElement('input'), text = document.createElement('span');
        box.type = 'checkbox'; box.value = warning.id; box.addEventListener('change', conversionControls); text.textContent = warning.message;
        label.className = 'conversion-warning'; label.append(box, text); $('#conversion-warnings').append(label);
      }
      if (plan.reason === 'capability-check') {
        retry.hidden = false; retry.disabled = true; retry.textContent = 'Retry Capability Check (available in 30 seconds)';
        retryTimer = setTimeout(() => { if (token === generation && request === planRequest) { retry.disabled = false; retry.textContent = 'Retry Capability Check'; } }, 30000);
      }
    } catch (error) { if (token === generation && request === planRequest) $('#conversion-plan-title').textContent = error.message; }
    finally { if (token === generation && request === planRequest) { planBusy = false; conversionControls(); } }
  }
  editButton.addEventListener('click', async () => {
    const token = generation;
    showView('edit');
    if (snapshot?.editor?.status === 'ready') { showView('edit', true); return; }
    editButton.disabled = true;
    try { const data = await post('/api/workspace/editor', identity()); if (token === generation) accept(data.workspace); }
    catch (error) { if (token === generation) { message(error.message, true); editButton.disabled = false; } }
  });
  convertButton.addEventListener('click', () => { showView('convert', true); if (!plan && !planBusy) { if (!snapshot?.inspection.video) target.value = 'm4a-aac'; reviewPlan(); } });
  target.addEventListener('change', reviewPlan); retry.addEventListener('click', reviewPlan);
  start.addEventListener('click', async () => {
    if (!plan || start.disabled) return;
    const token = generation; operationRequest = true; conversionControls();
    try {
      const data = await post('/api/conversion/start', { ...identity(), targetId: target.value, planKey: plan.key,
        acknowledgedWarnings: [...$('#conversion-warnings').querySelectorAll('input:checked')].map(box => box.value) });
      if (token === generation) accept(data.workspace);
    } catch (error) { if (token === generation) { $('#conversion-plan-title').textContent = error.message; plan = null; } }
    finally { if (token === generation) { operationRequest = false; conversionControls(); } }
  });
  for (const [button, endpoint] of [[cancel, '/api/conversion/cancel'], [$('#conversion-cleanup'), '/api/conversion/cleanup']]) {
    button.addEventListener('click', async () => {
      const token = generation; button.disabled = true;
      try { const data = await post(endpoint, { workspaceId }); if (token === generation) accept(data.workspace); }
      catch (error) { if (token === generation) $('#conversion-status').textContent = error.message; }
      finally { if (token === generation) button.disabled = false; }
    });
  }
  choose.addEventListener('click', () => input.click()); input.addEventListener('change', () => beginUpload(input.files?.[0]));
  for (const selector of ['#workspace-discard', '#workspace-cancel', '#workspace-failure-discard']) $(selector).addEventListener('click', discard);
  for (const name of ['dragenter', 'dragover']) intake.addEventListener(name, event => { event.preventDefault(); if (!workspaceId && !upload) intake.classList.add('dragover'); });
  intake.addEventListener('dragleave', () => intake.classList.remove('dragover'));
  intake.addEventListener('drop', event => { event.preventDefault(); intake.classList.remove('dragover'); const files = [...(event.dataTransfer?.files || [])]; if (files.length !== 1) message('Choose one local video or audio file.', true); else beginUpload(files[0]); });
  document.addEventListener('lvovd:workspace-acquire-url', event => acquire(event.detail));
  root.LVOVDLocalWorkspace = { accept };
  publish();
})(typeof globalThis !== 'undefined' ? globalThis : this);
