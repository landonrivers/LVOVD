'use strict';
(async function () {
  const native = globalThis.LVOVDNative;
  const el = id => document.getElementById(id);
  const url = el('download-url'), message = el('download-message');
  const previewButton = el('download-preview-button'), start = el('download-start');
  const edit = el('download-edit-source'), editNote = el('download-edit-note');
  const folders = [el('download-choose-folder'), el('settings-choose-folder')];
  const rows = new Map();
  const states = { queued: 'Queued', downloading: 'Downloading', processing: 'Processing',
    saving: 'Saving', saved: 'Saved', saveFailed: 'Save failed', failed: 'Failed', cancelling: 'Cancelling', cancelled: 'Cancelled' };
  let ready = false, choosing = false, submitting = false, previewing = false;
  let openingEditor = false, intakeBusy = false;
  let destination = null, preview = null, previewGeneration = 0, revision = -1;

  const options = globalThis.LVOVDDownloadOptions(controls);
  function controls() {
    previewButton.disabled = !ready || previewing || !url.value.trim();
    start.disabled = !ready || choosing || submitting || !destination || !(preview && (preview.choices ? options.valid() : preview.canDownload));
    const choices = preview?.choices;
    const content = choices?.available ? options.editorSource().content : null;
    const video = content === 'av' || content === 'video';
    edit.disabled = !ready || openingEditor || intakeBusy || !video || !choices[content];
    editNote.textContent = !choices?.available ? '' : openingEditor || intakeBusy ? 'Local Media is adding files.' :
      video ? 'Edit opens the full source. Ranges, extras and SponsorBlock apply to Download.' :
      choices.av || choices.video ? 'Choose Video + Audio or Video Only to edit the source.' : 'This source has no editable video.';
    for (const button of folders) button.disabled = !ready || choosing;
    for (const id of ['settings-folder', 'download-folder']) el(id).textContent = destination?.path || 'Choose a folder';
    for (const row of rows.values()) row.retry.disabled = !destination || choosing || row.pending;
  }
  function resetPreview() {
    previewGeneration++;
    previewing = false;
    preview = null;
    el('download-preview').hidden = true;
    el('download-artwork').removeAttribute('src');
    message.textContent = '';
    controls();
  }
  function time(seconds) {
    const n = Math.ceil(seconds);
    const hours = Math.floor(n / 3600), minutes = Math.floor(n / 60) % 60;
    return (hours ? hours + ':' + String(minutes).padStart(2, '0') : minutes) + ':' + String(n % 60).padStart(2, '0');
  }
  function renderPreview(value) {
    preview = value;
    el('download-preview').hidden = false;
    el('download-title').textContent = value.title;
    el('download-facts').textContent = [value.source, Number.isFinite(value.duration) ? time(value.duration) : 'Duration unknown',
      value.choices ? '' : value.profile === 'compatible' ? 'Compatible MP4' : 'Maximum Quality'].filter(Boolean).join(' · ');
    el('download-filename').textContent = value.canDownload ? value.filename : '';
    options.reset(value);
    const artwork = el('download-artwork');
    const hasArt = typeof value.artwork === 'string' && /^data:image\/(?:jpeg|png|webp);base64,/.test(value.artwork);
    artwork.hidden = !hasArt;
    if (hasArt) artwork.src = value.artwork;
    else artwork.removeAttribute('src');
    message.textContent = (value.choices?.available ? '' : value.message) || (destination ? '' : 'Choose an output folder to download this video.');
  }
  url.addEventListener('input', resetPreview);
  el('download-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (previewButton.disabled) return;
    resetPreview();
    const generation = previewGeneration;
    previewing = true;
    message.textContent = 'Reading source information…';
    controls();
    try {
      const value = await native.call('preview_download', { request: { url: url.value.trim() } });
      if (generation === previewGeneration) renderPreview(value);
    } catch (error) {
      if (generation === previewGeneration) message.textContent = error.message;
    } finally {
      if (generation === previewGeneration) { previewing = false; controls(); }
    }
  });
  async function choose() {
    if (choosing) return;
    choosing = true; controls();
    const status = el('desktop-settings').hidden ? message : el('settings-message');
    try {
      const choice = await native.call('choose_download_destination');
      if (choice) { destination = choice; status.textContent = ''; }
    } catch (error) { status.textContent = error.message; }
    finally { choosing = false; controls(); }
  }
  for (const button of folders) button.addEventListener('click', choose);
  document.addEventListener('lvovd:workspace-state', event => {
    intakeBusy = Boolean(event.detail.nativeImporting);
    controls();
  });
  edit.addEventListener('click', async () => {
    if (edit.disabled) return;
    const generation = previewGeneration, previewId = preview.previewId;
    const selection = options.editorSource();
    openingEditor = true; controls();
    try {
      // Let button activation finish before moving keyboard focus to Local Media.
      await Promise.resolve();
      if (generation !== previewGeneration) return;
      const local = el('desktop-local');
      local.focus({ preventScroll: true });
      local.scrollIntoView({ block: 'start' });
      await globalThis.LVOVDLocalWorkspace.openDownloadSource(previewId, selection, () => generation === previewGeneration);
    } catch (error) {
      if (generation === previewGeneration) message.textContent = error.message;
    } finally { openingEditor = false; controls(); }
  });
  start.addEventListener('click', async () => {
    if (start.disabled) return;
    const generation = previewGeneration;
    submitting = true; controls();
    try {
      const snapshot = await native.call('start_download', { request: { previewId: preview.previewId, destinationId: destination.id, ...(preview.choices ? {options:options.read()} : {}) } });
      render(snapshot);
      if (generation === previewGeneration) message.textContent = 'Added to the download queue.';
    } catch (error) { if (generation === previewGeneration) message.textContent = error.message; }
    finally { submitting = false; controls(); }
  });
  function child(parent, tag) {
    const node = document.createElement(tag);
    parent.append(node);
    return node;
  }
  function createRow(id) {
    const li = child(el('download-jobs'), 'li');
    const row = { li, title: child(li, 'strong'), status: child(li, 'p'), meter: child(li, 'div'),
      path: child(li, 'p'), failure: child(li, 'p'), note: child(li, 'p'), pending: false };
    li.dataset.jobId = id;
    row.status.className = 'download-job-status';
    row.meter.className = 'progress-track';
    row.meter.setAttribute('role', 'progressbar');
    row.fill = child(row.meter, 'div');
    row.fill.className = 'progress-bar';
    row.note.setAttribute('role', 'status');
    const actions = child(li, 'div');
    actions.className = 'download-job-actions';
    for (const [key, label, command] of [
      ['cancel', 'Cancel', 'cancel_download'], ['retry', 'Retry Save', 'retry_download_save'],
      ['open', 'Open File', 'open_download'], ['reveal', 'Show in Folder', 'reveal_download']
    ]) {
      const button = row[key] = child(actions, 'button');
      button.dataset.action = key;
      button.type = 'button'; button.textContent = label; button.className = 'text-button';
      button.addEventListener('click', async () => {
        if (row.pending || (key === 'retry' && !destination)) return;
        row.pending = true; button.disabled = true; row.note.textContent = '';
        try {
          const request = { jobId: id };
          if (['open','reveal'].includes(key) && row.files.options.length>1) request.index=row.files.selectedIndex;
          if (key === 'retry') request.destinationId = destination.id;
          const result = await native.call(command, { request });
          if (result) render(result);
        } catch (error) { row.note.textContent = error.message; }
        finally { row.pending = false; button.disabled = false; controls(); }
      });
    }
    row.files = child(actions,'select');
    row.files.setAttribute('aria-label','Saved output');
    row.files.addEventListener('change',()=>{ row.path.textContent=row.files.selectedOptions[0]?.dataset.path || ''; });
    return row;
  }
  function render(snapshot) {
    if (snapshot.revision <= revision) return;
    revision = snapshot.revision;
    const seen = new Set();
    for (const job of snapshot.jobs) {
      const row = rows.get(job.jobId) || createRow(job.jobId);
      rows.set(job.jobId, row); seen.add(job.jobId);
      row.title.textContent = job.title;
      row.li.dataset.status = job.status;
      const progress = job.progress;
      const stage = states[job.status] || job.status;
      const details = [stage];
      const percent = job.status === 'saved' ? 100 : job.status === 'downloading' ? progress?.percent : null;
      row.meter.hidden = !['downloading', 'processing', 'saving', 'cancelling', 'saved'].includes(job.status);
      row.meter.setAttribute('aria-label', stage + ' · ' + job.title);
      globalThis.LVOVDProgress(row.fill, percent);
      if (job.status === 'downloading' && progress) {
        if (Number.isFinite(percent)) details.push(Math.floor(percent) + '%');
        if (Number.isFinite(progress.speed)) details.push((progress.speed / 1048576).toFixed(1) + ' MiB/s');
        if (Number.isFinite(progress.eta)) details.push(time(progress.eta) + ' remaining');
      }
      row.status.textContent = details.join(' · ');
      row.path.textContent = [job.savedName || job.filename, job.destination].filter(Boolean).join(' · ');
      row.failure.textContent = typeof job.error === 'string' ? job.error : job.error?.message || '';
      row.cancel.hidden = !['queued', 'downloading', 'processing'].includes(job.status);
      row.retry.hidden = job.status !== 'saveFailed';
      const files = job.savedFiles || [];
      while(row.files.options.length<files.length) {
        const index=row.files.options.length;
        const file=files[index], option=new Option(file.name,String(index));
        option.dataset.path=file.name+' · '+file.folder;
        row.files.add(option);
      }
      if (files.length) row.path.textContent=row.files.selectedOptions[0]?.dataset.path || '';
      row.files.hidden=files.length<2;
      row.open.hidden = row.reveal.hidden = job.status !== 'saved' && !files.length;
      row.retry.disabled = !destination || choosing || row.pending;
    }
    for (const [id, row] of rows) if (!seen.has(id)) { row.li.remove(); rows.delete(id); }
    el('download-queue').hidden = !rows.size;
  }
  try {
    const handshake = await globalThis.LVOVDWorkspaceTransport.ready;
    destination = await native.call('download_destination');
    const channel = new globalThis.__TAURI__.core.Channel();
    let connectionId;
    function receive(value) {
      if (value.connectionId !== connectionId) return;
      render(value.snapshot);
      native.call('acknowledge_downloads', { request: { connectionId, revision: value.snapshot.revision } })
        .catch(error => { message.textContent = error.message; });
    }
    channel.onmessage = receive;
    const initial = await native.call('subscribe_downloads', { request: { generation: handshake.downloadGeneration + 1 }, channel });
    connectionId = initial.connectionId; receive(initial);
    ready = true; controls();
  } catch (error) { message.textContent = error.message; }
})();
