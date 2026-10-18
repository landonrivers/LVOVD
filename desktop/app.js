'use strict';
(async function desktop() {
  const native = globalThis.LVOVDNative, byId = id => document.getElementById(id);
  let sources = [], selected = null, revision = -1, selectionGeneration = 0, operation = 0, healthGeneration = 0;
  let pendingSelection = null;
  const removed = new Set(), cleanup = new Set();
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
    else message('Direct playback is unavailable for this container. This foundation build does not yet create playback proxies.');
  }
  function snapshot(value) {
    if (!Number.isSafeInteger(value.revision) || value.revision <= revision) return;
    revision = value.revision;
    sources = value.sources.filter(s => !removed.has(s.assetId));
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
        button.disabled = true;
        try { const result = await native.call('remove_source', { request: { assetId: id } }); if (result.cleanupComplete) cleanup.delete(id); }
        catch { /* Keep the cleanup reachable without replacing another file's status. */ }
        cleanupControls();
      };
      return button;
    }));
  }
  byId('files').onchange = event => select(event.target.value);
  byId('add-file').onclick = async () => {
    const current = ++operation, generation = selectionGeneration; byId('add-file').disabled = true;
    message('Choose a file; its temporary copy will be inspected locally.');
    try {
      const source = await native.call('pick_source');
      if (current === operation && source && !removed.has(source.assetId) && generation === selectionGeneration) {
        // The command response and progress channel can arrive in either order.
        // Membership comes only from the authoritative snapshot.
        if (sources.some(s => s.assetId === source.assetId)) select(source.assetId);
        else pendingSelection = { id: source.assetId, generation };
      }
      if (current === operation && generation === selectionGeneration) message('');
    } catch (error) { if (current === operation && generation === selectionGeneration) message(error.message, true); }
    finally { byId('add-file').disabled = false; }
  };
  byId('remove-file').onclick = async () => {
    const id = selected; if (!id) return;
    const current = ++operation; removed.add(id); cleanup.add(id); select(null); cleanupControls();
    const generation = selectionGeneration;
    try { const result = await native.call('remove_source', { request: { assetId: id } }); if (result.cleanupComplete) cleanup.delete(id); }
    catch (error) { if (current === operation && generation === selectionGeneration) message(error.message, true); }
    cleanupControls();
  };
  byId('player').addEventListener('loadedmetadata', () => { const seconds = byId('player').duration; byId('duration').textContent = Number.isFinite(seconds) ? `${seconds.toFixed(3)} s` : ''; });
  byId('player').addEventListener('error', () => {
    const player = byId('player');
    if (selected && player.error && player.currentSrc === native.mediaUrl(selected)) message('Native playback failed. This foundation build has not passed every platform playback gate; see the desktop documentation.', true);
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
    byId('connection').textContent = `Rust · ${handshake.appVersion}`;
    byId('runtime-detail').textContent = `Webview ${handshake.webviewVersion} · Native commands · No localhost application server`;
    await native.subscribe(snapshot); byId('add-file').disabled = false; await health();
  } catch (error) { byId('connection').textContent = 'Desktop unavailable'; message(error.message, true); }
})();
