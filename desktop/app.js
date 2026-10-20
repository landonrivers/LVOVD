'use strict';
(async function desktop() {
  const native = globalThis.LVOVDNative, byId = id => document.getElementById(id);
  let sources = [], selected = null, revision = -1, queueRevision = -1, selectionGeneration = 0, operation = 0, healthGeneration = 0;
  let workbenchId = null, workbenchGeneration = 0, importing = false, discarded = false;
  let pendingSelection = null;
  const cleanup = new Set();
  function message(text, error = false) { byId('status').textContent = text; byId('status').classList.toggle('error', error); }
  function select(id) {
    if (id === selected) return;
    selectionGeneration++; selected = id;
    const player = byId('player'); player.pause(); player.removeAttribute('src'); player.load();
    const source = sources.find(s => s.assetId === id);
    byId('files').value = id || ''; byId('remove-file').disabled = !source;
    byId('media-name').textContent = source?.name || 'Choose local media to begin';
    byId('details').replaceChildren();
    byId('duration').textContent = '';
    if (!source) return;
    for (const [label, value] of [['Container', source.inspection.format], ['Size', `${(source.size / 1024 / 1024).toFixed(2)} MiB`], ...source.inspection.streams.map(s => [s.kind, [s.codec, s.sampleRate && `${s.sampleRate} Hz`, s.channelLayout, s.sampleFormat, s.bitsPerRawSample && `${s.bitsPerRawSample} meaningful bits`].filter(Boolean).join(' · ')])]) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value || 'Unknown'; byId('details').append(dt, dd);
    }
    message('');
    if (source.inspection.mime) player.src = native.mediaUrl(id);
    else message('This preview cannot play this file type. Choose another file.');
  }
  function snapshot(value) {
    if (!value) { refreshWorkbenches(true).catch(error => message(error.message, true)); return; }
    if (value.workbenchId !== workbenchId || !Number.isSafeInteger(value.revision) ||
      value.revision < revision || value.queueRevision < queueRevision ||
      (value.revision === revision && value.queueRevision === queueRevision)) return;
    revision = value.revision; queueRevision = value.queueRevision;
    sources = value.sources; importing = value.importing; discarded = value.discarded;
    byId('add-file').disabled = importing || discarded;
    byId('discard-workbench').disabled = discarded;
    cleanup.clear(); for (const id of value.cleanup) cleanup.add(id); cleanupControls();
    byId('files').replaceChildren(...sources.map(s => { const option = document.createElement('option'); option.value = s.assetId; option.textContent = s.name; return option; }));
    if (pendingSelection && pendingSelection.generation === selectionGeneration && sources.some(s => s.assetId === pendingSelection.id)) {
      const id = pendingSelection.id; pendingSelection = null; select(id);
    } else if (!sources.some(s => s.assetId === selected)) select(sources[0]?.assetId || null);
    else byId('files').value = selected;
  }
  function cleanupControls() {
    byId('cleanup').replaceChildren(...[...cleanup].map(id => {
      const button = document.createElement('button'); button.textContent = 'Retry temporary-file cleanup';
      button.onclick = async () => {
        const id = workbenchId, generation = workbenchGeneration;
        button.disabled = true;
        try {
          const result = await native.call('cleanup_workbench', { request: { workbenchId: id } });
          if (generation === workbenchGeneration) snapshot(result);
        }
        catch { /* Keep the cleanup reachable without replacing another file's status. */ }
        if (generation === workbenchGeneration) cleanupControls();
      };
      return button;
    }));
  }
  byId('files').onchange = event => select(event.target.value);
  byId('add-file').onclick = async () => {
    const current = ++operation, generation = selectionGeneration, owner = workbenchId; byId('add-file').disabled = true;
    message('Opening file…');
    try {
      const result = await native.call('pick_source', { request: { workbenchId: owner } });
      const source = result?.sources.at(-1);
      if (current === operation && owner === workbenchId && source && generation === selectionGeneration) {
        // The command response and progress channel can arrive in either order.
        // Membership comes only from the authoritative snapshot.
        if (sources.some(s => s.assetId === source.assetId)) select(source.assetId);
        else pendingSelection = { id: source.assetId, generation };
      }
      if (current === operation && generation === selectionGeneration) message(result?.failure?.message || '', !!result?.failure);
    } catch (error) { if (current === operation && generation === selectionGeneration) message(error.message, true); }
    finally { if (owner === workbenchId) byId('add-file').disabled = importing || discarded; }
  };
  byId('remove-file').onclick = async () => {
    const id = selected; if (!id) return;
    const current = ++operation, owner = workbenchId, priorRevision = revision; select(null);
    const generation = selectionGeneration;
    try {
      const result = await native.call('remove_source', { request: { workbenchId: owner, sourceId: id } });
      if (owner === workbenchId) snapshot(result);
    }
    catch (error) { if (current === operation && owner === workbenchId && generation === selectionGeneration && revision === priorRevision) message(error.message, true); }
  };
  async function switchWorkbench(id) {
    const generation = ++workbenchGeneration;
    operation++; workbenchId = id; pendingSelection = null;
    revision = -1; queueRevision = -1; sources = []; cleanup.clear(); select(null); cleanupControls();
    byId('files').replaceChildren(); byId('workbenches').value = id;
    byId('add-file').disabled = true;
    await native.subscribe(id, value => { if (generation === workbenchGeneration) snapshot(value); });
  }
  async function refreshWorkbenches(reopen = false) {
    const generation = workbenchGeneration;
    let entries = await native.call('list_workbenches');
    if (generation !== workbenchGeneration) return;
    if (!entries.length) entries = [await native.call('create_workbench')];
    if (generation !== workbenchGeneration) return;
    byId('workbenches').replaceChildren(...entries.map((entry, index) => {
      const option = document.createElement('option'); option.value = entry.workbenchId;
      option.textContent = `Workbench ${index + 1}${entry.discarded ? ' · cleanup pending' : ''}`;
      return option;
    }));
    byId('new-workbench').disabled = entries.length >= 2;
    if (reopen || !entries.some(entry => entry.workbenchId === workbenchId)) await switchWorkbench(entries[0].workbenchId);
    else byId('workbenches').value = workbenchId;
  }
  byId('workbenches').onchange = event => { switchWorkbench(event.target.value).catch(error => message(error.message, true)); };
  byId('new-workbench').onclick = async () => {
    byId('new-workbench').disabled = true;
    try { const created = await native.call('create_workbench'); await refreshWorkbenches(); await switchWorkbench(created.workbenchId); }
    catch (error) { message(error.message, true); }
  };
  byId('discard-workbench').onclick = async () => {
    const owner = workbenchId, generation = workbenchGeneration;
    byId('discard-workbench').disabled = true; select(null);
    try {
      const result = await native.call('discard_workbench', { request: { workbenchId: owner } });
      if (generation === workbenchGeneration) snapshot(result);
    } catch (error) { if (generation === workbenchGeneration) message(error.message, true); }
  };
  byId('player').addEventListener('loadedmetadata', () => { const seconds = byId('player').duration; byId('duration').textContent = Number.isFinite(seconds) ? `${seconds.toFixed(3)} s` : ''; });
  byId('player').addEventListener('error', () => {
    const player = byId('player');
    if (selected && player.error && player.currentSrc === native.mediaUrl(selected)) message('Playback failed for this file. You can choose another file or check Runtime details.', true);
  });
  async function health() {
    const current = ++healthGeneration; byId('recheck').disabled = true;
    try {
      const result = await native.call('runtime_health'); if (current !== healthGeneration) return;
      byId('runtime').replaceChildren(...[['ffmpeg', 'FFmpeg'], ['ffprobe', 'FFprobe'], ['ytdlp', 'yt-dlp'], ['providerRuntime', 'Node · provider helper']].map(([key, label]) => {
        const status = result[key], span = document.createElement('span'); span.className = status.installed ? 'ok' : 'missing'; span.textContent = `${label}: ${status.installed ? 'available' : 'unavailable'}`; span.title = status.version || status.error; return span;
      }));
    } catch (error) { if (current === healthGeneration) message(error.message, true); }
    finally { if (current === healthGeneration) byId('recheck').disabled = false; }
  }
  byId('recheck').onclick = health;
  try {
    const handshake = await native.call('desktop_handshake');
    if (handshake.protocolVersion !== 1) throw new Error('The desktop interface and backend versions do not match.');
    byId('connection').textContent = `Desktop · ${handshake.appVersion}`;
    byId('runtime-detail').textContent = `Backend: Rust ${handshake.appVersion} · Webview: ${handshake.webviewVersion}`;
    await refreshWorkbenches(true); await health();
  } catch (error) { byId('connection').textContent = 'Desktop unavailable'; byId('recheck').disabled = true; message(error.message, true); }
})();
